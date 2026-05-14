import { describe, it, expect } from "vitest";
import { ContextManager, slidingWindowStrategy } from "../src/context-manager.js";
import type { ContextStrategy, TokenCounter } from "../src/types.js";
import type { AgentMessage } from "../src/types.js";

describe("ContextManager", () => {
  describe("token estimation", () => {
    it("estimates tokens for simple text messages", () => {
      const contextManager = new ContextManager({
        budget: 10000,
        strategy: slidingWindowStrategy,
      });

      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System prompt" },
        { role: "user" as const, content: "Hello, world!", timestamp: Date.now() },
        { role: "user" as const, content: "Hi there!", timestamp: Date.now() },
      ];

      const tokenCount = contextManager.count(messages);
      expect(tokenCount).toBeGreaterThan(10);
      expect(tokenCount).toBeLessThanOrEqual(20);
    });

    it("estimates tokens for array content with text parts", () => {
      const contextManager = new ContextManager({
        budget: 10000,
        strategy: slidingWindowStrategy,
      });

      const messages: AgentMessage[] = [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Sample text" }],
          timestamp: Date.now(),
        },
      ];

      const tokenCount = contextManager.count(messages);
      expect(tokenCount).toBeGreaterThan(0);
    });

    it("estimates overhead for non-text content", () => {
      const contextManager = new ContextManager({
        budget: 10000,
        strategy: slidingWindowStrategy,
      });

      const messages: AgentMessage[] = [
        {
          role: "user" as const,
          content: [
            {
              type: "image" as const,
              image: "https://example.com/image.png",
            },
          ],
          timestamp: Date.now(),
        },
      ];

      const tokenCount = contextManager.count(messages);
      expect(tokenCount).toBeGreaterThan(40);
    });

    it("counts empty message list as 0 tokens", () => {
      const contextManager = new ContextManager({
        budget: 10000,
        strategy: slidingWindowStrategy,
      });

      const tokenCount = contextManager.count([]);
      expect(tokenCount).toBe(0);
    });
  });

  describe("properties", () => {
    it("returns correct budget", () => {
      const budget = 15000;
      const contextManager = new ContextManager({
        budget,
        strategy: slidingWindowStrategy,
      });

      expect(contextManager.budget).toBe(budget);
    });

    it("returns remaining budget", () => {
      const budget = 1000;
      const contextManager = new ContextManager({
        budget,
        strategy: slidingWindowStrategy,
      });

      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "Hello", timestamp: Date.now() },
      ];
      contextManager.prepareMessages(messages);
      const tokenCount = contextManager.tokenCount;

      expect(contextManager.remainingBudget).toBe(budget - tokenCount);
    });

    it("returns trim count", () => {
      const contextManager = new ContextManager({
        budget: 100,
        strategy: slidingWindowStrategy,
      });

      expect(contextManager.trimCount).toBe(0);

      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "A".repeat(1000), timestamp: Date.now() },
        { role: "user" as const, content: "Response", timestamp: Date.now() },
        { role: "user" as const, content: "B".repeat(1000), timestamp: Date.now() },
      ];
      contextManager.prepareMessages(messages);

      expect(contextManager.trimCount).toBeGreaterThan(0);
    });

    it("returns strategy name", () => {
      const contextManager = new ContextManager({
        budget: 10000,
        strategy: slidingWindowStrategy,
      });

      expect(contextManager.strategyName).toBe("slidingWindow");
    });
  });

  describe("prepareMessages", () => {
    it("returns unchanged messages when under budget", () => {
      const budget = 10000;
      const contextManager = new ContextManager({
        budget,
        strategy: slidingWindowStrategy,
      });

      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "Hello", timestamp: Date.now() },
        { role: "user" as const, content: "Hi", timestamp: Date.now() },
      ];

      const result = contextManager.prepareMessages(messages);

      expect(result.dropped).toBe(0);
      expect(result.prepared).toEqual(messages);
      expect(result.strategyName).toBe("slidingWindow");
    });

    it("returns strategy name when under budget", () => {
      const contextManager = new ContextManager({
        budget: 10000,
        strategy: slidingWindowStrategy,
      });

      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "Hello", timestamp: Date.now() },
      ];

      const result = contextManager.prepareMessages(messages);

      expect(result.strategyName).toBe("slidingWindow");
    });

    it("trims messages when over budget", () => {
      const budget = 100;
      const contextManager = new ContextManager({
        budget,
        strategy: slidingWindowStrategy,
      });

      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "A".repeat(1000), timestamp: Date.now() },
        { role: "user" as const, content: "Response", timestamp: Date.now() },
        { role: "user" as const, content: "B".repeat(1000), timestamp: Date.now() },
      ];

      const result = contextManager.prepareMessages(messages);

      expect(result.dropped).toBeGreaterThan(0);
      expect(result.prepared.length).toBeLessThan(messages.length);
      expect(result.tokenCountAfter).toBeLessThan(result.tokenCountBefore);
    });

    it("accounts for system prompt in budget", () => {
      const budget = 50;
      const contextManager = new ContextManager({
        budget,
        strategy: slidingWindowStrategy,
      });

      const systemPrompt =
        "You are a helpful assistant with a very long system prompt that consumes tokens.";
      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "Hello", timestamp: Date.now() },
      ];

      const result = contextManager.prepareMessages(messages, systemPrompt);
      const messagesOnlyTokens = contextManager.count(messages);

      expect(result.tokenCountBefore).toBeGreaterThan(messagesOnlyTokens);
      expect(result.tokenCountAfter).toBeGreaterThan(messagesOnlyTokens);
    });

    it("updates internal tokenCount after preparation", () => {
      const contextManager = new ContextManager({
        budget: 10000,
        strategy: slidingWindowStrategy,
      });

      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "Hello", timestamp: Date.now() },
      ];
      contextManager.prepareMessages(messages);

      expect(contextManager.tokenCount).toBeGreaterThan(0);
    });

    it("increments trimCount only when trimming occurs", () => {
      const contextManager = new ContextManager({
        budget: 2000,
        strategy: slidingWindowStrategy,
      });

      const shortMessages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "Hi", timestamp: Date.now() },
      ];
      contextManager.prepareMessages(shortMessages);
      expect(contextManager.trimCount).toBe(0);

      const longMessages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "A".repeat(10000), timestamp: Date.now() },
        { role: "user" as const, content: "Response", timestamp: Date.now() },
      ];
      contextManager.prepareMessages(longMessages);
      expect(contextManager.trimCount).toBe(1);
    });
  });

  describe("custom strategy", () => {
    it("receives correct arguments", () => {
      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "Hello", timestamp: Date.now() },
        { role: "user" as const, content: "Hi", timestamp: Date.now() },
      ];
      const budget = 10;

      const customStrategy: ContextStrategy = {
        name: "custom",
        apply: (msgs, bud, counter) => {
          expect(msgs).toEqual(messages);
          expect(bud).toBe(budget);
          expect(typeof counter.count).toBe("function");
          return msgs.slice(0, 1);
        },
      };

      const contextManager = new ContextManager({
        budget,
        strategy: customStrategy,
      });

      const result = contextManager.prepareMessages(messages);
      expect(result.prepared.length).toBe(1);
      expect(result.strategyName).toBe("custom");
    });

    it("uses custom strategy return value", () => {
      const keepOnlyFirstStrategy: ContextStrategy = {
        name: "keep-first",
        apply: (messages) => messages.slice(0, 1),
      };

      const contextManager = new ContextManager({
        budget: 10,
        strategy: keepOnlyFirstStrategy,
      });

      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "First", timestamp: Date.now() },
        { role: "user" as const, content: "Response", timestamp: Date.now() },
        { role: "user" as const, content: "Second", timestamp: Date.now() },
      ];

      const result = contextManager.prepareMessages(messages);
      expect(result.prepared).toEqual([messages[0]]);
    });
  });
});

describe("slidingWindowStrategy", () => {
  describe("system message preservation", () => {
    it("preserves all system messages", () => {
      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System 1" },
        { role: "user" as const, content: "User 1", timestamp: Date.now() },
        { role: "user" as const, content: "Assistant 1", timestamp: Date.now() },
        { role: "system" as const, content: "System 2" },
      ];

      const tokenCounter: TokenCounter = { count: () => 1000 };
      const result = slidingWindowStrategy.apply(messages, 5000, tokenCounter);

      const systemMessages = result.filter((m) => m.role === "system");
      expect(systemMessages.length).toBe(2);
    });

    it("keeps system messages even when non-system are dropped", () => {
      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System prompt" },
        { role: "user" as const, content: "A".repeat(10000), timestamp: Date.now() },
        { role: "user" as const, content: "Response", timestamp: Date.now() },
        { role: "user" as const, content: "B".repeat(10000), timestamp: Date.now() },
      ];

      const tokenCounter: TokenCounter = { count: () => 10000 };
      const result = slidingWindowStrategy.apply(messages, 500, tokenCounter);

      expect(result[0]?.role).toBe("system");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("dropping oldest messages", () => {
    it("drops oldest non-system messages when over budget", () => {
      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "User 1", timestamp: Date.now() },
        { role: "user" as const, content: "Assistant 1", timestamp: Date.now() },
        { role: "user" as const, content: "User 2", timestamp: Date.now() },
        { role: "user" as const, content: "Assistant 2", timestamp: Date.now() },
      ];

      let callCount = 0;
      const tokenCounter: TokenCounter = {
        count: (msgs) => {
          callCount++;
          return msgs.length === 5 ? 1000 : 200;
        },
      };

      const result = slidingWindowStrategy.apply(messages, 300, tokenCounter);

      expect(result).not.toEqual(messages);
      expect(result.length).toBeLessThan(messages.length);
    });

    it("drops from the beginning (oldest)", () => {
      const messages: AgentMessage[] = [
        { role: "user" as const, content: "First", timestamp: Date.now() },
        { role: "user" as const, content: "First response", timestamp: Date.now() },
        { role: "user" as const, content: "Second", timestamp: Date.now() },
        { role: "user" as const, content: "Second response", timestamp: Date.now() },
      ];

      const tokenCounter: TokenCounter = { count: (msgs) => msgs.length * 100 };
      const result = slidingWindowStrategy.apply(messages, 300, tokenCounter);

      expect(result.length).toBe(3);
      expect(result[0]?.content).toBe("First response");
    });
  });

  describe("keeping at least one message", () => {
    it("keeps at least one non-system message when possible", () => {
      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "User", timestamp: Date.now() },
        { role: "user" as const, content: "Assistant", timestamp: Date.now() },
      ];

      const tokenCounter: TokenCounter = { count: () => 200 };
      const result = slidingWindowStrategy.apply(messages, 300, tokenCounter);

      const nonSystem = result.filter((m) => m.role !== "system");
      expect(nonSystem.length).toBeGreaterThan(0);
    });

    it("drops all non-system if even one exceeds budget", () => {
      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System" },
        { role: "user" as const, content: "A".repeat(10000), timestamp: Date.now() },
      ];

      const tokenCounter: TokenCounter = { count: () => 10000 };
      const result = slidingWindowStrategy.apply(messages, 500, tokenCounter);

      expect(result.every((m) => m.role === "system")).toBe(true);
    });
  });

  describe("budget compliance", () => {
    it("returns messages under budget", () => {
      const messages: AgentMessage[] = [
        { role: "user" as const, content: "A".repeat(1000), timestamp: Date.now() },
        { role: "user" as const, content: "Response", timestamp: Date.now() },
        { role: "user" as const, content: "B".repeat(1000), timestamp: Date.now() },
      ];

      const budget = 200;
      const tokenCounter: TokenCounter = { count: (msgs) => msgs.length * 100 };
      const result = slidingWindowStrategy.apply(messages, budget, tokenCounter);

      const afterCount = tokenCounter.count(result);
      expect(afterCount).toBeLessThanOrEqual(budget);
    });
  });

  describe("edge cases", () => {
    it("handles empty message list", () => {
      const messages: AgentMessage[] = [];
      const tokenCounter: TokenCounter = { count: () => 0 };
      const result = slidingWindowStrategy.apply(messages, 100, tokenCounter);

      expect(result).toEqual([]);
    });

    it("handles only system messages", () => {
      const messages: AgentMessage[] = [
        { role: "system" as const, content: "System 1" },
        { role: "system" as const, content: "System 2" },
      ];

      const tokenCounter: TokenCounter = { count: () => 100 };
      const result = slidingWindowStrategy.apply(messages, 500, tokenCounter);

      expect(result).toEqual(messages);
    });

    it("handles system prompt exceeding budget alone", () => {
      const messages: AgentMessage[] = [
        { role: "system" as const, content: "A".repeat(10000) },
        { role: "user" as const, content: "User", timestamp: Date.now() },
      ];

      const budget = 100;
      const tokenCounter: TokenCounter = { count: () => 10000 };
      const result = slidingWindowStrategy.apply(messages, budget, tokenCounter);

      expect(result.length).toBe(1);
      expect(result[0]?.role).toBe("system");
    });
  });
});
