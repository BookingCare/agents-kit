import mysql, { type PoolOptions } from "mysql2/promise";
import type {
  AgentInfo,
  LoadMessagesOptions,
  Store,
  StoredMessage,
  TodoSnapshot,
} from "../types.js";
import { CorruptDataError } from "../errors.js";

export type MySQLStoreOptions = PoolOptions;

export interface MySQLExecutor {
  execute(sql: string, params?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface MySQLConnection extends MySQLExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface MySQLPool extends MySQLExecutor {
  getConnection(): Promise<MySQLConnection>;
  end(): Promise<void>;
}

type SessionRow = {
  session_id: string;
};

type MessageRow = {
  seq: number | string;
  role: string;
  timestamp: number | string | null;
  message_json: string;
};

type SingleJsonRow = {
  json_data: string;
};

function toNumber(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJson<T>(sessionId: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new CorruptDataError(sessionId, error);
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * MySQL-backed session store.
 */
export class MySQLStore implements Store {
  private readonly ready: Promise<void>;

  constructor(private readonly pool: MySQLPool) {
    this.ready = this.initialize();
  }

  static async create(options: MySQLStoreOptions): Promise<MySQLStore> {
    const pool = mysql.createPool(options) as unknown as MySQLPool;
    const store = new MySQLStore(pool);

    try {
      await store.ready;
      return store;
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    const statements = [
      `
        CREATE TABLE IF NOT EXISTS sessions (
          session_id VARCHAR(191) NOT NULL,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          PRIMARY KEY (session_id)
        ) ENGINE=InnoDB
      `,
      `
        CREATE TABLE IF NOT EXISTS messages (
          session_id VARCHAR(191) NOT NULL,
          seq INT NOT NULL,
          role VARCHAR(32) NOT NULL,
          timestamp BIGINT NULL,
          message_json LONGTEXT NOT NULL,
          PRIMARY KEY (session_id, seq),
          KEY idx_messages_session_role (session_id, role),
          KEY idx_messages_session_timestamp (session_id, timestamp),
          CONSTRAINT fk_messages_sessions
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
            ON DELETE CASCADE
        ) ENGINE=InnoDB
      `,
      `
        CREATE TABLE IF NOT EXISTS todos (
          session_id VARCHAR(191) NOT NULL,
          todo_json LONGTEXT NOT NULL,
          PRIMARY KEY (session_id),
          CONSTRAINT fk_todos_sessions
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
            ON DELETE CASCADE
        ) ENGINE=InnoDB
      `,
      `
        CREATE TABLE IF NOT EXISTS infos (
          session_id VARCHAR(191) NOT NULL,
          info_json LONGTEXT NOT NULL,
          PRIMARY KEY (session_id),
          CONSTRAINT fk_infos_sessions
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
            ON DELETE CASCADE
        ) ENGINE=InnoDB
      `,
    ];

    for (const statement of statements) {
      await this.pool.execute(statement);
    }
  }

  private async withConnection<T>(
    operation: (connection: MySQLConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();

    try {
      return await operation(connection);
    } finally {
      connection.release();
    }
  }

  private async withTransaction<T>(
    operation: (connection: MySQLConnection) => Promise<T>,
  ): Promise<T> {
    return this.withConnection(async (connection) => {
      await connection.beginTransaction();

      try {
        const result = await operation(connection);
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          console.error("MySQL transaction rollback failed", rollbackError);
        }
        throw error;
      }
    });
  }

  private async touchSession(
    executor: MySQLExecutor,
    sessionId: string,
    createdAt: number,
    updatedAt: number,
  ): Promise<void> {
    await executor.execute(
      `INSERT IGNORE INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)`,
      [sessionId, createdAt, updatedAt],
    );

    await executor.execute(
      `UPDATE sessions SET created_at = LEAST(created_at, ?), updated_at = ? WHERE session_id = ?`,
      [createdAt, updatedAt, sessionId],
    );
  }

  private async runJsonUpsert(
    connection: MySQLExecutor,
    table: "todos" | "infos",
    column: "todo_json" | "info_json",
    sessionId: string,
    jsonValue: string,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO ${table} (session_id, ${column}) VALUES (?, ?) ON DUPLICATE KEY UPDATE ${column} = ?`,
      [sessionId, jsonValue, jsonValue],
    );
  }

  private async readSingleJson<T>(
    sessionId: string,
    table: "todos" | "infos",
    column: "todo_json" | "info_json",
  ): Promise<T | undefined> {
    const [rows] = await this.pool.execute(
      `SELECT ${column} AS json_data FROM ${table} WHERE session_id = ?`,
      [sessionId],
    );
    const [row] = rows as SingleJsonRow[];

    if (!row) {
      return undefined;
    }

    return parseJson<T>(sessionId, row.json_data);
  }

  async saveMessages(sessionId: string, messages: StoredMessage[]): Promise<void> {
    await this.ready;

    await this.withTransaction(async (connection) => {
      const now = Date.now();
      await this.touchSession(connection, sessionId, now, now);
      await connection.execute(`DELETE FROM messages WHERE session_id = ?`, [sessionId]);

      const insertSql = `
        INSERT INTO messages (session_id, seq, role, timestamp, message_json)
        VALUES (?, ?, ?, ?, ?)
      `;

      for (const [seq, message] of messages.entries()) {
        await connection.execute(insertSql, [
          sessionId,
          seq,
          message.role,
          "timestamp" in message && typeof message.timestamp === "number"
            ? message.timestamp
            : null,
          JSON.stringify(message),
        ]);
      }
    });
  }

  async loadMessages(sessionId: string, opts?: LoadMessagesOptions): Promise<StoredMessage[]> {
    await this.ready;

    const [rows] = await this.pool.execute(
      `
        SELECT seq, role, timestamp, message_json
        FROM messages
        WHERE session_id = ?
        ORDER BY seq ASC
      `,
      [sessionId],
    );

    const messages = (rows as MessageRow[]).map((row) => ({
      message: parseJson<StoredMessage>(sessionId, row.message_json),
      timestamp: toNumber(row.timestamp),
    }));

    let result = messages;

    if (opts?.role) {
      result = result.filter((entry) => entry.message.role === opts.role);
    }

    if (opts?.since !== undefined) {
      result = result.filter(
        (entry) => entry.timestamp !== undefined && entry.timestamp >= opts.since!,
      );
    }

    if (opts?.limit !== undefined && opts.limit > 0) {
      result = result.slice(-opts.limit);
    }

    return result.map((entry) => entry.message);
  }

  async saveTodos(sessionId: string, snapshot: TodoSnapshot): Promise<void> {
    await this.ready;

    await this.withTransaction(async (connection) => {
      const now = Date.now();
      await this.touchSession(connection, sessionId, now, now);
      await this.runJsonUpsert(
        connection,
        "todos",
        "todo_json",
        sessionId,
        JSON.stringify(snapshot),
      );
    });
  }

  async loadTodos(sessionId: string): Promise<TodoSnapshot | undefined> {
    await this.ready;
    return this.readSingleJson<TodoSnapshot>(sessionId, "todos", "todo_json");
  }

  async saveInfo(sessionId: string, info: AgentInfo): Promise<void> {
    await this.ready;

    await this.withTransaction(async (connection) => {
      await this.touchSession(connection, sessionId, info.createdAt, info.updatedAt);
      await this.runJsonUpsert(connection, "infos", "info_json", sessionId, JSON.stringify(info));
    });
  }

  async loadInfo(sessionId: string): Promise<AgentInfo | undefined> {
    await this.ready;
    return this.readSingleJson<AgentInfo>(sessionId, "infos", "info_json");
  }

  async exists(sessionId: string): Promise<boolean> {
    await this.ready;

    const [rows] = await this.pool.execute(`SELECT 1 FROM sessions WHERE session_id = ? LIMIT 1`, [
      sessionId,
    ]);
    return (rows as SessionRow[]).length > 0;
  }

  async delete(sessionId: string): Promise<void> {
    await this.ready;

    await this.withTransaction(async (connection) => {
      await connection.execute(`DELETE FROM messages WHERE session_id = ?`, [sessionId]);
      await connection.execute(`DELETE FROM todos WHERE session_id = ?`, [sessionId]);
      await connection.execute(`DELETE FROM infos WHERE session_id = ?`, [sessionId]);
      await connection.execute(`DELETE FROM sessions WHERE session_id = ?`, [sessionId]);
    });
  }

  async list(prefix?: string): Promise<string[]> {
    await this.ready;

    if (prefix) {
      const escapedPrefix = escapeLike(prefix);
      const [rows] = await this.pool.execute(
        `SELECT session_id FROM sessions WHERE session_id LIKE ? ESCAPE '\\' ORDER BY created_at DESC, session_id ASC`,
        [`${escapedPrefix}%`],
      );
      return (rows as SessionRow[]).map((row) => row.session_id);
    }

    const [rows] = await this.pool.execute(
      `SELECT session_id FROM sessions ORDER BY created_at DESC, session_id ASC`,
    );
    return (rows as SessionRow[]).map((row) => row.session_id);
  }

  async close(): Promise<void> {
    await this.ready;
    await this.pool.end();
  }
}
