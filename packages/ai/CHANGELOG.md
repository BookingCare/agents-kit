# @bookingcare/ai

## [Unreleased]

## [0.3.0] - 2026-05-17

### Breaking Changes

- `ToolCall.arguments` type changed from `string` to `Record<string, any>`. Providers now receive and emit parsed argument objects instead of JSON-encoded strings.
- `ToolCall` now requires a `type: "toolCall"` discriminator field. All tool call objects must include this property.

### Added

- `Context.systemPrompt?: string` — optional system prompt that is automatically prepended as a system message when building provider request parameters.

### Changed

- `Usage` interface restructured: renamed fields (`inputTokens`→`input`, `outputTokens`→`output`), added `cacheRead`, `cacheWrite`, `totalTokens`, and embedded `cost` object
- Removed standalone `Cost` interface - cost is now accessed via `usage.cost`
- `StreamResult` no longer has a top-level `cost` field (use `result.usage.cost` instead)
- `calculateCost()` now returns `Usage["cost"]` type with cache cost fields

## [0.2.0] - 2026-05-13

### Breaking Changes

- `stream()` and `streamSimple()` now return `AssistantMessageEventStream` (push-based `EventStream`) instead of `AsyncGenerator<StreamEvent>`.
- `Tool<TSchema>` replaces `ToolDefinition`. `ToolDefinition` is now a deprecated alias.
- `AssistantMessageEvent` replaces flat `StreamEvent` union. Events are now structured with typed start/delta/end lifecycle (`text_start`, `text_delta`, `text_end`, `toolcall_start`, `toolcall_delta`, `toolcall_end`, etc.).
- Removed `TextEvent`, `ToolCallDeltaEvent`, `ToolCallParsedEvent`, `ThinkingEvent`, `UsageEvent`, `StopEvent`, `StreamEvent` types.
- Removed `withParsedToolCalls()` (was built on legacy `tool_call_parsed` events).
- Removed `TypedToolDefinition`; `tool()` now returns `Tool<TParams>` directly.
- `StopReason` now includes `stop`, `length`, `toolUse`, `aborted` (in addition to legacy values).
- `OpenAICompletionsCompat.variant` and `OpenAIResponsesCompat.variant` reduced to `"openai" | "azure" | "custom"`.
- Removed `ProviderApi` interface. Providers now implement `ApiProvider<TApi, TOptions>` and register via `registerApiProvider()`.
- Replaced `registerProvider(api, provider)` with `registerApiProvider(provider, sourceId?)`.
- Replaced `resolveApiProvider(api)` with `getApiProvider(api)`.
- Replaced `listApis()` with `getApiProviders()`.
- Renamed `provider-registry.ts` to `api-registry.ts`.
- `AzureOpenAIStreamOptions` fields renamed: `endpoint` -> `azureEndpoint`, `apiVersion` -> `azureApiVersion` (both now optional).

### Added

- `EventStream<T, R>` class: generic push-based async iterable with typed final result via `result()`.
- `AssistantMessageEventStream` class: extends `EventStream` with structured event protocol for assistant messages.
- `createAssistantMessageEventStream()` factory function.
- `AssistantMessageEvent` type: structured event protocol where every event carries a `partial` `AssistantMessage` for live state inspection.
- Content type guards: `isTextContent()`, `isImageContent()`, `isToolCall()`.
- `StreamFunction<TApi, TOptions>` type: typed contract for provider stream functions with error-in-stream guarantees.
- `ApiProvider<TApi, TOptions>` interface: providers declare their `api`, `stream`, and `streamSimple` with full type specificity.
- `ApiStreamFunction` and `ApiStreamSimpleFunction` types for the registry's internal storage.
- `getApiProviders()`: list all registered API providers.
- `unregisterApiProviders(sourceId)`: remove providers by source ID.
- `clearApiProviders()`: remove all registered providers.
- Runtime API mismatch guard: `wrapStream`/`wrapStreamSimple` validate `model.api` matches the registered API type.
- Azure OpenAI provider exports typed `streamAzureOpenAICompletions` and `streamSimpleAzureOpenAICompletions` as `StreamFunction` instances.

### Changed

- Azure OpenAI provider refactored from monolithic function to `StreamFunction` pattern with extracted `buildParams()` and `createClient()` helpers.
- Azure OpenAI provider exports a plain `{ api, stream, streamSimple }` object instead of a `ProviderApi`-typed object.

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
