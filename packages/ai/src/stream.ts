import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
  StreamResult,
  StopReason,
  ToolCall,
  Usage,
} from "./types.js";
import type { AssistantMessageEventStream } from "./utils/event-stream.js";
import { getModel } from "./models.generated.js";
import { getApiProvider } from "./api-registry.js";
import { registerBuiltinProviders } from "./providers/register-builtins.js";
import { calculateCost } from "./utils/costs.js";

registerBuiltinProviders();

/**
 * Stream a completion from an LLM provider.
 * Provider is resolved from the model's API type.
 */
export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  const provider = getApiProvider(model.api);
  if (!provider) {
    throw new Error(`No provider registered for API: "${model.api}"`);
  }
  return provider.stream(model, context, options);
}

/**
 * Stream a simple completion (prompt-in, stream-out).
 * Provider is resolved from the model's API type.
 */
export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const provider = getApiProvider(model.api);
  if (!provider) {
    throw new Error(`No provider registered for API: "${model.api}"`);
  }
  return provider.streamSimple(model, context, options);
}

/**
 * Consume an event stream into a single StreamResult with accumulated text, tool calls, usage, and cost.
 */
const MAX_TOOL_CALLS = 128;

export async function collectStream(
  eventStream: AssistantMessageEventStream,
  model?: Model<Api>,
): Promise<StreamResult> {
  let text = "";
  const toolCallParts = new Map<number, ToolCall>();
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  let stopReason: StopReason = "unknown";

  for await (const event of eventStream) {
    switch (event.type) {
      case "text_delta":
        text += event.delta;
        break;

      case "toolcall_start": {
        if (toolCallParts.size >= MAX_TOOL_CALLS) {
          throw new Error(`Too many tool calls (max ${MAX_TOOL_CALLS})`);
        }
        toolCallParts.set(event.contentIndex, { id: "", name: "", arguments: "" });
        break;
      }

      case "toolcall_delta": {
        toolCallParts.get(event.contentIndex)!.arguments += event.delta;
        break;
      }

      case "toolcall_end": {
        toolCallParts.set(event.contentIndex, event.toolCall);
        break;
      }

      case "done":
        stopReason = event.reason;
        usage.input = event.message.usage.input;
        usage.output = event.message.usage.output;
        usage.cacheRead = event.message.usage.cacheRead;
        usage.cacheWrite = event.message.usage.cacheWrite;
        usage.totalTokens = event.message.usage.totalTokens;
        usage.cost = { ...event.message.usage.cost };
        break;

      case "error":
        stopReason = event.reason;
        usage.input = event.error.usage.input;
        usage.output = event.error.usage.output;
        usage.cacheRead = event.error.usage.cacheRead;
        usage.cacheWrite = event.error.usage.cacheWrite;
        usage.totalTokens = event.error.usage.totalTokens;
        usage.cost = { ...event.error.usage.cost };
        break;
    }
  }

  const toolCalls = Array.from(toolCallParts.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => tc);

  // Calculate costs if model is provided
  if (model) {
    usage.cost = calculateCost(usage, model);
  }

  return { text, toolCalls, usage, stopReason };
}

/**
 * Generate a completion from an LLM provider, collecting the full result.
 * Convenience wrapper around `stream` + `collectStream`.
 */
export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
): Promise<StreamResult> {
  const eventStream = stream(model, context, options);
  return collectStream(eventStream, model);
}

/**
 * Generate a simple completion (prompt-in, result-out).
 * Convenience wrapper around `streamSimple` + `collectStream`.
 */
export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<StreamResult> {
  const eventStream = streamSimple(model, context, options);
  return collectStream(eventStream, model);
}
