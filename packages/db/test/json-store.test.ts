import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { JSONStore } from "../src/providers/json-store.js";
import { CorruptDataError, StoreError } from "../src/errors.js";
import type { StoredMessage, TodoSnapshot, AgentInfo } from "../src/types.js";

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "db-test-"));
}

function createMessages(sessionId: string): StoredMessage[] {
  return [
    { role: "system", content: "You are a test agent." },
    {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
      timestamp: 1000,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Hi there" }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4",
      usage: { inputTokens: 5, outputTokens: 10 },
      stopReason: "stop",
      timestamp: 2000,
    },
    {
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "echo",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 3000,
    },
    {
      role: "user",
      content: [{ type: "text", text: "Thanks" }],
      timestamp: 4000,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "You're welcome" }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4",
      usage: { inputTokens: 3, outputTokens: 5 },
      stopReason: "stop",
      timestamp: 5000,
    },
  ];
}

function createTodoSnapshot(): TodoSnapshot {
  return {
    items: [
      { id: "1", text: "Task one", status: "completed" },
      { id: "2", text: "Task two", status: "in_progress" },
    ],
    rendered: "[x] #1: Task one\n[>] #2: Task two\n\n(1/2 completed)",
  };
}

function createAgentInfo(sessionId: string): AgentInfo {
  return {
    sessionId,
    model: "gpt-4",
    provider: "openai",
    systemPrompt: "You are a test agent.",
    createdAt: 1000,
    updatedAt: 5000,
    messageCount: 6,
  };
}

describe("JSONStore", () => {
  let baseDir: string;
  let store: JSONStore;

  beforeEach(async () => {
    baseDir = await createTempDir();
    store = await JSONStore.create({ baseDir });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  describe("messages", () => {
    it("round-trips messages", async () => {
      const sessionId = "test-session";
      const messages = createMessages(sessionId);

      await store.saveMessages(sessionId, messages);
      const loaded = await store.loadMessages(sessionId);

      expect(loaded).toEqual(messages);
    });

    it("filters by role", async () => {
      const sessionId = "role-filter";
      const messages = createMessages(sessionId);

      await store.saveMessages(sessionId, messages);

      const assistantMsgs = await store.loadMessages(sessionId, { role: "assistant" });
      expect(assistantMsgs).toHaveLength(2);
      expect(assistantMsgs.every((m) => m.role === "assistant")).toBe(true);

      const userMsgs = await store.loadMessages(sessionId, { role: "user" });
      expect(userMsgs).toHaveLength(2);

      const toolMsgs = await store.loadMessages(sessionId, { role: "toolResult" });
      expect(toolMsgs).toHaveLength(1);

      const systemMsgs = await store.loadMessages(sessionId, { role: "system" });
      expect(systemMsgs).toHaveLength(1);
    });

    it("filters by limit (returns last N)", async () => {
      const sessionId = "limit-test";
      const messages = createMessages(sessionId);

      await store.saveMessages(sessionId, messages);
      const limited = await store.loadMessages(sessionId, { limit: 3 });

      expect(limited).toHaveLength(3);
      expect(limited[0]).toEqual(messages[3]);
      expect(limited[1]).toEqual(messages[4]);
      expect(limited[2]).toEqual(messages[5]);
    });

    it("filters by since timestamp", async () => {
      const sessionId = "since-test";
      const messages = createMessages(sessionId);

      await store.saveMessages(sessionId, messages);
      const filtered = await store.loadMessages(sessionId, { since: 3000 });

      expect(filtered).toHaveLength(3);
      expect(filtered[0]).toEqual(messages[3]); // toolResult at 3000
      expect(filtered[1]).toEqual(messages[4]);
      expect(filtered[2]).toEqual(messages[5]);
    });

    it("combines role and limit filters", async () => {
      const sessionId = "combined";
      const messages = createMessages(sessionId);

      await store.saveMessages(sessionId, messages);
      const filtered = await store.loadMessages(sessionId, {
        role: "assistant",
        limit: 1,
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toEqual(messages[5]);
    });

    it("returns empty array for missing session", async () => {
      const loaded = await store.loadMessages("nonexistent");
      expect(loaded).toEqual([]);
    });

    it("overwrites existing messages", async () => {
      const sessionId = "overwrite";
      const messages1 = createMessages(sessionId);
      const messages2 = messages1.slice(0, 2);

      await store.saveMessages(sessionId, messages1);
      await store.saveMessages(sessionId, messages2);

      const loaded = await store.loadMessages(sessionId);
      expect(loaded).toEqual(messages2);
    });
  });

  describe("todos", () => {
    it("round-trips todo snapshot", async () => {
      const sessionId = "todo-test";
      const snapshot = createTodoSnapshot();

      await store.saveTodos(sessionId, snapshot);
      const loaded = await store.loadTodos(sessionId);

      expect(loaded).toEqual(snapshot);
    });

    it("returns undefined for missing todos", async () => {
      const loaded = await store.loadTodos("nonexistent");
      expect(loaded).toBeUndefined();
    });
  });

  describe("info", () => {
    it("round-trips agent info", async () => {
      const sessionId = "info-test";
      const info = createAgentInfo(sessionId);

      await store.saveInfo(sessionId, info);
      const loaded = await store.loadInfo(sessionId);

      expect(loaded).toEqual(info);
    });

    it("returns undefined for missing info", async () => {
      const loaded = await store.loadInfo("nonexistent");
      expect(loaded).toBeUndefined();
    });
  });

  describe("exists", () => {
    it("returns true for existing session", async () => {
      const sessionId = "exists-test";
      await store.saveInfo(sessionId, createAgentInfo(sessionId));
      expect(await store.exists(sessionId)).toBe(true);
    });

    it("returns false for missing session", async () => {
      expect(await store.exists("nonexistent")).toBe(false);
    });
  });

  describe("delete", () => {
    it("removes all session data", async () => {
      const sessionId = "delete-test";
      await store.saveMessages(sessionId, createMessages(sessionId));
      await store.saveTodos(sessionId, createTodoSnapshot());
      await store.saveInfo(sessionId, createAgentInfo(sessionId));

      await store.delete(sessionId);

      expect(await store.exists(sessionId)).toBe(false);
      expect(await store.loadMessages(sessionId)).toEqual([]);
      expect(await store.loadTodos(sessionId)).toBeUndefined();
      expect(await store.loadInfo(sessionId)).toBeUndefined();
    });

    it("does not throw for non-existent session", async () => {
      await expect(store.delete("nonexistent")).resolves.not.toThrow();
    });
  });

  describe("list", () => {
    it("returns all session IDs sorted", async () => {
      await store.saveInfo("beta", createAgentInfo("beta"));
      await store.saveInfo("alpha", createAgentInfo("alpha"));
      await store.saveInfo("gamma", createAgentInfo("gamma"));

      const ids = await store.list();
      expect(ids).toEqual(["alpha", "beta", "gamma"]);
    });

    it("filters by prefix", async () => {
      await store.saveInfo("pref-abc", createAgentInfo("pref-abc"));
      await store.saveInfo("pref-def", createAgentInfo("pref-def"));
      await store.saveInfo("other", createAgentInfo("other"));

      const ids = await store.list("pref-");
      expect(ids).toEqual(["pref-abc", "pref-def"]);
    });

    it("returns empty array when none exist", async () => {
      const ids = await store.list();
      expect(ids).toEqual([]);
    });
  });

  describe("error handling", () => {
    it("throws CorruptDataError for invalid JSON in messages", async () => {
      const sessionId = "corrupt";
      const sessionDir = path.join(baseDir, sessionId);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(path.join(sessionDir, "messages.json"), "not json", "utf-8");

      await expect(store.loadMessages(sessionId)).rejects.toThrow(CorruptDataError);
    });

    it("throws CorruptDataError for invalid JSON in todos", async () => {
      const sessionId = "corrupt-todo";
      const sessionDir = path.join(baseDir, sessionId);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(path.join(sessionDir, "todos.json"), "not json", "utf-8");

      await expect(store.loadTodos(sessionId)).rejects.toThrow(CorruptDataError);
    });

    it("throws CorruptDataError for invalid JSON in info", async () => {
      const sessionId = "corrupt-info";
      const sessionDir = path.join(baseDir, sessionId);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(path.join(sessionDir, "info.json"), "not json", "utf-8");

      await expect(store.loadInfo(sessionId)).rejects.toThrow(CorruptDataError);
    });

    it("throws StoreError for path traversal in sessionId", async () => {
      await expect(store.loadMessages("../etc")).rejects.toThrow(StoreError);
      await expect(store.saveMessages("../../outside", [])).rejects.toThrow(StoreError);
      await expect(store.delete("../secret")).rejects.toThrow(StoreError);
    });
  });

  describe("create", () => {
    it("creates baseDir if it does not exist", async () => {
      const newDir = path.join(baseDir, "nested", "store");
      const newStore = await JSONStore.create({ baseDir: newDir });
      await newStore.saveInfo("test", createAgentInfo("test"));
      expect(await newStore.exists("test")).toBe(true);
    });
  });
});
