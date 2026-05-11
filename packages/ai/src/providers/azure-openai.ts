import { AzureOpenAI } from "openai/azure";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  AssistantMessageEventStream,
  ImageContent,
  Message,
  Model,
  StopReason,
  StreamEvent,
  StreamOptions,
  SystemMessage,
  TextContent,
  ToolCall,
  ToolDefinition,
  ToolResultMessage,
  UserMessage,
  Api,
  Context,
  ProviderApi,
} from "../types.js";
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

function convertTools(tools: ToolDefinition[]): ChatCompletionTool[] {
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
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "stop_sequence";
    default:
      return "unknown";
  }
}

function parseChunk(chunk: ChatCompletionChunk): StreamEvent[] {
  const events: StreamEvent[] = [];
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;

  // Text content
  if (delta?.content) {
    events.push({ type: "text", content: delta.content });
  }

  // Tool calls
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      events.push({
        type: "tool_call",
        index: tc.index ?? 0,
        ...(tc.id && { id: tc.id }),
        ...(tc.function?.name && { name: tc.function.name }),
        arguments: tc.function?.arguments ?? "",
      });
    }
  }

  // Reasoning/thinking content (o1, o3 models)
  const deltaRecord = delta as Record<string, unknown> | undefined;
  if (deltaRecord?.reasoning_content) {
    events.push({
      type: "thinking",
      content: deltaRecord.reasoning_content as string,
    });
  }

  // Usage (emitted in final chunk when stream_options.include_usage is true)
  if (chunk.usage) {
    events.push({
      type: "usage",
      input: chunk.usage.prompt_tokens ?? 0,
      output: chunk.usage.completion_tokens ?? 0,
      ...(chunk.usage.prompt_tokens_details?.cached_tokens != null && {
        cacheRead: chunk.usage.prompt_tokens_details.cached_tokens,
      }),
    });
  }

  // Finish reason
  if (choice?.finish_reason) {
    events.push({ type: "stop", reason: mapFinishReason(choice.finish_reason) });
  }

  return events;
}

async function* streamAzureOpenAI<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
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

  let stream: AsyncIterable<ChatCompletionChunk>;
  try {
    const response = await client.chat.completions.create(createParams, {
      signal: options?.signal,
    });
    // The SDK returns Stream<ChatCompletionChunk> when stream: true
    stream = response as AsyncIterable<ChatCompletionChunk>;
  } catch (err) {
    throw new AIError(`Azure OpenAI request failed: ${(err as Error).message}`, {
      provider: "azure-openai",
      cause: err,
    });
  }

  for await (const chunk of stream) {
    const events = parseChunk(chunk);
    for (const event of events) {
      yield event;
    }
  }
}

export const azureOpenAIProvider: ProviderApi = {
  stream: streamAzureOpenAI,
  streamSimple: streamAzureOpenAI,
};
