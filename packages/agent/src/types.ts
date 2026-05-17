import type {
  Api,
  AssistantMessageEventStream,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  Static,
  StreamResult,
  TSchema,
  Tool,
  ToolCall,
  Transport,
} from "@bookingcare/ai";
import type { SkillLoader } from "./skill-loader.js";
import type { TodoManager } from "./todo-manager.js";
import type { ContextManager } from "./context-manager.js";

// --- Context management ---

export interface ContextStrategy {
  name: string;
  apply(messages: AgentMessage[], budget: number, tokenCounter: TokenCounter): AgentMessage[];
}

export interface TokenCounter {
  count(messages: AgentMessage[]): number;
}

export interface ContextTrimmedEvent {
  type: "context_trimmed";
  droppedMessages: number;
  remainingMessages: number;
  budget: number;
  tokenCountBefore: number;
  tokenCountAfter: number;
  strategyName: string;
}

// --- Agent loop ---

export interface AgentLoopOptions {
  model: Model<Api>;
  system?: string;
  tools?: Tool[];
  dispatch?: Record<string, ToolHandler>;
  workdir?: string;
  skillsDir?: string;
  maxTokens?: number;
  maxIterations?: number;
  onStreamResult?: (result: StreamResult, iteration: number) => void;
  signal?: AbortSignal;
}

// --- Tools ---

export type ToolHandler = (args: Record<string, unknown>) => string | Promise<string>;

export interface ToolDispatch {
  tools: Tool[];
  dispatch: Record<string, ToolHandler>;
  skillLoader?: SkillLoader;
  todoManager?: TodoManager;
}

// --- Streaming agent loop ---

export type StreamFn = (
  model: Model<Api>,
  context: { messages: Message[]; tools?: Tool[] },
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type ToolExecutionMode = "parallel" | "sequential";

/** Hook context and result types for before/after tool call hooks. */
export interface BeforeToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
}

export type BeforeToolCallResult =
  | { action: "continue" }
  | { action: "skip"; result?: string }
  | { action: "replace"; args: Record<string, unknown> };

export interface AfterToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
  result: string;
}

export type AfterToolCallResult = { action: "continue" } | { action: "replace"; result: string };

export interface PermissionScope {
  paths?: string[];
  commands?: string[];
}

export interface PermissionRule {
  tool: string;
  action: "allow" | "deny" | "ask";
  scope?: PermissionScope;
}

export interface PermissionDecision {
  action: "allow" | "deny" | "ask";
  rule: PermissionRule;
}

export type PermissionResolver = (decision: "allow" | "deny") => void;

export interface PermissionNeededEvent {
  type: "permission_needed";
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
  rule: PermissionRule;
  resolve: PermissionResolver;
}

export interface PermissionManagerOptions {
  rules?: PermissionRule[];
  workspaceRoot?: string;
}

export interface AgentLoopTurnUpdate {
  model?: Model<Api>;
  tools?: AgentTool[];
  systemPrompt?: string;
}

export type BreakpointStage =
  | "pre_stream"
  | "streaming"
  | "post_stream"
  | "pre_tool"
  | "tool_exec"
  | "post_tool"
  | "pre_followup"
  | "complete";

export type BreakpointCondition = (context: AgentContext) => boolean;

export interface BreakpointHit {
  stage: BreakpointStage;
  context: AgentContext;
  snapshot: AgentState;
}

export interface AgentLoopConfig {
  model: Model<Api>;
  maxTokens?: number;
  reasoning?: string;
  sessionId?: string;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  transport?: Transport;
  thinkingBudgets?: unknown;
  maxRetryDelayMs?: number;
  toolExecution: ToolExecutionMode;
  beforeStage?: (stage: BreakpointStage, context: AgentContext) => Promise<void> | void;
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  permissionManager?: {
    evaluate(toolName: string, args: Record<string, unknown>): PermissionDecision;
  };
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  prepareNextTurn?: (signal?: AbortSignal) => Promise<AgentLoopTurnUpdate | undefined>;
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  getSteeringMessages: () => Promise<AgentMessage[]>;
  getFollowUpMessages: () => Promise<AgentMessage[]>;
  contextManager?: ContextManager;
}

// --- Agent tool execution ---

/** Result returned by an AgentTool's execute method. */
export interface AgentToolResult {
  content: string;
  isError?: boolean;
}

/** Callback for streaming progress updates from a tool execution. */
export type AgentToolUpdateCallback = (update: string) => void;

/** Tool definition used by the agent runtime. */
export interface AgentTool<TParameters extends TSchema = TSchema> extends Tool<TParameters> {
  /** Human-readable label for UI display. */
  label: string;
  /**
   * Optional compatibility shim for raw tool-call arguments before schema validation.
   * Must return an object that matches `TParameters`.
   */
  prepareArguments?: (args: unknown) => Static<TParameters>;
  /** Execute the tool call. Throw on failure instead of encoding errors in `content`. */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ) => Promise<AgentToolResult>;
  /**
   * Per-tool execution mode override.
   * - "sequential": this tool must execute one at a time with other tool calls.
   * - "parallel": this tool can execute concurrently with other tool calls.
   *
   * If omitted, the default execution mode applies.
   */
  executionMode?: ToolExecutionMode;
}

// --- Agent class types ---

/** Agent messages are `Message` from `@bookingcare/ai`. Alias for semantic clarity. */
export type AgentMessage = Message;

/** Streaming partial of an AssistantMessage, used during text delta accumulation. */
export interface StreamingAssistantMessage {
  role: "assistant";
  content: string;
  timestamp: number;
}

export interface AgentState {
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: string;
  tools: AgentTool[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage?: StreamingAssistantMessage;
  pendingToolCalls: ReadonlySet<string>;
  errorMessage?: string;
}

export type AgentEvent =
  | { type: "message_start"; message: StreamingAssistantMessage }
  | { type: "message_update"; message: StreamingAssistantMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string }
  | { type: "tool_execution_end"; toolCallId: string }
  | { type: "turn_end"; message: AgentMessage; toolResults: AgentMessage[] }
  | { type: "agent_end"; messages: AgentMessage[] }
  | PermissionNeededEvent
  | ContextTrimmedEvent;

export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
}

export type QueueMode = "all" | "one-at-a-time";

// --- Skill loading ---

export interface SkillMeta {
  name: string;
  description: string;
  [key: string]: string;
}

export interface Skill {
  meta: SkillMeta;
  body: string;
}
