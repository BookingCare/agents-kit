import { AzureOpenAI } from "openai/azure";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  Message,
  Model,
  StopReason,
  StreamOptions,
  SystemMessage,
  TextContent,
  ToolCall,
  Tool,
  ToolResultMessage,
  Usage,
  UserMessage,
  Api,
  Context,
  ProviderApi,
} from "../types.js";
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "../utils/event-stream.js";
import { detectAzureOpenAIConfig } from "../utils/env-api-keys.js";
import { AIError } from "../utils/error.js";

/**
 * Cached Azure OpenAI client.
 * Reads environment variables once on first use and caches the client for the lifetime of the process.
 * Use _resetClient() to clear the cache (e.g., after credential rotation in tests).
 */
let cachedClient: AzureOpenAI | null = null;

/** @internal Reset cached client — for testing only */
export function _resetClient(): void {
  cachedClient = null;
}

function getClient(): AzureOpenAI {
  if (cachedClient) return cachedClient;
  const config = detectAzureOpenAIConfig();
  if (!config) {
    throw new AIError(
      "Azure OpenAI requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY environment variables.",
      { provider: "azure-openai" },
    );
  }
  cachedClient = new AzureOpenAI({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    apiVersion: config.apiVersion,
  });
  return cachedClient;
}

function convertUserContent(
  content: string | (TextContent | ImageContent)[],
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return {
      type: "image_url",
      image_url: {
        url: part.image instanceof URL ? part.image.toString() : part.image,
      },
    };
  });
}

function convertMessages(messages: Message[]): ChatCompletionMessageParam[] {
  return messages.map((msg): ChatCompletionMessageParam => {
    switch (msg.role) {
      case "system": {
        const m = msg as SystemMessage;
        return { role: "system", content: m.content };
      }
      case "user": {
        const m = msg as UserMessage;
        return {
          role: "user",
          content: convertUserContent(m.content),
        } as ChatCompletionMessageParam;
      }
      case "assistant": {
        const m = msg;
        let text = "";
        const toolCalls: ToolCall[] = [];
        for (const c of m.content) {
          if ("type" in c && c.type === "text") text += c.text;
          else if ("id" in c) toolCalls.push(c as ToolCall);
        }
        return {
          role: "assistant",
          ...(text && { content: text }),
          ...(toolCalls.length && {
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }),
        };
      }
      case "toolResult": {
        const m = msg as ToolResultMessage;
        const text = m.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");
        return { role: "tool", tool_call_id: m.toolCallId, content: text };
      }
    }
  });
}

function convertTools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      ...(tool.description && { description: tool.description }),
      parameters: tool.parameters,
    },
  }));
}

function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
      return "toolUse";
    case "length":
      return "length";
    case "content_filter":
      return "stop";
    default:
      return "unknown";
  }
}

function makePartial(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "azure-openai-completions" as Api,
    provider: "azure-openai",
    model: "",
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "unknown",
    timestamp: Date.now(),
    ...overrides,
  };
}

function streamAzureOpenAI<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  // Run the async work in the background — push events into the stream.
  (async () => {
    const client = getClient();

    const createParams = {
      model: model.id,
      messages: convertMessages(context.messages),
      stream: true as const,
      stream_options: { include_usage: true as const },
      ...(context.tools?.length && { tools: convertTools(context.tools) }),
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
      ...(options?.maxTokens !== undefined && { max_completion_tokens: options.maxTokens }),
      ...(options?.topP !== undefined && { top_p: options.topP }),
      ...(options?.stopSequences?.length && { stop: options.stopSequences }),
    };

    let response: AsyncIterable<ChatCompletionChunk>;
    try {
      response = (await client.chat.completions.create(createParams, {
        signal: options?.signal,
      })) as AsyncIterable<ChatCompletionChunk>;
    } catch (err) {
      stream.push({
        type: "error",
        reason: "error",
        error: makePartial({
          model: model.id,
          stopReason: "error",
          errorMessage: (err as Error).message,
        }),
      });
      return;
    }

    const partial = makePartial({ model: model.id });
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const toolCallParts = new Map<number, ToolCall>();
    let textBuf = "";
    let contentIndex = 0;
    let textContentIndex = -1;
    let thinkingContentIndex = -1;
    let toolcallContentIndex = -1;
    let finishReason: string | null = null;

    stream.push({ type: "start", partial });

    for await (const chunk of response) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      // Text content
      if (delta?.content) {
        if (textContentIndex === -1) {
          textContentIndex = contentIndex++;
          stream.push({ type: "text_start", contentIndex: textContentIndex, partial });
        }
        textBuf += delta.content;
        stream.push({
          type: "text_delta",
          contentIndex: textContentIndex,
          delta: delta.content,
          partial,
        });
      }

      // Tool calls
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let tcPart = toolCallParts.get(idx);
          if (!tcPart) {
            toolcallContentIndex = contentIndex++;
            tcPart = {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: "",
            };
            toolCallParts.set(idx, tcPart);
            stream.push({ type: "toolcall_start", contentIndex: toolcallContentIndex, partial });
          }
          if (tc.function?.arguments) tcPart.arguments += tc.function.arguments;
          stream.push({
            type: "toolcall_delta",
            contentIndex: toolcallContentIndex!,
            delta: tc.function?.arguments ?? "",
            partial,
          });
        }
      }

      // Reasoning/thinking content (o1, o3 models)
      const deltaRecord = delta as Record<string, unknown> | undefined;
      if (deltaRecord?.reasoning_content) {
        const thinking = deltaRecord.reasoning_content as string;
        if (thinkingContentIndex === -1) {
          thinkingContentIndex = contentIndex++;
          stream.push({ type: "thinking_start", contentIndex: thinkingContentIndex, partial });
        }
        stream.push({
          type: "thinking_delta",
          contentIndex: thinkingContentIndex,
          delta: thinking,
          partial,
        });
      }

      // Usage (may arrive in a trailing chunk after finish_reason)
      if (chunk.usage) {
        usage.inputTokens += chunk.usage.prompt_tokens ?? 0;
        usage.outputTokens += chunk.usage.completion_tokens ?? 0;
        if (chunk.usage.prompt_tokens_details?.cached_tokens != null) {
          usage.cacheReadTokens =
            (usage.cacheReadTokens ?? 0) + chunk.usage.prompt_tokens_details.cached_tokens;
        }
      }

      // Track finish reason but don't emit done yet — usage may arrive in a later chunk
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;

        // Close any open content blocks
        if (textContentIndex !== -1) {
          stream.push({
            type: "text_end",
            contentIndex: textContentIndex,
            content: textBuf,
            partial,
          });
        }
        if (thinkingContentIndex !== -1) {
          stream.push({
            type: "thinking_end",
            contentIndex: thinkingContentIndex,
            content: "",
            partial,
          });
        }
        for (const [idx, tc] of toolCallParts) {
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: tc, partial });
        }
      }
    }

    // Emit done after all chunks processed — usage is now fully accumulated
    if (finishReason) {
      const stopReason = mapFinishReason(finishReason);
      const content: (TextContent | ToolCall)[] = [];
      if (textBuf) content.push({ type: "text", text: textBuf });
      for (const [, tc] of toolCallParts) content.push(tc);

      const message: AssistantMessage = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason,
        timestamp: Date.now(),
      };

      stream.push({
        type: "done",
        reason: stopReason as Extract<StopReason, "stop" | "length" | "toolUse">,
        message,
      });
    } else {
      // Stream ended without a finish_reason — treat as error
      stream.push({
        type: "error",
        reason: "error",
        error: makePartial({
          model: model.id,
          stopReason: "error",
          errorMessage: "Stream ended without finish_reason",
        }),
      });
    }
  })().catch((err) => {
    // If the stream isn't already settled, push an error event.
    stream.push({
      type: "error",
      reason: "error",
      error: makePartial({
        model: model.id,
        stopReason: "error",
        errorMessage: (err as Error).message,
      }),
    });
  });

  return stream;
}

export const azureOpenAIProvider: ProviderApi = {
  stream: streamAzureOpenAI,
  streamSimple: streamAzureOpenAI,
};
