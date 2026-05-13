# Persistence Layer for Agent Sessions - Tech Spec

## Problem

The `Agent` class in `packages/agent` holds all state in `MutableAgentState` (messages, tools config, system prompt, model). There is no persistence layer, so sessions are lost on process restart. We need to:

1. Serialize `AgentState` to/from a storage backend
2. Store message transcripts, todo state, and metadata
3. Enable session resumption via `Agent.resume()`
4. Abstract storage behind pluggable interfaces

The persistence layer must be a separate package (`packages/db`) to avoid coupling `packages/agent` to specific storage implementations.

## Relevant code

### packages/agent/src/types.ts

- `AgentState` (line ~100-112): Immutable state contract with `systemPrompt`, `model`, `thinkingLevel`, `tools`, `messages`, `isStreaming`, `streamingMessage`, `pendingToolCalls`, `errorMessage`
- `MutableAgentState` (line ~135-155): Mutable version used internally in `Agent`
- `AgentMessage`: Alias for `Message` from `@bookingcare/ai`
- `AgentEvent` (line ~118-126): Event types including `agent_end`

### packages/agent/src/agent.ts

- `Agent` class (line ~185+): Main agent class with state management
- `createMutableAgentState()` (line ~140-166): Creates mutable state instance
- `processEvents()` (line ~470-530): Handles lifecycle events including `agent_end`
- `AgentOptions` (line ~174-187): Constructor options where `store` parameter will be added

### packages/agent/src/todo-manager.ts

- `TodoItem` (line ~4): Todo item with `id`, `text`, `status`
- `TodoManager` (line ~21-73): Manages todo list state

### packages/ai/src/types.ts

- `Message` (line ~75+): Union of `SystemMessage`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`
- `SystemMessage`: `{ role: "system", content: string }`
- `UserMessage`: `{ role: "user", content: ..., timestamp: number }`
- `AssistantMessage`: `{ role: "assistant", content: [...], api, provider, model, usage, stopReason, errorMessage?, timestamp: number }`
- `ToolResultMessage`: `{ role: "toolResult", toolCallId, toolName, content, details?, isError, timestamp: number }`

## Current state

### State ownership

- `Agent` owns `MutableAgentState` in `this._state`
- `AgentState` is the read-only snapshot returned by `this.state`
- `TodoManager` owns todo items (no serialization currently)
- Messages are stored in `AgentState.messages` array

### Event flow

```
user prompt → runAgentLoop() → processEvents() → listeners
                                              → agent_end event
```

The `agent_end` event contains the final message transcript. This is the natural hook for persistence.

### No storage

- No serialization of `AgentState`
- No file or database I/O
- No session persistence

## Proposed changes

### New package: packages/db

Structure following `packages/ai` pattern:

```
packages/db/
  src/
    index.ts              — public API exports
    types.ts              — Store, SessionStore, MessageStore, TodoStore interfaces
    store.ts              — Base Store interface and error types
    providers/
      index.ts            — Provider exports
      json-store.ts       — Filesystem-based Store implementation
    utils/
      serialize.ts        — AgentState ↔ JSON conversion
    errors.ts             — StoreError, NotFoundError, CorruptDataError
  test/
    serialize.test.ts     — Round-trip tests
    json-store.test.ts    — Store implementation tests
    integration.test.ts    — Agent + Store integration
  package.json
  tsconfig.json
  README.md
```

### Core types (packages/db/src/types.ts)

```typescript
import type { Message } from "@bookingcare/ai";

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodoSnapshot {
  items: TodoItem[];
  rendered: string;
}

export interface AgentInfo {
  sessionId: string;
  model: string;
  provider: string;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface LoadMessagesOptions {
  role?: "system" | "user" | "assistant" | "toolResult";
  limit?: number;
  since?: number; // Unix timestamp
}

export interface Store {
  // Messages
  saveMessages(sessionId: string, messages: Message[]): Promise<void>;
  loadMessages(sessionId: string, opts?: LoadMessagesOptions): Promise<Message[]>;

  // Todos
  saveTodos(sessionId: string, snapshot: TodoSnapshot): Promise<void>;
  loadTodos(sessionId: string): Promise<TodoSnapshot | undefined>;

  // Metadata
  saveInfo(sessionId: string, info: AgentInfo): Promise<void>;
  loadInfo(sessionId: string): Promise<AgentInfo | undefined>;

  // Lifecycle
  exists(sessionId: string): Promise<boolean>;
  delete(sessionId: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
```

### Store errors (packages/db/src/errors.ts)

```typescript
export class StoreError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export class NotFoundError extends StoreError {
  constructor(agentId: string) {
    super(`Session not found: ${agentId}`);
    this.name = "NotFoundError";
  }
}

export class CorruptDataError extends StoreError {
  constructor(
    agentId: string,
    public readonly cause?: unknown,
  ) {
    super(`Corrupt data for session: ${agentId}`, cause);
    this.name = "CorruptDataError";
  }
}
```

### JSONStore implementation (packages/db/src/providers/json-store.ts)

```typescript
import { promises as fs } from "fs";
import path from "path";
import type { Store, LoadMessagesOptions } from "../types.js";
import { NotFoundError, CorruptDataError, StoreError } from "../errors.js";

export interface JSONStoreOptions {
  baseDir: string;
}

export class JSONStore implements Store {
  constructor(private readonly options: JSONStoreOptions) {}

  static async create(options: JSONStoreOptions): Promise<JSONStore> {
    await fs.mkdir(options.baseDir, { recursive: true });
    return new JSONStore(options);
  }

  private getSessionDir(agentId: string): string {
    return path.join(this.options.baseDir, agentId);
  }

  private async ensureSessionDir(agentId: string): Promise<string> {
    const sessionDir = this.getSessionDir(agentId);
    await fs.mkdir(sessionDir, { recursive: true });
    return sessionDir;
  }

  async saveMessages(agentId: string, messages: AgentMessage[]): Promise<void> {
    const sessionDir = await this.ensureSessionDir(agentId);
    const messagesPath = path.join(sessionDir, "messages.json");
    await fs.writeFile(messagesPath, JSON.stringify(messages, null, 2), "utf-8");
  }

  async loadMessages(agentId: string, opts?: LoadMessagesOptions): Promise<AgentMessage[]> {
    const messagesPath = path.join(this.getSessionDir(agentId), "messages.json");
    try {
      const data = await fs.readFile(messagesPath, "utf-8");
      let messages = JSON.parse(data) as AgentMessage[];

      // Apply filters
      if (opts?.role) {
        messages = messages.filter((m) => m.role === opts.role);
      }
      if (opts?.since) {
        messages = messages.filter((m) => m.timestamp >= opts.since);
      }
      if (opts?.limit) {
        messages = messages.slice(-opts.limit);
      }

      return messages;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw new CorruptDataError(agentId, error);
    }
  }

  async saveTodos(agentId: string, snapshot: TodoSnapshot): Promise<void> {
    const sessionDir = await this.ensureSessionDir(agentId);
    const todosPath = path.join(sessionDir, "todos.json");
    await fs.writeFile(todosPath, JSON.stringify(snapshot, null, 2), "utf-8");
  }

  async loadTodos(agentId: string): Promise<TodoSnapshot | undefined> {
    const todosPath = path.join(this.getSessionDir(agentId), "todos.json");
    try {
      const data = await fs.readFile(todosPath, "utf-8");
      return JSON.parse(data) as TodoSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw new CorruptDataError(agentId, error);
    }
  }

  async saveInfo(agentId: string, info: AgentInfo): Promise<void> {
    const sessionDir = await this.ensureSessionDir(agentId);
    const infoPath = path.join(sessionDir, "info.json");
    await fs.writeFile(infoPath, JSON.stringify(info, null, 2), "utf-8");
  }

  async loadInfo(agentId: string): Promise<AgentInfo | undefined> {
    const infoPath = path.join(this.getSessionDir(agentId), "info.json");
    try {
      const data = await fs.readFile(infoPath, "utf-8");
      return JSON.parse(data) as AgentInfo;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw new CorruptDataError(agentId, error);
    }
  }

  async exists(agentId: string): Promise<boolean> {
    try {
      await fs.access(this.getSessionDir(agentId));
      return true;
    } catch {
      return false;
    }
  }

  async delete(agentId: string): Promise<void> {
    try {
      await fs.rm(this.getSessionDir(agentId), { recursive: true, force: true });
    } catch (error) {
      throw new StoreError(`Failed to delete session: ${agentId}`, error);
    }
  }

  async list(prefix?: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.options.baseDir, { withFileTypes: true });
      const sessionDirs = entries.filter((e) => e.isDirectory());
      let sessionIds = sessionDirs.map((e) => e.name);

      if (prefix) {
        sessionIds = sessionIds.filter((id) => id.startsWith(prefix));
      }

      return sessionIds.sort();
    } catch (error) {
      throw new StoreError("Failed to list sessions", error);
    }
  }
}
```

### Serialization utilities (packages/db/src/utils/serialize.ts)

To avoid a circular dependency between `packages/db` and `packages/agent`, the serializer accepts a locally defined `AgentStateLike` interface instead of importing `AgentState` directly.

```typescript
import type { Message } from "@bookingcare/ai";
import type { TodoItem, TodoSnapshot, AgentInfo } from "../types.js";

interface AgentStateLike {
  messages: Message[];
  model: { id: string; provider: string | unknown };
  systemPrompt: string;
}

export function serializeAgentState(state: AgentStateLike): {
  messages: Message[];
  info: Pick<AgentInfo, "model" | "provider" | "systemPrompt">;
} {
  return {
    messages: state.messages,
    info: {
      model: state.model.id,
      provider: String(state.model.provider),
      systemPrompt: state.systemPrompt,
    },
  };
}

export function createTodoSnapshot(items: TodoItem[], rendered: string): TodoSnapshot {
  return { items: items.slice(), rendered };
}
```

### Integration with packages/agent

#### Modify packages/agent/src/agent.ts

1. Add `store` to `AgentOptions`:

```typescript
export interface AgentOptions {
  // ... existing options
  store?: import("@bookingcare/db").Store; // Lazy import to avoid circular deps
  todoManager?: TodoManager; // Optional TodoManager for persistence
}
```

2. Add `store`, `todoManager`, and `createdAt` to Agent class:

```typescript
class Agent {
  // ... existing properties
  private store?: import("@bookingcare/db").Store;
  private todoManager?: TodoManager;
  private createdAt?: number; // Set on first persistence or resume
  private sessionId: string; // Make this required when store is provided
}
```

3. Update constructor:

```typescript
constructor(options: AgentOptions = {}) {
  // ... existing initialization
  this.store = options.store;
  this.todoManager = options.todoManager;
  this.sessionId = options.sessionId ?? (options.store ? randomUUID() : undefined);
}
```

When a store is provided but no `sessionId` is given, a UUID is auto-generated. Without a store, `sessionId` remains optional (preserving existing behavior).

4. Add persistence to `processEvents()` on `agent_end`:

```typescript
private async processEvents(event: AgentEvent): Promise<void> {
  switch (event.type) {
    // ... existing cases
    case "agent_end":
      this._state.messages = event.messages.slice();
      this._state.streamingMessage = undefined;

      // Persist state if store is available
      if (this.store) {
        await this.persistSession(event.messages);
      }
      break;
  }

  // ... existing listener invocation
}

private async persistSession(messages: AgentMessage[]): Promise<void> {
  if (!this.store || !this.sessionId) return;

  // Uses serializeAgentState and createTodoSnapshot from @bookingcare/db

  const serialized = serializeAgentState(this._state);
  const todoSnapshot = this.todoManager
    ? createTodoSnapshot(
        this.todoManager.getItems(),
        this.todoManager.render()
      )
    : { items: [], rendered: "No todos." };

  const now = Date.now();
  const info: AgentInfo = {
    sessionId: this.sessionId,
    model: serialized.info.model,
    systemPrompt: serialized.info.systemPrompt,
    createdAt: this.createdAt ?? now,
    updatedAt: now,
    messageCount: messages.length,
  };

  // Save to store
  await this.store.saveMessages(this.sessionId, messages);
  await this.store.saveTodos(this.sessionId, todoSnapshot);
  await this.store.saveInfo(this.sessionId, info);
}
```

5. Add static `resume()` method:

```typescript
export class Agent {
  // ... existing code

  public static async resume(options: {
    sessionId: string;
    store: import("@bookingcare/db").Store;
    model?: Model<Api>;
    todoManager?: TodoManager;
    // ... other AgentOptions
  }): Promise<Agent> {
    const { sessionId, store, model: providedModel, todoManager, ...agentOptions } = options;

    // Load from store
    const messages = await store.loadMessages(sessionId);
    const info = await store.loadInfo(sessionId);
    const todoSnapshot = await store.loadTodos(sessionId);

    if (!info) {
      throw new NotFoundError(sessionId);
    }

    // Reconstruct model from saved model ID
    const model = providedModel ?? getModel(info.model);
    if (!model) {
      throw new Error(`Model not found: ${info.model}`);
    }

    // Create agent with restored state
    const agent = new Agent({
      initialState: {
        messages,
        systemPrompt: info.systemPrompt,
        model,
        thinkingLevel: "off", // Default or restore from metadata
        tools: [], // Tools need to be re-registered
      },
      sessionId,
      store,
      todoManager,
      ...agentOptions,
    });

    // Restore todo state if TodoManager provided
    if (todoSnapshot && todoManager) {
      todoManager.update(todoSnapshot.items);
    }

    agent.createdAt = info.createdAt;
    return agent;
  }
}
```

**Note on Store interface structure**: Issue #9 proposes a nested structure `Store { sessions, messages, todos }` with sub-interfaces. This tech spec uses a flattened Store interface for simplicity and ease of use. The flattened API is easier to implement and consume (e.g., `store.loadMessages()` vs `store.messages.loadMessages()`). If future requirements demand more modularity, we can refactor to nested structure.

#### packages/agent/src/types.ts

No changes needed for core types. Store-related types live in `packages/db`.

### packages/db/package.json

```json
{
  "name": "@bookingcare/db",
  "version": "0.2.0",
  "description": "Persistence layer for agent sessions with pluggable storage backends",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./json-store": {
      "types": "./dist/providers/json-store.d.ts",
      "default": "./dist/providers/json-store.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "clean": "rm -rf dist *.tsbuildinfo",
    "type-check": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@bookingcare/tsconfig": "workspace:*",
    "@types/node": "^25.6.2",
    "typescript": "^5.8.0",
    "vitest": "^4.1.5"
  },
  "dependencies": {
    "@bookingcare/ai": "workspace:*"
  }
}
```

### packages/agent/package.json

Add `@bookingcare/db` as both a `devDependency` (for build-time type resolution) and a `peerDependency` (for runtime):

```json
{
  "devDependencies": {
    "@bookingcare/db": "workspace:*"
  },
  "peerDependencies": {
    "@bookingcare/db": "*"
  }
}
```

## End-to-end flow

### New session with persistence

```
User creates agent with store
  → new Agent({ store: JSONStore, sessionId: "abc123" })
  → Constructor initializes with in-memory state
  → User runs agent.prompt("...")
  → Loop runs, emits events
  → agent_end event emitted
  → processEvents() calls persistSession()
  → serializeAgentState() extracts messages + metadata
  → store.saveMessages() writes to ./data/agents/abc123/messages.json
  → store.saveTodos() writes to ./data/agents/abc123/todos.json
  → store.saveInfo() writes to ./data/agents/abc123/info.json
```

### Resume session

```
User calls Agent.resume({ sessionId: "abc123", store })
  → store.loadMessages() reads ./data/agents/abc123/messages.json
  → store.loadInfo() reads ./data/agents/abc123/info.json
  → store.loadTodos() reads ./data/agents/abc123/todos.json
  → Model is resolved from model ID
  → new Agent({ initialState: { messages, systemPrompt, model, tools: [] } })
  → todoManager.update() restores todo state
  → Agent ready for continue()
```

### Session without persistence (unchanged)

```
User creates agent without store
  → new Agent({ ... })
  → Constructor initializes with in-memory state
  → Runs as before, no I/O
  → No persistence on agent_end
```

## Risks and mitigations

### Risk 1: Circular dependencies

**Problem**: `packages/agent` depends on `packages/db`, and `packages/db` previously depended on `packages/agent` for `AgentState` types.

**Mitigation**: `packages/db` defines a local `AgentStateLike` interface instead of importing `AgentState` from `@bookingcare/agent`, removing the circular dependency entirely. `packages/db` only depends on `@bookingcare/ai` for `Message` types. `packages/agent` references `packages/db` types via lazy inline imports and dynamic `import()` at runtime. `@bookingcare/db` is listed as both a `devDependency` (for build-time types) and a `peerDependency` (for runtime) of `@bookingcare/agent`.

### Risk 2: Model reconstruction on resume

**Problem**: `AgentState` contains a full `Model<Api>` object with provider-specific fields. Serializing to JSON loses the `Model` instance.

**Mitigation**: Store only the model ID in `AgentInfo`. On resume, use `getModel(id)` from `@bookingcare/ai` to reconstruct Model instance. If model is not found, throw a clear error.

### Risk 3: Tool state not serializable

**Problem**: `AgentState.tools` is an array of `AgentTool` instances with function references. Cannot be serialized.

**Mitigation**: Document that tools must be re-registered after resume. The `Agent.resume()` method accepts a `tools` option. This matches the current limitation that tool registrations are runtime constructs.

### Risk 4: Streaming state not serializable

**Problem**: `AgentState.streamingMessage` and `pendingToolCalls` are transient runtime state. Should not be persisted.

**Mitigation**: `serializeAgentState()` excludes these fields. On resume, agent starts fresh without transient state. This is correct behavior.

**Crash mid-run**: If agent crashes while processing, only state from the last successful `agent_end` is persisted. The partial `streamingMessage` and in-progress tool calls are lost. Users should re-send their last prompt to continue.

### Risk 5: Filesystem race conditions

**Problem**: Multiple processes could write to the same session directory concurrently.

**Mitigation**: Document as out of scope for initial implementation. Add note in README that JSONStore is single-process only. Future `SqliteStore` or `PostgresStore` will handle concurrency.

## Testing and validation

### Unit tests (packages/db/test/)

#### serialize.test.ts

- `serializeAgentState()` extracts messages and metadata correctly
- Todo snapshot creation preserves items and rendered text
- Edge cases: empty state, missing fields

#### json-store.test.ts

- `saveMessages()` / `loadMessages()` round-trip
- `loadMessages({role: 'assistant'})` filters correctly
- `loadMessages({limit: 10})` returns correct count
- `loadMessages({since: timestamp})` filters by time
- `saveTodos()` / `loadTodos()` round-trip
- `saveInfo()` / `loadInfo()` round-trip
- `exists()` returns true for existing sessions
- `delete()` removes all session files
- `list()` returns all session IDs sorted
- `list(prefix)` filters by prefix
- Missing session returns empty array/undefined
- Invalid JSON throws `CorruptDataError`
- Filesystem errors throw `StoreError`

### Integration tests (packages/agent/test/)

Add new test file `persistence.test.ts`:

- `Agent` with `store` saves state automatically on `agent_end`
- `Agent.resume()` restores state correctly
- `Agent` without `store` has identical behavior to baseline
- `sessionId` auto-generated when `store` is provided without one
- `sessionId` remains optional when no `store` is provided
- Tools are not persisted (must be re-registered)
- Message history is restored
- Todo state is restored when `todoManager` is provided
- Todo state is empty snapshot when `todoManager` is not provided
- `createdAt` is preserved across resume
- Missing session throws `NotFoundError` on resume
- Model info (model ID, provider) is persisted correctly

### Breaking change verification

- Run `packages/agent/test/` test suite
- Verify all existing tests pass without modifications
- Confirm no API changes in public signatures (except new optional `store` parameter)

### Manual validation

1. Create agent with `JSONStore`
2. Run multi-turn conversation
3. Verify files exist: `./data/agents/{sessionId}/messages.json`, `todos.json`, `info.json`
4. Parse JSON files and verify content accuracy
5. Resume session and verify all state restored
6. Modify resume session and verify changes persisted
7. Delete session and verify files removed

## Follow-ups

### Deferred features (future PRs)

1. **AsyncIterable events**: Support streaming message replay via `readEvents()`
2. **Snapshots**: Named checkpoints with `saveSnapshot(agentId, name)` / `loadSnapshot()`
3. **SqliteStore**: Database backend for multi-process support
4. **PostgresStore**: Production-scale backend with connection pooling
5. **Tool call records**: Track tool executions with timestamps, durations, errors
6. **Encryption at rest**: Encrypt stored data with session keys
7. **Multi-process locking**: Distributed locks for concurrent writes

### Cleanup

- Once `SqliteStore` and `PostgresStore` are implemented, consider renaming `JSONStore` to `FileStore` for clarity
- Add benchmarking utilities to compare store performance
- Add migration utilities for store upgrades (e.g., JSONStore → SqliteStore)

### Documentation

- Update `packages/agent/README.md` with persistence examples
- Create `packages/db/README.md` with API reference and examples
- Add examples directory with sample usage patterns
