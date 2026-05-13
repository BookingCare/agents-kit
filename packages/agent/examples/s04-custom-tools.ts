// s04: Custom tool dispatch
// Shows how to add custom tools to the dispatch table alongside the built-in file tools.
//
// Usage: npx tsx examples/s04-custom-tools.ts

import { agentLoop, createToolDispatch } from "../src/index.js";
import { getModel, Type, tool } from "@bookingcare/ai";
import { applyAuth } from "../test/helpers/auth.js";

const auth = applyAuth();
if (!auth) {
  console.error("Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .agents/auth.json");
  process.exit(1);
}

const model = getModel("gpt-5.4-nano")!;

// Define a custom tool
const currentTimeTool = tool({
  name: "current_time",
  description: "Get the current date and time in ISO format.",
  parameters: Type.Object({}),
});

// Build dispatch with the custom tool added
const { tools, dispatch } = createToolDispatch();
dispatch["current_time"] = () => new Date().toISOString();
tools.push(currentTimeTool);

const { messages } = await agentLoop("What time is it right now? Use the current_time tool.", {
  model,
  tools,
  dispatch,
});

const last = messages[messages.length - 1];
const text = (last.content as { type: "text"; text: string }[])
  .filter((c) => c.type === "text")
  .map((c) => c.text)
  .join("");
console.log("Assistant:", text);
