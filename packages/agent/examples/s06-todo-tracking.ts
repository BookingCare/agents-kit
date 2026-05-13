// s06: Todo tracking
// The agent plans multi-step tasks using the todo tool and tracks progress.
// A nag reminder fires if the model forgets to update its todos for 3 rounds.
//
// Usage: npx tsx examples/s06-todo-tracking.ts

import { agentLoop } from "../src/index.js";
import { getModel } from "@bookingcare/ai";
import { applyAuth } from "../test/helpers/auth.js";

const auth = applyAuth();
if (!auth) {
  console.error("Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .agents/auth.json");
  process.exit(1);
}

const model = getModel("gpt-5.4-nano")!;

console.log("=== Multi-step task with todo tracking ===\n");

const { messages, iterations } = await agentLoop(
  "I need you to plan and execute 3 tasks: " +
    "1) Create a file called plan.txt with a brief project plan. " +
    "2) Create a file called code.ts with a simple hello function. " +
    "3) Create a file called test.ts with a basic test. " +
    "Use the todo tool to track your progress on each step.",
  { model },
);

console.log(`Iterations: ${iterations}\n`);

for (const m of messages) {
  if (m.role === "assistant") {
    const text = (m.content as { type: "text"; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (text) console.log(`Assistant: ${text.slice(0, 200)}`);
  }
  if (m.role === "toolResult") {
    const text = (m.content as { type: "text"; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    const name = m.toolName;
    const preview = text.length > 150 ? text.slice(0, 150) + "..." : text;
    console.log(`  [${name}]: ${preview}`);
  }
}
