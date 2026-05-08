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

export type Api =
  | "azure-openai-completions"
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

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

export interface AzureOpenAIStreamOptions extends StreamOptions {
  endpoint: string;
  apiKey: string;
  apiVersion?: string;
}

export interface OpenAIStreamOptions extends StreamOptions {
  baseUrl: string;
  apiKey: string;
}

export interface AnthropicStreamOptions extends StreamOptions {
  baseUrl: string;
  apiKey: string;
}

export interface ApiOptionsMap {
  "azure-openai-completions": AzureOpenAIStreamOptions;
  "openai-completions": OpenAIStreamOptions;
  "openai-responses": OpenAIStreamOptions;
  "anthropic-messages": AnthropicStreamOptions;
}

// === Stream Options ===

export interface StreamOptions {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stopSequences?: string[];
  abortSignal?: AbortSignal;
}

export interface SimpleStreamOptions {
  model: string;
  prompt: string;
  system?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

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
