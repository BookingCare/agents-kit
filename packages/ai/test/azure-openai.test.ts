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

function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    ...overrides,
  };
}

describe("buildParams", () => {
  it("prepends systemPrompt as a system message", () => {
    const params = buildParams(
      testModel,
      makeContext({ systemPrompt: "You are a test assistant." }),
    );

    expect(params.messages).toHaveLength(2);
    expect(params.messages[0]).toEqual({ role: "system", content: "You are a test assistant." });
    expect(params.messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  it("does not add a system message when systemPrompt is absent", () => {
    const params = buildParams(testModel, makeContext());

    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("propagates stream_options.include_usage as true", () => {
    const params = buildParams(testModel, makeContext());

    expect(params.stream).toBe(true);
    expect(params.stream_options).toEqual({ include_usage: true });
  });

  it("forwards optional fields from StreamOptions", () => {
    const params = buildParams(testModel, makeContext(), {
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

  it("forwards reasoning effort for reasoning models", () => {
    const params = buildParams(testModel, makeContext(), { reasoningEffort: "low" });

    expect(params.reasoning_effort).toBe("low");
  });

  it("sets model id from the model object", () => {
    const params = buildParams(testModel, makeContext());

    expect(params.model).toBe("gpt-test");
  });
});
