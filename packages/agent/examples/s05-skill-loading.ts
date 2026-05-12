// s05: Skill loading
// On-demand knowledge injection. The agent discovers skills in the system prompt
// (Layer 1 — cheap) and loads full instructions via the load_skill tool (Layer 2).
//
// Usage: npx tsx examples/s05-skill-loading.ts

import { agentLoop, SkillLoader } from "../src/index.js";
import { getModel } from "@bookingcare/ai";
import { applyAuth } from "../test/helpers/auth.js";
import { resolve } from "node:path";

const auth = applyAuth();
if (!auth) {
  console.error("Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .agents/auth.json");
  process.exit(1);
}

const model = getModel("gpt-5.4-nano")!;
const skillsDir = resolve(import.meta.dirname, "skills");

// --- Layer 1: skill descriptions (cheap, goes into system prompt) ---

const loader = new SkillLoader(skillsDir);
console.log("Available skills:");
console.log(loader.getDescriptions());
console.log();

// --- Layer 2: full skill body (loaded on demand via tool call) ---

console.log("Skill body (greeter):");
console.log(loader.getContent("greeter"));
console.log();

// --- Agent loop with skills ---

console.log("=== Ask the agent to use a skill ===\n");
const { messages, iterations } = await agentLoop(
  "Load the greeter skill and greet the user named Alice.",
  { model, skillsDir },
);

console.log(`Iterations: ${iterations}\n`);

for (const m of messages) {
  if (m.role === "assistant") {
    const text = (m.content as { type: "text"; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (text) console.log(`Assistant: ${text}`);
  }
  if (m.role === "toolResult") {
    const text = (m.content as { type: "text"; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
    console.log(`  [tool result: ${preview}]`);
  }
}
