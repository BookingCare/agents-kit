import type { AgentMessage, ContextStrategy, TokenCounter } from "./types.js";

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
   * Estimate token count for a single message.
   * Naive approximation: characters / 4, rounded up.
   */
  private estimateTokensForMessage(message: AgentMessage): number {
    let chars = 0;
    if (typeof message.content === "string") {
      chars = message.content.length;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === "object" && "text" in part) {
          chars += (part as { text: string }).text.length;
        } else {
          // image or other: estimate fixed overhead
          chars += 200;
        }
      }
    }
    // Base overhead per message (role, formatting)
    return Math.ceil(chars / 4) + 3;
  }

  count(messages: AgentMessage[]): number {
    return messages.reduce((sum, m) => sum + this.estimateTokensForMessage(m), 0);
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
    // Separate system prompts
    const systemMessages = messages.filter(
      (m): m is Extract<AgentMessage, { role: "system" }> => m.role === "system",
    );
    const nonSystemMessages = messages.filter(
      (m): m is Exclude<AgentMessage, { role: "system" }> => m.role !== "system",
    );

    // Start with all messages
    let kept = [...systemMessages, ...nonSystemMessages];
    let dropIndex = 0;

    // Drop oldest non-system messages one at a time until under budget
    // or all non-system messages have been dropped.
    // Complexity: O(n²) token counting due to re-counting from scratch each iteration.
    while (tokenCounter.count(kept) > budget && dropIndex < nonSystemMessages.length) {
      dropIndex++;
      kept = [...systemMessages, ...nonSystemMessages.slice(dropIndex)];
    }

    // If still over budget, progressively reduce to the minimal viable context
    if (tokenCounter.count(kept) > budget) {
      const systemOnlyTokens = tokenCounter.count(systemMessages);
      if (systemOnlyTokens > budget) {
        // System prompt alone exceeds budget — keep just the first system message
        kept = systemMessages.length > 0 ? [systemMessages[0]] : [];
      } else {
        // Find the smallest suffix of non-system messages that still fits within budget,
        // preferring recent messages.
        let bestKept: AgentMessage[] = systemMessages;
        for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
          const candidate = [...systemMessages, ...nonSystemMessages.slice(i)];
          if (tokenCounter.count(candidate) <= budget) {
            bestKept = candidate;
            break;
          }
        }
        kept = bestKept;
      }
    }

    return kept;
  },
};
