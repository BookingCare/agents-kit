import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  Static,
  StopReason,
  StreamResult,
  Tool,
  ToolCall,
  Usage,
} from "@bookingcare/ai";
import { streamSimple, Type } from "@bookingcare/ai";
import { createToolDispatch } from "./tools.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentLoopOptions,
  AgentMessage,
  AgentTool,
  BreakpointStage,
  StreamFn,
  StreamingAssistantMessage,
} from "./types.js";

export type { AgentLoopOptions } from "./types.js";

const MAX_TOOL_CALLS = 128;

// ── Public: simple API ────────────────────────────────────────────────

/**
 * Run an agent loop with a simple query string.
 *
 * Convenience wrapper around the streaming loop that handles tool dispatch,
 * skill loading, and todo nag automatically. Returns the full message
 * transcript and iteration count.
 */
export async function agentLoop(query: string, options: AgentLoopOptions) {
  const {
    model,
    system,
    workdir,
    skillsDir,
    maxTokens = 8000,
    maxIterations = 50,
    onStreamResult,
    signal: userSignal,
  } = options;

  // Use provided dispatch or create default from workdir
  const { tools, dispatch, skillLoader, todoManager } = options.dispatch
    ? {
        tools: options.tools ?? [],
        dispatch: options.dispatch,
        skillLoader: undefined,
        todoManager: undefined,
      }
    : createToolDispatch(workdir, skillsDir);

  // Build system prompt with skill descriptions (Layer 1)
  let systemPrompt = system ?? "";
  if (skillLoader && skillLoader.listNames().length > 0) {
    const skillSection = `\nSkills available:\n${skillLoader.getDescriptions()}`;
    systemPrompt += skillSection;
  }

  // Convert dispatch map to AgentTool[], preserving schemas from the original tools
  const agentTools: AgentTool[] = tools.map((t) => {
    const handler = dispatch[t.name];
    return {
      name: t.name,
      description: t.description,
      parameters: t.parameters as AgentTool["parameters"],
      label: t.name,
      execute: handler
        ? async (_toolCallId, params) => ({ content: handler(params as Record<string, unknown>) })
        : async () => ({ content: `Unknown tool: ${t.name}`, isError: true }),
    };
  });

  // Add any dispatch entries not in the tools array (shouldn't happen, but be safe)
  for (const name of Object.keys(dispatch)) {
    if (!agentTools.some((t) => t.name === name)) {
      agentTools.push({
        name,
        label: name,
        parameters: Type.Object({}),
        execute: async (_toolCallId, params) => ({
          content: dispatch[name](params as Record<string, unknown>),
        }),
      });
    }
  }

  // Collect state from the streaming loop
  let iterations = 0;
  let roundsSinceTodo = 0;
  const NAG_THRESHOLD = 3;
  const collectedMessages: AgentMessage[] = [];

  // Seed with user message
  const seedMessages: AgentMessage[] = [{ role: "user", content: query, timestamp: Date.now() }];

  const emit = async (event: AgentEvent): Promise<void> => {
    switch (event.type) {
      case "message_end": {
        iterations++;
        const msg = event.message;
        // Reconstruct StreamResult for the callback
        if (onStreamResult && msg.role === "assistant") {
          const textParts: string[] = [];
          const toolCalls: ToolCall[] = [];
          if (typeof msg.content === "string") {
            textParts.push(msg.content);
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if ("type" in part && part.type === "text")
                textParts.push((part as { type: "text"; text: string }).text);
              else if ("id" in part && "name" in part && "arguments" in part)
                toolCalls.push(part as ToolCall);
            }
          }
          const result: StreamResult = {
            text: textParts.join(""),
            toolCalls,
            usage:
              msg.usage ??
              ({
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              } as Usage),
            stopReason: (msg.stopReason as StreamResult["stopReason"]) ?? "stop",
          };
          onStreamResult(result, iterations);
        }
        break;
      }

      case "turn_end": {
        // Track todo nag
        const msg = event.message;
        if (msg.role === "assistant") {
          // Check if any tool call was "todo"
          const content = msg.content;
          let usedTodo = false;
          if (Array.isArray(content)) {
            usedTodo = content.some((p) => "name" in p && (p as { name: string }).name === "todo");
          }
          roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
        }
        break;
      }

      case "agent_end": {
        collectedMessages.push(...event.messages);
        break;
      }
    }
  };

  // Build config
  const config: AgentLoopConfig = {
    model,
    maxTokens,
    toolExecution: "sequential",
    convertToLlm: (msgs) => msgs,
    getSteeringMessages: async () => {
      // Inject todo nag reminder
      if (todoManager && roundsSinceTodo >= NAG_THRESHOLD) {
        roundsSinceTodo = 0;
        return [
          {
            role: "user" as const,
            content: "<reminder>Update your todos.</reminder>",
            timestamp: Date.now(),
          },
        ];
      }
      return [];
    },
    getFollowUpMessages: async () => [],
  };

  const context = {
    systemPrompt,
    messages: [] as AgentMessage[],
    tools: agentTools,
  };

  await loop(
    seedMessages,
    context,
    config,
    emit,
    userSignal ?? new AbortController().signal,
    streamSimple,
    maxIterations,
  );

  return {
    messages: collectedMessages,
    iterations,
  };
}

// ── Public: streaming API (for Agent class) ───────────────────────────

/**
 * Start a new agent loop from initial messages.
 * Appends to the context's existing messages.
 */
export async function runAgentLoop(
  initialMessages: AgentMessage[],
  context: { systemPrompt: string; messages: AgentMessage[]; tools: AgentTool[] },
  config: AgentLoopConfig,
  emit: (event: AgentEvent) => Promise<void>,
  signal: AbortSignal,
  streamFn: StreamFn,
): Promise<void> {
  const messages = [...context.messages, ...initialMessages];
  await loop(messages, context, config, emit, signal, streamFn);
}

/**
 * Continue an agent loop from the existing transcript.
 */
export async function runAgentLoopContinue(
  context: { systemPrompt: string; messages: AgentMessage[]; tools: AgentTool[] },
  config: AgentLoopConfig,
  emit: (event: AgentEvent) => Promise<void>,
  signal: AbortSignal,
  streamFn: StreamFn,
): Promise<void> {
  await loop(context.messages, context, config, emit, signal, streamFn);
}

// ── Core loop ─────────────────────────────────────────────────────────

async function loop(
  messages: AgentMessage[],
  context: { systemPrompt: string; tools: AgentTool[] },
  config: AgentLoopConfig,
  emit: (event: AgentEvent) => Promise<void>,
  signal: AbortSignal,
  streamFn: StreamFn,
  maxIterations?: number,
): Promise<void> {
  let iterationCount = 0;

  const buildStageContext = (): AgentContext => ({
    systemPrompt: context.systemPrompt,
    messages: structuredClone(messages),
    tools: context.tools.map((tool) => ({ ...tool })),
  });

  const checkStage = async (stage: BreakpointStage): Promise<void> => {
    if (!config.beforeStage) {
      return;
    }

    await config.beforeStage(stage, buildStageContext());
  };

  const finishRun = async (): Promise<void> => {
    await checkStage("complete");
    await emit({ type: "agent_end", messages: messages.slice() });
  };

  const finishRunIfAborted = async (): Promise<boolean> => {
    if (!signal.aborted) {
      return false;
    }

    await finishRun();
    return true;
  };

  for (;;) {
    if (signal.aborted) {
      await finishRun();
      return;
    }
    if (maxIterations !== undefined && ++iterationCount > maxIterations) {
      await finishRun();
      return;
    }

    // Allow mid-loop updates (model swap, tool changes, etc.)
    const update = await config.prepareNextTurn?.(signal);
    if (update) {
      if (update.model) config.model = update.model;
      if (update.tools) context.tools = update.tools;
      if (update.systemPrompt !== undefined) context.systemPrompt = update.systemPrompt;
    }

    let contextMessages = messages.slice();

    if (config.contextManager) {
      const result = config.contextManager.prepareMessages(contextMessages, context.systemPrompt);
      if (result.dropped > 0) {
        await emit({
          type: "context_trimmed",
          droppedMessages: result.dropped,
          remainingMessages: result.prepared.length,
          budget: config.contextManager.budget,
          tokenCountBefore: result.tokenCountBefore,
          tokenCountAfter: result.tokenCountAfter,
          strategyName: result.strategyName,
        });
      }
      contextMessages = result.prepared;
    }

    // transformContext is expected not to grow the context. If it does,
    // the result may exceed budget. Budget enforcement happens before this step.
    if (config.transformContext) {
      contextMessages = await config.transformContext(contextMessages, signal);
    }

    const llmMessages = await config.convertToLlm(contextMessages);
    if (context.systemPrompt) {
      llmMessages.unshift({ role: "system", content: context.systemPrompt });
    }

    // Resolve API key
    const apiKey = await config.getApiKey?.(config.model.provider as string);

    // Build stream options
    const options: SimpleStreamOptions = {
      signal,
      ...(apiKey && { apiKey }),
      ...(config.sessionId && { sessionId: config.sessionId }),
      ...(config.onPayload && { onPayload: config.onPayload }),
      ...(config.onResponse && { onResponse: config.onResponse }),
      ...(config.transport && { transport: config.transport }),
      ...(config.maxRetryDelayMs !== undefined && { maxRetryDelayMs: config.maxRetryDelayMs }),
      ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
    };

    // Collect tools in Tool[] format — AgentTool extends Tool so spread works directly
    const tools: Tool[] = context.tools;

    await checkStage("pre_stream");
    if (signal.aborted) {
      await finishRun();
      return;
    }

    // Stream the assistant response
    const eventStream = streamFn(config.model, { messages: llmMessages, tools }, options);
    let streamingStageChecked = false;
    const emitWithBreakpoint = async (event: AgentEvent): Promise<void> => {
      if (event.type === "message_start" && !streamingStageChecked) {
        streamingStageChecked = true;
        await checkStage("streaming");
      }
      await emit(event);
    };
    const result = await collectStreamIntoMessage(eventStream, emitWithBreakpoint, signal);

    if (!result) {
      await finishRun();
      return;
    }

    const assistantMessage: AgentMessage = {
      role: "assistant",
      content: result.text
        ? [
            ...(result.text ? [{ type: "text" as const, text: result.text }] : []),
            ...result.toolCalls,
          ]
        : result.toolCalls.length > 0
          ? result.toolCalls
          : [{ type: "text" as const, text: "" }],
      api: config.model.api,
      provider: config.model.provider,
      model: config.model.id,
      usage: result.usage,
      stopReason: result.stopReason,
      timestamp: Date.now(),
      ...(result.errorMessage && { errorMessage: result.errorMessage }),
    };

    await emit({ type: "message_end", message: assistantMessage });
    messages.push(assistantMessage);
    await checkStage("post_stream");
    if (await finishRunIfAborted()) {
      return;
    }

    // If no tool calls or error, check for follow-ups then exit
    const hasToolCalls = result.toolCalls.length > 0;
    const isStop =
      result.stopReason !== "tool_use" &&
      result.stopReason !== "toolUse" &&
      result.stopReason !== "error" &&
      result.stopReason !== "aborted";

    if (isStop || !hasToolCalls) {
      await checkStage("pre_followup");
      if (await finishRunIfAborted()) {
        return;
      }

      // Drain follow-up queue
      const followUps = await config.getFollowUpMessages();
      if (followUps.length > 0) {
        messages.push(...followUps);
        continue;
      }

      await finishRun();
      return;
    }

    if (result.errorMessage) {
      await finishRun();
      return;
    }

    await checkStage("pre_tool");
    if (await finishRunIfAborted()) {
      return;
    }

    // Execute tool calls
    const toolResults = await executeToolCalls(
      result.toolCalls,
      context.tools,
      config,
      emit,
      signal,
      async () => {
        await checkStage("tool_exec");
      },
    );

    if (await finishRunIfAborted()) {
      return;
    }

    for (const tr of toolResults) {
      messages.push(tr);
    }

    await emit({ type: "turn_end", message: assistantMessage, toolResults });
    await checkStage("post_tool");
    if (await finishRunIfAborted()) {
      return;
    }

    await checkStage("pre_followup");
    if (await finishRunIfAborted()) {
      return;
    }

    // Check for steering messages
    const steering = await config.getSteeringMessages();
    if (steering.length > 0) {
      messages.push(...steering);
    }

    // Check for follow-ups
    const followUps = await config.getFollowUpMessages();
    if (followUps.length > 0) {
      messages.push(...followUps);
    }
  }
}

// ── Stream collection ─────────────────────────────────────────────────

interface StreamCollectResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
}

async function collectStreamIntoMessage(
  eventStream: AssistantMessageEventStream,
  emit: (event: AgentEvent) => Promise<void>,
  signal: AbortSignal,
): Promise<StreamCollectResult | null> {
  let text = "";
  const toolCallParts = new Map<number, ToolCall>();
  let usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  let stopReason: StopReason = "unknown";
  let errorMessage: string | undefined;

  let partial: StreamingAssistantMessage = {
    role: "assistant",
    content: "",
    timestamp: Date.now(),
  };

  for await (const event of eventStream) {
    if (signal.aborted) return null;

    switch (event.type) {
      case "start":
        await emit({ type: "message_start", message: partial });
        break;

      case "text_delta":
        text += event.delta;
        partial = { ...partial, content: text };
        await emit({ type: "message_update", message: partial });
        break;

      case "text_end":
        break;

      case "toolcall_start":
        if (toolCallParts.size >= MAX_TOOL_CALLS) {
          throw new Error(`Too many tool calls (max ${MAX_TOOL_CALLS})`);
        }
        toolCallParts.set(event.contentIndex, {
          type: "toolCall",
          id: "",
          name: "",
          arguments: {},
        });
        break;

      case "toolcall_delta":
        // Note: toolcall_delta with object arguments requires provider-side handling
        // This is a no-op for now since providers handle argument parsing
        break;

      case "toolcall_end":
        toolCallParts.set(event.contentIndex, event.toolCall);
        break;

      case "done":
        stopReason = event.reason;
        usage = {
          input: event.message.usage.input,
          output: event.message.usage.output,
          cacheRead: event.message.usage.cacheRead,
          cacheWrite: event.message.usage.cacheWrite,
          totalTokens: event.message.usage.totalTokens,
          cost: { ...event.message.usage.cost },
        };
        break;

      case "error":
        stopReason = event.reason;
        errorMessage = event.error.errorMessage;
        usage = {
          input: event.error.usage.input,
          output: event.error.usage.output,
          cacheRead: event.error.usage.cacheRead,
          cacheWrite: event.error.usage.cacheWrite,
          totalTokens: event.error.usage.totalTokens,
          cost: { ...event.error.usage.cost },
        };
        break;
    }
  }

  const toolCalls = Array.from(toolCallParts.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => tc);

  return { text, toolCalls, usage, stopReason, errorMessage };
}

// ── Tool execution ────────────────────────────────────────────────────

async function executeToolCalls(
  toolCalls: ToolCall[],
  tools: AgentTool[],
  config: AgentLoopConfig,
  emit: (event: AgentEvent) => Promise<void>,
  signal: AbortSignal,
  beforeToolExecute?: () => Promise<void>,
): Promise<AgentMessage[]> {
  const results: AgentMessage[] = [];
  const toolMap = new Map(tools.map((t) => [t.name, t] as [string, AgentTool]));

  type PreparedToolExecution =
    | { kind: "skip"; result: AgentMessage }
    | { kind: "run"; run: () => Promise<AgentMessage> };

  const prepare = async (toolCall: ToolCall): Promise<PreparedToolExecution> => {
    let args = toolCall.arguments as Record<string, unknown>;
    const toolDef = toolMap.get(toolCall.name);

    if (config.beforeToolCall) {
      const before = await config.beforeToolCall(
        { toolName: toolCall.name, args, toolCallId: toolCall.id },
        signal,
      );
      if (before) {
        if (before.action === "skip") {
          return {
            kind: "skip",
            result: {
              role: "toolResult",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              content: [{ type: "text" as const, text: before.result ?? "" }],
              isError: false,
              timestamp: Date.now(),
            },
          };
        }
        if (before.action === "replace") {
          args = before.args;
        }
      }
    }

    if (beforeToolExecute) {
      await beforeToolExecute();
    }

    if (signal.aborted) {
      return {
        kind: "skip",
        result: {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text" as const, text: "" }],
          isError: false,
          timestamp: Date.now(),
        },
      };
    }

    return {
      kind: "run",
      run: async (): Promise<AgentMessage> => {
        await emit({ type: "tool_execution_start", toolCallId: toolCall.id });

        let output: string;
        let isError = false;

        if (toolDef) {
          try {
            const prepared = toolDef.prepareArguments
              ? toolDef.prepareArguments(args)
              : (args as Static<typeof toolDef.parameters>);
            const result = await toolDef.execute(toolCall.id, prepared, signal);
            output = result.content;
            isError = result.isError ?? false;
          } catch (e) {
            output = `Error: ${(e as Error).message}`;
            isError = true;
          }
        } else {
          output = `Unknown tool: ${toolCall.name}`;
          isError = true;
        }

        if (config.afterToolCall) {
          const after = await config.afterToolCall(
            { toolName: toolCall.name, args, toolCallId: toolCall.id, result: output },
            signal,
          );
          if (after && after.action === "replace") {
            output = after.result;
          }
        }

        await emit({ type: "tool_execution_end", toolCallId: toolCall.id });

        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text" as const, text: output }],
          isError,
          timestamp: Date.now(),
        };
      },
    };
  };

  // Per-tool executionMode overrides: if any tool call requires sequential, run all sequentially.
  const hasSequential = toolCalls.some((tc) => {
    const toolDef = toolMap.get(tc.name);
    return toolDef?.executionMode === "sequential";
  });

  if (config.toolExecution === "sequential" || hasSequential) {
    for (const tc of toolCalls) {
      if (signal.aborted) break;
      const prepared = await prepare(tc);
      if (prepared.kind === "skip") {
        results.push(prepared.result);
        continue;
      }
      results.push(await prepared.run());
    }
  } else {
    const prepared = [] as PreparedToolExecution[];
    for (const tc of toolCalls) {
      if (signal.aborted) break;
      prepared.push(await prepare(tc));
    }

    if (signal.aborted) {
      return results;
    }

    const settled = await Promise.all(
      prepared.map((item) => (item.kind === "skip" ? item.result : item.run())),
    );
    results.push(...settled);
  }

  return results;
}
