import { describe, expect, it, vi } from "vitest";
import {
  Agent,
  EventBus,
  type AgentEvent,
  type AgentMessage,
  type ContextTrimmedEvent,
  type PermissionNeededEvent,
} from "../src/index.js";
import { createMockStream } from "./helpers/helpers.js";
import { liveModel } from "./helpers/live-model.js";

const model = liveModel();
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createAssistantMessage(): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp: 0,
  };
}

function createStreamingMessage() {
  return {
    role: "assistant" as const,
    content: "",
    timestamp: 0,
  };
}

function createPermissionNeededEvent(): PermissionNeededEvent {
  return {
    type: "permission_needed",
    toolName: "bash",
    args: { command: "echo hi" },
    toolCallId: "tool-1",
    rule: { tool: "bash", action: "ask" },
    resolve: () => undefined,
  };
}

function createContextTrimmedEvent(): ContextTrimmedEvent {
  return {
    type: "context_trimmed",
    droppedMessages: 1,
    remainingMessages: 2,
    budget: 3,
    tokenCountBefore: 4,
    tokenCountAfter: 2,
    strategyName: "test",
  };
}

function createAgent(streamFn = createMockStream([{ text: "hello" }])): Agent {
  return new Agent({
    initialState: {
      model,
      systemPrompt: "You are helpful.",
      thinkingLevel: "off",
      tools: [],
      messages: [],
    },
    streamFn,
  });
}

describe("EventBus", () => {
  it("routes events to the matching channel", async () => {
    const bus = new EventBus();
    const signal = new AbortController().signal;
    const lifecycle: AgentEvent["type"][] = [];
    const streaming: AgentEvent["type"][] = [];
    const tools: AgentEvent["type"][] = [];

    bus.on("lifecycle", (event) => {
      lifecycle.push(event.type);
    });
    bus.on("streaming", (event) => {
      streaming.push(event.type);
    });
    bus.on("tools", (event) => {
      tools.push(event.type);
    });

    await bus.emit(createContextTrimmedEvent(), signal);
    await bus.emit({ type: "message_start", message: createStreamingMessage() }, signal);
    await bus.emit({ type: "message_update", message: createStreamingMessage() }, signal);
    await bus.emit({ type: "message_end", message: createAssistantMessage() }, signal);
    await bus.emit(createPermissionNeededEvent(), signal);
    await bus.emit({ type: "tool_execution_start", toolCallId: "tool-2" }, signal);
    await bus.emit({ type: "tool_execution_end", toolCallId: "tool-2" }, signal);
    await bus.emit(
      {
        type: "turn_end",
        message: createAssistantMessage(),
        toolResults: [],
      },
      signal,
    );
    await bus.emit({ type: "agent_end", messages: [createAssistantMessage()] }, signal);

    expect(lifecycle).toEqual(["context_trimmed", "agent_end"]);
    expect(streaming).toEqual(["message_start", "message_update", "message_end"]);
    expect(tools).toEqual([
      "permission_needed",
      "tool_execution_start",
      "tool_execution_end",
      "turn_end",
    ]);
  });

  it("calls listeners in order and supports unsubscribe", async () => {
    const bus = new EventBus();
    const signal = new AbortController().signal;
    const calls: string[] = [];

    const unsubscribeFirst = bus.on("streaming", async () => {
      calls.push("first");
    });
    bus.on("streaming", async () => {
      calls.push("second");
    });

    await bus.emit({ type: "message_start", message: createStreamingMessage() }, signal);
    expect(calls).toEqual(["first", "second"]);

    calls.length = 0;
    unsubscribeFirst();
    unsubscribeFirst();

    await bus.emit({ type: "message_update", message: createStreamingMessage() }, signal);
    expect(calls).toEqual(["second"]);
  });

  it("once listeners fire once and remove themselves after completion", async () => {
    const bus = new EventBus();
    const signal = new AbortController().signal;
    const calls: string[] = [];

    bus.once("streaming", async () => {
      calls.push("once");
    });

    await bus.emit({ type: "message_start", message: createStreamingMessage() }, signal);
    await bus.emit({ type: "message_update", message: createStreamingMessage() }, signal);

    expect(calls).toEqual(["once"]);
  });

  it("unsubscribing during emission does not affect the current emission", async () => {
    const bus = new EventBus();
    const signal = new AbortController().signal;
    const calls: string[] = [];
    let unsubscribeSecond = () => {};

    bus.on("streaming", async () => {
      calls.push("first");
      unsubscribeSecond();
    });
    unsubscribeSecond = bus.on("streaming", async () => {
      calls.push("second");
    });

    await bus.emit({ type: "message_start", message: createStreamingMessage() }, signal);

    expect(calls).toEqual(["first", "second"]);
  });

  it("logs and continues when an agent_end listener throws", async () => {
    const bus = new EventBus();
    const signal = new AbortController().signal;
    const calls: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    bus.on("lifecycle", async () => {
      calls.push("first");
      throw new Error("boom");
    });
    bus.on("lifecycle", async () => {
      calls.push("second");
    });

    await expect(
      bus.emit({ type: "agent_end", messages: [createAssistantMessage()] }, signal),
    ).resolves.toBeUndefined();

    expect(calls).toEqual(["first", "second"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("aborts the current channel when a non-agent_end listener throws", async () => {
    const bus = new EventBus();
    const signal = new AbortController().signal;
    const calls: string[] = [];

    bus.on("streaming", async () => {
      calls.push("first");
      throw new Error("boom");
    });
    bus.on("streaming", async () => {
      calls.push("second");
    });

    await expect(
      bus.emit({ type: "message_start", message: createStreamingMessage() }, signal),
    ).rejects.toThrow("boom");

    expect(calls).toEqual(["first"]);
  });
});

describe("Agent.subscribe compatibility", () => {
  it("receives events from all channels", async () => {
    const agent = createAgent();
    const events: AgentEvent["type"][] = [];

    agent.subscribe((event) => {
      events.push(event.type);
    });

    await agent.prompt("Hello");

    expect(events).toEqual(["message_start", "message_update", "message_end", "agent_end"]);
  });

  it("unsubscribe removes the subscription from all channels", async () => {
    const agent = createAgent();
    const events: AgentEvent[] = [];

    const unsubscribe = agent.subscribe((event) => {
      events.push(event);
    });

    unsubscribe();
    await agent.prompt("Hello");

    expect(events).toHaveLength(0);
  });
});
