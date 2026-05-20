import type { Message } from "@bookingcare/ai";
import type { PoolOptions } from "mysql2/promise";

/** Alias for Message from @bookingcare/ai for semantic clarity in storage context. */
export type StoredMessage = Message;

/** Single todo item within a snapshot. */
export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/** Snapshot of the todo list for persistence. */
export interface TodoSnapshot {
  items: TodoItem[];
  rendered: string;
}

/** Agent session metadata saved to storage. */
export interface AgentInfo {
  sessionId: string;
  model: string;
  provider: string;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** Options for loading messages with filtering. */
export interface LoadMessagesOptions {
  role?: "system" | "user" | "assistant" | "toolResult";
  limit?: number;
  since?: number;
}

/** Operation counts collected by a Store instance. */
export interface StoreOperationCounts {
  saves: number;
  loads: number;
  queries: number;
  deletes: number;
}

/** Latency snapshot collected by a Store instance. */
export interface StorePerformanceMetrics {
  avgLatencyMs: number;
  maxLatencyMs: number;
  minLatencyMs: number;
}

/** Storage snapshot collected by a Store instance. */
export interface StoreStorageMetrics {
  totalAgents: number;
  totalMessages: number;
  dbSizeBytes: number;
}

/** Aggregated Store metrics snapshot. */
export interface StoreMetrics {
  operations: StoreOperationCounts;
  performance: StorePerformanceMetrics;
  storage: StoreStorageMetrics;
  collectedAt: number;
}

export type StoreOperationKind = keyof StoreOperationCounts;

export interface JSONStoreConfig {
  type: "json";
  baseDir: string;
}

export interface MySQLStoreConfig {
  type: "mysql";
  options: PoolOptions;
}

export type StoreConfig = JSONStoreConfig | MySQLStoreConfig;

/**
 * Pluggable storage interface for agent sessions.
 *
 * Implementations persist messages, todo state, and session metadata.
 * All methods are async and may throw {@link StoreError} subclasses.
 */
export interface Store {
  /** Close any underlying resources. */
  close(): Promise<void>;

  /** Collect metrics for the store and persisted data. */
  getMetrics(): Promise<StoreMetrics>;

  /** Persist messages for a session. Replaces existing message list. */
  saveMessages(sessionId: string, messages: StoredMessage[]): Promise<void>;

  /** Load messages for a session, optionally filtered. */
  loadMessages(sessionId: string, opts?: LoadMessagesOptions): Promise<StoredMessage[]>;

  /** Persist todo snapshot for a session. */
  saveTodos(sessionId: string, snapshot: TodoSnapshot): Promise<void>;

  /** Load todo snapshot for a session. Returns undefined if not found. */
  loadTodos(sessionId: string): Promise<TodoSnapshot | undefined>;

  /** Persist session metadata. */
  saveInfo(sessionId: string, info: AgentInfo): Promise<void>;

  /** Load session metadata. Returns undefined if not found. */
  loadInfo(sessionId: string): Promise<AgentInfo | undefined>;

  /** Check whether any data exists for a session. */
  exists(sessionId: string): Promise<boolean>;

  /** Delete all data for a session. */
  delete(sessionId: string): Promise<void>;

  /** List all session IDs, optionally filtered by prefix. */
  list(prefix?: string): Promise<string[]>;
}
