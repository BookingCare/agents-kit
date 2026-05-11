import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
  StreamResult,
  StopReason,
  ToolCall,
  Usage,
} from "./types.js";
import { parse } from "partial-json";
import { getModel } from "./models.generated.js";
import { resolveApiProvider } from "./provider-registry.js";
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
  const provider = resolveApiProvider(model.api);
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
  const provider = resolveApiProvider(model.api);
  return provider.streamSimple(model, context, options);
}

/**
 * Wrap an event stream to add parsed tool call events using partial JSON parsing.
 * Emits `tool_call_parsed` events with partially or fully parsed arguments.
 */
export async function* withParsedToolCalls(
  eventStream: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const event of eventStream) {
    yield event;

    if (event.type === "tool_call") {
      const existing = toolCallParts.get(event.index);
      if (existing) {
        existing.arguments += event.arguments;
      } else {
        toolCallParts.set(event.index, {
          id: event.id ?? "",
          name: event.name ?? "",
          arguments: event.arguments,
        });
      }

      const toolCall = toolCallParts.get(event.index)!;
      if (toolCall.id && toolCall.name && toolCall.arguments) {
        try {
          const parsedArgs = parse(toolCall.arguments);
          if (parsedArgs !== null && typeof parsedArgs === "object") {
            yield {
              type: "tool_call_parsed",
              index: event.index,
              id: toolCall.id,
              name: toolCall.name,
              arguments: parsedArgs as Record<string, unknown>,
              isComplete: toolCall.arguments.endsWith("}") && toolCall.arguments.startsWith("{"),
            };
          }
        } catch {
          // Invalid partial JSON, skip emitting parsed event
        }
      }
    }
  }
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
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "unknown";

  for await (const event of eventStream) {
    switch (event.type) {
      case "text":
        text += event.content;
        break;

      case "tool_call": {
        if (toolCallParts.size >= MAX_TOOL_CALLS && !toolCallParts.has(event.index)) {
          throw new Error(`Too many tool calls (max ${MAX_TOOL_CALLS})`);
        }
        const existing = toolCallParts.get(event.index);
        if (existing) {
          existing.arguments += event.arguments;
        } else {
          toolCallParts.set(event.index, {
            id: event.id ?? "",
            name: event.name ?? "",
            arguments: event.arguments,
          });
        }
        break;
      }

      case "usage":
        usage.inputTokens += event.input;
        usage.outputTokens += event.output;
        if (event.cacheCreation != null) usage.cacheCreationTokens = event.cacheCreation;
        if (event.cacheRead != null) usage.cacheReadTokens = event.cacheRead;
        break;

      case "stop":
        stopReason = event.reason;
        break;
    }
  }

  const toolCalls = Array.from(toolCallParts.entries()).sort(([a], [b]) => a - b).map(([, tc]) => tc);

  const cost = model ? calculateCost(usage, model) : undefined;

  return { text, toolCalls, usage, cost, stopReason };
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
