import { AzureOpenAI } from "openai/azure";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  StopReason,
  StreamFunction,
  StreamOptions,
  SystemMessage,
  TextContent,
  ToolCall,
  Tool,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { detectAzureOpenAIConfig } from "../utils/env-api-keys.js";
import { AIError } from "../utils/error.js";

// ── Options ────────────────────────────────────────────────────────

export interface AzureOpenAICompletionsOptions extends StreamOptions {
  azureApiVersion?: string;
  azureEndpoint?: string;
}

// ── Client ─────────────────────────────────────────────────────────

let cachedClient: AzureOpenAI | null = null;

/** @internal Reset cached client — for testing only */
export function _resetClient(): void {
  cachedClient = null;
}

function createClient(options?: AzureOpenAICompletionsOptions): AzureOpenAI {
  if (cachedClient) return cachedClient;
  const config = detectAzureOpenAIConfig();
  if (!config) {
    throw new AIError(
      "Azure OpenAI requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY environment variables.",
      { provider: "azure-openai" },
    );
  }
  cachedClient = new AzureOpenAI({
    endpoint: options?.azureEndpoint || config.endpoint,
    apiKey: config.apiKey,
    apiVersion: options?.azureApiVersion || config.apiVersion,
  });
  return cachedClient;
}

// ── Message conversion ─────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────

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

function buildParams(model: Model<Api>, context: Context, options?: StreamOptions) {
  return {
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
}

// ── Stream functions ───────────────────────────────────────────────

/**
 * Stream completions from Azure OpenAI Chat Completions API.
 */
export const streamAzureOpenAICompletions: StreamFunction<
  "azure-openai-completions",
  AzureOpenAICompletionsOptions
> = (
  model: Model<"azure-openai-completions">,
  context: Context,
  options?: AzureOpenAICompletionsOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();

  (async () => {
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "unknown",
      timestamp: Date.now(),
    };

    try {
      const client = createClient(options);
      const params = buildParams(model, context, options);

      const response = (await client.chat.completions.create(params, {
        signal: options?.signal,
      })) as AsyncIterable<ChatCompletionChunk>;

      const usage: Usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
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

        if (chunk.usage) {
          usage.input += chunk.usage.prompt_tokens ?? 0;
          usage.output += chunk.usage.completion_tokens ?? 0;
          if (chunk.usage.prompt_tokens_details?.cached_tokens != null) {
            usage.cacheRead += chunk.usage.prompt_tokens_details.cached_tokens;
          }
          // Azure OpenAI doesn't provide cache_write_tokens, assume 0 for now
          // Use total_tokens from API to avoid double-counting cached tokens
          // Note: Azure's total_tokens includes both prompt and completion tokens
          // but doesn't include cache_write_tokens, so we add cacheWrite separately
          usage.totalTokens = (chunk.usage.total_tokens ?? 0) + usage.cacheWrite;
        }

        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;

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
        partial.stopReason = "error";
        partial.errorMessage = "Stream ended without finish_reason";
        stream.push({ type: "error", reason: "error", error: partial });
      }
    } catch (error) {
      partial.stopReason = options?.signal?.aborted ? "aborted" : "error";
      partial.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: partial.stopReason, error: partial });
    }
  })();

  return stream;
};

/**
 * Simple stream — delegates to the main stream function with base options.
 */
export const streamSimpleAzureOpenAICompletions: StreamFunction<
  "azure-openai-completions",
  SimpleStreamOptions
> = (
  model: Model<"azure-openai-completions">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  return streamAzureOpenAICompletions(model, context, options);
};

// ── Provider export ───────────────────────────────────────────────

export const azureOpenAIProvider = {
  api: "azure-openai-completions" as const,
  stream: streamAzureOpenAICompletions,
  streamSimple: streamSimpleAzureOpenAICompletions,
};
