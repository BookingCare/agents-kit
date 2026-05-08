// Core types
export type {
  TextPart,
  ImagePart,
  ContentPart,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
  ToolDefinition,
  ToolCall,
  TextEvent,
  ToolCallDeltaEvent,
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
  AzureOpenAIStreamOptions,
  OpenAIStreamOptions,
  AnthropicStreamOptions,
  ApiOptionsMap,
  StreamOptions,
  SimpleStreamOptions,
  Usage,
  Cost,
  StreamResult,
} from "./types.js";

// Error
export { AIError } from "./error.js";

// Model discovery
export { getModel, listModels, getModelsByProvider } from "./models.generated.js";

// Provider registry
export { registerProvider, listProviders } from "./provider-registry.js";

// Cost calculation
export { calculateCost } from "./costs.js";

// Stream functions
export { stream, collectStream, streamSimple } from "./stream.js";

// Tool builder
export { tool } from "./tool.js";
export type { TypedToolDefinition } from "./tool.js";

// TypeBox re-exports for typed tool definitions
export { Type } from "@sinclair/typebox";
export type { Static, TSchema } from "@sinclair/typebox";

// Context persistence
export { Conversation } from "./context.js";
export type { ConversationJSON } from "./context.js";
