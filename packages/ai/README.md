# @repo/ai

Unified LLM API with automatic model discovery, provider configuration, token and cost tracking, and simple context persistence and hand-off to other models mid-session.

**Note:** This library only includes models that support tool calling (function calling), as this is essential for agentic workflows.

## Installation

```bash
pnpm add @repo/ai
```

## Quick Start

```typescript
import { stream, collectStream, streamSimple } from "@repo/ai";

// Stream events as they arrive
const events = stream({
  model: "gpt-4o",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" },
  ],
});

for await (const event of events) {
  if (event.type === "text") process.stdout.write(event.content);
}

// Or collect into a single result
const result = await streamSimple({
  model: "gpt-4o",
  system: "You are a helpful assistant.",
  prompt: "What is 2+2?",
});
console.log(result.text);    // "4"
console.log(result.usage);   // { inputTokens: 20, outputTokens: 5 }
console.log(result.cost);    // { input: 0.00005, output: 0.00005, total: 0.0001 }
```

## Tool Calling

```typescript
const result = await streamSimple({
  model: "gpt-4o",
  prompt: "What's the weather in Tokyo?",
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
});

if (result.stopReason === "tool_use") {
  const call = result.toolCalls[0];
  console.log(call.name);      // "get_weather"
  console.log(call.arguments); // '{"city":"Tokyo"}'
}
```

### Streaming Parsed Tool Calls

For real-time UI updates or early validation, use `withParsedToolCalls` to get partial JSON parsing:

```typescript
import { stream, withParsedToolCalls } from "@repo/ai";

const events = stream({
  model: "gpt-4o",
  messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
  tools: [
    {
      name: "get_weather",
      description: "Get the current weather in a city",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          units: { type: "string", enum: ["celsius", "fahrenheit"] },
        },
        required: ["city"],
      },
    },
  ],
});

const parsedStream = withParsedToolCalls(events);

for await (const event of parsedStream) {
  if (event.type === "tool_call_parsed") {
    // Tool call arguments are parsed as they stream
    console.log(`Tool: ${event.name}`);
    console.log(`Arguments:`, event.arguments);
    console.log(`Complete: ${event.isComplete}`);
    
    // Example output:
    // Tool: get_weather
    // Arguments: { city: "Tokyo" }
    // Complete: false  (partial) -> true  (complete)
  }
}
```

## Conversation & Model Hand-off

```typescript
import { Conversation, stream } from "@repo/ai";

const conv = new Conversation();
conv.addSystemMessage("You are a helpful assistant.");
conv.addUserMessage("Explain quantum computing briefly.");

// First turn with gpt-4o
const events1 = stream({ model: "gpt-4o", messages: conv.getMessages() });
await conv.addAssistantResponse(events1, "gpt-4o");

// Second turn, hand off to a cheaper model
conv.addUserMessage("Summarize that in one sentence.");
const events2 = stream({ model: "gpt-4o-mini", messages: conv.getMessages() });
await conv.addAssistantResponse(events2, "gpt-4o-mini");

// Track accumulated usage and cost
console.log(conv.totalUsage);
console.log(conv.getTotalCost("gpt-4o")); // approximate blended cost

// Persist conversation
const json = conv.toJSON();
// ... save to disk, database, etc.
const restored = Conversation.fromJSON(json);
```

## Model Discovery

```typescript
import { listModels, getModel, getModelsByProvider } from "@repo/ai";

// All models
const models = listModels();
// [{ id: "gpt-4o", name: "GPT-4o", provider: "azure-openai", contextWindow: 128000, ... }, ...]

// Look up a specific model
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

The model name in `stream()` maps to your Azure deployment name. Create deployments named `gpt-4o`, `gpt-4o-mini`, etc. to match the model registry.

#### Supported Models

| Model | Context Window | Max Output | Vision | Thinking | Price (in/out per 1M tokens) |
|-------|---------------|------------|--------|----------|------------------------------|
| gpt-4.1 | 1,047,576 | 32,768 | Yes | No | $2.00 / $8.00 |
| gpt-4.1-mini | 1,047,576 | 32,768 | Yes | No | $0.40 / $1.60 |
| gpt-4.1-nano | 1,047,576 | 32,768 | Yes | No | $0.10 / $0.40 |
| gpt-4o | 128,000 | 16,384 | Yes | No | $2.50 / $10.00 |
| gpt-4o-mini | 128,000 | 16,384 | Yes | No | $0.15 / $0.60 |
| o1 | 200,000 | 100,000 | Yes | Yes | $15.00 / $60.00 |
| o1-mini | 128,000 | 65,536 | No | Yes | $3.00 / $12.00 |
| o3-mini | 200,000 | 100,000 | Yes | Yes | $1.10 / $4.40 |

#### Direct Import

```typescript
import { streamAzureOpenAI } from "@repo/ai/providers/azure-openai";
```

## Stream Events

The `stream()` function returns an `AsyncGenerator<StreamEvent>` where `StreamEvent` is one of:

| Event | Fields | Description |
|-------|--------|-------------|
| `text` | `content` | Text delta |
| `tool_call` | `index`, `id?`, `name?`, `arguments` | Tool call delta (id/name on first delta, then argument fragments) |
| `thinking` | `content` | Reasoning content (o1/o3 models) |
| `usage` | `input`, `output`, `cacheCreation?`, `cacheRead?` | Token usage |
| `stop` | `reason` | Stream ended (`end_turn`, `tool_use`, `max_tokens`, `stop_sequence`) |

## API Reference

### `stream(options: StreamOptions): AssistantMessageEventStream`

Start a streaming completion. Provider auto-detected from model name.

### `collectStream(eventStream, modelId?): Promise<StreamResult>`

Consume a stream into a single result with text, tool calls, usage, and optional cost.

### `streamSimple(options: SimpleStreamOptions): Promise<StreamResult>`

Send a simple prompt and get a complete result.

### `Conversation`

Manages message history, tracks usage, supports serialization and model hand-off.

### `calculateCost(usage: Usage, model: Model): Cost`

Calculate cost from token usage and model pricing.

### `getModel(id: string): Model | undefined`

Look up a model by ID.

### `listModels(): Model[]`

List all registered models.

### `listProviders(): string[]`

List available provider names.
