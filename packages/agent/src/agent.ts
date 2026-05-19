import { randomUUID } from "node:crypto";
import {
  type Api,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  streamSimple,
  getModel,
  type TextContent,
  type Tool,
  type Transport,
  type Usage,
} from "@bookingcare/ai";
import type { Store, AgentInfo } from "@bookingcare/infra";
import type { McpServerConfig } from "./mcp/client.js";
import { McpRegistry } from "./mcp/registry.js";
import { NotFoundError, serializeAgentState, createTodoSnapshot } from "@bookingcare/infra";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import { EventBus } from "./event-bus.js";
import { BreakpointManager } from "./breakpoint-manager.js";
import type { TodoManager } from "./todo-manager.js";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentState,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  BreakpointCondition,
  BreakpointHit,
  BreakpointStage,
  QueueMode,
  StreamFn,
  ChannelListener,
  StreamingAssistantMessage,
  ToolExecutionMode,
} from "./types.js";
import type { ContextManager } from "./context-manager.js";

type PermissionManagerShape = NonNullable<AgentLoopConfig["permissionManager"]>;

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (message) =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  ) as Message[];
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL = {
  id: "unknown",
  name: "unknown",
  api: "unknown",
  provider: "unknown",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
} satisfies Model<any>;

type MutableAgentState = Omit<
  AgentState,
  "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"
> & {
  isStreaming: boolean;
  streamingMessage?: StreamingAssistantMessage;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
};

function createMutableAgentState(
  initialState?: Partial<
    Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
  >,
): MutableAgentState {
  let tools = initialState?.tools?.slice() ?? [];
  let messages = initialState?.messages?.slice() ?? [];

  return {
    systemPrompt: initialState?.systemPrompt ?? "",
    model: initialState?.model ?? DEFAULT_MODEL,
    thinkingLevel: initialState?.thinkingLevel ?? "off",
    get tools() {
      return tools;
    },
    set tools(nextTools: AgentTool<any>[]) {
      tools = nextTools.slice();
    },
    get messages() {
      return messages;
    },
    set messages(nextMessages: AgentMessage[]) {
      messages = nextMessages.slice();
    },
    isStreaming: false,
    streamingMessage: undefined,
    pendingToolCalls: new Set<string>(),
    errorMessage: undefined,
  };
}

/** Options for constructing an {@link Agent}. */
export interface AgentOptions {
  initialState?: Partial<
    Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
  >;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  streamFn?: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  prepareNextTurn?: (
    signal?: AbortSignal,
  ) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  sessionId?: string;
  transport?: Transport;
  maxRetryDelayMs?: number;
  toolExecution?: ToolExecutionMode;
  /** Optional persistence store for session save/resume. */
  store?: Store;
  /** Optional todo manager for persisting todo state. */
  todoManager?: TodoManager;
  /** Optional context manager for token budget management. */
  contextManager?: ContextManager;
  /** Optional MCP server configurations to connect during initialization. */
  mcpServers?: McpServerConfig[];
  /** Optional pre-configured MCP registry. */
  mcpRegistry?: McpRegistry;
  /** Optional breakpoint manager for pause/resume control. */
  breakpointManager?: BreakpointManager;
  /** Optional permission manager for tool approval flow. */
  permissionManager?: PermissionManagerShape;
}

class PendingMessageQueue {
  private messages: AgentMessage[] = [];

  constructor(public mode: QueueMode) {}

  enqueue(message: AgentMessage): void {
    this.messages.push(message);
  }

  hasItems(): boolean {
    return this.messages.length > 0;
  }

  drain(): AgentMessage[] {
    if (this.mode === "all") {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }

    const first = this.messages[0];
    if (!first) {
      return [];
    }
    this.messages = this.messages.slice(1);
    return [first];
  }

  clear(): void {
    this.messages = [];
  }
}

type ActiveRun = {
  promise: Promise<void>;
  resolve: () => void;
  abortController: AbortController;
};

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
  private _state: MutableAgentState;
  public readonly eventBus: EventBus;
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;

  public breakpointManager: BreakpointManager;
  public permissionManager?: PermissionManagerShape;
  public onBreakpoint?: (hit: BreakpointHit) => Promise<void> | void;

  public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  public transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => Promise<AgentMessage[]>;
  public streamFn: StreamFn;
  public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  public onPayload?: SimpleStreamOptions["onPayload"];
  public onResponse?: SimpleStreamOptions["onResponse"];
  public beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  public afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  public prepareNextTurn?: (
    signal?: AbortSignal,
  ) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  private activeRun?: ActiveRun;
  /** Session identifier forwarded to providers for cache-aware backends. */
  public sessionId?: string;
  /** Preferred transport forwarded to the stream function. */
  public transport: Transport;
  /** Optional cap for provider-requested retry delays. */
  public maxRetryDelayMs?: number;
  /** Tool execution strategy for assistant messages that contain multiple tool calls. */
  public toolExecution: ToolExecutionMode;
  private store?: Store;
  private todoManager?: TodoManager;
  private createdAt?: number;
  private mcpRegistry?: McpRegistry;
  private mcpInitialization?: Promise<void>;
  /** Optional context manager for token budget management. */
  public contextManager?: ContextManager;

  constructor(options: AgentOptions = {}) {
    this._state = createMutableAgentState(options.initialState);
    this.eventBus = new EventBus();
    this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
    this.transformContext = options.transformContext;
    this.streamFn = options.streamFn ?? streamSimple;
    this.getApiKey = options.getApiKey;
    this.onPayload = options.onPayload;
    this.onResponse = options.onResponse;
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
    this.prepareNextTurn = options.prepareNextTurn;
    this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
    this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
    this.breakpointManager = options.breakpointManager ?? new BreakpointManager();
    this.permissionManager = options.permissionManager;
    this.store = options.store;
    this.todoManager = options.todoManager;
    this.sessionId = options.sessionId ?? (options.store ? randomUUID() : undefined);
    this.createdAt = options.store ? Date.now() : undefined;
    this.transport = options.transport ?? "auto";
    this.maxRetryDelayMs = options.maxRetryDelayMs;
    this.toolExecution = options.toolExecution ?? "parallel";
    this.contextManager = options.contextManager;
    this.mcpRegistry = options.mcpRegistry;
    this.mcpInitialization = this.mcpRegistry
      ? Promise.resolve()
      : this.initializeMcpServers(options.mcpServers ?? []);
  }

  private async initializeMcpServers(servers: McpServerConfig[]): Promise<void> {
    if (servers.length === 0) return;

    const registry = new McpRegistry();
    this.mcpRegistry = registry;

    try {
      for (const server of servers) {
        await registry.addServer(server);
      }
    } catch (error) {
      await registry.shutdown();
      this.mcpRegistry = undefined;
      throw error;
    }
  }

  /**
   * Resume a previously persisted session.
   *
   * Loads messages, metadata, and todo state from the given store,
   * reconstructs the model from the saved model ID, and returns a new
   * Agent ready to continue.
   *
   * Tools are not persisted and must be re-registered after resume.
   */
  public static async resume(
    options: {
      sessionId: string;
      store: Store;
      model?: Model<Api>;
      todoManager?: TodoManager;
    } & Omit<AgentOptions, "store" | "sessionId" | "todoManager" | "initialState">,
  ): Promise<Agent> {
    const { sessionId, store, model: providedModel, todoManager, ...agentOptions } = options;

    const [messages, info, todoSnapshot] = await Promise.all([
      store.loadMessages(sessionId),
      store.loadInfo(sessionId),
      store.loadTodos(sessionId),
    ]);

    if (!info) {
      throw new NotFoundError(sessionId);
    }

    const model = providedModel ?? getModel(info.model);
    if (!model) {
      throw new Error(`Model not found: ${info.model}`);
    }

    const agent = new Agent({
      initialState: {
        messages,
        systemPrompt: info.systemPrompt,
        model,
        thinkingLevel: "off",
        tools: [],
      },
      sessionId,
      store,
      todoManager,
      ...agentOptions,
    });

    agent.createdAt = info.createdAt;

    if (todoSnapshot && todoManager) {
      todoManager.update(todoSnapshot.items);
    }

    return agent;
  }

  /** Persist current session state to the store. */
  private async persistSession(messages: AgentMessage[]): Promise<void> {
    if (!this.store || !this.sessionId) return;

    const serialized = serializeAgentState(this._state);
    const todoSnapshot = this.todoManager
      ? createTodoSnapshot(this.todoManager.getItems(), this.todoManager.render())
      : { items: [], rendered: "No todos." };

    const now = Date.now();
    const info: AgentInfo = {
      sessionId: this.sessionId,
      model: serialized.info.model,
      provider: serialized.info.provider,
      systemPrompt: serialized.info.systemPrompt,
      createdAt: this.createdAt ?? now,
      updatedAt: now,
      messageCount: messages.length,
    };

    await Promise.all([
      this.store.saveMessages(this.sessionId, messages),
      this.store.saveTodos(this.sessionId, todoSnapshot),
      this.store.saveInfo(this.sessionId, info),
    ]);
  }

  /**
   * Subscribe to agent lifecycle events.
   *
   * @deprecated Use `agent.eventBus.on(channel, listener)` for targeted subscriptions.
   */
  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    const lifecycleListener: ChannelListener<"lifecycle"> = (event, signal) =>
      listener(event, signal);
    const streamingListener: ChannelListener<"streaming"> = (event, signal) =>
      listener(event, signal);
    const toolsListener: ChannelListener<"tools"> = (event, signal) => listener(event, signal);

    const unsubscribeLifecycle = this.eventBus.on("lifecycle", lifecycleListener);
    const unsubscribeStreaming = this.eventBus.on("streaming", streamingListener);
    const unsubscribeTools = this.eventBus.on("tools", toolsListener);

    return () => {
      unsubscribeLifecycle();
      unsubscribeStreaming();
      unsubscribeTools();
    };
  }

  /**
   * Current agent state.
   *
   * Assigning `state.tools` or `state.messages` copies the provided top-level array.
   */
  get state(): AgentState {
    return this._state;
  }

  /** Controls how queued steering messages are drained. */
  set steeringMode(mode: QueueMode) {
    this.steeringQueue.mode = mode;
  }

  get steeringMode(): QueueMode {
    return this.steeringQueue.mode;
  }

  /** Controls how queued follow-up messages are drained. */
  set followUpMode(mode: QueueMode) {
    this.followUpQueue.mode = mode;
  }

  get followUpMode(): QueueMode {
    return this.followUpQueue.mode;
  }

  /** Queue a message to be injected after the current assistant turn finishes. */
  steer(message: AgentMessage): void {
    this.steeringQueue.enqueue(message);
  }

  /** Queue a message to run only after the agent would otherwise stop. */
  followUp(message: AgentMessage): void {
    this.followUpQueue.enqueue(message);
  }

  /** Remove all queued steering messages. */
  clearSteeringQueue(): void {
    this.steeringQueue.clear();
  }

  /** Remove all queued follow-up messages. */
  clearFollowUpQueue(): void {
    this.followUpQueue.clear();
  }

  /** Remove all queued steering and follow-up messages. */
  clearAllQueues(): void {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
  }

  setBreakpoint(stage: BreakpointStage, condition?: BreakpointCondition): void {
    this.breakpointManager.setBreakpoint(stage, condition);
  }

  clearBreakpoint(stage: BreakpointStage): void {
    this.breakpointManager.clearBreakpoint(stage);
  }

  clearAllBreakpoints(): void {
    this.breakpointManager.clearAllBreakpoints();
  }

  pause(): void {
    this.breakpointManager.pause();
  }

  resume(): void {
    this.breakpointManager.resume();
  }

  /** Returns true when either queue still contains pending messages. */
  hasQueuedMessages(): boolean {
    return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
  }

  /** Active abort signal for the current run, if any. */
  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  /** Abort the current run, if one is active. */
  abort(): void {
    this.activeRun?.abortController.abort();
  }

  /**
   * Resolve when the current run and all awaited event listeners have finished.
   *
   * This resolves after `agent_end` listeners settle.
   */
  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  /** Clear transcript state, runtime state, and queued messages. */
  reset(): void {
    this._state.messages = [];
    this._state.isStreaming = false;
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();
    this._state.errorMessage = undefined;
    this.clearFollowUpQueue();
    this.clearSteeringQueue();
  }

  /** Start a new prompt from text, a single message, or a batch of messages. */
  async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  async prompt(input: string, images?: ImageContent[]): Promise<void>;
  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<void> {
    if (this.activeRun) {
      throw new Error(
        "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
      );
    }
    const messages = this.normalizePromptInput(input, images);
    await this.ensureMcpInitialized();
    await this.runPromptMessages(messages);
  }

  /** Continue from the current transcript. The last message must be a user or tool-result message. */
  async continue(): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }

    const lastMessage = this._state.messages[this._state.messages.length - 1];
    if (!lastMessage) {
      throw new Error("No messages to continue from");
    }

    if (lastMessage.role === "assistant") {
      const queuedSteering = this.steeringQueue.drain();
      if (queuedSteering.length > 0) {
        await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
        return;
      }

      const queuedFollowUps = this.followUpQueue.drain();
      if (queuedFollowUps.length > 0) {
        await this.runPromptMessages(queuedFollowUps);
        return;
      }

      throw new Error("Cannot continue from message role: assistant");
    }

    await this.ensureMcpInitialized();
    await this.runContinuation();
  }

  private normalizePromptInput(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): AgentMessage[] {
    if (Array.isArray(input)) {
      return input;
    }

    if (typeof input !== "string") {
      return [input];
    }

    const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
    if (images && images.length > 0) {
      content.push(...images);
    }
    return [{ role: "user", content, timestamp: Date.now() }];
  }

  private async ensureMcpInitialized(): Promise<void> {
    await this.mcpInitialization;
  }

  private async runPromptMessages(
    messages: AgentMessage[],
    options: { skipInitialSteeringPoll?: boolean } = {},
  ): Promise<void> {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoop(
        messages,
        this.createContextSnapshot(),
        this.createLoopConfig(options),
        (event) => this.processEvents(event),
        signal,
        this.streamFn,
      );
    });
  }

  private async runContinuation(): Promise<void> {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoopContinue(
        this.createContextSnapshot(),
        this.createLoopConfig(),
        (event) => this.processEvents(event),
        signal,
        this.streamFn,
      );
    });
  }

  private createContextSnapshot(): AgentContext {
    return {
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages.slice(),
      tools: this._state.tools.slice(),
    };
  }

  private createStateSnapshot(): AgentState {
    const model = this._state.model;
    const compat = model.compat
      ? {
          ...model.compat,
          ...(model.compat.headers ? { headers: { ...model.compat.headers } } : {}),
        }
      : undefined;

    return {
      ...this._state,
      model: {
        ...model,
        input: [...model.input],
        cost: { ...model.cost },
        ...(model.headers ? { headers: { ...model.headers } } : {}),
        ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
        ...(compat ? { compat } : {}),
      },
      tools: this._state.tools.map((tool) => ({ ...tool })),
      messages: structuredClone(this._state.messages),
      pendingToolCalls: new Set(this._state.pendingToolCalls),
      streamingMessage: this._state.streamingMessage
        ? structuredClone(this._state.streamingMessage)
        : undefined,
    };
  }

  private async waitForBreakpoint(stage: BreakpointStage, context: AgentContext): Promise<void> {
    const manager = this.breakpointManager;
    const shouldPause = manager.isPaused() || manager.shouldPauseAt(stage, context);
    if (!shouldPause) {
      return;
    }

    if (!manager.isPaused()) {
      manager.pause();
    }

    const hit: BreakpointHit = {
      stage,
      context,
      snapshot: this.createStateSnapshot(),
    };

    try {
      await this.onBreakpoint?.(hit);
    } catch (error) {
      manager.resume();
      throw error;
    }

    const resumeWait = manager.resumeWait;
    if (!resumeWait) {
      return;
    }

    const abortSignal = this.signal;
    if (abortSignal?.aborted) {
      manager.resume();
      return;
    }

    let removeAbortListener = () => {};
    const abortWait = abortSignal
      ? new Promise<void>((resolve) => {
          const onAbort = () => {
            abortSignal.removeEventListener("abort", onAbort);
            resolve();
          };
          removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
          abortSignal.addEventListener("abort", onAbort, { once: true });
        })
      : Promise.resolve();

    try {
      await Promise.race([resumeWait, abortWait]);
    } finally {
      removeAbortListener();
    }

    if (abortSignal?.aborted) {
      manager.resume();
    }
  }

  private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
    let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
    return {
      model: this._state.model,
      sessionId: this.sessionId,
      onPayload: this.onPayload,
      onResponse: this.onResponse,
      transport: this.transport,
      maxRetryDelayMs: this.maxRetryDelayMs,
      toolExecution: this.toolExecution,
      beforeStage: async (stage, context) => {
        await this.waitForBreakpoint(stage, context);
      },
      beforeToolCall: this.beforeToolCall,
      permissionManager: this.permissionManager,
      afterToolCall: this.afterToolCall,
      prepareNextTurn: this.prepareNextTurn
        ? async () => await this.prepareNextTurn?.(this.signal)
        : undefined,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      getApiKey: this.getApiKey,
      getSteeringMessages: async () => {
        if (skipInitialSteeringPoll) {
          skipInitialSteeringPoll = false;
          return [];
        }
        return this.steeringQueue.drain();
      },
      getFollowUpMessages: async () => this.followUpQueue.drain(),
      contextManager: this.contextManager,
    };
  }

  async shutdown(): Promise<void> {
    await this.mcpInitialization;
    await this.mcpRegistry?.shutdown();
    this.mcpRegistry = undefined;
  }

  private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing.");
    }

    const abortController = new AbortController();
    let resolvePromise = () => {};
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    this.activeRun = { promise, resolve: resolvePromise, abortController };

    this._state.isStreaming = true;
    this._state.streamingMessage = undefined;
    this._state.errorMessage = undefined;

    try {
      await executor(abortController.signal);
    } catch (error) {
      await this.handleRunFailure(error, abortController.signal.aborted);
    } finally {
      this.finishRun();
    }
  }

  private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
    const errorText = error instanceof Error ? error.message : String(error);
    const failureMessage: AgentMessage = {
      role: "assistant",
      content: [{ type: "text" as const, text: errorText }],
      api: this._state.model.api,
      provider: this._state.model.provider as string,
      model: this._state.model.id,
      usage: EMPTY_USAGE,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: errorText,
      timestamp: Date.now(),
    };
    const streamingPartial: StreamingAssistantMessage = {
      role: "assistant",
      content: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    await this.processEvents({ type: "message_start", message: streamingPartial });
    await this.processEvents({ type: "message_end", message: failureMessage });
    await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
    try {
      await this.waitForBreakpoint("complete", this.createContextSnapshot());
    } catch (breakpointError) {
      console.warn(
        `[agent] breakpoint error during complete: ${
          breakpointError instanceof Error ? breakpointError.message : String(breakpointError)
        }`,
      );
    }
    await this.processEvents({ type: "agent_end", messages: [failureMessage] });
  }

  private finishRun(): void {
    this._state.isStreaming = false;
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();
    this.activeRun?.resolve();
    this.activeRun = undefined;
  }

  /**
   * Reduce internal state for a loop event, then await listeners.
   *
   * `agent_end` only means no further loop events will be emitted. The run is
   * considered idle later, after all awaited listeners for `agent_end` finish
   * and `finishRun()` clears runtime-owned state.
   */
  private async processEvents(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
        this._state.streamingMessage = event.message;
        break;

      case "message_update":
        this._state.streamingMessage = event.message;
        break;

      case "message_end":
        this._state.streamingMessage = undefined;
        this._state.messages.push(event.message);
        break;

      case "tool_execution_start": {
        const pendingToolCalls = new Set(this._state.pendingToolCalls);
        pendingToolCalls.add(event.toolCallId);
        this._state.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "tool_execution_end": {
        const pendingToolCalls = new Set(this._state.pendingToolCalls);
        pendingToolCalls.delete(event.toolCallId);
        this._state.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "turn_end":
        for (const tr of event.toolResults) {
          this._state.messages.push(tr);
        }
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this._state.errorMessage = event.message.errorMessage;
        }
        break;

      case "agent_end":
        // Sync full transcript from the loop's internal message list
        this._state.messages = event.messages.slice();
        this._state.streamingMessage = undefined;

        try {
          await this.persistSession(event.messages);
        } catch (err) {
          console.warn(
            `[agent] persistence failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;

      case "permission_needed":
        // No internal state change needed; event is forwarded to listeners
        break;

      case "context_trimmed":
        // No internal state change needed; event is forwarded to listeners
        break;
    }

    const signal = this.activeRun?.abortController.signal;
    if (!signal) {
      throw new Error("Agent listener invoked outside active run");
    }

    await this.eventBus.emit(event, signal);
  }
}
