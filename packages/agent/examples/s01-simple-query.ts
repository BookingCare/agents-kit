// s01: Basic agent loop
// A simple agent that answers questions without any tools.
//
// Usage: npx tsx examples/s01-simple-query.ts

import { agentLoop } from "../src/index.js";
import { getModel } from "@bookingcare/ai";
import { applyAuth } from "../test/helpers/auth.js";

const auth = applyAuth();
if (!auth) {
  console.error("Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .agents/auth.json");
  process.exit(1);
}

const model = getModel("gpt-5.4-nano")!;

const { messages, iterations } = await agentLoop(
  "What is the capital of France? Reply in one sentence.",
  { model },
);

console.log(`Iterations: ${iterations}`);
console.log();
for (const m of messages) {
  if (m.role === "user") console.log(`User: ${(m.content as string).slice(0, 200)}`);
  if (m.role === "assistant") {
    const text = (m.content as { type: "text"; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (text) console.log(`Assistant: ${text}`);
  }
}
