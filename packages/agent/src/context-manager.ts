import type { AgentMessage, ContextStrategy, TokenCounter } from "./types.js";
import type { ToolCall, Usage } from "@bookingcare/ai";

/**
 * Manages token budget and context trimming for agent messages.
 *
 * NOTE: This class is not thread-safe. Do not share instances across concurrent
 * operations or modify state from multiple threads simultaneously.
 */
export class ContextManager implements TokenCounter {
  private _tokenCount = 0;
  private _trimCount = 0;

  constructor(
    private readonly options: {
      budget: number;
      strategy: ContextStrategy;
    },
  ) {}

  get budget(): number {
    return this.options.budget;
  }

  get tokenCount(): number {
    return this._tokenCount;
  }

  get remainingBudget(): number {
    return Math.max(0, this.options.budget - this._tokenCount);
  }

  get trimCount(): number {
    return this._trimCount;
  }

  /**
   * Get token count for a single message.
   *
   * For assistant messages with actual usage data, uses the recorded input tokens.
   * For other message types (system, user, toolResult), estimates via character count.
   *
   * Estimation uses characters / 4, rounded up. This is generally accurate for
   * English text but may be less accurate for:
   * - Non-English languages (especially those with different character-to-token ratios)
   * - Code-heavy content (programming languages have different tokenization patterns)
   * - Content with many special characters or symbols
   */
  private getTokensForMessage(message: AgentMessage): number {
    // Assistant messages have actual usage data from when they were generated
    if (message.role === "assistant" && "usage" in message) {
      return message.usage.input;
    }

    // For messages without usage (system, user, toolResult), estimate
    let chars = 0;
    if (typeof message.content === "string") {
      chars = message.content.length;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === "object" && "text" in part) {
          chars += (part as { text: string }).text.length;
        } else if (this.isToolCall(part)) {
          // ToolCall: count id + name + arguments (actual content, not fixed overhead)
          chars += part.id.length + part.name.length + part.arguments.length;
        } else {
          // image or other: estimate fixed overhead
          chars += 200;
        }
      }
    }
    // Base overhead per message (role, formatting)
    return Math.ceil(chars / 4) + 3;
  }

  /**
   * Type guard for ToolCall content parts.
   */
  private isToolCall(part: unknown): part is ToolCall {
    return (
      typeof part === "object" &&
      part !== null &&
      "id" in part &&
      "name" in part &&
      "arguments" in part &&
      typeof (part as ToolCall).id === "string" &&
      typeof (part as ToolCall).name === "string" &&
      typeof (part as ToolCall).arguments === "string"
    );
  }

  count(messages: AgentMessage[]): number {
    return messages.reduce((sum, m) => sum + this.getTokensForMessage(m), 0);
  }

  /**
   * Name of the currently active strategy.
   */
  get strategyName(): string {
    return this.options.strategy.name;
  }

  /**
   * Analyze messages and trim if over budget, accounting for an optional
   * system prompt that will be prepended to the LLM context.
   *
   * Returns the message list to send to the LLM.
   * Also returns metadata about what was trimmed.
   *
   * `tokenCount` reflects the prepared (trimmed) message list, including
   * the estimated system prompt tokens if one is provided.
   */
  prepareMessages(
    messages: AgentMessage[],
    systemPrompt?: string,
  ): {
    prepared: AgentMessage[];
    dropped: number;
    tokenCountBefore: number;
    tokenCountAfter: number;
    strategyName: string;
  } {
    // Reserve budget for system prompt, if present
    const systemPromptTokens = systemPrompt ? Math.ceil(systemPrompt.length / 4) + 3 : 0;
    const effectiveBudget = Math.max(0, this.options.budget - systemPromptTokens);

    const tokenCountBefore = this.count(messages);

    if (tokenCountBefore <= effectiveBudget) {
      const totalBefore = tokenCountBefore + systemPromptTokens;
      const totalAfter = totalBefore;
      this._tokenCount = totalAfter;
      return {
        prepared: messages,
        dropped: 0,
        tokenCountBefore: totalBefore,
        tokenCountAfter: totalAfter,
        strategyName: this.strategyName,
      };
    }

    // Apply strategy with reduced budget (accounting for system prompt)
    const prepared = this.options.strategy.apply(messages, effectiveBudget, this);
    const trimmedTokens = this.count(prepared);
    const tokenCountAfter = trimmedTokens + systemPromptTokens;

    // Validate that the strategy actually produced a result within budget.
    // Custom strategies may return over-budget results, which defeats the purpose
    // of the ContextManager and can lead to context overflow at the provider.
    if (trimmedTokens > effectiveBudget) {
      throw new Error(
        `Context strategy '${this.options.strategy.name}' produced ${trimmedTokens} tokens, ` +
          `exceeding effective budget of ${effectiveBudget} tokens. ` +
          `The strategy returned a message list that is still too large.`,
      );
    }

    const dropped = messages.length - prepared.length;
    this._tokenCount = tokenCountAfter;
    this._trimCount++;

    return {
      prepared,
      dropped,
      tokenCountBefore: tokenCountBefore + systemPromptTokens,
      tokenCountAfter,
      strategyName: this.strategyName,
    };
  }
}

/**
 * Built-in sliding window strategy.
 *
 * Behavior:
 * 1. Preserves all `system` role messages
 * 2. Drops oldest non-system message pairs (user/assistant/toolResult) first
 * 3. Keeps at least one non-system message pair if possible
 * 4. If still over budget, progressively reduces to minimal viable context
 */
export const slidingWindowStrategy: ContextStrategy = {
  name: "slidingWindow",
  apply(messages, budget, tokenCounter) {
    const systemMessages = messages.filter(
      (m): m is Extract<AgentMessage, { role: "system" }> => m.role === "system",
    );
    const nonSystemMessages = messages.filter(
      (m): m is Exclude<AgentMessage, { role: "system" }> => m.role !== "system",
    );

    const systemTokens = tokenCounter.count(systemMessages);
    if (systemTokens > budget) {
      return systemMessages.length > 0 ? [systemMessages[0]] : [];
    }

    let currentTokens = systemTokens;
    let keepFrom = nonSystemMessages.length;

    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      const messageTokens = tokenCounter.count([nonSystemMessages[i]]);
      if (currentTokens + messageTokens > budget) break;
      currentTokens += messageTokens;
      keepFrom = i;
    }

    let result = [...systemMessages, ...nonSystemMessages.slice(keepFrom)];

    // If nothing fit and system alone is under budget, try keeping the most recent message
    if (
      keepFrom === nonSystemMessages.length &&
      systemTokens < budget &&
      nonSystemMessages.length > 0
    ) {
      const mostRecent = nonSystemMessages[nonSystemMessages.length - 1];
      result = [...systemMessages, mostRecent];
    }

    return result;
  },
};
