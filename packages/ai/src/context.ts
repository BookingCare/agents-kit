import type {
  AssistantMessageEventStream,
  ContentPart,
  Message,
  StreamResult,
  Usage,
  Cost,
} from "./types.js";
import { collectStream } from "./stream.js";
import { getModel } from "./models.generated.js";
import { calculateCost } from "./costs.js";

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
  private _totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
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
    this.messages.push({ role: "user", content });
    this.enforceMessageLimit();
  }

  /**
   * Add an assistant response from a stream.
   * Consumes the event stream and appends the resulting assistant message.
   * Returns the StreamResult for inspection.
   */
  async addAssistantResponse(
    eventStream: AssistantMessageEventStream,
    modelId?: string,
  ): Promise<StreamResult> {
    const result = await collectStream(eventStream, modelId);

    const assistantMsg: Message = { role: "assistant" };
    if (result.text) {
      (assistantMsg as { content?: string }).content = result.text;
    }
    if (result.toolCalls.length) {
      (assistantMsg as { toolCalls?: unknown }).toolCalls = result.toolCalls;
    }
    this.messages.push(assistantMsg);
    this.enforceMessageLimit();

    this._totalUsage.inputTokens += result.usage.inputTokens;
    this._totalUsage.outputTokens += result.usage.outputTokens;

    return result;
  }

  /** Add a tool result message */
  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({ role: "tool", toolCallId, content });
    this.enforceMessageLimit();
  }

  /** Get all messages (copy) */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** Get accumulated token usage */
  get totalUsage(): Usage {
    return { ...this._totalUsage };
  }

  /** Calculate total cost based on a specific model's pricing */
  getTotalCost(modelId: string): Cost | undefined {
    const model = getModel(modelId);
    if (!model) return undefined;
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
