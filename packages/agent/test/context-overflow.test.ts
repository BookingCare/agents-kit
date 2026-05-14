import { describe, it, expect } from "vitest";
import { stream, streamSimple, collectStream, type Message } from "@bookingcare/ai";
import { getModel, type Model } from "@bookingcare/ai";
import { ContextManager, slidingWindowStrategy } from "../src/index.js";
import { applyAuth } from "../test/helpers/auth.js";
import type { AgentMessage } from "../src/types.js";

const auth = applyAuth();

// Helper to create a large context that will overflow the budget
function createLargeContext(basePrompt: string, repeatCount: number): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: "system", content: basePrompt }];

  for (let i = 0; i < repeatCount; i++) {
    messages.push({
      role: "user",
      content: `Question ${i + 1}: ${basePrompt} Repeat this question many times: ${basePrompt}`,
      timestamp: Date.now() + i * 1000,
    });

    // Simulate assistant responses with usage data
    messages.push({
      role: "assistant",
      api: "azure-openai-completions",
      provider: "azure",
      model: "gpt-5.4-nano",
      content: [
        {
          type: "text",
          text: `Response ${i + 1}: This is a detailed response to question ${i + 1}. ${basePrompt}`,
        },
      ],
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now() + i * 1000 + 500,
    });
  }

  return messages;
}

// Helper to create context with cached assistant messages
function createContextWithCachedMessages(): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: "system", content: "You are a helpful assistant." }];

  for (let i = 0; i < 5; i++) {
    messages.push({
      role: "user",
      content: `Question ${i + 1}: What is ${i + 1} + ${i + 1}?`,
      timestamp: Date.now() + i * 1000,
    });

    // Assistant message with cached tokens
    messages.push({
      role: "assistant",
      api: "azure-openai-completions",
      provider: "azure",
      model: "gpt-5.4-nano",
      content: [{ type: "text", text: `The answer is ${i + 1 + i + 1}.` }],
      usage: {
        input: 30,
        output: 15,
        cacheRead: 10, // Simulate cache hit
        cacheWrite: 0,
        totalTokens: 55, // 30 + 15 + 10
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now() + i * 1000 + 500,
    });
  }

  return messages;
}

describe.skipIf(!auth)("Context overflow handling", () => {
  const model = auth ? getModel("gpt-5.4-nano") : null;

  describe("ContextManager with Azure OpenAI usage data", () => {
    it("correctly counts tokens from assistant messages with cache", () => {
      const contextManager = new ContextManager({
        budget: 1000,
        strategy: slidingWindowStrategy,
      });

      const messages = createContextWithCachedMessages();

      // Count tokens should include cached tokens
      const tokenCount = contextManager.count(messages);

      // Each assistant message: 30 (input) + 15 (output) + 10 (cached) = 55
      // Total for 5 assistant messages: 275
      // Plus system and user messages (estimated via char/4)
      expect(tokenCount).toBeGreaterThan(200);
      expect(tokenCount).toBeLessThan(400);
    });

    it("accurately budgets context with mixed cached/uncached messages", () => {
      const contextManager = new ContextManager({
        budget: 150,
        strategy: slidingWindowStrategy,
      });

      const messages = createContextWithCachedMessages();

      const result = contextManager.prepareMessages(messages);

      // Should trim some messages to fit budget
      expect(result.prepared.length).toBeLessThan(messages.length);
      expect(result.tokenCountAfter).toBeLessThanOrEqual(150);

      // After trimming, token count should be accurate
      const actualCount = contextManager.count(result.prepared);
      expect(actualCount).toBe(result.tokenCountAfter);
    });

    it("system prompt is accounted for in budget", () => {
      const longSystemPrompt =
        "You are a very detailed assistant with extensive instructions. ".repeat(20);

      // Create enough messages that would fit budget without system prompt
      const messages: AgentMessage[] = [
        { role: "user", content: "A".repeat(20), timestamp: Date.now() },
        { role: "user", content: "B".repeat(20), timestamp: Date.now() },
      ];

      const contextManager = new ContextManager({
        budget: 100,
        strategy: slidingWindowStrategy,
      });

      const result = contextManager.prepareMessages(messages, longSystemPrompt);

      // System prompt should cause messages to be trimmed
      expect(result.tokenCountBefore).toBeGreaterThan(result.tokenCountAfter);
      expect(result.prepared.length).toBeLessThan(messages.length);
    });

    it("cached tokens don't cause budget underflow", () => {
      const contextManager = new ContextManager({
        budget: 400,
        strategy: slidingWindowStrategy,
      });

      const messages = createContextWithCachedMessages();

      // This should not throw or cause issues
      const result = contextManager.prepareMessages(messages);

      // Verify result is valid
      expect(result.prepared).toBeDefined();
      expect(result.dropped).toBeGreaterThanOrEqual(0);
      expect(result.tokenCountAfter).toBeLessThanOrEqual(400);
    });
  });

  describe.skip("real API calls with context management", () => {
    it.skip("handles large context without overflow", async () => {
      // Create a moderately sized context
      const messages: Message[] = [
        {
          role: "user",
          timestamp: Date.now(),
          content: "What is 1+1? Reply with just the number.",
        },
        {
          role: "assistant",
          api: "azure-openai-completions",
          provider: "azure",
          model: model!.id,
          content: [{ type: "text", text: "2" }],
          usage: {
            input: 20,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 25,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
        {
          role: "user",
          timestamp: Date.now(),
          content: "What is 2+2? Reply with just the number.",
        },
      ];

      const events = await stream(model!, {
        messages: messages,
      });

      const result = await collectStream(events, model!);

      // Should succeed without context overflow errors
      expect(result.usage.input).toBeGreaterThan(0);
      expect(result.usage.output).toBeGreaterThan(0);
    });

    it.skip("handles context near model limit", async () => {
      if (!model) return;

      // Create context approaching (but not exceeding) the limit
      const longPrompt = "Consider the following: ".repeat(50);

      const events = await stream(model, {
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content: `${longPrompt} Count to 3. Reply with just the numbers.`,
          },
        ],
      });

      const result = await collectStream(events, model);

      // Should handle gracefully
      expect(result.usage.input).toBeGreaterThan(0);
      expect(result.usage.output).toBeGreaterThan(0);
    });
  });

  describe.skip("token counting accuracy", () => {
    it("totalTokens is accurate across multiple calls", async () => {
      const prompt = "What is 1+1?";

      const events1 = await stream(model!, {
        messages: [{ role: "user", timestamp: Date.now(), content: prompt }],
      });

      const result1 = await collectStream(events1, model!);

      const events2 = await stream(model!, {
        messages: [{ role: "user", timestamp: Date.now(), content: prompt }],
      });

      const result2 = await collectStream(events2, model!);

      // Both should have similar token counts (identical prompts)
      // Allow small variations due to cache behavior
      expect(Math.abs(result1.usage.input - result2.usage.input)).toBeLessThanOrEqual(2);
      expect(Math.abs(result1.usage.totalTokens - result2.usage.totalTokens)).toBeLessThanOrEqual(
        2,
      );
    });

    it("cached tokens don't cause totalTokens inflation", async () => {
      // Make multiple calls with similar content
      const prompt = "Test prompt for cache verification: unique-abc-123";

      const events = await stream(model!, {
        messages: [{ role: "user", timestamp: Date.now(), content: prompt }],
      });

      const result = await collectStream(events, model!);

      // Verify totalTokens is not inflated
      const calculated =
        result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite;

      expect(result.usage.totalTokens).toBe(calculated);

      // If cacheRead > 0, verify input doesn't double-count
      if (result.usage.cacheRead > 0) {
        // The fix ensures input represents uncached tokens only
        expect(result.usage.input + result.usage.cacheRead).toBeLessThanOrEqual(
          result.usage.totalTokens,
        );
      }
    });
  });
});
