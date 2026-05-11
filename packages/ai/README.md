# @agents-kit/ai

Unified LLM API with automatic model discovery, provider configuration, token and cost tracking, and simple context persistence and hand-off to other models mid-session.

**Note:** This library only includes models that support tool calling (function calling), as this is essential for agentic workflows.

## Installation

```bash
pnpm add @agents-kit/ai
```

## Quick Start

```typescript
import { getModel, stream, collectStream, streamSimple, Context } from "@agents-kit/ai";

// Get a typed model object from the registry
const model = getModel("gpt-4o")!;

const context: Context = {
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!", timestamp: Date.now() },
  ],
};

// Stream events as they arrive
const events = stream(model, context);

for await (const event of events) {
  if (event.type === "text") process.stdout.write(event.content);
}

// Or collect into a single result
const result = await collectStream(
  streamSimple(model, {
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is 2+2?", timestamp: Date.now() },
    ],
  }),
  model,
);
console.log(result.text); // "4"
console.log(result.usage); // { inputTokens: 20, outputTokens: 5 }
console.log(result.cost); // { input: 0.00005, output: 0.00005, total: 0.0001 }
```

## Architecture: Model-Context-Options

All streaming functions follow a 3-argument pattern:

```typescript
function stream<TApi extends Api>(
  model: Model<TApi>, // typed model object from the registry
  context: Context, // { messages, tools? }
  options?: StreamOptions, // transport-level: temperature, maxTokens, signal, etc.
): AssistantMessageEventStream;
```

- **Model** — carries API type, provider, base URL, pricing, and compat overrides. The provider is resolved from `model.api`.
- **Context** — content-level: `{ messages: Message[]; tools?: ToolDefinition[] }`. Separates what is being asked from how it is transported.
- **StreamOptions** — transport-level control: `temperature`, `maxTokens`, `topP`, `stopSequences`, `signal`, `apiKey`, `transport`, `cacheRetention`, `sessionId`, `onPayload`, `onResponse`, `headers`, `timeoutMs`, `maxRetries`, `maxRetryDelayMs`, `metadata`.

## Tool Calling

```typescript
import { getModel, streamSimple, collectStream, type Context } from "@agents-kit/ai";

const model = getModel("gpt-4o")!;

const context: Context = {
  messages: [{ role: "user", content: "What's the weather in Tokyo?", timestamp: Date.now() }],
  tools: [
    {
      name: "get_weather",
      description: "Get the current weather in a city",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
        },
        required: ["city"],
      },
    },
  ],
};

const result = await collectStream(streamSimple(model, context), model);

if (result.stopReason === "tool_use") {
  const call = result.toolCalls[0];
  console.log(call.name); // "get_weather"
  console.log(call.arguments); // '{"city":"Tokyo"}'
}
```

### Typed Tool Definitions

Use the `tool()` helper with TypeBox schemas for end-to-end type safety:

```typescript
import { Type, Static, tool } from "@agents-kit/ai";

const GetWeatherParams = Type.Object({
  city: Type.String({ description: "City name" }),
  unit: Type.Optional(Type.Union([Type.Literal("celsius"), Type.Literal("fahrenheit")])),
});

const getWeather = tool({
  name: "get_weather",
  description: "Get the current weather in a city",
  parameters: GetWeatherParams,
});

type WeatherArgs = Static<typeof getWeather.parameters>;
// { city: string; unit?: "celsius" | "fahrenheit" }
```

### Streaming Parsed Tool Calls

For real-time UI updates or early validation, use `withParsedToolCalls` to get partial JSON parsing:

```typescript
import { getModel, stream, withParsedToolCalls, type Context } from "@agents-kit/ai";

const model = getModel("gpt-4o")!;

const context: Context = {
  messages: [{ role: "user", content: "What's the weather in Tokyo?", timestamp: Date.now() }],
  tools: [getWeather],
};

const events = stream(model, context);

const parsedStream = withParsedToolCalls(events);

for await (const event of parsedStream) {
  if (event.type === "tool_call_parsed") {
    console.log(`Tool: ${event.name}`);
    console.log(`Arguments:`, event.arguments);
    console.log(`Complete: ${event.isComplete}`);
  }
}
```

## Conversation & Model Hand-off

```typescript
import { getModel, Conversation, stream } from "@agents-kit/ai";

const gpt4o = getModel("gpt-4o")!;
const gpt4oMini = getModel("gpt-4o-mini")!;

const conv = new Conversation();
conv.addSystemMessage("You are a helpful assistant.");
conv.addUserMessage("Explain quantum computing briefly.");

// First turn with gpt-4o
const events1 = stream(gpt4o, conv.toContext());
await conv.addAssistantResponse(events1, gpt4o);

// Second turn, hand off to a cheaper model
conv.addUserMessage("Summarize that in one sentence.");
const events2 = stream(gpt4oMini, conv.toContext());
await conv.addAssistantResponse(events2, gpt4oMini);

// Track accumulated usage and cost
console.log(conv.totalUsage);
console.log(conv.getTotalCost(gpt4o));

// Add tool results
conv.addToolResult("call_123", "get_weather", [{ type: "text", text: "Sunny, 22°C" }]);

// Persist conversation
const json = conv.toJSON();
const restored = Conversation.fromJSON(json);
```

## Model Discovery

```typescript
import { listModels, getModel, getModelsByProvider } from "@agents-kit/ai";

// All models
const models = listModels();
// [{ id: "gpt-4o", name: "GPT-4o", provider: "azure-openai", contextWindow: 128000, ... }, ...]

// Look up a specific model (returns undefined if not found)
const gpt4o = getModel("gpt-4o");

// Filter by provider
const azureModels = getModelsByProvider("azure-openai");
```

## Providers

### Azure OpenAI

Configure via environment variables:

```bash
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_API_VERSION=2024-12-01-preview  # optional, defaults to 2024-12-01-preview
```

The model name in `getModel()` maps to your Azure deployment name. Create deployments named `gpt-4o`, `gpt-4o-mini`, etc. to match the model registry.

#### Supported Models

| Model        | Context Window | Max Output | Vision | Thinking | Price (in/out per 1M tokens) |
| ------------ | -------------- | ---------- | ------ | -------- | ---------------------------- |
| gpt-4.1      | 1,047,576      | 32,768     | Yes    | No       | $2.00 / $8.00                |
| gpt-4.1-mini | 1,047,576      | 32,768     | Yes    | No       | $0.40 / $1.60                |
| gpt-4.1-nano | 1,047,576      | 32,768     | Yes    | No       | $0.10 / $0.40                |
| gpt-4o       | 128,000        | 16,384     | Yes    | No       | $2.50 / $10.00               |
| gpt-4o-mini  | 128,000        | 16,384     | Yes    | No       | $0.15 / $0.60                |
| o1           | 200,000        | 100,000    | Yes    | Yes      | $15.00 / $60.00              |
| o1-mini      | 128,000        | 65,536     | No     | Yes      | $3.00 / $12.00               |
| o3-mini      | 200,000        | 100,000    | Yes    | Yes      | $1.10 / $4.40                |

#### Direct Import

```typescript
import { streamAzureOpenAI } from "@agents-kit/ai/azure-openai";
```

## Stream Events

The `stream()` function returns an `AsyncGenerator<StreamEvent>` where `StreamEvent` is one of:

| Event              | Fields                                            | Description                                                                              |
| ------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `text`             | `content`                                         | Text delta                                                                               |
| `tool_call`        | `index`, `id?`, `name?`, `arguments`              | Tool call delta (id/name on first delta, then argument fragments)                        |
| `tool_call_parsed` | `index`, `id`, `name`, `arguments`, `isComplete`  | Partially parsed tool call arguments                                                     |
| `thinking`         | `content`                                         | Reasoning content (o1/o3 models)                                                         |
| `usage`            | `input`, `output`, `cacheCreation?`, `cacheRead?` | Token usage                                                                              |
| `stop`             | `reason`                                          | Stream ended (`end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `error`, `unknown`) |

## API Reference

### `stream(model, context, options?): AssistantMessageEventStream`

Start a streaming completion. Provider auto-detected from the model's API type.

### `collectStream(eventStream, model?): Promise<StreamResult>`

Consume a stream into a single result with text, tool calls, usage, and optional cost.

### `streamSimple(model, context, options?): AssistantMessageEventStream`

Stream a simple completion. Same signature as `stream()`.

### `withParsedToolCalls(eventStream): AssistantMessageEventStream`

Wrap an event stream to emit `tool_call_parsed` events with partial JSON parsing.

### `Conversation`

Manages message history, tracks usage, supports serialization and model hand-off. Use `toContext()` to get a `Context` object for passing to `stream()`.

### `tool(def): TypedToolDefinition`

Define a tool with a TypeBox schema for type-safe parameters.

### `calculateCost(usage, model): Cost`

Calculate cost from token usage and model pricing.

### `getModel(id): Model | undefined`

Look up a model by ID.

### `listModels(): Model[]`

List all registered models.

### `getModelsByProvider(provider): Model[]`

List models filtered by provider name.

### `registerProvider(api, provider): void`

Register a provider implementation for an API type.

### `listApis(): string[]`

List registered API types.
