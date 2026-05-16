import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  Type,
} from "@bookingcare/ai";
import { describe, expect, it, vi } from "vitest";
import {
  Agent,
  DEFAULT_RULES,
  PermissionManager,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
  type PermissionManagerOptions,
  type PermissionNeededEvent,
  type StreamFn,
} from "../src/index.js";
import path from "node:path";
import os from "node:os";

type MockResponse = {
  text?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  stopReason?: "stop" | "length" | "toolUse";
};

const TEST_MODEL: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
};

const echoTool: AgentTool = {
  name: "echo",
  description: "Echoes back the provided message",
  parameters: Type.Object({ message: Type.String() }),
  label: "Echo",
  execute: async (_toolCallId, params) => {
    const { message } = params as { message: string };
    return { content: message };
  },
};

const pathTool: AgentTool = {
  name: "inspect_path",
  description: "Returns the path",
  parameters: Type.Object({ path: Type.String() }),
  label: "Inspect Path",
  execute: async (_toolCallId, params) => {
    const { path: filePath } = params as { path: string };
    return { content: filePath };
  },
};

function getTextContent(message: AgentMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function buildAssistantMessage(response: MockResponse): AssistantMessage {
  const content: AssistantMessage["content"] = [];

  if (response.text) {
    content.push({ type: "text", text: response.text });
  }

  if (response.toolCalls) {
    for (const toolCall of response.toolCalls) {
      content.push({
        type: "toolCall",
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      });
    }
  }

  return {
    role: "assistant",
    content,
    api: TEST_MODEL.api,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: response.stopReason ?? "stop",
    timestamp: Date.now(),
  };
}

function createMockStream(responses: MockResponse[]): StreamFn {
  const remaining = [...responses];

  return (_model, _context, _options) => {
    const stream = createAssistantMessageEventStream();
    const response = remaining.shift();
    if (!response) {
      throw new Error("No more mock responses");
    }

    setTimeout(() => {
      const assistant = buildAssistantMessage(response);

      stream.push({ type: "start", partial: assistant });
      if (response.text) {
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: response.text,
          partial: assistant,
        });
      }

      const contentIndexOffset = response.text ? 1 : 0;
      response.toolCalls?.forEach((toolCall, index) => {
        const contentIndex = contentIndexOffset + index;
        stream.push({ type: "toolcall_start", contentIndex, partial: assistant });
        stream.push({
          type: "toolcall_end",
          contentIndex,
          toolCall: {
            type: "toolCall",
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          },
          partial: assistant,
        });
      });

      stream.push({
        type: "done",
        reason: response.stopReason ?? "stop",
        message: assistant,
      });
    }, 0);

    return stream;
  };
}

function createAgent(options: {
  streamFn: StreamFn;
  permissionManager?: AgentOptions["permissionManager"];
  beforeToolCall?: AgentOptions["beforeToolCall"];
  tools?: AgentTool[];
}) {
  return new Agent({
    initialState: {
      model: TEST_MODEL,
      systemPrompt: "You are a helpful assistant.",
      thinkingLevel: "off",
      tools: options.tools ?? [echoTool],
      messages: [],
    },
    streamFn: options.streamFn,
    permissionManager: options.permissionManager,
    beforeToolCall: options.beforeToolCall,
  });
}

describe("PermissionManager", () => {
  it("uses the default rule set", () => {
    const manager = new PermissionManager();

    expect(manager.listRules()).toEqual(DEFAULT_RULES);
    expect(manager.evaluate("read_file", { path: "/tmp/file.txt" })).toMatchObject({
      action: "allow",
    });
    expect(manager.evaluate("bash", { command: "ls -la" })).toMatchObject({ action: "ask" });
    expect(manager.evaluate("unknown_tool", {})).toMatchObject({ action: "deny" });
  });

  it("appends grants and keeps last-match-wins evaluation", () => {
    const manager = new PermissionManager({
      rules: [{ tool: "echo", action: "deny" }],
    });

    manager.grant({ tool: "echo", action: "allow" });

    expect(manager.listRules()).toHaveLength(2);
    expect(manager.evaluate("echo", {})).toMatchObject({ action: "allow" });
  });

  it("matches scoped paths and commands with OR semantics", () => {
    const basePath = path.resolve(os.tmpdir(), `permission-manager-${Date.now()}`);
    const manager = new PermissionManager({
      rules: [
        {
          tool: "bash",
          action: "allow",
          scope: {
            paths: [basePath],
            commands: ["ls"],
          },
        },
      ],
    });

    expect(
      manager.evaluate("bash", {
        path: path.join(basePath, "nested", "file.txt"),
      }),
    ).toMatchObject({ action: "allow" });

    expect(manager.evaluate("bash", { command: "ls -la" })).toMatchObject({ action: "allow" });
    expect(
      manager.evaluate("bash", {
        path: path.resolve(os.tmpdir(), "elsewhere.txt"),
        command: "pwd",
      }),
    ).toMatchObject({ action: "deny" });
  });

  it("revokes all rules for a tool and ignores missing tools", () => {
    const manager = new PermissionManager({
      rules: [
        { tool: "bash", action: "deny" },
        { tool: "read_file", action: "allow" },
      ],
    });

    manager.revoke("missing");
    expect(manager.listRules()).toHaveLength(2);

    manager.revoke("bash");
    expect(manager.listRules()).toEqual([{ tool: "read_file", action: "allow" }]);
  });

  it("round-trips through JSON serialization", () => {
    const manager = new PermissionManager({
      rules: [{ tool: "write_file", action: "ask", scope: { paths: ["/tmp"] } }],
    });

    const reloaded = new PermissionManager({
      rules: JSON.parse(JSON.stringify(manager.listRules())) as PermissionManagerOptions["rules"],
    });

    expect(reloaded.listRules()).toEqual(manager.listRules());
  });
});

describe("Agent permission integration", () => {
  it("runs beforeToolCall after permission allow", async () => {
    const streamFn = createMockStream([
      {
        toolCalls: [{ id: "tc-1", name: "echo", arguments: { message: "hello" } }],
        stopReason: "toolUse",
      },
      { text: "done" },
    ]);

    const beforeToolCall = vi.fn(async () => ({ action: "continue" as const }));
    const manager = new PermissionManager({
      rules: [{ tool: "echo", action: "ask" }],
    });
    let permissionEvent: PermissionNeededEvent | undefined;

    const agent = createAgent({
      streamFn,
      permissionManager: manager,
      beforeToolCall,
    });

    agent.subscribe((event) => {
      if (event.type === "permission_needed") {
        permissionEvent = event;
        event.resolve("allow");
      }
    });

    await agent.prompt("Use echo");

    expect(permissionEvent).toMatchObject({
      type: "permission_needed",
      toolName: "echo",
      toolCallId: "tc-1",
      args: { message: "hello" },
      rule: { tool: "echo", action: "ask" },
    });
    expect(beforeToolCall).toHaveBeenCalledTimes(1);

    const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toBeDefined();
    if (!toolResult || toolResult.role !== "toolResult") {
      throw new Error("Expected tool result message");
    }
    expect(getTextContent(toolResult)).toBe("hello");
  });

  it("accepts custom permission manager implementations", async () => {
    const streamFn = createMockStream([
      {
        toolCalls: [{ id: "tc-1", name: "echo", arguments: { message: "hello" } }],
        stopReason: "toolUse",
      },
      { text: "done" },
    ]);

    const permissionManager: NonNullable<AgentOptions["permissionManager"]> = {
      evaluate: () => ({
        action: "allow",
        rule: { tool: "echo", action: "allow" },
      }),
    };

    const agent = createAgent({
      streamFn,
      permissionManager,
    });

    await agent.prompt("Use echo");

    const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toBeDefined();
    if (!toolResult || toolResult.role !== "toolResult") {
      throw new Error("Expected tool result message");
    }
    expect(getTextContent(toolResult)).toBe("hello");
  });

  it("re-evaluates permission after beforeToolCall replaces args", async () => {
    const safeDir = path.resolve(os.tmpdir(), `permission-manager-safe-${Date.now()}`);
    const safePath = path.join(safeDir, "inside.txt");
    const unsafePath = path.resolve(os.tmpdir(), `permission-manager-unsafe-${Date.now()}.txt`);

    const streamFn = createMockStream([
      {
        toolCalls: [{ id: "tc-1", name: "inspect_path", arguments: { path: safePath } }],
        stopReason: "toolUse",
      },
      { text: "done" },
    ]);

    const beforeToolCall = vi.fn(async () => ({
      action: "replace" as const,
      args: { path: unsafePath },
    }));
    const manager = new PermissionManager({
      rules: [
        { tool: "inspect_path", action: "deny" },
        { tool: "inspect_path", action: "allow", scope: { paths: [safeDir] } },
      ],
    });

    const agent = createAgent({
      streamFn,
      tools: [pathTool],
      permissionManager: manager,
      beforeToolCall,
    });

    await agent.prompt("Use inspect_path");

    expect(beforeToolCall).toHaveBeenCalledTimes(1);

    const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toBeDefined();
    if (!toolResult || toolResult.role !== "toolResult") {
      throw new Error("Expected tool result message");
    }
    expect(toolResult.isError).toBe(true);
    expect(getTextContent(toolResult)).toBe("Permission denied.");
  });

  it("returns a denied tool result when permission is rejected", async () => {
    const streamFn = createMockStream([
      {
        toolCalls: [{ id: "tc-1", name: "echo", arguments: { message: "hello" } }],
        stopReason: "toolUse",
      },
      { text: "done" },
    ]);

    const beforeToolCall = vi.fn(async () => ({ action: "continue" as const }));
    const manager = new PermissionManager({
      rules: [{ tool: "echo", action: "ask" }],
    });
    let permissionEvent: PermissionNeededEvent | undefined;

    const agent = createAgent({
      streamFn,
      permissionManager: manager,
      beforeToolCall,
    });

    agent.subscribe((event) => {
      if (event.type === "permission_needed") {
        permissionEvent = event;
        event.resolve("deny");
      }
    });

    await agent.prompt("Use echo");

    expect(permissionEvent).toMatchObject({
      type: "permission_needed",
      toolName: "echo",
      toolCallId: "tc-1",
    });
    expect(beforeToolCall).not.toHaveBeenCalled();

    const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toBeDefined();
    if (!toolResult || toolResult.role !== "toolResult") {
      throw new Error("Expected tool result message");
    }
    expect(toolResult.isError).toBe(true);
    expect(getTextContent(toolResult)).toBe("Permission denied.");
  });

  it("stays pending until permission is resolved", async () => {
    const streamFn = createMockStream([
      {
        toolCalls: [{ id: "tc-1", name: "echo", arguments: { message: "hello" } }],
        stopReason: "toolUse",
      },
      { text: "done" },
    ]);

    const manager = new PermissionManager({
      rules: [{ tool: "echo", action: "ask" }],
    });
    let permissionEvent: PermissionNeededEvent | undefined;

    const agent = createAgent({
      streamFn,
      permissionManager: manager,
    });

    agent.subscribe((event) => {
      if (event.type === "permission_needed") {
        permissionEvent = event;
      }
    });

    let settled = false;
    const run = agent.prompt("Use echo").then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(permissionEvent).toBeDefined();
    expect(settled).toBe(false);

    permissionEvent!.resolve("allow");
    await run;

    expect(settled).toBe(true);

    const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toBeDefined();
  });

  it("skips beforeToolCall when permission is denied immediately", async () => {
    const streamFn = createMockStream([
      {
        toolCalls: [{ id: "tc-1", name: "echo", arguments: { message: "hello" } }],
        stopReason: "toolUse",
      },
      { text: "done" },
    ]);

    const beforeToolCall = vi.fn(async () => ({ action: "continue" as const }));
    const manager = new PermissionManager({
      rules: [{ tool: "echo", action: "deny" }],
    });

    const agent = createAgent({
      streamFn,
      permissionManager: manager,
      beforeToolCall,
    });

    await agent.prompt("Use echo");

    expect(beforeToolCall).not.toHaveBeenCalled();

    const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toBeDefined();
    if (!toolResult || toolResult.role !== "toolResult") {
      throw new Error("Expected tool result message");
    }
    expect(toolResult.isError).toBe(true);
    expect(getTextContent(toolResult)).toBe("Permission denied.");
  });
});
