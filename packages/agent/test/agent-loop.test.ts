import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { agentLoop } from "../src/agent-loop.js";
import { Type, tool } from "@bookingcare/ai";
import { createToolDispatch } from "../src/tools.js";
import type { McpRegistry } from "../src/mcp/registry.js";
import { auth, liveModel as getLiveModel } from "./helpers/live-model.js";

import type { StreamResult } from "@bookingcare/ai";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// --- s01: Agent loop basics (bash only) ---

describe.skipIf(!auth)("agentLoop e2e", () => {
  it("answers a simple question without tools", async () => {
    const { messages, iterations } = await agentLoop("What is 2+2? Reply with just the number.", {
      model: getLiveModel(),
    });

    expect(iterations).toBe(1);
    expect(messages.length).toBe(2); // user + assistant

    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(
      (last.content as { type: "text"; text: string }[]).some((c) => c.text.includes("4")),
    ).toBe(true);
  });

  it("uses bash tool to list files", async () => {
    const { messages, iterations } = await agentLoop(
      "List all .ts files in the current directory using bash. Reply with just the filenames.",
      { model: getLiveModel() },
    );

    expect(iterations).toBeGreaterThanOrEqual(2);
    expect(messages.length).toBeGreaterThanOrEqual(4);

    const toolResults = messages.filter((m) => m.role === "toolResult");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
  });

  it("creates a file via bash tool", async () => {
    const workdir = resolve(tmpdir(), `agent-bash-test-${Date.now()}`);
    mkdirSync(workdir, { recursive: true });
    try {
      const { messages, iterations } = await agentLoop(
        "Use bash to create a file called test.txt in the workspace with the content 'hello from agent loop'. Run: echo 'hello from agent loop' > test.txt",
        { model: getLiveModel(), workdir },
      );

      expect(iterations).toBeGreaterThanOrEqual(2);
      expect(messages.some((m) => m.role === "toolResult")).toBe(true);

      const content = readFileSync(resolve(workdir, "test.txt"), "utf-8");
      expect(content).toContain("hello from agent loop");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("chains multiple tool calls", async () => {
    const workdir = resolve(tmpdir(), `agent-chain-test-${Date.now()}`);
    mkdirSync(workdir, { recursive: true });
    try {
      const { messages, iterations } = await agentLoop(
        "Create 3 files in the workspace: a.txt containing 'a', b.txt containing 'b', c.txt containing 'c'. Use bash to run: mkdir -p subdir && echo a > subdir/a.txt && echo b > subdir/b.txt && echo c > subdir/c.txt",
        { model: getLiveModel(), workdir },
      );

      expect(iterations).toBeGreaterThanOrEqual(2);
      expect(messages.filter((m) => m.role === "toolResult").length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("respects maxIterations limit", async () => {
    const { iterations } = await agentLoop("Keep running 'echo hello' over and over forever.", {
      model: getLiveModel(),
      maxIterations: 3,
    });

    expect(iterations).toBeLessThanOrEqual(3);
  });

  it("reports current git branch", async () => {
    const { messages } = await agentLoop(
      "What is the current git branch? Use bash to run: git branch --show-current. Reply with just the branch name.",
      {
        model: getLiveModel(),
        workdir: resolve(import.meta.dirname, "../../.."),
      },
    );

    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(messages.some((m) => m.role === "toolResult")).toBe(true);
  });

  it("invokes onStreamResult callback", async () => {
    const results: { result: StreamResult; iteration: number }[] = [];

    await agentLoop("What is 2+2? Reply with just the number.", {
      model: getLiveModel(),
      onStreamResult: (result, iteration) => {
        results.push({ result, iteration });
      },
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].iteration).toBe(1);
    expect(results[0].result.usage.input).toBeGreaterThan(0);
  });

  it("respects system prompt", async () => {
    const { messages } = await agentLoop("What is your name?", {
      model: getLiveModel(),
      system: "You are a helpful assistant named TestBot. Always introduce yourself as TestBot.",
    });

    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    const text = (last.content as { type: "text"; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.toLowerCase()).toContain("testbot");
  });
});

// --- s02: Tool dispatch (read, write, edit) ---

describe.skipIf(!auth)("tool dispatch e2e", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = resolve(tmpdir(), `agent-test-${Date.now()}`);
    mkdirSync(workdir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("creates a file with write_file", async () => {
    const { messages, iterations } = await agentLoop(
      "Create a file called greet.py with a greet(name) function that returns a greeting string.",
      { model: getLiveModel(), workdir },
    );

    expect(iterations).toBeGreaterThanOrEqual(2);

    const content = readFileSync(resolve(workdir, "greet.py"), "utf-8");
    expect(content).toContain("greet");
    expect(content).toContain("def ");
  });

  it("reads a file with read_file", async () => {
    writeFileSync(resolve(workdir, "data.txt"), "line1\nline2\nline3\nline4\nline5\n");

    const { messages } = await agentLoop(
      "Read the file data.txt and tell me how many lines it has.",
      {
        model: getLiveModel(),
        workdir,
      },
    );

    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    // Model should have read the file and report 5 lines
    const text = (last.content as { type: "text"; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("5");
  });

  it("edits a file with edit_file", async () => {
    writeFileSync(resolve(workdir, "greet.py"), 'def greet(name):\n    return "Hello " + name\n');

    const { messages } = await agentLoop(
      'Edit greet.py to change the greeting from "Hello" to "Hi".',
      { model: getLiveModel(), workdir },
    );

    expect(messages.some((m) => m.role === "toolResult")).toBe(true);

    const content = readFileSync(resolve(workdir, "greet.py"), "utf-8");
    expect(content).toContain("Hi");
    expect(content).not.toContain("Hello");
  });

  it("reads after write to verify content", async () => {
    const { messages } = await agentLoop(
      "Create a file called notes.txt with the content 'my secret notes', then read it back to verify.",
      { model: getLiveModel(), workdir },
    );

    const toolResults = messages.filter((m) => m.role === "toolResult");
    // Should have at least 2 tool calls (write + read)
    expect(toolResults.length).toBeGreaterThanOrEqual(2);

    const content = readFileSync(resolve(workdir, "notes.txt"), "utf-8");
    expect(content).toContain("my secret notes");
  });

  it("rejects path traversal attacks", async () => {
    const { dispatch } = await createToolDispatch(workdir);

    expect(() => dispatch["read_file"]({ path: "../../etc/passwd" })).toThrow(
      "Path escapes workspace",
    );
    expect(() => dispatch["write_file"]({ path: "../../../tmp/evil", content: "pwned" })).toThrow(
      "Path escapes workspace",
    );
  });
});

// --- s05: Skill loading ---

describe.skipIf(!auth)("skill loading e2e", () => {
  const skillsDir = resolve(import.meta.dirname, "fixtures/skills");

  it("injects skill descriptions into system prompt", async () => {
    const { dispatch } = await createToolDispatch(process.cwd(), skillsDir);

    // The load_skill handler should be present
    expect(dispatch["load_skill"]).toBeDefined();
  });

  it("loads a skill via the agent loop", async () => {
    const { messages, iterations } = await agentLoop(
      "Load the greeter skill and follow its instructions to greet the user named Alice.",
      {
        model: getLiveModel(),
        skillsDir,
      },
    );

    expect(iterations).toBeGreaterThanOrEqual(2);

    // Should have loaded the skill via tool call
    const toolResults = messages.filter((m) => m.role === "toolResult");
    const skillResults = toolResults.filter(
      (m) =>
        m.role === "toolResult" &&
        m.content.some((c) => c.type === "text" && c.text.includes('<skill name="greeter">')),
    );
    expect(skillResults.length).toBeGreaterThanOrEqual(1);

    // Final response should contain a greeting for Alice
    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    const text = (last.content as { type: "text"; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text.toLowerCase()).toContain("alice");
  });

  it("works without skills dir (backward compatible)", async () => {
    const { messages, iterations } = await agentLoop("What is 1+1? Reply with just the number.", {
      model: getLiveModel(),
    });

    expect(iterations).toBe(1);
    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
  });
});

// --- Tool dispatch unit tests ---

describe("tool dispatch", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = resolve(tmpdir(), `agent-tool-test-${Date.now()}`);
    mkdirSync(workdir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("bash throws on non-zero exit", async () => {
    const { dispatch } = await createToolDispatch(workdir);
    expect(() => dispatch["bash"]({ command: "exit 1" })).toThrow();
  });

  it("edit_file throws when old_text not found", async () => {
    writeFileSync(resolve(workdir, "test.txt"), "hello world");
    const { dispatch } = await createToolDispatch(workdir);
    expect(() =>
      dispatch["edit_file"]({
        path: "test.txt",
        old_text: "nonexistent",
        new_text: "replaced",
      }),
    ).toThrow("old_text not found");
  });

  it("edit_file throws when old_text is not unique", async () => {
    writeFileSync(resolve(workdir, "test.txt"), "abc def abc");
    const { dispatch } = await createToolDispatch(workdir);
    expect(() =>
      dispatch["edit_file"]({
        path: "test.txt",
        old_text: "abc",
        new_text: "xyz",
      }),
    ).toThrow("not unique");
  });

  it("read_file throws on negative limit", async () => {
    writeFileSync(resolve(workdir, "test.txt"), "line1\nline2\nline3\n");
    const { dispatch } = await createToolDispatch(workdir);
    expect(() => dispatch["read_file"]({ path: "test.txt", limit: -1 })).toThrow("Invalid limit");
  });

  it("registers MCP tools and delegates calls", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const mcpRegistry = {
      getAllTools: async () => [
        tool({
          name: "alpha:lookup",
          description: "Lookup",
          parameters: Type.Object({}),
        }),
      ],
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return "mcp-result";
      },
    };

    const { tools, dispatch } = await createToolDispatch(
      workdir,
      undefined,
      undefined,
      mcpRegistry as unknown as McpRegistry,
    );

    expect(tools.some((tool) => tool.name === "alpha:lookup")).toBe(true);
    await expect(dispatch["alpha:lookup"]({ query: "hello" })).resolves.toBe("mcp-result");
    expect(calls).toEqual([{ name: "alpha:lookup", args: { query: "hello" } }]);
  });

  it("propagates MCP tool failures to the agent loop", async () => {
    const mcpRegistry = {
      getAllTools: async () => [
        tool({
          name: "alpha:lookup",
          description: "Lookup",
          parameters: Type.Object({}),
        }),
      ],
      callTool: async () => {
        throw new Error("mcp failed");
      },
    };

    const { dispatch } = await createToolDispatch(
      workdir,
      undefined,
      undefined,
      mcpRegistry as unknown as McpRegistry,
    );

    await expect(dispatch["alpha:lookup"]({ query: "hello" })).rejects.toThrow("mcp failed");
  });
});

// --- Todo tracking ---

describe.skipIf(!auth)("todo tracking e2e", () => {
  it("uses todo tool to plan a multi-step task", async () => {
    const { messages, iterations } = await agentLoop(
      "Create a plan with 3 tasks: plan, code, test. Use the todo tool to create the list.",
      { model: getLiveModel() },
    );

    expect(iterations).toBeGreaterThanOrEqual(2);

    // Should have at least one todo tool call
    const toolResults = messages.filter((m) => m.role === "toolResult" && m.toolName === "todo");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);

    // The todo result should contain formatted items
    const todoResult = toolResults[0];
    const text = (todoResult.content as { type: "text"; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("[ ]");
    expect(text).toContain("plan");
  });

  it("tracks progress through task completion", async () => {
    const { messages } = await agentLoop(
      "Create a todo list with 2 tasks: 'write code' and 'write tests'. " +
        "Then mark 'write code' as in_progress, then completed. Use the todo tool for each step.",
      { model: getLiveModel() },
    );

    const todoResults = messages.filter((m) => m.role === "toolResult" && m.toolName === "todo");
    // Should have multiple todo calls (create -> update in_progress -> update completed)
    expect(todoResults.length).toBeGreaterThanOrEqual(2);
  });
});
