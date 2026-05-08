// === Content Parts ===

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  /** base64 data URL or URL */
  image: string | URL;
  mimeType?: string;
}

export type ContentPart = TextPart | ImagePart;

// === Messages ===

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string | ContentPart[];
}

export interface AssistantMessage {
  role: "assistant";
  content?: string;
  toolCalls?: ToolCall[];
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

// === Tools ===

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema object */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments string */
  arguments: string;
}

// === Stream Events ===

export interface TextEvent {
  type: "text";
  content: string;
}

export interface ToolCallDeltaEvent {
  type: "tool_call";
  index: number;
  /** Present on the first delta for this tool call */
  id?: string;
  /** Present on the first delta for this tool call */
  name?: string;
  /** Fragment of the JSON arguments */
  arguments: string;
}

export interface ToolCallParsedEvent {
  type: "tool_call_parsed";
  index: number;
  /** Tool call ID */
  id: string;
  /** Tool name */
  name: string;
  /** Partially or fully parsed arguments object */
  arguments: Record<string, unknown>;
  /** Whether the arguments are complete */
  isComplete: boolean;
}

export interface ThinkingEvent {
  type: "thinking";
  content: string;
}

export interface UsageEvent {
  type: "usage";
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "error"
  | "unknown";

export interface StopEvent {
  type: "stop";
  reason: StopReason;
}

export type StreamEvent =
  | TextEvent
  | ToolCallDeltaEvent
  | ToolCallParsedEvent
  | ThinkingEvent
  | UsageEvent
  | StopEvent;

// === Event Stream ===

export type AssistantMessageEventStream = AsyncGenerator<StreamEvent>;

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

export type knownProvider = 
  | "azure-openai" 
  | "openai" 
  | "anthropic";

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
  variant?: "openai" | "azure" | "openrouter" | "together" | "deepinfra" | "groq" | "perplexity" | "custom";
  /** Custom headers to include in requests. */
  headers?: Record<string, string>;
}

/** Compatibility overrides for OpenAI Responses API. */
export interface OpenAIResponsesCompat {
  /** Override auto-detection of which variant is being used. */
  variant?: "openai" | "azure" | "openrouter" | "together" | "deepinfra" | "groq" | "perplexity" | "custom";
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
  tools?: ToolDefinition[];
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
  onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
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

/**
 * A provider implementation for a specific API.
 * Registered by API type and resolved via `resolveApiProvider(model.api)`.
 */
export interface ProviderApi {
  /** Stream a completion, yielding standardized events. */
  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: StreamOptions,
  ): AssistantMessageEventStream;

  /** Stream a simple completion (prompt-in, stream-out). */
  streamSimple<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: StreamOptions,
  ): AssistantMessageEventStream;
}

// === Provider-Specific Options ===

export interface AzureOpenAIStreamOptions extends StreamOptions {
  endpoint: string;
  apiVersion?: string;
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
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export interface Cost {
  input: number;
  output: number;
  total: number;
}

export interface StreamResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  cost?: Cost;
  stopReason: StopReason;
}
