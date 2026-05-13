import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Agent } from "../src/agent.js";
import { JSONStore, NotFoundError } from "@bookingcare/db";
import { TodoManager } from "../src/todo-manager.js";
import type { Model } from "@bookingcare/ai";
import { createMockStream } from "./helpers/helpers.js";

// ── Test constants ────────────────────────────────────────────────────

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

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agent-persist-"));
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Agent persistence", () => {
  let baseDir: string;
  let store: JSONStore;

  beforeEach(async () => {
    baseDir = await createTempDir();
    store = await JSONStore.create({ baseDir });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("generates sessionId when store is provided but no sessionId", () => {
    const agent = new Agent({ initialState: { model: TEST_MODEL }, store });
    expect(agent.sessionId).toBeDefined();
    expect(typeof agent.sessionId).toBe("string");
  });

  it("leaves sessionId undefined when no store is provided", () => {
    const agent = new Agent({ initialState: { model: TEST_MODEL } });
    expect(agent.sessionId).toBeUndefined();
  });

  it("persists messages after prompt completes", async () => {
    const sessionId = "persist-prompt";
    const streamFn = createMockStream([{ text: "Hello back!" }]);

    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "You are helpful.",
      },
      streamFn: streamFn as any,
      sessionId,
      store,
    });

    await agent.prompt("Hello");

    const loaded = await store.loadMessages(sessionId);
    expect(loaded.length).toBeGreaterThanOrEqual(2);
    expect(loaded.some((m) => m.role === "user")).toBe(true);
    expect(loaded.some((m) => m.role === "assistant")).toBe(true);
  });

  it("round-trips through Agent.resume()", async () => {
    const sessionId = "resume-test";
    const todoManager = new TodoManager();
    const streamFn = createMockStream([{ text: "Resumed response" }]);

    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "You are helpful.",
      },
      streamFn: streamFn as any,
      sessionId,
      store,
      todoManager,
    });

    // Add some todos
    todoManager.update([{ id: "1", text: "First task", status: "completed" }]);

    await agent.prompt("Hello");

    // Verify store has data
    expect(await store.exists(sessionId)).toBe(true);

    // Resume with a fresh todo manager
    const newTodoManager = new TodoManager();
    const resumed = await Agent.resume({
      sessionId,
      store,
      model: TEST_MODEL,
      todoManager: newTodoManager,
    });

    expect(resumed.sessionId).toBe(sessionId);
    expect(resumed.state.systemPrompt).toBe("You are helpful.");
    const loadedMessages = resumed.state.messages;
    expect(loadedMessages.length).toBeGreaterThanOrEqual(1);

    // Verify todos were restored
    const items = newTodoManager.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "1", text: "First task", status: "completed" });
  });

  it("throws NotFoundError when resuming non-existent session", async () => {
    await expect(
      Agent.resume({ sessionId: "nonexistent", store, model: TEST_MODEL }),
    ).rejects.toThrow(NotFoundError);
  });

  it("stores info with correct model and provider", async () => {
    const sessionId = "info-test";
    const streamFn = createMockStream([{ text: "Info here" }]);

    const agent = new Agent({
      initialState: {
        model: TEST_MODEL,
        systemPrompt: "System prompt here.",
      },
      streamFn: streamFn as any,
      sessionId,
      store,
    });

    await agent.prompt("hi");

    const info = await store.loadInfo(sessionId);
    expect(info).toBeDefined();
    expect(info!.model).toBe("gpt-4");
    expect(info!.provider).toBe("openai");
    expect(info!.systemPrompt).toBe("System prompt here.");
    expect(info!.sessionId).toBe(sessionId);
    expect(info!.messageCount).toBeGreaterThanOrEqual(1);
    expect(info!.createdAt).toBeGreaterThan(0);
    expect(info!.updatedAt).toBeGreaterThanOrEqual(info!.createdAt);
  });

  it("does not throw when no store is configured", () => {
    const agent = new Agent({ initialState: { model: TEST_MODEL } });
    expect(agent.state.messages).toEqual([]);
    expect(agent.state.systemPrompt).toBe("");
  });

  it("does not persist when store is not configured", async () => {
    const sessionId = "no-store";
    const streamFn = createMockStream([{ text: "No persistence" }]);
    const agent = new Agent({
      initialState: { model: TEST_MODEL },
      streamFn: streamFn as any,
      sessionId,
    });

    await agent.prompt("test");

    // Store exists but session should not have been created
    expect(await store.exists(sessionId)).toBe(false);
  });

  it("handles todo persistence without todoManager", async () => {
    const sessionId = "no-todo-mgr";
    const streamFn = createMockStream([{ text: "No todos" }]);

    const agent = new Agent({
      initialState: { model: TEST_MODEL },
      streamFn: streamFn as any,
      sessionId,
      store,
    });

    await agent.prompt("test");

    const todos = await store.loadTodos(sessionId);
    expect(todos).toBeDefined();
    expect(todos!.items).toEqual([]);
    expect(todos!.rendered).toContain("No todos");
  });
});
