import { Type } from "@bookingcare/ai";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from "../src/types.js";
import { createMockStream } from "./helpers/helpers.js";
import type { Model } from "@bookingcare/ai";

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

const echoTool: AgentTool = {
  name: "echo",
  description: "Echoes the provided message",
  parameters: Type.Object({ message: Type.String() }),
  label: "Echo",
  execute: async (_id, params) => ({ content: (params as { message: string }).message }),
};

function createAgent(streamFn: ReturnType<typeof createMockStream>, tools: AgentTool[] = []) {
  return new Agent({
    initialState: {
      model: TEST_MODEL,
      systemPrompt: "",
      thinkingLevel: "off",
      tools,
      messages: [],
    },
    streamFn: streamFn as unknown as StreamFn,
  });
}

describe("BreakpointManager", () => {
  it("pauses before stream start and exposes isolated snapshots", async () => {
    const streamFn = createMockStream([{ text: "Hello" }]);
    const agent = createAgent(streamFn);

    agent.setBreakpoint("pre_stream", (context) =>
      context.messages.some((message) => message.role === "user"),
    );

    agent.onBreakpoint = async (hit) => {
      expect(hit.stage).toBe("pre_stream");
      expect(hit.context.messages).toHaveLength(1);
      expect(hit.context.tools).toHaveLength(0);
      expect(hit.context.messages).not.toBe(hit.snapshot.messages);
      expect(hit.context.tools).not.toBe(hit.snapshot.tools);

      const contextMutation: AgentMessage = {
        role: "user",
        content: "mutated-context",
        timestamp: Date.now(),
      };
      const snapshotMutation: AgentMessage = {
        role: "user",
        content: "mutated-snapshot",
        timestamp: Date.now(),
      };

      hit.context.messages.push(contextMutation);
      hit.snapshot.messages.push(snapshotMutation);

      expect(streamFn).not.toHaveBeenCalled();
      agent.resume();
    };

    await agent.prompt("Hello");

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(
      agent.state.messages.some(
        (message) => typeof message.content === "string" && message.content === "mutated-context",
      ),
    ).toBe(false);
    expect(
      agent.state.messages.some(
        (message) => typeof message.content === "string" && message.content === "mutated-snapshot",
      ),
    ).toBe(false);
  });

  it("pauses on an explicit pause at the next boundary", async () => {
    const streamFn = createMockStream([
      {
        text: "",
        toolCalls: [{ type: "toolCall", id: "tc1", name: "echo", arguments: { message: "hi" } }],
        stopReason: "toolUse",
      },
      { text: "Done" },
    ]);
    const agent = createAgent(streamFn, [echoTool]);
    const events: AgentEvent[] = [];

    agent.subscribe((event) => {
      events.push(event);
      if (event.type === "message_end") {
        agent.pause();
      }
    });

    agent.onBreakpoint = async (hit) => {
      expect(hit.stage).toBe("post_stream");
      expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
      agent.resume();
    };

    await agent.prompt("Use echo");

    expect(streamFn).toHaveBeenCalledTimes(2);
  });

  it("clears individual breakpoints and all breakpoints", async () => {
    const firstStream = createMockStream([{ text: "First" }]);
    const firstAgent = createAgent(firstStream);
    const firstBreakpoint = vi.fn();

    firstAgent.setBreakpoint("pre_stream");
    firstAgent.clearBreakpoint("pre_stream");
    firstAgent.onBreakpoint = async () => {
      firstBreakpoint();
    };

    await firstAgent.prompt("One");
    expect(firstBreakpoint).not.toHaveBeenCalled();

    const secondStream = createMockStream([{ text: "Second" }]);
    const secondAgent = createAgent(secondStream);
    const secondBreakpoint = vi.fn();

    secondAgent.setBreakpoint("pre_stream");
    secondAgent.setBreakpoint("post_stream");
    secondAgent.clearAllBreakpoints();
    secondAgent.onBreakpoint = async () => {
      secondBreakpoint();
    };

    await secondAgent.prompt("Two");
    expect(secondBreakpoint).not.toHaveBeenCalled();
  });

  it("fires complete exactly once at shutdown", async () => {
    const streamFn = createMockStream([{ text: "Done" }]);
    const agent = createAgent(streamFn);
    const stages: string[] = [];

    agent.setBreakpoint("complete");
    agent.onBreakpoint = async (hit) => {
      stages.push(hit.stage);
      agent.resume();
    };

    await agent.prompt("Finish");

    expect(stages).toEqual(["complete"]);
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it("aborts cleanly while paused", async () => {
    const streamFn = createMockStream([{ text: "Will not run" }]);
    const agent = createAgent(streamFn);

    agent.setBreakpoint("pre_stream");
    agent.onBreakpoint = async () => {
      agent.abort();
    };

    await expect(agent.prompt("Stop")).resolves.toBeUndefined();

    expect(streamFn).not.toHaveBeenCalled();
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.messages).toHaveLength(1);
  });
});
