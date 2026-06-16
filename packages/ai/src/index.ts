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
  Tool,
  ToolCall,
  StopReason,
  AssistantMessageEvent,
  Model,
  Api,
  Provider,
  knownProvider,
  ThinkingLevelMap,
  ReasoningEffort,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  AnthropicMessagesCompat,
  Transport,
  CacheRetention,
  ProviderResponse,
  Context,
  AzureOpenAIStreamOptions,
  AzureOpenAIResponsesStreamOptions,
  OpenAIStreamOptions,
  AnthropicStreamOptions,
  ApiOptionsMap,
  StreamOptions,
  ProviderStreamOptions,
  StreamFunction,
  SimpleStreamOptions,
  Usage,
  StreamResult,
  ToolDefinition,
} from "./types.js";

// Content type guards
export { isTextContent, isImageContent, isToolCall } from "./types.js";

// Error
export { AIError } from "./utils/error.js";

// Event stream
export {
  EventStream,
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "./utils/event-stream.js";

// Model discovery
export { getModel, listModels, getModelsByProvider } from "./models.generated.js";

// API provider registry
export {
  registerApiProvider,
  getApiProvider,
  getApiProviders,
  unregisterApiProviders,
  clearApiProviders,
} from "./api-registry.js";
export type { ApiStreamFunction, ApiStreamSimpleFunction, ApiProvider } from "./api-registry.js";

// Cost calculation
export { calculateCost } from "./utils/costs.js";

// Stream functions
export { stream, collectStream, streamSimple, complete, completeSimple } from "./stream.js";

// Tool builder
export { tool } from "./tool.js";

// TypeBox re-exports for typed tool definitions
export { Type } from "@sinclair/typebox";
export type { Static, TSchema } from "@sinclair/typebox";

// Context persistence
export { Conversation } from "./context.js";
export type { ConversationJSON } from "./context.js";
