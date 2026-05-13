// s03: System prompt and iteration tracking
// Demonstrates system prompts, iteration limits, and the onStreamResult callback.
//
// Usage: npx tsx examples/s03-system-prompt.ts

import { agentLoop } from "../src/index.js";
import { getModel } from "@bookingcare/ai";
import { applyAuth } from "../test/helpers/auth.js";

const auth = applyAuth();
if (!auth) {
  console.error("Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .agents/auth.json");
  process.exit(1);
}

const model = getModel("gpt-5.4-nano")!;

console.log("=== With system prompt ===\n");
const { messages } = await agentLoop("What is your name and what do you do?", {
  model,
  system:
    "You are a senior TypeScript developer named AgentKit. Always introduce yourself and mention you write type-safe code.",
});

const last = messages[messages.length - 1];
const text = (last.content as { type: "text"; text: string }[])
  .filter((c) => c.type === "text")
  .map((c) => c.text)
  .join("");
console.log("Assistant:", text);

console.log("\n=== Iteration callback ===\n");
await agentLoop("What is 2+2?", {
  model,
  onStreamResult: (result, iteration) => {
    console.log(
      `Iteration ${iteration}: ${result.text ? result.text.slice(0, 80) : "(tool call)"} (${result.usage.inputTokens} in / ${result.usage.outputTokens} out)`,
    );
  },
});
