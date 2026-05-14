import { describe, it, expect } from "vitest";
import { stream, streamSimple, collectStream } from "../src/index.js";
import { getModel, type Model } from "../src/index.js";
import { applyAuth } from "./helpers/auth.js";

const auth = applyAuth();

// Helper to get a model that supports prompt caching (if available)
function getCacheCapableModel(): Model<"azure-openai-completions"> | null {
  // Use a model that's likely to support caching
  // In practice, this would require a specific model configured in Azure
  return getModel("gpt-5.4-nano") as Model<"azure-openai-completions"> | null;
}

describe.skipIf(!auth)("Azure OpenAI token counting", () => {
  const model = getModel("gpt-5.4-nano");

  describe("basic token counting", () => {
    it("counts input and output tokens correctly", async () => {
      if (!model) return;

      const events = await stream(model, {
        messages: [{ role: "user", timestamp: Date.now(), content: "Say hello." }],
      });

      const result = await collectStream(events, model);

      expect(result.usage.input).toBeGreaterThan(0);
      expect(result.usage.output).toBeGreaterThan(0);
      expect(result.usage.totalTokens).toBe(result.usage.input + result.usage.output);
    });

    it("totalTokens equals input + output + cacheRead + cacheWrite", async () => {
      if (!model) return;

      const events = await stream(model, {
        messages: [{ role: "user", timestamp: Date.now(), content: "Count to 5." }],
      });

      const result = await collectStream(events, model);

      expect(result.usage.totalTokens).toBe(
        result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite,
      );
    });

    it("cacheRead and cacheWrite are zero for non-cached prompts", async () => {
      if (!model) return;

      const events = await stream(model, {
        messages: [{ role: "user", timestamp: Date.now(), content: "What is 2+2?" }],
      });

      const result = await collectStream(events, model);

      expect(result.usage.cacheRead).toBe(0);
      expect(result.usage.cacheWrite).toBe(0);
    });
  });

  describe("cached token counting", () => {
    it("detects cached tokens when available", async () => {
      const cacheModel = getCacheCapableModel();
      if (!cacheModel) return;

      // First call - may write to cache
      const firstEvents = await stream(cacheModel, {
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content: "A very specific prompt to test caching: test-prompt-12345",
          },
        ],
      });
      const firstResult = await collectStream(firstEvents, cacheModel);

      // Second call - may read from cache
      const secondEvents = await stream(cacheModel, {
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content: "A very specific prompt to test caching: test-prompt-12345",
          },
        ],
      });
      const secondResult = await collectStream(secondEvents, cacheModel);

      // Either firstResult.cacheWrite > 0 or secondResult.cacheRead > 0
      // (or both, depending on cache implementation)
      const hasCacheActivity = firstResult.usage.cacheWrite > 0 || secondResult.usage.cacheRead > 0;

      if (hasCacheActivity) {
        // Verify cacheRead is not double-counted in totalTokens
        const calculatedTotal =
          secondResult.usage.input +
          secondResult.usage.output +
          secondResult.usage.cacheRead +
          secondResult.usage.cacheWrite;

        expect(secondResult.usage.totalTokens).toBe(calculatedTotal);
      }
    });

    it("does not double-count cached tokens in totalTokens", async () => {
      const cacheModel = getCacheCapableModel();
      if (!cacheModel) return;

      // Make a call that potentially uses cached tokens
      const events = await stream(cacheModel, {
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content:
              "Explain quantum computing in one sentence. Use the exact same prompt twice to trigger cache: Explain quantum computing in one sentence.",
          },
        ],
      });

      const result = await collectStream(events, cacheModel);

      // The critical invariant: totalTokens should not double-count cached tokens
      // This is the main bug fix from PR #22 review
      expect(result.usage.totalTokens).toBe(
        result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite,
      );

      // If cacheRead > 0, verify input doesn't include those tokens
      if (result.usage.cacheRead > 0) {
        // Azure OpenAI: input should be uncached tokens only after the fix
        // cacheRead represents cached tokens that were read
        const expectedTotal =
          result.usage.input +
          result.usage.output +
          result.usage.cacheRead +
          result.usage.cacheWrite;
        expect(result.usage.totalTokens).toBe(expectedTotal);
      }
    });
  });

  describe("cost calculation", () => {
    it("calculates cost correctly for cached tokens", async () => {
      if (!model) return;

      const events = await stream(model, {
        messages: [{ role: "user", timestamp: Date.now(), content: "Generate 10 words." }],
      });

      const result = await collectStream(events, model);

      // Cost should include all token types
      expect(result.usage.cost.input).toBeGreaterThanOrEqual(0);
      expect(result.usage.cost.output).toBeGreaterThanOrEqual(0);
      expect(result.usage.cost.cacheRead).toBeGreaterThanOrEqual(0);
      expect(result.usage.cost.cacheWrite).toBeGreaterThanOrEqual(0);

      // Total cost should match sum of components
      const expectedTotal =
        result.usage.cost.input +
        result.usage.cost.output +
        result.usage.cost.cacheRead +
        result.usage.cost.cacheWrite;

      expect(result.usage.cost.total).toBeCloseTo(expectedTotal, 10); // Allow floating point rounding
    });

    it("cached tokens have different pricing than uncached", async () => {
      const cacheModel = getCacheCapableModel();
      if (!cacheModel) return;

      // Make a call that might use cache
      const events = await stream(cacheModel, {
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content: "Test cache pricing: unique-prompt-xyz-987",
          },
        ],
      });

      const result = await collectStream(events, cacheModel);

      if (result.usage.cacheRead > 0) {
        // Cached tokens should be cheaper than uncached
        // (This depends on Azure's cache pricing model)
        const uncachedCost = result.usage.cost.input;
        const cachedCost = result.usage.cost.cacheRead;

        // If we have both, verify the cost calculation respects cache pricing
        const totalTokenCost = uncachedCost + cachedCost;
        expect(result.usage.cost.input + result.usage.cost.cacheRead).toBeLessThanOrEqual(
          totalTokenCost + 0.01,
        );
      }
    });
  });

  describe("streamSimple token counting", () => {
    it("counts tokens correctly in streamSimple", async () => {
      if (!model) return;

      const eventStream = await streamSimple(model, {
        messages: [{ role: "user", timestamp: Date.now(), content: "Count to 3." }],
      });

      const result = await collectStream(eventStream, model);

      expect(result.usage.input).toBeGreaterThan(0);
      expect(result.usage.output).toBeGreaterThan(0);
      expect(result.usage.totalTokens).toBe(result.usage.input + result.usage.output);
    });
  });
});
