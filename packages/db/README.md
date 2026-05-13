# @bookingcare/db

Persistence layer for agent sessions with pluggable storage backends.

Provides a `Store` interface for saving messages, todo snapshots, and session metadata. The shipped `JSONStore` provider writes each session to a dedicated directory on the local filesystem.

## Installation

```bash
pnpm add @bookingcare/db
```

## Quick Start

```typescript
import { JSONStore } from "@bookingcare/db";

const store = await JSONStore.create({ baseDir: "./data" });

// Save a session
await store.saveMessages("session-1", messages);
await store.saveInfo("session-1", {
  sessionId: "session-1",
  model: "gpt-4",
  provider: "openai",
  systemPrompt: "You are helpful.",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messageCount: messages.length,
});

// Resume a session
const messages = await store.loadMessages("session-1");
const info = await store.loadInfo("session-1");
```

## Store Interface

All storage backends implement `Store`:

```typescript
interface Store {
  // Messages
  saveMessages(agentId: string, messages: Message[]): Promise<void>;
  loadMessages(agentId: string, opts?: LoadMessagesOptions): Promise<Message[]>;

  // Todos
  saveTodos(agentId: string, snapshot: TodoSnapshot): Promise<void>;
  loadTodos(agentId: string): Promise<TodoSnapshot | undefined>;

  // Metadata
  saveInfo(agentId: string, info: AgentInfo): Promise<void>;
  loadInfo(agentId: string): Promise<AgentInfo | undefined>;

  // Lifecycle
  exists(agentId: string): Promise<boolean>;
  delete(agentId: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
```

### loadMessages filters

```typescript
const msgs = await store.loadMessages("session-1", {
  role: "assistant", // only assistant messages
  limit: 10, // last 10 messages
  since: Date.now() - 24 * 60 * 60 * 1000, // messages from the last 24h
});
```

Filters can be combined. `limit` applies last (after role and since).

## JSONStore

A filesystem-based `Store` implementation. Each session gets a directory containing three JSON files:

```
{baseDir}/{sessionId}/
  messages.json  — message transcript
  todos.json     — todo snapshot
  info.json      — session metadata
```

```typescript
import { JSONStore } from "@bookingcare/db";

const store = await JSONStore.create({ baseDir: "./data/sessions" });

// Check if a session exists
if (await store.exists("session-1")) {
  // Delete it
  await store.delete("session-1");
}

// List all sessions
const sessionIds = await store.list();
// Filter by prefix
const agents = await store.list("agent-");
```

## Error Types

| Error              | When                            |
| ------------------ | ------------------------------- |
| `StoreError`       | Base class for all store errors |
| `NotFoundError`    | Session does not exist          |
| `CorruptDataError` | Stored JSON is malformed        |

`JSONStore` treats missing session files as normal: `loadMessages` returns an empty array, `loadInfo` and `loadTodos` return `undefined`.

## Serialization Utilities

Helpers for converting agent runtime state into storable snapshots:

```typescript
import { serializeAgentState, createTodoSnapshot } from "@bookingcare/db";

const { messages, info } = serializeAgentState(agentState);
const todoSnapshot = createTodoSnapshot(todoItems, renderedText);
```

`serializeAgentState` intentionally excludes transient fields (`streamingMessage`, `pendingToolCalls`, `isStreaming`, `errorMessage`) and tools (which are runtime function references). Callers must re-register tools after resuming a session.
