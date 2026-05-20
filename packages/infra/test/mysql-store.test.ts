import { beforeEach, describe, expect, it } from "vitest";
import {
  MySQLStore,
  type MySQLConnection,
  type MySQLPool,
} from "../src/persistence/providers/mysql-store.js";
import { CorruptDataError, StoreError } from "../src/persistence/errors.js";
import type { AgentInfo, StoredMessage, TodoSnapshot } from "../src/persistence/types.js";

type SessionRecord = {
  createdAt: number;
  updatedAt: number;
};

type MessageRecord = {
  seq: number;
  role: string;
  timestamp: number | null;
  message_json: string;
};

function decodeLikePrefix(pattern: string): string {
  const trimmed = pattern.endsWith("%") ? pattern.slice(0, -1) : pattern;
  let result = "";

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "\\" && index + 1 < trimmed.length) {
      result += trimmed[index + 1];
      index += 1;
      continue;
    }

    result += char;
  }

  return result;
}

class FakeMySQLPool implements MySQLPool {
  sessions = new Map<string, SessionRecord>();
  messages = new Map<string, MessageRecord[]>();
  todos = new Map<string, string>();
  infos = new Map<string, string>();
  ended = false;

  private sortedSessionRows(prefix?: string): Array<{ session_id: string }> {
    const rows = [...this.sessions.entries()]
      .filter(([sessionId]) => (prefix ? sessionId.startsWith(prefix) : true))
      .sort((left, right) => {
        const timeDelta = right[1].createdAt - left[1].createdAt;
        return timeDelta !== 0 ? timeDelta : left[0].localeCompare(right[0]);
      });

    return rows.map(([sessionId]) => ({ session_id: sessionId }));
  }

  async getConnection(): Promise<MySQLConnection> {
    return new FakeMySQLConnection(this);
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<[unknown, unknown]> {
    const statement = sql.trim().replace(/\s+/g, " ");

    if (statement.startsWith("CREATE TABLE IF NOT EXISTS")) {
      return [[], []];
    }

    if (statement.startsWith("INSERT IGNORE INTO sessions")) {
      const [sessionId, createdAt, updatedAt] = params as [string, number, number];
      if (!this.sessions.has(sessionId)) {
        this.sessions.set(sessionId, { createdAt, updatedAt });
      }
      return [[], []];
    }

    if (
      statement.startsWith(
        "UPDATE sessions SET created_at = LEAST(created_at, ?), updated_at = ? WHERE session_id = ?",
      )
    ) {
      const [createdAt, updatedAt, sessionId] = params as [number, number, string];
      const session = this.sessions.get(sessionId);
      if (session) {
        session.createdAt = Math.min(session.createdAt, createdAt);
        session.updatedAt = updatedAt;
      }
      return [[], []];
    }

    if (statement.startsWith("DELETE FROM messages WHERE session_id = ?")) {
      const [sessionId] = params as [string];
      this.messages.delete(sessionId);
      return [[], []];
    }

    if (statement.startsWith("DELETE FROM todos WHERE session_id = ?")) {
      const [sessionId] = params as [string];
      this.todos.delete(sessionId);
      return [[], []];
    }

    if (statement.startsWith("DELETE FROM infos WHERE session_id = ?")) {
      const [sessionId] = params as [string];
      this.infos.delete(sessionId);
      return [[], []];
    }

    if (statement.startsWith("DELETE FROM sessions WHERE session_id = ?")) {
      const [sessionId] = params as [string];
      this.sessions.delete(sessionId);
      this.messages.delete(sessionId);
      this.todos.delete(sessionId);
      this.infos.delete(sessionId);
      return [[], []];
    }

    if (
      statement.startsWith("INSERT INTO messages (session_id, seq, role, timestamp, message_json)")
    ) {
      const [sessionId, seq, role, timestamp, messageJson] = params as [
        string,
        number,
        string,
        number | null,
        string,
      ];
      const rows = this.messages.get(sessionId) ?? [];
      rows.push({
        seq,
        role,
        timestamp,
        message_json: messageJson,
      });
      this.messages.set(sessionId, rows);
      return [[], []];
    }

    if (statement.startsWith("INSERT INTO todos (session_id, todo_json)")) {
      const [sessionId, todoJson] = params as [string, string, string];
      this.todos.set(sessionId, todoJson);
      return [[], []];
    }

    if (statement.startsWith("INSERT INTO infos (session_id, info_json)")) {
      const [sessionId, infoJson] = params as [string, string, string];
      this.infos.set(sessionId, infoJson);
      return [[], []];
    }

    if (
      statement.startsWith(
        "SELECT seq, role, timestamp, message_json FROM messages WHERE session_id = ? ORDER BY seq ASC",
      )
    ) {
      const [sessionId] = params as [string];
      const rows = [...(this.messages.get(sessionId) ?? [])].sort(
        (left, right) => left.seq - right.seq,
      );
      return [rows, []];
    }

    if (statement.startsWith("SELECT todo_json AS json_data FROM todos WHERE session_id = ?")) {
      const [sessionId] = params as [string];
      const value = this.todos.get(sessionId);
      return [value ? [{ json_data: value }] : [], []];
    }

    if (statement.startsWith("SELECT info_json AS json_data FROM infos WHERE session_id = ?")) {
      const [sessionId] = params as [string];
      const value = this.infos.get(sessionId);
      return [value ? [{ json_data: value }] : [], []];
    }

    if (statement.startsWith("SELECT 1 FROM sessions WHERE session_id = ? LIMIT 1")) {
      const [sessionId] = params as [string];
      return [this.sessions.has(sessionId) ? [{}] : [], []];
    }

    if (
      statement.startsWith(
        "SELECT session_id FROM sessions WHERE session_id LIKE ? ESCAPE '\\' ORDER BY created_at DESC, session_id ASC",
      )
    ) {
      const [pattern] = params as [string];
      return [this.sortedSessionRows(decodeLikePrefix(pattern)), []];
    }

    if (
      statement.startsWith(
        "SELECT session_id FROM sessions ORDER BY created_at DESC, session_id ASC",
      )
    ) {
      return [this.sortedSessionRows(), []];
    }

    throw new Error(`Unexpected SQL: ${statement}`);
  }
}

class FakeMySQLConnection implements MySQLConnection {
  constructor(private readonly pool: FakeMySQLPool) {}

  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  release(): void {}

  async execute(sql: string, params?: readonly unknown[]): Promise<[unknown, unknown]> {
    return this.pool.execute(sql, params);
  }
}

function createMessages(): StoredMessage[] {
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
      usage: {
        input: 5,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
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
      usage: {
        input: 3,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 8,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
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

describe("MySQLStore", () => {
  let pool: FakeMySQLPool;
  let store: MySQLStore;

  beforeEach(() => {
    pool = new FakeMySQLPool();
    store = new MySQLStore(pool);
  });

  it("round-trips messages and filters them", async () => {
    const sessionId = "test-session";
    const messages = createMessages();

    await store.saveMessages(sessionId, messages);

    expect(await store.loadMessages(sessionId)).toEqual(messages);
    expect(await store.loadMessages(sessionId, { role: "assistant" })).toHaveLength(2);
    expect(await store.loadMessages(sessionId, { role: "user" })).toHaveLength(2);
    expect(await store.loadMessages(sessionId, { role: "toolResult" })).toHaveLength(1);
    expect(await store.loadMessages(sessionId, { since: 3000 })).toEqual(messages.slice(3));
    expect(await store.loadMessages(sessionId, { limit: 3 })).toEqual(messages.slice(3));
  });

  it("round-trips todos and info", async () => {
    const sessionId = "state-session";
    const snapshot = createTodoSnapshot();
    const info = createAgentInfo(sessionId);

    await store.saveTodos(sessionId, snapshot);
    await store.saveInfo(sessionId, info);

    expect(await store.loadTodos(sessionId)).toEqual(snapshot);
    expect(await store.loadInfo(sessionId)).toEqual(info);
  });

  it("overwrites existing messages", async () => {
    const sessionId = "overwrite";
    const messages = createMessages();

    await store.saveMessages(sessionId, messages);
    await store.saveMessages(sessionId, messages.slice(0, 2));

    expect(await store.loadMessages(sessionId)).toEqual(messages.slice(0, 2));
  });

  it("tracks existence, listing, and deletion", async () => {
    await store.saveInfo("beta", createAgentInfo("beta"));
    await store.saveInfo("alpha", createAgentInfo("alpha"));
    await store.saveInfo("pref-abc", createAgentInfo("pref-abc"));

    expect(await store.exists("alpha")).toBe(true);
    expect(await store.list()).toEqual(["alpha", "beta", "pref-abc"]);
    expect(await store.list("pref-")).toEqual(["pref-abc"]);

    await store.delete("alpha");

    expect(await store.exists("alpha")).toBe(false);
    expect(await store.loadInfo("alpha")).toBeUndefined();
    expect(await store.list()).toEqual(["beta", "pref-abc"]);
  });

  it("rejects invalid session IDs", async () => {
    const tooLongSessionId = "a".repeat(192);

    await expect(store.saveInfo("a/b", createAgentInfo("a/b"))).rejects.toThrow(StoreError);
    await expect(store.exists(tooLongSessionId)).rejects.toThrow(StoreError);
  });

  it("closes the pool", async () => {
    await store.close();
    expect(pool.ended).toBe(true);
  });

  it("throws CorruptDataError for invalid JSON", async () => {
    pool.todos.set("bad-todo", "not json");
    pool.infos.set("bad-info", "not json");
    pool.messages.set("bad-message", [
      { seq: 0, role: "user", timestamp: 1, message_json: "not json" },
    ]);
    pool.sessions.set("bad-message", { createdAt: 1, updatedAt: 1 });
    pool.sessions.set("bad-todo", { createdAt: 1, updatedAt: 1 });
    pool.sessions.set("bad-info", { createdAt: 1, updatedAt: 1 });

    await expect(store.loadMessages("bad-message")).rejects.toThrow(CorruptDataError);
    await expect(store.loadTodos("bad-todo")).rejects.toThrow(CorruptDataError);
    await expect(store.loadInfo("bad-info")).rejects.toThrow(CorruptDataError);
  });
});
