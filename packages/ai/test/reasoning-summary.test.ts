import { describe, expect, it } from "vitest";
import { getModel, stream } from "../src/index.js";
import { applyAuth } from "./helpers/auth.js";

const auth = applyAuth();

describe.skipIf(!auth)("Azure OpenAI Responses reasoning summary", () => {
  it("streams reasoning summary text as thinking events and reports reasoning tokens", {
    retry: 3,
  }, async () => {
    const model = getModel("gpt-5.4-nano");
    expect(model?.api).toBe("azure-openai-responses");

    const eventStream = stream(
      model!,
      {
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content:
              "Find the smallest positive integer n such that n is divisible by 7, leaves remainder 2 when divided by 5, and the sum of its digits is 11. Explain only the final answer in one sentence.",
          },
        ],
      },
      { maxTokens: 1024, reasoningEffort: "medium", reasoningSummary: "auto" },
    );

    let summary = "";
    let text = "";
    let reasoningTokens = 0;

    for await (const event of eventStream) {
      if (event.type === "thinking_delta") {
        summary += event.delta;
      }
      if (event.type === "text_delta") {
        text += event.delta;
      }
      if (event.type === "done") {
        reasoningTokens = event.message.usage.reasoningTokens ?? 0;
      }
    }

    expect(summary.length).toBeGreaterThan(0);
    expect(text).toContain("182");
    expect(reasoningTokens).toBeGreaterThan(0);
  });
});
