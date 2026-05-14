// === Content Parts ===

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  /** base64 data URL or URL */
  image: string | URL;
  mimeType?: string;
}

export interface ThinkingContent {
  type: "thinking";
  text: string;
}

export type ContentPart = TextContent | ImageContent;

// === Content Type Guards ===

export function isTextContent(content: ContentPart): content is TextContent {
  return content.type === "text";
}

export function isImageContent(content: ContentPart): content is ImageContent {
  return content.type === "image";
}

export function isToolCall(content: unknown): content is ToolCall {
  return (
    typeof content === "object" &&
    content !== null &&
    "id" in content &&
    "name" in content &&
    "arguments" in content
  );
}

// === Diagnostics ===

export interface AssistantMessageDiagnostic {
  type: string;
  message: string;
  details?: Record<string, unknown>;
}

// === Messages ===

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;
  responseModel?: string;
  responseId?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

// === Tools ===

import type { TSchema } from "@sinclair/typebox";
import { AssistantMessageEventStream } from "./index.js";

export interface Tool<TParams extends TSchema = TSchema> {
  name: string;
  description?: string;
  parameters: TParams;
}

/** @deprecated Use `Tool` instead */
export type ToolDefinition = Tool;

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments string */
  arguments: string;
}

// === Stop Reason ===

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "error"
  | "unknown"
  | "stop"
  | "length"
  | "toolUse"
  | "aborted";

/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Streams should emit `start` before partial updates, then terminate with either:
 * - `done` carrying the final successful AssistantMessage, or
 * - `error` carrying the final AssistantMessage with stopReason "error" or "aborted"
 *   and errorMessage.
 */
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      message: AssistantMessage;
    }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

// === Model ===

export interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  /**
   * Maps pi thinking levels to provider/model-specific values.
   * Missing keys use provider defaults. null marks a level as unsupported.
   */
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: {
    input: number; // $/million tokens
    output: number; // $/million tokens
    cacheRead: number; // $/million tokens
    cacheWrite: number; // $/million tokens
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  /** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
  compat?: TApi extends "openai-completions"
    ? OpenAICompletionsCompat
    : TApi extends "openai-responses"
      ? OpenAIResponsesCompat
      : TApi extends "anthropic-messages"
        ? AnthropicMessagesCompat
        : never;
}

// === API Types ===
export type KnownApi =
  | "azure-openai-responses"
  | "azure-openai-completions"
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

export type Api = KnownApi | (string & {});

// === Provider ===

export type Provider = string;

export type knownProvider = "azure-openai" | "openai" | "anthropic";

// === Thinking Level Map ===

/**
 * Maps pi thinking levels to provider/model-specific values.
 * Missing keys use provider defaults. null marks a level as unsupported.
 */
export interface ThinkingLevelMap {
  none?: number | null;
  short?: number | null;
  medium?: number | null;
  long?: number | null;
}

// === Compatibility Overrides ===

/** Compatibility overrides for OpenAI-compatible APIs. */
export interface OpenAICompletionsCompat {
  /** Override auto-detection of which variant is being used. */
  variant?: "openai" | "azure" | "custom";
  /** Custom headers to include in requests. */
  headers?: Record<string, string>;
}

/** Compatibility overrides for OpenAI Responses API. */
export interface OpenAIResponsesCompat {
  /** Override auto-detection of which variant is being used. */
  variant?: "openai" | "azure" | "custom";
  /** Custom headers to include in requests. */
  headers?: Record<string, string>;
}

/** Compatibility overrides for Anthropic Messages API. */
export interface AnthropicMessagesCompat {
  /** Custom headers to include in requests. */
  headers?: Record<string, string>;
}

// === Transport & Request Types ===

/** Preferred transport for providers that support multiple transports. */
export type Transport = "sse" | "websocket" | (string & {});

/** Prompt cache retention preference. Providers map this to their supported values. */
export type CacheRetention = "short" | "medium" | "long";

/** HTTP response metadata passed to onResponse callbacks. */
export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  url: string;
}

/** Conversation context: messages and available tools. */
export interface Context {
  messages: Message[];
  tools?: Tool[];
}

/** Base stream options — transport-level and request control. */
export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stopSequences?: string[];
  signal?: AbortSignal;
  apiKey?: string;
  /**
   * Preferred transport for providers that support multiple transports.
   * Providers that do not support this option ignore it.
   */
  transport?: Transport;
  /**
   * Prompt cache retention preference. Providers map this to their supported values.
   * Default: "short".
   */
  cacheRetention?: CacheRetention;
  /**
   * Optional session identifier for providers that support session-based caching.
   * Providers can use this to enable prompt caching, request routing, or other
   * session-aware features. Ignored by providers that don't support it.
   */
  sessionId?: string;
  /**
   * Optional callback for inspecting or replacing provider payloads before sending.
   * Return undefined to keep the payload unchanged.
   */
  onPayload?: (
    payload: unknown,
    model: Model<Api>,
  ) => unknown | undefined | Promise<unknown | undefined>;
  /**
   * Optional callback invoked after an HTTP response is received and before
   * its body stream is consumed.
   */
  onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
  /**
   * Optional custom HTTP headers to include in API requests.
   * Merged with provider defaults; can override default headers.
   * Not supported by all providers (e.g., AWS Bedrock uses SDK auth).
   */
  headers?: Record<string, string>;
  /**
   * HTTP request timeout in milliseconds for providers/SDKs that support it.
   * For example, OpenAI and Anthropic SDK clients default to 10 minutes.
   */
  timeoutMs?: number;
  /**
   * Maximum retry attempts for providers/SDKs that support client-side retries.
   * For example, OpenAI and Anthropic SDK clients default to 2.
   */
  maxRetries?: number;
  /**
   * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
   * If the server's requested delay exceeds this value, the request fails immediately
   * with an error containing the requested delay, allowing higher-level retry logic
   * to handle it with user visibility.
   * Default: 60000 (60 seconds). Set to 0 to disable the cap.
   */
  maxRetryDelayMs?: number;
  /**
   * Optional metadata to include in API requests.
   * Providers extract the fields they understand and ignore the rest.
   * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
   */
  metadata?: Record<string, unknown>;
}

/** Provider-extensible stream options. */
export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

// Generic StreamFunction with typed options.
//
// Contract:
// - Must return an AssistantMessageEventStream.
// - Once invoked, request/model/runtime failures should be encoded in the
//   returned stream, not thrown.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
export type StreamFunction<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions,
> = (model: Model<TApi>, context: Context, options?: TOptions) => AssistantMessageEventStream;

// === Provider-Specific Options ===

export interface AzureOpenAIStreamOptions extends StreamOptions {
  azureEndpoint?: string;
  azureApiVersion?: string;
}

export interface OpenAIStreamOptions extends StreamOptions {
  baseUrl: string;
}

export interface AnthropicStreamOptions extends StreamOptions {
  baseUrl: string;
}

export interface ApiOptionsMap {
  "azure-openai-completions": AzureOpenAIStreamOptions;
  "openai-completions": OpenAIStreamOptions;
  "openai-responses": OpenAIStreamOptions;
  "anthropic-messages": AnthropicStreamOptions;
}

// === Convenience Options ===

/** Options for the simple prompt-in stream-out API. */
export interface SimpleStreamOptions extends StreamOptions {}

// === Stream Result ===

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface StreamResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: StopReason;
}
