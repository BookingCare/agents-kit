import { Type, streamSimple } from "@bookingcare/ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent.js";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from "../../src/types.js";
import { auth, liveModel as getLiveModel, type LiveModel } from "../helpers/live-model.js";

const echoTool: AgentTool = {
  name: "echo",
  description: "Echoes the provided message",
  parameters: Type.Object({ message: Type.String() }),
  label: "Echo",
  execute: async (_id, params) => ({ content: (params as { message: string }).message }),
};

function createAgent(liveModel: LiveModel, tools: AgentTool[] = []) {
  let streamCalls = 0;
  const streamFn: StreamFn = (streamModel, context, options) => {
    streamCalls += 1;
    return streamSimple(streamModel, context, options);
  };

  const agent = new Agent({
    initialState: {
      model: liveModel,
      systemPrompt: "",
      thinkingLevel: "off",
      tools,
      messages: [],
    },
    streamFn,
  });

  return { agent, getStreamCalls: () => streamCalls };
}

describe.skipIf(!auth)("BreakpointManager", () => {
  it("pauses before stream start and exposes isolated snapshots", async () => {
    const { agent, getStreamCalls } = createAgent(getLiveModel());

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

      expect(getStreamCalls()).toBe(0);
      agent.resume();
    };

    await agent.prompt("Hello");

    expect(getStreamCalls()).toBe(1);
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
    const { agent, getStreamCalls } = createAgent(getLiveModel(), [echoTool]);
    const events: AgentEvent[] = [];
    let releaseBreakpoint!: () => void;
    const breakpointReached = new Promise<void>((resolve) => {
      releaseBreakpoint = resolve;
    });

    agent.subscribe((event) => {
      events.push(event);
      if (event.type === "message_end") {
        agent.pause();
      }
    });

    agent.onBreakpoint = async (hit) => {
      expect(hit.stage).toBe("post_stream");
      expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
      releaseBreakpoint();
    };

    const promptPromise = agent.prompt("Use the echo tool to repeat hi exactly.");
    await breakpointReached;

    expect(agent.state.isStreaming).toBe(true);
    const idlePromise = agent.waitForIdle();
    const settledBeforeResume = await Promise.race([
      idlePromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    expect(settledBeforeResume).toBe(false);

    agent.resume();
    await idlePromise;
    await promptPromise;

    expect(agent.state.isStreaming).toBe(false);
    expect(getStreamCalls()).toBe(2);
  });

  it("clears individual breakpoints and all breakpoints", async () => {
    const { agent: firstAgent } = createAgent(getLiveModel());
    let firstBreakpointHits = 0;

    firstAgent.setBreakpoint("pre_stream");
    firstAgent.clearBreakpoint("pre_stream");
    firstAgent.onBreakpoint = async () => {
      firstBreakpointHits += 1;
    };

    await firstAgent.prompt("One");
    expect(firstBreakpointHits).toBe(0);

    const { agent: secondAgent } = createAgent(getLiveModel());
    let secondBreakpointHits = 0;

    secondAgent.setBreakpoint("pre_stream");
    secondAgent.setBreakpoint("post_stream");
    secondAgent.clearAllBreakpoints();
    secondAgent.onBreakpoint = async () => {
      secondBreakpointHits += 1;
    };

    await secondAgent.prompt("Two");
    expect(secondBreakpointHits).toBe(0);
  });

  it("fires complete exactly once at shutdown", async () => {
    const { agent, getStreamCalls } = createAgent(getLiveModel());
    const stages: string[] = [];

    agent.setBreakpoint("complete");
    agent.onBreakpoint = async (hit) => {
      stages.push(hit.stage);
      agent.resume();
    };

    await agent.prompt("Finish");

    expect(stages).toEqual(["complete"]);
    expect(getStreamCalls()).toBe(1);
  });

  it("aborts cleanly while paused", async () => {
    const { agent, getStreamCalls } = createAgent(getLiveModel());

    agent.setBreakpoint("pre_stream");
    agent.onBreakpoint = async () => {
      agent.abort();
    };

    await expect(agent.prompt("Stop")).resolves.toBeUndefined();

    expect(getStreamCalls()).toBe(0);
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.messages).toHaveLength(1);
  });
});
