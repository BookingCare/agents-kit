import { describe, it, expect } from "vitest";
import { buildParams } from "../src/providers/azure-openai.js";
import type { Model, Context } from "../src/types.js";

const testModel: Model<"azure-openai-completions"> = {
  id: "gpt-test",
  name: "Test",
  api: "azure-openai-completions",
  provider: "azure-openai",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};

describe("buildParams", () => {
  it("prepends systemPrompt as a system message", () => {
    const context: Context = {
      systemPrompt: "You are a test assistant.",
      messages: [
        { role: "user", content: "Hello", timestamp: Date.now() },
      ],
    };

    const params = buildParams(testModel, context);

    expect(params.messages).toHaveLength(2);
    expect(params.messages[0]).toEqual({ role: "system", content: "You are a test assistant." });
    expect(params.messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  it("does not add a system message when systemPrompt is absent", () => {
    const context: Context = {
      messages: [
        { role: "user", content: "Hello", timestamp: Date.now() },
      ],
    };

    const params = buildParams(testModel, context);

    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("propagates stream_options.include_usage as true", () => {
    const context: Context = {
      messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
    };

    const params = buildParams(testModel, context);

    expect(params.stream).toBe(true);
    expect(params.stream_options).toEqual({ include_usage: true });
  });

  it("forwards optional fields from StreamOptions", () => {
    const context: Context = {
      messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
    };

    const params = buildParams(testModel, context, {
      temperature: 0.5,
      maxTokens: 256,
      topP: 0.9,
      stopSequences: ["STOP"],
    });

    expect(params.temperature).toBe(0.5);
    expect(params.max_completion_tokens).toBe(256);
    expect(params.top_p).toBe(0.9);
    expect(params.stop).toEqual(["STOP"]);
  });

  it("sets model id from the model object", () => {
    const context: Context = {
      messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
    };

    const params = buildParams(testModel, context);

    expect(params.model).toBe("gpt-test");
  });
});
