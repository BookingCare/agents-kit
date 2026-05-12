import { describe, it, expect, vi, beforeEach } from "vitest";
import { Agent } from "../src/agent.js";
import type { AgentEvent, AgentMessage, AgentTool, QueueMode } from "../src/types.js";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  StopReason,
  Tool,
} from "@bookingcare/ai";
import { createAssistantMessageEventStream, Type } from "@bookingcare/ai";

// ── Mock stream function ──────────────────────────────────────────────

/**
 * Create a mock streamFn that emits a text response, optionally followed by tool calls.
 * Returns the event stream — the caller's loop collects it.
 */
function createMockStream(responses: MockResponse[]) {
  const remaining = [...responses];
  return vi.fn((_model: Model<any>, _ctx: any, _opts?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const response = remaining.shift();
    if (!response) throw new Error("No more mock responses");

    // Push events asynchronously so the loop can collect them
    setTimeout(() => {
      const assistant = buildAssistantMessage(response);

      // Emit start
      stream.push({ type: "start", partial: assistant });

      // Emit text deltas
      if (response.text) {
        stream.push({ type: "text_start", contentIndex: 0, partial: assistant });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: response.text,
          partial: assistant,
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: response.text,
          partial: assistant,
        });
      }

      // Emit tool call events
      for (let i = 0; i < (response.toolCalls?.length ?? 0); i++) {
        const tc = response.toolCalls![i];
        stream.push({ type: "toolcall_start", contentIndex: i, partial: assistant });
        stream.push({
          type: "toolcall_delta",
          contentIndex: i,
          delta: tc.arguments,
          partial: assistant,
        });
        stream.push({ type: "toolcall_end", contentIndex: i, toolCall: tc, partial: assistant });
      }

      // Emit done
      stream.push({ type: "done", reason: response.stopReason ?? "stop", message: assistant });
    }, 0);

    return stream;
  });
}

interface MockResponse {
  text?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  stopReason?: StopReason;
}

function buildAssistantMessage(response: MockResponse): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (response.text) {
    content.push({ type: "text", text: response.text });
  }
  if (response.toolCalls) {
    for (const tc of response.toolCalls) {
      content.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
    }
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 20 },
    stopReason: response.stopReason ?? "stop",
    timestamp: Date.now(),
  };
}

// ── Test tool ─────────────────────────────────────────────────────────

const echoTool: AgentTool = {
  name: "echo",
  description: "Echoes back the input",
  parameters: Type.Object({ message: Type.String() }),
  label: "Echo",
  execute: async (_id, params) => ({ content: params.message }),
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

// ── Agent basics ──────────────────────────────────────────────────────

describe("Agent", () => {
  it("emits message_start/update/end events on prompt", async () => {
    const streamFn = createMockStream([{ text: "Hello!" }]);
    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      streamFn: streamFn as any,
    });

    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    await agent.prompt("Say hi");

    expect(events.some((e) => e.type === "message_start")).toBe(true);
    expect(events.some((e) => e.type === "message_update")).toBe(true);
    expect(events.some((e) => e.type === "message_end")).toBe(true);
    expect(events.some((e) => e.type === "agent_end")).toBe(true);

    // Final assistant message should contain the text
    const endEvent = events.find((e) => e.type === "agent_end")!;
    const msgs = (endEvent as { type: "agent_end"; messages: AgentMessage[] }).messages;
    const assistantMsg = msgs.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
  });

  it("throws if prompt is called while already running", async () => {
    const streamFn = createMockStream([{ text: "Thinking..." }]);
    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      streamFn: streamFn as any,
    });

    const promise = agent.prompt("First");
    await expect(agent.prompt("Second")).rejects.toThrow("already processing");
    await promise;
  });

  it("executes tool calls and returns results", async () => {
    const streamFn = createMockStream([
      {
        text: "",
        toolCalls: [{ id: "tc1", name: "echo", arguments: '{"message":"hi"}' }],
        stopReason: "toolUse",
      },
      { text: "Done" },
    ]);

    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [echoTool],
        messages: [],
      },
      streamFn: streamFn as any,
    });

    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });

    await agent.prompt("Use echo");

    // Should have tool execution events
    expect(events.some((e) => e.type === "tool_execution_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_execution_end")).toBe(true);

    // Should have a turn_end with tool results
    const turnEnd = events.find((e) => e.type === "turn_end") as
      | { type: "turn_end"; toolResults: AgentMessage[] }
      | undefined;
    expect(turnEnd).toBeDefined();
    expect(turnEnd!.toolResults.length).toBe(1);
    expect(turnEnd!.toolResults[0].role).toBe("toolResult");

    // Tool result should contain the echoed message
    const toolResult = turnEnd!.toolResults[0];
    if (typeof toolResult.content !== "string" && "some" in toolResult.content) {
      const text = toolResult.content
        .filter((p): p is { type: "text"; text: string } => "type" in p && p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(text).toBe("hi");
    }
  });

  it("handles tool execution errors gracefully", async () => {
    const streamFn = createMockStream([
      {
        text: "",
        toolCalls: [{ id: "tc1", name: "fail", arguments: "{}" }],
        stopReason: "toolUse",
      },
      { text: "Recovered" },
    ]);

    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [failTool],
        messages: [],
      },
      streamFn: streamFn as any,
    });

    await agent.prompt("Make it fail");

    // Agent should complete without throwing
    expect(agent.state.isStreaming).toBe(false);
  });

  it("aborts a running prompt", async () => {
    // Create a stream that delays, then ends with a message when aborted
    const streamFn = vi.fn((_model: Model<any>, _ctx: any, opts?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      // Use the signal to detect abort and end the stream
      const signal = opts?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          const assistant = buildAssistantMessage({ text: "" });
          stream.push({ type: "done", reason: "aborted", message: assistant });
        });
      }
      return stream;
    });

    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      streamFn: streamFn as any,
    });

    const promise = agent.prompt("Wait forever");

    // Give the loop time to start streaming
    await new Promise((r) => setTimeout(r, 10));

    expect(agent.state.isStreaming).toBe(true);
    agent.abort();

    await agent.waitForIdle();
    expect(agent.state.isStreaming).toBe(false);
  });

  it("steer injects messages between turns", async () => {
    const streamFn = createMockStream([
      {
        text: "",
        toolCalls: [{ id: "tc1", name: "echo", arguments: '{"message":"first"}' }],
        stopReason: "toolUse",
      },
      { text: "Final" },
    ]);

    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [echoTool],
        messages: [],
      },
      streamFn: streamFn as any,
      steeringMode: "all",
    });

    // Queue a steering message before prompting
    agent.steer({ role: "user", content: "Steered message", timestamp: Date.now() });

    await agent.prompt("Start");

    // The steering message should appear in the final messages
    const endMessages = agent.state.messages;
    const steered = endMessages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content === "Steered message",
    );
    expect(steered).toBeDefined();
  });

  it("followUp runs after agent would otherwise stop", async () => {
    const streamFn = createMockStream([{ text: "First response" }, { text: "Follow-up response" }]);

    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      streamFn: streamFn as any,
      followUpMode: "all",
    });

    // Queue a follow-up
    agent.followUp({ role: "user", content: "Continue", timestamp: Date.now() });

    await agent.prompt("Start");

    // The stream should have been called twice (once for initial, once for follow-up)
    expect(streamFn).toHaveBeenCalledTimes(2);
  });

  it("subscribe returns unsubscribe function", async () => {
    const streamFn = createMockStream([{ text: "Hello" }]);
    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      streamFn: streamFn as any,
    });

    const events: AgentEvent[] = [];
    const unsub = agent.subscribe((event) => {
      events.push(event);
    });

    // Unsubscribe before prompt
    unsub();
    await agent.prompt("Ignored event");

    // No events should have been collected
    expect(events.length).toBe(0);
  });

  it("reset clears messages and queues", async () => {
    const streamFn = createMockStream([{ text: "Hello" }]);
    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      streamFn: streamFn as any,
      steeringMode: "all",
      followUpMode: "all",
    });

    await agent.prompt("Test");

    agent.steer({ role: "user", content: "steer", timestamp: Date.now() });
    agent.followUp({ role: "user", content: "followup", timestamp: Date.now() });

    expect(agent.state.messages.length).toBeGreaterThan(0);
    expect(agent.hasQueuedMessages()).toBe(true);

    agent.reset();

    expect(agent.state.messages.length).toBe(0);
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it("cannot continue from empty messages", async () => {
    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
    });

    await expect(agent.continue()).rejects.toThrow("No messages to continue from");
  });

  it("cannot continue from assistant message without queued messages", async () => {
    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
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
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
        ],
      },
    });

    await expect(agent.continue()).rejects.toThrow("Cannot continue from message role: assistant");
  });

  it("clearSteeringQueue and clearFollowUpQueue work", () => {
    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
    });

    agent.steer({ role: "user", content: "s1", timestamp: Date.now() });
    agent.followUp({ role: "user", content: "f1", timestamp: Date.now() });

    expect(agent.hasQueuedMessages()).toBe(true);

    agent.clearSteeringQueue();
    expect(agent.hasQueuedMessages()).toBe(true);

    agent.clearFollowUpQueue();
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it("supports prompt with string and images", async () => {
    const streamFn = createMockStream([{ text: "I see an image" }]);
    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      streamFn: streamFn as any,
    });

    await agent.prompt("Describe this", [
      { type: "image", image: "data:image/png;base64,abc", mimeType: "image/png" },
    ]);

    // Stream should have been called with messages containing the image
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it("supports prompt with AgentMessage array", async () => {
    const streamFn = createMockStream([{ text: "Got it" }]);
    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      streamFn: streamFn as any,
    });

    await agent.prompt([
      { role: "user", content: "First", timestamp: Date.now() },
      { role: "user", content: "Second", timestamp: Date.now() },
    ]);

    expect(streamFn).toHaveBeenCalledTimes(1);
  });
});
