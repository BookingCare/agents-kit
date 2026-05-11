# @agents-kit/ai

## [Unreleased]

### Breaking Changes

- `stream()` and `streamSimple()` now return `AssistantMessageEventStream` (push-based `EventStream`) instead of `AsyncGenerator<StreamEvent>`.
- `Tool<TSchema>` replaces `ToolDefinition`. `ToolDefinition` is now a deprecated alias.
- `AssistantMessageEvent` replaces flat `StreamEvent` union. Events are now structured with typed start/delta/end lifecycle (`text_start`, `text_delta`, `text_end`, `toolcall_start`, `toolcall_delta`, `toolcall_end`, etc.).
- Removed `TextEvent`, `ToolCallDeltaEvent`, `ToolCallParsedEvent`, `ThinkingEvent`, `UsageEvent`, `StopEvent`, `StreamEvent` types.
- Removed `withParsedToolCalls()` (was built on legacy `tool_call_parsed` events).
- Removed `TypedToolDefinition`; `tool()` now returns `Tool<TParams>` directly.
- `StopReason` now includes `stop`, `length`, `toolUse`, `aborted` (in addition to legacy values).
- `OpenAICompletionsCompat.variant` and `OpenAIResponsesCompat.variant` reduced to `"openai" | "azure" | "custom"`.

### Added

- `EventStream<T, R>` class: generic push-based async iterable with typed final result via `result()`.
- `AssistantMessageEventStream` class: extends `EventStream` with structured event protocol for assistant messages.
- `createAssistantMessageEventStream()` factory function.
- `AssistantMessageEvent` type: structured event protocol where every event carries a `partial` `AssistantMessage` for live state inspection.
- Content type guards: `isTextContent()`, `isImageContent()`, `isToolCall()`.

## [0.1.2] - 2026-05-11

### Breaking Changes

- `stream()` now takes `(Model, Context, StreamOptions?)` instead of a single options bag. Model ID strings replaced by typed `Model` objects; messages/tools moved to `Context`.
- `streamSimple()` now takes `(Model, Context, StreamOptions?)` and returns `AssistantMessageEventStream` instead of `Promise<StreamResult>`.
- `collectStream()` takes an optional `Model` object instead of a model ID string.
- `Conversation.addAssistantResponse()` takes an optional `Model` instead of model ID string.
- `Conversation.getTotalCost()` takes a `Model` instead of model ID string.
- `CompletionRequest` removed — decomposed into `(Model, Context, StreamOptions)`.
- `abortSignal` renamed to `signal` across all interfaces.
- Provider registry keyed by API type instead of provider name; `listProviders()` replaced by `listApis()`.
- Providers implement `ProviderApi` interface with `stream()` and `streamSimple()` methods.

### Added

- `Context` interface: `{ messages: Message[]; tools?: ToolDefinition[] }` — separates content from transport options.
- `ProviderApi` interface for provider implementations.
- `StreamOptions` extended with `topP`, `stopSequences`, `transport`, `cacheRetention`, `sessionId`, `onPayload`, `onResponse`, `headers`, `timeoutMs`, `maxRetries`, `maxRetryDelayMs`, `metadata`.
- `Transport`, `CacheRetention`, `ProviderResponse` types.
- `Conversation.toContext()` for building a `Context` from a conversation.
- `withParsedToolCalls()` wrapper for partial JSON parsing of tool call arguments.
- `ToolCallParsedEvent` type for streaming parsed tool call events.
- `src/utils/` directory for utility modules (`error.ts`, `costs.ts`, `env-api-keys.ts`).
