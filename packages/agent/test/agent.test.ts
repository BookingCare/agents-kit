import { Type } from "@bookingcare/ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "../src/index.js";
import { auth, liveModel as getLiveModel, type LiveModel } from "./helpers/live-model.js";

const IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3Z4eQAAAAASUVORK5CYII=";

function createAgent(liveModel: LiveModel, tools: AgentTool[] = [], systemPrompt = "") {
  return new Agent({
    initialState: {
      model: liveModel,
      systemPrompt,
      thinkingLevel: "off",
      tools,
      messages: [],
    },
  });
}

function getTextContent(message: AgentMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function waitForStreaming(agent: Agent, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!agent.state.isStreaming) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for streaming to start");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const echoTool: AgentTool = {
  name: "echo",
  description: "Echoes back the input",
  parameters: Type.Object({ message: Type.String() }),
  label: "Echo",
  execute: async (_toolCallId, params) => {
    const { message } = params as { message: string };
    return {
      content: message,
    };
  },
};

const failTool: AgentTool = {
  name: "fail",
  description: "Always fails",
  parameters: Type.Object({}),
  label: "Fail",
  execute: async () => {
    throw new Error("Tool failed");
  },
};

describe.skipIf(!auth)("Agent", () => {
  it("emits message lifecycle events on prompt", async () => {
    const agent = createAgent(
      getLiveModel(),
      [],
      "You are a helpful assistant. Keep your responses concise.",
    );
    const events: AgentEvent[] = [];

    agent.subscribe((event) => {
      events.push(event);
    });

    await agent.prompt("What is 2+2? Answer with just the number.");

    const types = events.map((event) => event.type);
    expect(types).toContain("message_start");
    expect(types).toContain("message_update");
    expect(types).toContain("message_end");
    expect(types).toContain("agent_end");
    expect(types.indexOf("message_start")).toBeLessThan(types.indexOf("message_update"));
    expect(types.indexOf("message_update")).toBeLessThan(types.indexOf("message_end"));
    expect(types.indexOf("message_end")).toBeLessThan(types.indexOf("agent_end"));

    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.messages).toHaveLength(2);
  });

  it("throws if prompt is called while already running", async () => {
    const agent = createAgent(getLiveModel(), [], "You are a helpful assistant.");
    const firstPrompt = agent.prompt(
      "Write a long, detailed explanation of how to stay calm during a busy day, using at least eight numbered points.",
    );

    await waitForStreaming(agent);
    await expect(agent.prompt("Second prompt")).rejects.toThrow("already processing");
    await firstPrompt;
  });

  it("executes tool calls and returns results", async () => {
    const agent = createAgent(
      getLiveModel(),
      [echoTool],
      "You are a helpful assistant. When asked to repeat a word, you must use the echo tool.",
    );

    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    await agent.prompt("Use the echo tool to repeat HELLO exactly.");

    expect(events.some((event) => event.type === "tool_execution_start")).toBe(true);
    expect(events.some((event) => event.type === "tool_execution_end")).toBe(true);
    expect(agent.state.pendingToolCalls.size).toBe(0);

    const toolResultMsg = agent.state.messages.find((message) => message.role === "toolResult");
    expect(toolResultMsg).toBeDefined();
    if (toolResultMsg?.role !== "toolResult") throw new Error("Expected tool result message");
    expect(getTextContent(toolResultMsg)).toContain("HELLO");

    const finalMessage = agent.state.messages.at(-1);
    if (!finalMessage || finalMessage.role !== "assistant") {
      throw new Error("Expected final assistant message");
    }
    expect(getTextContent(finalMessage)).toContain("HELLO");
  });

  it("handles tool execution errors gracefully", async () => {
    const agent = createAgent(
      getLiveModel(),
      [failTool],
      "You are a helpful assistant. When asked to fail, call the fail tool.",
    );

    await agent.prompt("Make it fail.");

    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.messages.at(-1)?.role).toBe("assistant");
  });

  it("aborts a running prompt", async () => {
    const agent = createAgent(getLiveModel(), [], "You are a helpful assistant.");
    const prompt = agent.prompt(
      "Write a long, detailed explanation of how the internet works in at least ten paragraphs.",
    );

    await waitForStreaming(agent);
    agent.abort();

    await prompt;
    await agent.waitForIdle();

    expect(agent.state.isStreaming).toBe(false);
  });

  it("steer injects messages between turns", async () => {
    const agent = createAgent(
      getLiveModel(),
      [echoTool],
      "You are a helpful assistant. When asked to repeat a word, you must use the echo tool.",
    );

    agent.steer({ role: "user", content: "Steered message", timestamp: Date.now() });

    await agent.prompt("Use the echo tool to repeat FIRST exactly.");

    const steered = agent.state.messages.find(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content === "Steered message",
    );
    expect(steered).toBeDefined();
  });

  it("followUp runs after agent would otherwise stop", async () => {
    const agent = createAgent(getLiveModel(), [], "You are a helpful assistant.");

    agent.followUp({ role: "user", content: "Continue", timestamp: Date.now() });

    await agent.prompt("Start");

    expect(agent.state.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(
      agent.state.messages.find(
        (message) => message.role === "user" && message.content === "Continue",
      ),
    ).toBeDefined();
  });

  it("subscribe returns unsubscribe function", async () => {
    const agent = createAgent(getLiveModel(), [], "You are a helpful assistant.");
    const events: AgentEvent[] = [];

    const unsubscribe = agent.subscribe((event) => {
      events.push(event);
    });

    unsubscribe();
    await agent.prompt("Ignored event");

    expect(events).toHaveLength(0);
  });

  it("reset clears messages and queues", async () => {
    const agent = createAgent(getLiveModel(), [], "You are a helpful assistant.");

    await agent.prompt("Test");
    agent.steer({ role: "user", content: "steer", timestamp: Date.now() });
    agent.followUp({ role: "user", content: "followup", timestamp: Date.now() });

    expect(agent.state.messages.length).toBeGreaterThan(0);
    expect(agent.hasQueuedMessages()).toBe(true);

    agent.reset();

    expect(agent.state.messages).toHaveLength(0);
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it("cannot continue from empty messages", async () => {
    const agent = createAgent(getLiveModel(), [], "You are a helpful assistant.");

    await expect(agent.continue()).rejects.toThrow("No messages to continue from");
  });

  it("cannot continue from assistant message without queued messages", async () => {
    const liveModel = getLiveModel();
    const agent = new Agent({
      initialState: {
        model: liveModel,
        systemPrompt: "You are a helpful assistant.",
        thinkingLevel: "off",
        tools: [],
        messages: [
          { role: "user", content: "hi", timestamp: Date.now() },
          {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            api: "openai-completions",
            provider: "openai",
            model: "test",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          },
        ],
      },
    });

    await expect(agent.continue()).rejects.toThrow("Cannot continue from message role: assistant");
  });

  it("clearSteeringQueue and clearFollowUpQueue work", () => {
    const agent = createAgent(getLiveModel(), [], "You are a helpful assistant.");

    agent.steer({ role: "user", content: "s1", timestamp: Date.now() });
    agent.followUp({ role: "user", content: "f1", timestamp: Date.now() });

    expect(agent.hasQueuedMessages()).toBe(true);

    agent.clearSteeringQueue();
    expect(agent.hasQueuedMessages()).toBe(true);

    agent.clearFollowUpQueue();
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it("supports prompt with string and images", async () => {
    const agent = createAgent(getLiveModel(), [], "You are a helpful assistant.");

    await agent.prompt("Describe this", [
      {
        type: "image",
        image: IMAGE_DATA_URL,
        mimeType: "image/png",
      },
    ]);

    expect(agent.state.messages).toHaveLength(2);
    expect(agent.state.messages.at(-1)?.role).toBe("assistant");
  });

  it("supports prompt with AgentMessage array", async () => {
    const agent = createAgent(getLiveModel(), [], "You are a helpful assistant.");

    await agent.prompt([
      { role: "user", content: "First", timestamp: Date.now() },
      { role: "user", content: "Second", timestamp: Date.now() },
    ]);

    expect(agent.state.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(agent.state.messages.at(-1)?.role).toBe("assistant");
  });
});
