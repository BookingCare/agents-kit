// s02: Tool dispatch — file read/write/edit
// The agent uses structured file tools instead of raw bash for file operations.
//
// Usage: npx tsx examples/s02-file-tools.ts

import { agentLoop } from "../src/index.js";
import { getModel } from "@bookingcare/ai";
import { applyAuth } from "../test/helpers/auth.js";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const auth = applyAuth();
if (!auth) {
  console.error("Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .agents/auth.json");
  process.exit(1);
}

const model = getModel("gpt-5.4-nano")!;

// Create a temporary workspace
const workdir = resolve(tmpdir(), `agent-example-s02-${Date.now()}`);
mkdirSync(workdir, { recursive: true });

try {
  // Write a file
  console.log("=== Write a file ===");
  const { messages: m1 } = await agentLoop(
    "Create a file called hello.txt with the content 'Hello, world!'",
    { model, workdir },
  );
  printAssistant(m1);
  console.log("File on disk:", readFileSync(resolve(workdir, "hello.txt"), "utf-8"));

  // Edit the file
  console.log("\n=== Edit the file ===");
  const { messages: m2 } = await agentLoop("Change 'world' to 'agent' in hello.txt", {
    model,
    workdir,
  });
  printAssistant(m2);
  console.log("File on disk:", readFileSync(resolve(workdir, "hello.txt"), "utf-8"));

  // Read it back
  console.log("\n=== Read the file ===");
  const { messages: m3 } = await agentLoop("Read hello.txt and tell me its contents.", {
    model,
    workdir,
  });
  printAssistant(m3);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

function printAssistant(messages: Awaited<ReturnType<typeof agentLoop>>["messages"]) {
  const last = messages[messages.length - 1];
  if (last.role === "assistant") {
    const text = (last.content as { type: "text"; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (text) console.log("Assistant:", text);
  }
}
