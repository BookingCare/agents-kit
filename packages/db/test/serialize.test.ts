import { describe, it, expect } from "vitest";
import { serializeAgentState, createTodoSnapshot } from "../src/utils/serialize.js";
import type { Model, Message } from "@bookingcare/ai";

type AgentStateLike = {
  messages: Message[];
  model: { id: string; provider: string | unknown };
  systemPrompt: string;
  thinkingLevel?: string;
  tools?: unknown[];
  isStreaming?: boolean;
  streamingMessage?: unknown;
  pendingToolCalls?: unknown;
  errorMessage?: string;
};

const TEST_MODEL: Model<"openai-completions"> = {
  id: "gpt-4",
  name: "GPT-4",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.03, output: 0.06, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 4096,
};

describe("serializeAgentState", () => {
  it("extracts messages and metadata", () => {
    const state: AgentStateLike = {
      systemPrompt: "You are helpful.",
      model: TEST_MODEL,
      thinkingLevel: "off",
      tools: [],
      messages: [
        { role: "system", content: "You are helpful." },
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          timestamp: 1000,
        },
      ],
      isStreaming: false,
      streamingMessage: undefined,
      pendingToolCalls: new Set(),
    };

    const serialized = serializeAgentState(state);

    expect(serialized.messages).toEqual(state.messages);
    expect(serialized.info.model).toBe("gpt-4");
    expect(serialized.info.provider).toBe("openai");
    expect(serialized.info.systemPrompt).toBe("You are helpful.");
  });

  it("excludes transient state", () => {
    const state: AgentStateLike = {
      systemPrompt: "Test",
      model: TEST_MODEL,
      thinkingLevel: "medium",
      tools: [],
      messages: [],
      isStreaming: true,
      streamingMessage: { role: "assistant", content: "partial", timestamp: 999 },
      pendingToolCalls: new Set(["tc1"]),
      errorMessage: "something went wrong",
    };

    const serialized = serializeAgentState(state);

    // These should not appear in the serialized output
    expect("isStreaming" in serialized).toBe(false);
    expect("streamingMessage" in serialized).toBe(false);
    expect("pendingToolCalls" in serialized).toBe(false);
    expect("errorMessage" in serialized).toBe(false);
    // tools are also excluded (runtime fn references)
    expect("tools" in serialized).toBe(false);
  });

  it("handles empty state", () => {
    const state: AgentStateLike = {
      systemPrompt: "",
      model: TEST_MODEL,
      thinkingLevel: "off",
      tools: [],
      messages: [],
      isStreaming: false,
      pendingToolCalls: new Set(),
    };

    const serialized = serializeAgentState(state);

    expect(serialized.messages).toEqual([]);
    expect(serialized.info.systemPrompt).toBe("");
  });
});

describe("createTodoSnapshot", () => {
  it("creates snapshot with items and rendered text", () => {
    const items = [{ id: "1", text: "Task one", status: "completed" as const }];
    const rendered = "[x] #1: Task one";

    const snapshot = createTodoSnapshot(items, rendered);

    expect(snapshot.items).toEqual(items);
    expect(snapshot.rendered).toBe(rendered);
  });

  it("copies items array", () => {
    const items: Array<{
      id: string;
      text: string;
      status: "pending" | "in_progress" | "completed";
    }> = [{ id: "1", text: "Task", status: "pending" }];
    const snapshot = createTodoSnapshot(items, "rendered");

    // Push to the original array - snapshot should be unaffected
    items.push({ id: "2", text: "New", status: "completed" });
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].text).toBe("Task");
  });

  it("handles empty items", () => {
    const snapshot = createTodoSnapshot([], "No todos.");
    expect(snapshot.items).toEqual([]);
    expect(snapshot.rendered).toBe("No todos.");
  });
});
