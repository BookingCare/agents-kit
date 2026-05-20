// --- Types ---
export type {
  StoredMessage,
  TodoItem,
  TodoSnapshot,
  AgentInfo,
  LoadMessagesOptions,
  StoreConfig,
  Store,
} from "./types.js";

// --- Errors ---
export { StoreError, NotFoundError, CorruptDataError } from "./errors.js";

// --- Serialization ---
export { serializeAgentState, createTodoSnapshot } from "./utils/serialize.js";

// --- Providers ---
export { createStore } from "./factory.js";
export { JSONStore } from "./providers/json-store.js";
export type { JSONStoreOptions } from "./providers/json-store.js";
export { MySQLStore } from "./providers/mysql-store.js";
export type { MySQLStoreOptions, MySQLPool, MySQLConnection } from "./providers/mysql-store.js";
