import { AzureOpenAI } from "openai/azure";
import type {
  ResponseCreateParamsStreaming,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputContent,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStatus,
  ResponseStreamEvent,
  Tool as OpenAIResponsesTool,
} from "openai/resources/responses/responses";
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
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "../types.js";
import { isToolCall } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { detectAzureOpenAIConfig } from "../utils/env-api-keys.js";
import { AIError } from "../utils/error.js";
import { calculateCost } from "../utils/costs.js";

const DEFAULT_AZURE_RESPONSES_API_VERSION = "2025-03-01-preview";

interface ToolCallPart extends ToolCall {
  partialArguments?: string;
}

export interface AzureOpenAIResponsesOptions extends StreamOptions {
  azureApiVersion?: string;
  azureEndpoint?: string;
  azureDeploymentName?: string;
}

let cachedClient: AzureOpenAI | null = null;
let cachedClientKey = "";

/** @internal Reset cached client — for testing only */
export function _resetResponsesClient(): void {
  cachedClient = null;
  cachedClientKey = "";
}

function createClient(options?: AzureOpenAIResponsesOptions): AzureOpenAI {
  const config = detectAzureOpenAIConfig();
  if (!config) {
    throw new AIError(
      "Azure OpenAI requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY environment variables.",
      { provider: "azure-openai" },
    );
  }

  const endpoint = options?.azureEndpoint || config.endpoint;
  const apiVersion = options?.azureApiVersion || DEFAULT_AZURE_RESPONSES_API_VERSION;
  const cacheKey = `${endpoint}|${apiVersion}`;
  if (cachedClient && cachedClientKey === cacheKey) return cachedClient;

  cachedClient = new AzureOpenAI({
    endpoint,
    apiKey: options?.apiKey || config.apiKey,
    apiVersion,
  });
  cachedClientKey = cacheKey;
  return cachedClient;
}

function resolveDeploymentName(
  model: Model<"azure-openai-responses">,
  options?: AzureOpenAIResponsesOptions,
): string {
  return options?.azureDeploymentName || model.id;
}

function convertImage(part: ImageContent): ResponseInputContent {
  const image = part.image instanceof URL ? part.image.toString() : part.image;
  const imageUrl = image.startsWith("data:")
    ? image
    : `data:${part.mimeType || "image/png"};base64,${image}`;

  return {
    type: "input_image",
    detail: "auto",
    image_url: imageUrl,
  };
}

function convertUserContent(content: UserMessage["content"]): ResponseInputContent[] {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }

  return content.map((part) => {
    if (part.type === "text") {
      return { type: "input_text", text: part.text };
    }
    return convertImage(part);
  });
}

function convertAssistantMessage(message: AssistantMessage): ResponseInput {
  const output: ResponseInput = [];

  for (const block of message.content) {
    if (block.type === "thinking") {
      continue;
    }

    if (block.type === "text") {
      output.push({ role: "assistant", content: block.text });
      continue;
    }

    const [callId, itemId] = block.id.split("|", 2);
    output.push({
      type: "function_call",
      id: itemId,
      call_id: callId,
      name: block.name,
      arguments: JSON.stringify(block.arguments),
    });
  }

  return output;
}

function convertToolResultMessage(message: ToolResultMessage): ResponseInput[number] {
  const [callId] = message.toolCallId.split("|", 1);
  const text = message.content
    .filter((content): content is TextContent => content.type === "text")
    .map((content) => content.text)
    .join("\n");

  return {
    type: "function_call_output",
    call_id: callId,
    output: text || "(no text output)",
  };
}

export function convertResponsesMessages(model: Model<Api>, context: Context): ResponseInput {
  const messages: ResponseInput = [];

  if (context.systemPrompt) {
    messages.push({
      role: model.reasoning ? "developer" : "system",
      content: context.systemPrompt,
    });
  }

  for (const message of context.messages) {
    if (message.role === "system") {
      messages.push({ role: model.reasoning ? "developer" : "system", content: message.content });
    } else if (message.role === "user") {
      const content = convertUserContent(message.content);
      if (content.length > 0) messages.push({ role: "user", content });
    } else if (message.role === "assistant") {
      messages.push(...convertAssistantMessage(message));
    } else if (message.role === "toolResult") {
      messages.push(convertToolResultMessage(message));
    }
  }

  return messages;
}

export function convertResponsesTools(tools: Tool[]): OpenAIResponsesTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Record<string, unknown>,
    strict: false,
  }));
}

export function buildResponsesParams(
  model: Model<"azure-openai-responses">,
  context: Context,
  options?: AzureOpenAIResponsesOptions,
): ResponseCreateParamsStreaming {
  const params: ResponseCreateParamsStreaming = {
    model: resolveDeploymentName(model, options),
    input: convertResponsesMessages(model, context),
    stream: true,
  };

  if (options?.maxTokens !== undefined) params.max_output_tokens = options.maxTokens;
  if (options?.temperature !== undefined) params.temperature = options.temperature;
  if (options?.topP !== undefined) params.top_p = options.topP;
  if (context.tools?.length) params.tools = convertResponsesTools(context.tools);

  if (model.reasoning && (options?.reasoningEffort || options?.reasoningSummary)) {
    params.reasoning = {
      effort: options.reasoningEffort || "medium",
      summary: options.reasoningSummary || "auto",
    };
    params.include = ["reasoning.encrypted_content"];
  }

  return params;
}

function mapStopReason(status: ResponseStatus | undefined): StopReason {
  switch (status) {
    case "completed":
    case "in_progress":
    case "queued":
    case undefined:
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
  }
}

function getContentIndex(blocks: AssistantMessage["content"]): number {
  return blocks.length - 1;
}

async function processResponsesStream<TApi extends Api>(
  responseStream: AsyncIterable<ResponseStreamEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<TApi>,
): Promise<void> {
  let currentItem: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | null =
    null;
  let currentBlock: ThinkingContent | TextContent | ToolCallPart | null = null;

  for await (const event of responseStream) {
    if (event.type === "response.created") {
      output.responseId = event.response.id;
      continue;
    }

    if (event.type === "response.output_item.added") {
      const item = event.item;
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", text: "" };
        output.content.push(currentBlock);
        stream.push({
          type: "thinking_start",
          contentIndex: getContentIndex(output.content),
          partial: output,
        });
      } else if (item.type === "message") {
        currentItem = item;
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        stream.push({
          type: "text_start",
          contentIndex: getContentIndex(output.content),
          partial: output,
        });
      } else if (item.type === "function_call") {
        currentItem = item;
        currentBlock = {
          type: "toolCall",
          id: `${item.call_id}|${item.id || item.call_id}`,
          name: item.name,
          arguments: {},
          partialArguments: item.arguments || "",
        };
        output.content.push(currentBlock);
        stream.push({
          type: "toolcall_start",
          contentIndex: getContentIndex(output.content),
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.text += event.delta;
        stream.push({
          type: "thinking_delta",
          contentIndex: getContentIndex(output.content),
          delta: event.delta,
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.reasoning_summary_part.done") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.text += "\n\n";
        stream.push({
          type: "thinking_delta",
          contentIndex: getContentIndex(output.content),
          delta: "\n\n",
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.reasoning_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.text += event.delta;
        stream.push({
          type: "thinking_delta",
          contentIndex: getContentIndex(output.content),
          delta: event.delta,
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.output_text.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        currentBlock.text += event.delta;
        stream.push({
          type: "text_delta",
          contentIndex: getContentIndex(output.content),
          delta: event.delta,
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        currentBlock.text += event.delta;
        stream.push({
          type: "text_delta",
          contentIndex: getContentIndex(output.content),
          delta: event.delta,
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.function_call_arguments.delta") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialArguments = `${currentBlock.partialArguments || ""}${event.delta}`;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialArguments);
        stream.push({
          type: "toolcall_delta",
          contentIndex: getContentIndex(output.content),
          delta: event.delta,
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "response.function_call_arguments.done") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialArguments = event.arguments;
        currentBlock.arguments = parseStreamingJson(event.arguments || "{}");
      }
      continue;
    }

    if (event.type === "response.output_item.done") {
      const item = event.item;
      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        const summary = item.summary?.map((part) => part.text).join("\n\n") || currentBlock.text;
        currentBlock.text = summary;
        stream.push({
          type: "thinking_end",
          contentIndex: getContentIndex(output.content),
          content: currentBlock.text,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = item.content
          .map((part) => (part.type === "output_text" ? part.text : part.refusal))
          .join("");
        stream.push({
          type: "text_end",
          contentIndex: getContentIndex(output.content),
          content: currentBlock.text,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "function_call") {
        const toolCall = currentBlock;
        if (toolCall?.type === "toolCall") {
          toolCall.id = `${item.call_id}|${item.id || item.call_id}`;
          toolCall.name = item.name;
          toolCall.arguments = parseStreamingJson(
            item.arguments || toolCall.partialArguments || "{}",
          );
          delete toolCall.partialArguments;
          stream.push({
            type: "toolcall_end",
            contentIndex: getContentIndex(output.content),
            toolCall,
            partial: output,
          });
        }
        currentBlock = null;
      }
      continue;
    }

    if (event.type === "response.completed") {
      const response = event.response;
      output.responseId = response.id;
      const cachedTokens = response.usage?.input_tokens_details?.cached_tokens || 0;
      const usage: Usage = {
        input: (response.usage?.input_tokens || 0) - cachedTokens,
        output: response.usage?.output_tokens || 0,
        cacheRead: cachedTokens,
        cacheWrite: 0,
        reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens,
        totalTokens: response.usage?.total_tokens || 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      usage.cost = calculateCost(usage, model);
      output.usage = usage;
      output.stopReason = mapStopReason(response.status);
      if (output.content.some((block) => isToolCall(block)) && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }
      continue;
    }

    if (event.type === "response.failed") {
      const error = event.response.error;
      throw new Error(error ? `${error.code}: ${error.message}` : "Azure OpenAI Responses failed");
    }

    if (event.type === "error") {
      throw new Error(`Error Code ${event.code}: ${event.message}`);
    }
  }
}

export const streamAzureOpenAIResponses: StreamFunction<
  "azure-openai-responses",
  AzureOpenAIResponsesOptions
> = (
  model: Model<"azure-openai-responses">,
  context: Context,
  options?: AzureOpenAIResponsesOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
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
      const params = buildResponsesParams(model, context, options);
      const responseStream = await client.responses.stream(params, {
        signal: options?.signal,
      });

      stream.push({ type: "start", partial: output });
      await processResponsesStream(responseStream, output, stream, model);

      if (options?.signal?.aborted) {
        output.stopReason = "aborted";
        output.errorMessage = "Request was aborted";
        stream.push({ type: "error", reason: "aborted", error: output });
        return;
      }

      if (output.stopReason === "error") {
        output.errorMessage = "Azure OpenAI Responses failed";
        stream.push({ type: "error", reason: "error", error: output });
        return;
      }

      stream.push({
        type: "done",
        reason: output.stopReason as Extract<StopReason, "stop" | "length" | "toolUse">,
        message: output,
      });
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
    }
  })();

  return stream;
};

export const streamSimpleAzureOpenAIResponses: StreamFunction<
  "azure-openai-responses",
  SimpleStreamOptions
> = (
  model: Model<"azure-openai-responses">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  return streamAzureOpenAIResponses(model, context, options);
};

export const azureOpenAIResponsesProvider = {
  api: "azure-openai-responses" as const,
  stream: streamAzureOpenAIResponses,
  streamSimple: streamSimpleAzureOpenAIResponses,
};
