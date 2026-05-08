import type {
  AssistantMessageEventStream,
  Message,
  SimpleStreamOptions,
  StreamOptions,
  StreamResult,
  StopReason,
  ToolCall,
  Usage,
  Api,
} from "./types.js";
import { getModel } from "./models.generated.js";
import { getProviderStreamFn } from "./provider-registry.js";
import { registerBuiltinProviders } from "./providers/register-builtins.js";
import { calculateCost } from "./costs.js";

registerBuiltinProviders();

function resolveProviderName(modelId: string): string {
  const model = getModel(modelId);
  if (model) return model.provider;
  throw new Error(
    `Cannot determine provider for model: "${modelId}". Model not found in registry.`,
  );
}

/**
 * Stream a completion from an LLM provider. Provider is auto-detected from the model name.
 * Returns an async generator yielding standardized stream events.
 */
export function stream(options: StreamOptions): AssistantMessageEventStream {
  const providerName = resolveProviderName(options.model);
  const streamFn = getProviderStreamFn(providerName);
  return streamFn(options);
}

/**
 * Consume an event stream into a single StreamResult with accumulated text, tool calls, usage, and cost.
 */
const MAX_TOOL_CALLS = 128;

export async function collectStream(
  eventStream: AssistantMessageEventStream,
  modelId?: string,
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

  const toolCalls = [...toolCallParts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => tc);

  // Calculate cost if model is known
  let cost;
  if (modelId) {
    const model = getModel(modelId);
    if (model) cost = calculateCost(usage, model);
  }

  return { text, toolCalls, usage, cost, stopReason };
}

/**
 * Convenience: send a simple prompt and collect the full result.
 */
export async function streamSimple(options: SimpleStreamOptions): Promise<StreamResult> {
  const messages: Message[] = [];
  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: options.prompt });

  const eventStream = stream({
    model: options.model,
    messages,
    tools: options.tools,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  });

  return collectStream(eventStream, options.model);
}
