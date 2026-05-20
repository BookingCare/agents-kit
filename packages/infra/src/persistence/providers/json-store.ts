import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Store,
  LoadMessagesOptions,
  StoredMessage,
  TodoSnapshot,
  AgentInfo,
  StoreMetrics,
  StoreStorageMetrics,
} from "../types.js";
import { StoreError, CorruptDataError } from "../errors.js";
import { StoreMetricsTracker } from "../utils/store-metrics.js";
import { validateSessionId } from "../utils/session-id.js";

export interface JSONStoreOptions {
  /** Directory where session subdirectories will be created. */
  baseDir: string;
}

/**
 * Filesystem-based Store implementation.
 *
 * Each session gets a subdirectory under `baseDir` containing:
 * - `messages.json` — array of messages
 * - `todos.json` — todo snapshot
 * - `info.json` — session metadata
 *
 * Single-process only. Concurrent writes to the same session are not protected.
 */
export class JSONStore implements Store {
  private readonly metrics = new StoreMetricsTracker();

  constructor(private readonly options: JSONStoreOptions) {}

  /** Create a JSONStore, ensuring the base directory exists. */
  static async create(options: JSONStoreOptions): Promise<JSONStore> {
    await fs.mkdir(options.baseDir, { recursive: true });
    return new JSONStore(options);
  }

  private getSessionDir(sessionId: string): string {
    validateSessionId(sessionId);
    return path.resolve(this.options.baseDir, sessionId);
  }

  private async ensureSessionDir(sessionId: string): Promise<string> {
    const sessionDir = this.getSessionDir(sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    return sessionDir;
  }

  private async writeJson<T>(filePath: string, data: T): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }

  private async readJson<T>(sessionId: string, filePath: string): Promise<T | undefined> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        return undefined;
      }
      if (error instanceof SyntaxError) {
        throw new CorruptDataError(sessionId, error);
      }
      throw new StoreError(`Failed to read data for session: ${sessionId}`, error);
    }
  }

  async saveMessages(sessionId: string, messages: StoredMessage[]): Promise<void> {
    return this.metrics.track("saves", async () => {
      const sessionDir = await this.ensureSessionDir(sessionId);
      await this.writeJson(path.join(sessionDir, "messages.json"), messages);
    });
  }

  async loadMessages(sessionId: string, opts?: LoadMessagesOptions): Promise<StoredMessage[]> {
    return this.metrics.track("loads", async () => {
      const filePath = path.join(this.getSessionDir(sessionId), "messages.json");
      const messages = await this.readJson<StoredMessage[]>(sessionId, filePath);

      if (!messages) {
        return [];
      }

      let result = messages;

      if (opts?.role) {
        result = result.filter((m) => m.role === opts.role);
      }

      if (opts?.since !== undefined) {
        result = result.filter((m) => "timestamp" in m && m.timestamp >= opts.since!);
      }

      if (opts?.limit !== undefined && opts.limit > 0) {
        result = result.slice(-opts.limit);
      }

      return result;
    });
  }

  async saveTodos(sessionId: string, snapshot: TodoSnapshot): Promise<void> {
    return this.metrics.track("saves", async () => {
      const sessionDir = await this.ensureSessionDir(sessionId);
      await this.writeJson(path.join(sessionDir, "todos.json"), snapshot);
    });
  }

  async loadTodos(sessionId: string): Promise<TodoSnapshot | undefined> {
    return this.metrics.track("loads", async () => {
      const filePath = path.join(this.getSessionDir(sessionId), "todos.json");
      return this.readJson<TodoSnapshot>(sessionId, filePath);
    });
  }

  async saveInfo(sessionId: string, info: AgentInfo): Promise<void> {
    return this.metrics.track("saves", async () => {
      const sessionDir = await this.ensureSessionDir(sessionId);
      await this.writeJson(path.join(sessionDir, "info.json"), info);
    });
  }

  async loadInfo(sessionId: string): Promise<AgentInfo | undefined> {
    return this.metrics.track("loads", async () => {
      const filePath = path.join(this.getSessionDir(sessionId), "info.json");
      return this.readJson<AgentInfo>(sessionId, filePath);
    });
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.metrics.track("queries", async () => {
      try {
        await fs.access(this.getSessionDir(sessionId));
        return true;
      } catch {
        return false;
      }
    });
  }

  async delete(sessionId: string): Promise<void> {
    return this.metrics.track("deletes", async () => {
      try {
        await fs.rm(this.getSessionDir(sessionId), { recursive: true, force: true });
      } catch (error) {
        throw new StoreError(`Failed to delete session: ${sessionId}`, error);
      }
    });
  }

  async getMetrics(): Promise<StoreMetrics> {
    return this.metrics.snapshot(await this.collectStorageMetrics());
  }

  async close(): Promise<void> {}

  private async collectStorageMetrics(): Promise<StoreStorageMetrics> {
    try {
      const entries = await fs.readdir(this.options.baseDir, { withFileTypes: true });
      const sessionDirs = entries.filter((entry) => entry.isDirectory());
      let totalMessages = 0;

      for (const entry of sessionDirs) {
        const messages = await this.readJson<StoredMessage[]>(
          entry.name,
          path.join(this.options.baseDir, entry.name, "messages.json"),
        );
        totalMessages += messages?.length ?? 0;
      }

      return {
        totalAgents: sessionDirs.length,
        totalMessages,
        dbSizeBytes: await this.collectDirectorySize(this.options.baseDir),
      };
    } catch (error) {
      if (error instanceof StoreError) {
        throw error;
      }

      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        return { totalAgents: 0, totalMessages: 0, dbSizeBytes: 0 };
      }

      throw new StoreError("Failed to collect store metrics", error);
    }
  }

  private async collectDirectorySize(dirPath: string): Promise<number> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      let size = 0;

      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          size += await this.collectDirectorySize(entryPath);
        } else {
          size += (await fs.stat(entryPath)).size;
        }
      }

      return size;
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        return 0;
      }

      throw error;
    }
  }

  async list(prefix?: string): Promise<string[]> {
    return this.metrics.track("queries", async () => {
      try {
        const entries = await fs.readdir(this.options.baseDir, { withFileTypes: true });
        const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);

        if (prefix) {
          return ids.filter((id) => id.startsWith(prefix)).sort();
        }

        return ids.sort();
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code === "ENOENT") {
          return [];
        }
        throw new StoreError("Failed to list sessions", error);
      }
    });
  }
}
