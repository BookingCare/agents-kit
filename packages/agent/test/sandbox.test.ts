import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSandbox } from "@bookingcare/infa";
import { createToolDispatch, type ToolDispatch } from "../src/tools.js";
import { runAgentLoop } from "../src/agent-loop.js";
import type { AgentMessage, AgentTool, AgentLoopConfig } from "../src/types.js";
import type { Model } from "@bookingcare/ai";
import { createMockStream } from "./helpers/helpers.js";

const TEST_MODEL: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://test.example.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
};

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function toAgentTools(dispatchBundle: ToolDispatch): AgentTool[] {
  return dispatchBundle.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as AgentTool["parameters"],
    label: tool.name,
    execute: async (_toolCallId, params) => {
      const handler = dispatchBundle.dispatch[tool.name];
      if (!handler) {
        throw new Error(`Missing dispatch handler: ${tool.name}`);
      }
      return { content: await handler(params as Record<string, unknown>) };
    },
  }));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("sandbox dispatch integration", () => {
  it("routes bash through the sandbox and awaits async tool execution", async () => {
    const workdir = createTempDir("agent-sandbox-bash-");
    const sandbox = createSandbox({ kind: "local", workdir });
    const dispatchBundle = createToolDispatch(workdir, undefined, sandbox);
    const agentTools = toAgentTools(dispatchBundle);

    const streamFn = createMockStream([
      {
        toolCalls: [
          {
            id: "tc1",
            name: "bash",
            arguments: JSON.stringify({
              command: `"${process.execPath}" -e "process.stdout.write('done')"`,
            }),
          },
        ],
        stopReason: "toolUse",
      },
      { text: "finished" },
    ]);

    const config: AgentLoopConfig = {
      model: TEST_MODEL,
      toolExecution: "sequential",
      convertToLlm: (messages) => messages,
      getSteeringMessages: async () => [],
      getFollowUpMessages: async () => [],
    };

    const messages: AgentMessage[] = [];
    await runAgentLoop(
      [{ role: "user", content: "run bash", timestamp: Date.now() }],
      { systemPrompt: "", messages, tools: agentTools },
      config,
      async () => undefined,
      new AbortController().signal,
      streamFn,
    );

    expect(streamFn).toHaveBeenCalledTimes(2);
  });

  it("routes read/write/edit through the sandbox", async () => {
    const workdir = createTempDir("agent-sandbox-files-");
    const sandbox = createSandbox({ kind: "local", workdir });
    const dispatchBundle = createToolDispatch(workdir, undefined, sandbox);

    await dispatchBundle.dispatch.write_file({
      path: "nested/file.txt",
      content: "hello",
    });

    await expect(dispatchBundle.dispatch.read_file({ path: "nested/file.txt" })).resolves.toBe(
      "hello",
    );

    await dispatchBundle.dispatch.edit_file({
      path: "nested/file.txt",
      old_text: "hello",
      new_text: "hi",
    });

    expect(readFileSync(join(workdir, "nested/file.txt"), "utf-8")).toBe("hi");
  });

  it("preserves the 50KB default cap for sandboxed read_file", async () => {
    const workdir = createTempDir("agent-sandbox-read-cap-");
    const sandbox = createSandbox({ kind: "local", workdir });
    const dispatchBundle = createToolDispatch(workdir, undefined, sandbox);

    writeFileSync(join(workdir, "big.txt"), "a".repeat(60_000));

    const content = await dispatchBundle.dispatch.read_file({ path: "big.txt" });
    expect(content.length).toBe(50_000);
    expect(content).toBe("a".repeat(50_000));
  });

  it("enforces timeout through the dispatch flow", async () => {
    const workdir = createTempDir("agent-sandbox-timeout-");
    const sandbox = createSandbox({ kind: "local", workdir, timeout: 50 });
    const dispatchBundle = createToolDispatch(workdir, undefined, sandbox);

    await expect(
      dispatchBundle.dispatch.bash({ command: `"${process.execPath}" -e "while(true){}"` }),
    ).rejects.toThrow(/timeout.*exit code/i);
  });

  it("enforces output limits through the dispatch flow", async () => {
    const workdir = createTempDir("agent-sandbox-output-");
    const sandbox = createSandbox({ kind: "local", workdir, maxOutput: 100 });
    const dispatchBundle = createToolDispatch(workdir, undefined, sandbox);

    await expect(
      dispatchBundle.dispatch.bash({
        command: `"${process.execPath}" -e "process.stdout.write('x'.repeat(5000))"`,
      }),
    ).rejects.toThrow(/output.*exit code/i);
  });
});
