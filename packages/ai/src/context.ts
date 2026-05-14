import type {
  ContentPart,
  Context,
  Message,
  Model,
  Api,
  StreamResult,
  Tool,
  ToolResultMessage,
  Usage,
  TextContent,
  ImageContent,
  ThinkingContent,
  ToolCall,
} from "./types.js";
import { collectStream } from "./stream.js";
import type { AssistantMessageEventStream } from "./utils/event-stream.js";
import { calculateCost } from "./utils/costs.js";

export interface ConversationJSON {
  messages: Message[];
  totalUsage: Usage;
}

const DEFAULT_MAX_MESSAGES = 1000;

/**
 * Manages a conversation's message history, usage tracking, and cost calculation.
 * Supports serialization for persistence and model hand-off mid-session.
 */
export class Conversation {
  private messages: Message[] = [];
  private _totalUsage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  private readonly maxMessages: number;

  constructor(maxMessages: number = DEFAULT_MAX_MESSAGES) {
    this.maxMessages = maxMessages;
  }

  private enforceMessageLimit(): void {
    if (this.messages.length > this.maxMessages) {
      const removeCount = this.messages.length - this.maxMessages;
      this.messages.splice(0, removeCount);
    }
  }

  /** Add a system message */
  addSystemMessage(content: string): void {
    this.messages.push({ role: "system", content });
    this.enforceMessageLimit();
  }

  /** Add a user message */
  addUserMessage(content: string | ContentPart[]): void {
    this.messages.push({ role: "user", content, timestamp: Date.now() });
    this.enforceMessageLimit();
  }

  /**
   * Add an assistant response from a stream.
   * Consumes the event stream and appends the resulting assistant message.
   * Returns the StreamResult for inspection.
   */
  async addAssistantResponse(
    eventStream: AssistantMessageEventStream,
    model?: Model<Api>,
  ): Promise<StreamResult> {
    const result = await collectStream(eventStream, model);

    const content: (TextContent | ThinkingContent | ToolCall)[] = [];
    if (result.text) {
      content.push({ type: "text", text: result.text });
    }
    content.push(...result.toolCalls);

    const assistantMsg: Message = {
      role: "assistant",
      content,
      api: model?.api ?? ("unknown" as Api),
      provider: model?.provider ?? "unknown",
      model: model?.id ?? "unknown",
      usage: result.usage,
      stopReason: result.stopReason,
      timestamp: Date.now(),
    };
    this.messages.push(assistantMsg);
    this.enforceMessageLimit();

    this._totalUsage.input += result.usage.input;
    this._totalUsage.output += result.usage.output;
    this._totalUsage.cacheRead += result.usage.cacheRead;
    this._totalUsage.cacheWrite += result.usage.cacheWrite;
    this._totalUsage.totalTokens += result.usage.totalTokens;

    // Update costs
    this._totalUsage.cost.input += result.usage.cost.input;
    this._totalUsage.cost.output += result.usage.cost.output;
    this._totalUsage.cost.cacheRead += result.usage.cost.cacheRead;
    this._totalUsage.cost.cacheWrite += result.usage.cost.cacheWrite;
    this._totalUsage.cost.total += result.usage.cost.total;

    return result;
  }

  /** Add a tool result message */
  addToolResult(
    toolCallId: string,
    toolName: string,
    content: (TextContent | ImageContent)[],
    options?: { isError?: boolean; details?: unknown },
  ): void {
    const msg: ToolResultMessage = {
      role: "toolResult",
      toolCallId,
      toolName,
      content,
      isError: options?.isError ?? false,
      timestamp: Date.now(),
      ...(options?.details !== undefined && { details: options.details }),
    };
    this.messages.push(msg);
    this.enforceMessageLimit();
  }

  /** Get all messages (copy) */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** Get as a Context object for passing to stream/streamSimple. */
  toContext(tools?: Tool[]): Context {
    return { messages: [...this.messages], tools };
  }

  /** Get accumulated token usage */
  get totalUsage(): Usage {
    return { ...this._totalUsage };
  }

  /** Calculate total cost based on a specific model's pricing */
  getTotalCost(model: Model<Api>): Usage["cost"] {
    return calculateCost(this._totalUsage, model);
  }

  /** Number of messages in the conversation */
  get length(): number {
    return this.messages.length;
  }

  /** Serialize for persistence */
  toJSON(): ConversationJSON {
    return {
      messages: this.messages,
      totalUsage: this._totalUsage,
    };
  }

  /** Restore from serialized state */
  static fromJSON(json: ConversationJSON, maxMessages?: number): Conversation {
    const conv = new Conversation(maxMessages);
    conv.messages = [...json.messages];
    conv._totalUsage = { ...json.totalUsage };
    conv.enforceMessageLimit();
    return conv;
  }
}
