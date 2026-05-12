# @agents-kit/ai

Unified LLM API with automatic model discovery, provider configuration, token and cost tracking, and simple context persistence and hand-off to other models mid-session.

**Note:** This library only includes models that support tool calling (function calling), as this is essential for agentic workflows.

## Installation

```bash
pnpm add @agents-kit/ai
```

## Quick Start

```typescript
import { getModel, complete, stream, collectStream } from "@agents-kit/ai";
import type { Context } from "@agents-kit/ai";

const model = getModel("gpt-5.4-nano")!;

const context: Context = {
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!", timestamp: Date.now() },
  ],
};

// Option 1: Collect the full result at once
const result = await complete(model, context);
console.log(result.text);
console.log(result.usage); // { inputTokens: 20, outputTokens: 5 }
console.log(result.cost); // { input: 0.000004, output: 0.000006, total: 0.00001 }

// Option 2: Stream events as they arrive
const eventStream = stream(model, context);
for await (const event of eventStream) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}

// Option 3: Stream then collect
const result2 = await collectStream(stream(model, context), model);

// Option 4: Await the final message directly
const eventStream2 = stream(model, context);
const finalMessage = await eventStream2.result();
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

- **Model** — carries API type, provider, base URL, pricing, and compat overrides. The provider is resolved from `model.api` via the API registry.
- **Context** — content-level: `{ messages: Message[]; tools?: Tool[] }`. Separates what is being asked from how it is transported.
- **StreamOptions** — transport-level control: `temperature`, `maxTokens`, `topP`, `stopSequences`, `signal`, `apiKey`, `transport`, `cacheRetention`, `sessionId`, `onPayload`, `onResponse`, `headers`, `timeoutMs`, `maxRetries`, `maxRetryDelayMs`, `metadata`.

Providers implement `StreamFunction<TApi, TOptions>` — a typed function `(model, context, options?) => AssistantMessageEventStream` that encodes all errors into the stream.

## Streaming vs Collecting

There are two families of functions:

| Function                                   | Returns                       | Description                                  |
| ------------------------------------------ | ----------------------------- | -------------------------------------------- |
| `stream(model, context, options?)`         | `AssistantMessageEventStream` | Stream events in real time                   |
| `streamSimple(model, context, options?)`   | `AssistantMessageEventStream` | Stream a simple completion                   |
| `complete(model, context, options?)`       | `Promise<StreamResult>`       | Collect full result (wraps `stream`)         |
| `completeSimple(model, context, options?)` | `Promise<StreamResult>`       | Collect simple result (wraps `streamSimple`) |
| `collectStream(eventStream, model?)`       | `Promise<StreamResult>`       | Consume any stream into a result             |

`complete` and `completeSimple` are convenience wrappers that combine streaming and collection in a single call.

## Event Stream

The `stream()` function returns an `AssistantMessageEventStream` — a push-based async iterable that emits structured `AssistantMessageEvent` events. Every event carries a `partial` field with the current state of the `AssistantMessage` being built, enabling live state inspection.

### Event Protocol

Streams emit `start` before partial updates, then terminate with either `done` (success) or `error`:

| Event            | Fields                                | Description                                     |
| ---------------- | ------------------------------------- | ----------------------------------------------- |
| `start`          | `partial`                             | Stream started, first partial message           |
| `text_start`     | `contentIndex`, `partial`             | Text content block started                      |
| `text_delta`     | `contentIndex`, `delta`, `partial`    | Text fragment                                   |
| `text_end`       | `contentIndex`, `content`, `partial`  | Text content block completed                    |
| `thinking_start` | `contentIndex`, `partial`             | Thinking block started                          |
| `thinking_delta` | `contentIndex`, `delta`, `partial`    | Thinking fragment                               |
| `thinking_end`   | `contentIndex`, `content`, `partial`  | Thinking block completed                        |
| `toolcall_start` | `contentIndex`, `partial`             | Tool call started                               |
| `toolcall_delta` | `contentIndex`, `delta`, `partial`    | Tool call argument fragment                     |
| `toolcall_end`   | `contentIndex`, `toolCall`, `partial` | Tool call completed with full `ToolCall` object |
| `done`           | `reason`, `message`                   | Stream completed successfully                   |
| `error`          | `reason`, `error`                     | Stream ended with error                         |

### EventStream API

The `AssistantMessageEventStream` extends the generic `EventStream<T, R>` class:

```typescript
const eventStream = stream(model, context);

// Iterate events as they arrive
for await (const event of eventStream) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}

// Or await the final AssistantMessage directly
const message = await eventStream.result();
```

## Tool Calling

```typescript
import { getModel, complete, type Context } from "@agents-kit/ai";

const model = getModel("gpt-5.4-nano")!;

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

const result = await complete(model, context);

if (result.stopReason === "toolUse") {
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

## Conversation & Model Hand-off

```typescript
import { getModel, Conversation, stream } from "@agents-kit/ai";

const model = getModel("gpt-5.4-nano")!;

const conv = new Conversation();
conv.addSystemMessage("You are a helpful assistant.");
conv.addUserMessage("Explain quantum computing briefly.");

// First turn
const events1 = stream(model, conv.toContext());
await conv.addAssistantResponse(events1, model);

// Second turn
conv.addUserMessage("Summarize that in one sentence.");
const events2 = stream(model, conv.toContext());
await conv.addAssistantResponse(events2, model);

// Track accumulated usage and cost
console.log(conv.totalUsage);
console.log(conv.getTotalCost(model));

// Add tool results
conv.addToolResult("call_123", "get_weather", [{ type: "text", text: "Sunny, 22\u00B0C" }]);

// Persist conversation
const json = conv.toJSON();
const restored = Conversation.fromJSON(json);
```

## Model Discovery

```typescript
import { listModels, getModel, getModelsByProvider } from "@agents-kit/ai";

// All models
const models = listModels();

// Look up a specific model (returns undefined if not found)
const model = getModel("gpt-5.4-nano");

// Filter by provider
const azureModels = getModelsByProvider("azure-openai");
```

## Providers

Providers implement the `ApiProvider<TApi, TOptions>` interface and register via `registerApiProvider()`. Each provider declares:

- `api` — the API type string (e.g. `"azure-openai-completions"`)
- `stream` — a `StreamFunction<TApi, TOptions>` for streaming completions
- `streamSimple` — a `StreamFunction<TApi, SimpleStreamOptions>` for simple completions

The `StreamFunction` contract guarantees that all errors are encoded into the returned stream (never thrown), with `stopReason: "error" | "aborted"` and an `errorMessage`.

### Azure OpenAI

Configure via environment variables:

```bash
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_API_VERSION=2024-12-01-preview  # optional, defaults to 2024-12-01-preview
```

The model name in `getModel()` maps to your Azure deployment name. Create deployments named `gpt-5.4-nano`, etc. to match the model registry.

#### Supported Models

| Model        | Context Window | Max Output | Vision | Reasoning | Price (in/out per 1M tokens) |
| ------------ | -------------- | ---------- | ------ | --------- | ---------------------------- |
| gpt-5.4-nano | 400,000        | 128,000    | Yes    | No        | $0.20 / $1.25                |

## Content Type Guards

Utility functions for narrowing content types:

```typescript
import { isTextContent, isImageContent, isToolCall } from "@agents-kit/ai";

// Check content parts
if (isTextContent(part)) {
  console.log(part.text);
}

// Check tool calls
if (isToolCall(someValue)) {
  console.log(someValue.name, someValue.arguments);
}
```

## API Reference

### `stream(model, context, options?): AssistantMessageEventStream`

Start a streaming completion. Provider auto-detected from the model's API type.

### `streamSimple(model, context, options?): AssistantMessageEventStream`

Stream a simple completion. Same signature as `stream()`.

### `complete(model, context, options?): Promise<StreamResult>`

Generate a completion, collecting the full result. Convenience wrapper around `stream` + `collectStream`.

### `completeSimple(model, context, options?): Promise<StreamResult>`

Generate a simple completion, collecting the full result. Convenience wrapper around `streamSimple` + `collectStream`.

### `collectStream(eventStream, model?): Promise<StreamResult>`

Consume a stream into a single result with text, tool calls, usage, and optional cost. Cost is calculated only when a `model` is provided.

### `Conversation`

Manages message history, tracks usage, supports serialization and model hand-off. Use `toContext(tools?)` to get a `Context` object for passing to `stream()`.

### `tool(def): Tool<TParams>`

Define a tool with a TypeBox schema for type-safe parameters.

### `calculateCost(usage, model): Cost`

Calculate cost from token usage and model pricing.

### `getModel(id): Model | undefined`

Look up a model by ID.

### `listModels(): Model[]`

List all registered models.

### `getModelsByProvider(provider): Model[]`

List models filtered by provider name.

### `registerApiProvider(provider, sourceId?): void`

Register a typed API provider. `provider` must be an `ApiProvider<TApi, TOptions>` with `api`, `stream`, and `streamSimple` fields. Optional `sourceId` enables batch removal via `unregisterApiProviders()`.

### `getApiProvider(api): ApiProviderInternal | undefined`

Look up a registered provider by API type.

### `getApiProviders(): ApiProviderInternal[]`

List all registered API providers.

### `unregisterApiProviders(sourceId): void`

Remove all providers registered with the given `sourceId`.

### `clearApiProviders(): void`

Remove all registered providers.

### `isTextContent(content): boolean`

Type guard for `TextContent`.

### `isImageContent(content): boolean`

Type guard for `ImageContent`.

### `isToolCall(value): boolean`

Type guard for `ToolCall`.

### `EventStream<T, R>`

Generic push-based async iterable with a typed final result. Call `push()` to emit events, `end()` to close, and `result()` to await the final value.

### `AssistantMessageEventStream`

Extends `EventStream<AssistantMessageEvent, AssistantMessage>`. The standard return type for all streaming functions.

### `createAssistantMessageEventStream(): AssistantMessageEventStream`

Factory function to create a new event stream instance.
