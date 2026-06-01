import { describe, expect, it } from "vitest";
import { buildResponsesParams } from "../src/providers/azure-openai-responses.js";
import type { Context, Model } from "../src/types.js";

const testModel: Model<"azure-openai-responses"> = {
  id: "gpt-5.4-nano",
  name: "GPT-5.4 Nano",
  api: "azure-openai-responses",
  provider: "azure-openai",
  baseUrl: "",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  contextWindow: 400000,
  maxTokens: 128000,
};

function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    ...overrides,
  };
}

describe("buildResponsesParams", () => {
  it("uses the Responses API input shape", () => {
    const params = buildResponsesParams(testModel, makeContext({ systemPrompt: "Be concise." }));

    expect(params.model).toBe("gpt-5.4-nano");
    expect(params.stream).toBe(true);
    expect(params.input).toEqual([
      { role: "developer", content: "Be concise." },
      { role: "user", content: [{ type: "input_text", text: "Hello" }] },
    ]);
  });

  it("forwards reasoning summary options", () => {
    const params = buildResponsesParams(testModel, makeContext(), {
      reasoningEffort: "medium",
      reasoningSummary: "auto",
    });

    expect(params.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("uses azureDeploymentName when provided", () => {
    const params = buildResponsesParams(testModel, makeContext(), {
      azureDeploymentName: "deployment-name",
    });

    expect(params.model).toBe("deployment-name");
  });
});
