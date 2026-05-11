// Core types
export type {
  TextContent,
  ImageContent,
  ThinkingContent,
  ContentPart,
  AssistantMessageDiagnostic,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
  ToolDefinition,
  ToolCall,
  TextEvent,
  ToolCallDeltaEvent,
  ToolCallParsedEvent,
  ThinkingEvent,
  UsageEvent,
  StopReason,
  StopEvent,
  StreamEvent,
  AssistantMessageEventStream,
  Model,
  Api,
  Provider,
  knownProvider,
  ThinkingLevelMap,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  AnthropicMessagesCompat,
  Transport,
  CacheRetention,
  ProviderResponse,
  Context,
  ProviderApi,
  AzureOpenAIStreamOptions,
  OpenAIStreamOptions,
  AnthropicStreamOptions,
  ApiOptionsMap,
  StreamOptions,
  ProviderStreamOptions,
  SimpleStreamOptions,
  Usage,
  Cost,
  StreamResult,
} from "./types.js";

// Error
export { AIError } from "./utils/error.js";

// Model discovery
export { getModel, listModels, getModelsByProvider } from "./models.generated.js";

// Provider registry
export { registerProvider, listApis } from "./provider-registry.js";

// Cost calculation
export { calculateCost } from "./utils/costs.js";

// Stream functions
export { stream, collectStream, streamSimple, withParsedToolCalls, complete, completeSimple } from "./stream.js";

// Tool builder
export { tool } from "./tool.js";
export type { TypedToolDefinition } from "./tool.js";

// TypeBox re-exports for typed tool definitions
export { Type } from "@sinclair/typebox";
export type { Static, TSchema } from "@sinclair/typebox";

// Context persistence
export { Conversation } from "./context.js";
export type { ConversationJSON } from "./context.js";
