import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { auth, liveModel as getLiveModel } from "../helpers/live-model.js";
import { Agent } from "../../src/agent.js";
import { JSONStore, NotFoundError } from "@bookingcare/infra";
import { TodoManager } from "../../src/todo-manager.js";

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agent-persist-"));
}

describe.skipIf(!auth)("Agent persistence", () => {
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
    const agent = new Agent({ initialState: { model: getLiveModel() }, store });
    expect(agent.sessionId).toBeDefined();
    expect(typeof agent.sessionId).toBe("string");
  });

  it("leaves sessionId undefined when no store is provided", () => {
    const agent = new Agent({ initialState: { model: getLiveModel() } });
    expect(agent.sessionId).toBeUndefined();
  });

  it("persists messages after prompt completes", async () => {
    const sessionId = "persist-prompt";

    const agent = new Agent({
      initialState: {
        model: getLiveModel(),
        systemPrompt: "You are helpful.",
        thinkingLevel: "off",
        tools: [],
      },
      sessionId,
      store,
    });

    await agent.prompt("Hello");

    const loaded = await store.loadMessages(sessionId);
    expect(loaded.length).toBeGreaterThanOrEqual(2);
    expect(loaded.some((message) => message.role === "user")).toBe(true);
    expect(loaded.some((message) => message.role === "assistant")).toBe(true);
  });

  it("round-trips through Agent.resume()", async () => {
    const sessionId = "resume-test";
    const todoManager = new TodoManager();

    const agent = new Agent({
      initialState: {
        model: getLiveModel(),
        systemPrompt: "You are helpful.",
        thinkingLevel: "off",
        tools: [],
      },
      sessionId,
      store,
      todoManager,
    });

    todoManager.update([{ id: "1", text: "First task", status: "completed" }]);

    await agent.prompt("Hello");

    expect(await store.exists(sessionId)).toBe(true);

    const newTodoManager = new TodoManager();
    const resumed = await Agent.resume({
      sessionId,
      store,
      model: getLiveModel(),
      todoManager: newTodoManager,
    });

    expect(resumed.sessionId).toBe(sessionId);
    expect(resumed.state.systemPrompt).toBe("You are helpful.");
    expect(resumed.state.messages.length).toBeGreaterThanOrEqual(1);

    const items = newTodoManager.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "1", text: "First task", status: "completed" });
  });

  it("throws NotFoundError when resuming non-existent session", async () => {
    await expect(
      Agent.resume({ sessionId: "nonexistent", store, model: getLiveModel() }),
    ).rejects.toThrow(NotFoundError);
  });

  it("stores info with correct model and provider", async () => {
    const sessionId = "info-test";
    const liveModel = getLiveModel();

    const agent = new Agent({
      initialState: {
        model: liveModel,
        systemPrompt: "System prompt here.",
        thinkingLevel: "off",
        tools: [],
      },
      sessionId,
      store,
    });

    await agent.prompt("hi");

    const info = await store.loadInfo(sessionId);
    expect(info).toBeDefined();
    expect(info!.model).toBe(liveModel.id);
    expect(info!.provider).toBe(liveModel.provider);
    expect(info!.systemPrompt).toBe("System prompt here.");
    expect(info!.sessionId).toBe(sessionId);
    expect(info!.messageCount).toBeGreaterThanOrEqual(1);
    expect(info!.createdAt).toBeGreaterThan(0);
    expect(info!.updatedAt).toBeGreaterThanOrEqual(info!.createdAt);
  });

  it("does not throw when no store is configured", () => {
    const agent = new Agent({ initialState: { model: getLiveModel() } });
    expect(agent.state.messages).toEqual([]);
    expect(agent.state.systemPrompt).toBe("");
  });

  it("does not persist when store is not configured", async () => {
    const sessionId = "no-store";
    const agent = new Agent({
      initialState: { model: getLiveModel(), thinkingLevel: "off", tools: [] },
      sessionId,
    });

    await agent.prompt("test");

    expect(await store.exists(sessionId)).toBe(false);
  });

  it("handles todo persistence without todoManager", async () => {
    const sessionId = "no-todo-mgr";

    const agent = new Agent({
      initialState: { model: getLiveModel(), thinkingLevel: "off", tools: [] },
      sessionId,
      store,
    });

    await agent.prompt("test");

    const todos = await store.loadTodos(sessionId);
    expect(todos).toBeDefined();
    expect(todos!.items).toEqual([]);
    expect(todos!.rendered.length).toBeGreaterThan(0);
  });
});
