# Persistence Layer for Agent Sessions - Product Spec

## Summary

Create `packages/db` — a persistence layer that enables saving and resuming agent sessions, storing message transcripts, and persisting todo state across process restarts. The layer abstracts storage concerns from the core `packages/agent` through pluggable backends (filesystem, with future SQLite/Postgres support).

## Problem

The current `Agent` class holds all state in memory. This creates several limitations:

- **No durability**: Session state, message history, and todo lists are lost when the process terminates
- **No inspection**: Past agent runs cannot be reviewed or analyzed
- **No resumption**: Long-running conversations cannot be resumed after crashes or restarts
- **No analytics**: No way to query across sessions to understand usage patterns

## Goals

- Enable agent sessions to be saved and resumed across process restarts
- Provide append-only message storage with query capabilities
- Persist todo state per session
- Abstract storage backend behind pluggable interfaces
- Zero breaking changes: existing in-memory behavior remains the default
- Support both synchronous (file-based) and asynchronous (database) storage

## Non-goals

- Encryption at rest (deferred)
- Multi-process concurrency control (deferred)
- Network-based storage backends (deferred)
- Real-time streaming of stored data (deferred)
- Cross-session aggregation or analytics UI (deferred)

## Figma / design references

Not applicable — this is a developer-facing library without UI components.

## User experience

### Default behavior (no changes)

The following existing code continues to work without modification:

```typescript
import { Agent } from "@bookingcare/agent";

// No Store provided = in-memory behavior (unchanged)
const agent = new Agent({ model: "anthropic/claude-3-5-sonnet" });
// ... session ends, state is lost
```

### Enabling persistence

Developers opt into persistence by providing a `Store` implementation:

```typescript
import { Agent } from "@bookingcare/agent";
import { JSONStore } from "@bookingcare/db";

// Create filesystem-based store
const store = await JSONStore.create({ baseDir: "./data/agents" });

// Agent with persistence enabled
const agent = new Agent({
  model: "anthropic/claude-3-5-sonnet",
  store,
});
```

### Automatic persistence

When a `Store` is provided, persistence happens automatically:

- **Session save**: On `agent_end` event, the complete `AgentState` is saved
- **Message append**: Each message (user/assistant/system) is appended to the message store
- **Todo persistence**: Todo state is saved when changed
- **Agent info**: Session metadata (model, config, timestamps) is saved

### Resuming sessions

Developers can resume a previous session by ID:

```typescript
// Resume existing session
const resumedAgent = await Agent.resume({
  sessionId: "abc123",
  store,
});
```

Resuming restores:

- Complete message history
- System prompt and model configuration
- Todo state at session end
- All agent metadata

### Querying stored data

Developers can query stored data for inspection or analytics:

```typescript
// List all sessions
const sessionIds = await store.list();

// Load specific session (all messages)
const messages = await store.loadMessages("abc123");

// Query with filtering
const assistantMessages = await store.loadMessages("abc123", {
  role: "assistant",
});

const recentUserMessages = await store.loadMessages("abc123", {
  role: "user",
  limit: 10,
  since: Date.now() - 3600000, // Last hour
});

const todos = await store.loadTodos("abc123");
const info = await store.loadInfo("abc123");
```

### Pluggable backends

Developers can implement custom backends:

```typescript
import { Store, LoadMessagesOptions } from "@bookingcare/db";

class CustomStore implements Store {
  // Implement all Store methods
  async saveMessages(agentId: string, messages: Message[]) {
    /* ... */
  }
  async loadMessages(agentId: string, opts?: LoadMessagesOptions): Promise<Message[]> {
    /* ... */
  }
  // ... other methods
}
```

### Error handling

Storage operations are async and may throw:

- `StoreError` for general storage failures
- `NotFoundError` when attempting to load non-existent sessions
- `CorruptDataError` when saved data cannot be deserialized

All errors include context (agent ID, operation, underlying cause) for debugging.

### Directory structure (JSONStore)

When using `JSONStore`, the filesystem layout is:

```
./data/agents/
  abc123/
    messages.json       # Array of Message objects
    todos.json          # Todo snapshot
    info.json           # Agent metadata
  def456/
    messages.json
    todos.json
    info.json
```

### Backward compatibility

When a `Store` is not provided, all store methods are no-ops that throw if called explicitly:

```typescript
// No Store = in-memory behavior
const agent = new Agent({ model: "..." });

// Direct store access not available
// (store property is undefined or internal API)

// Existing code works unchanged
await agent.prompt("Hello");
```

## Success criteria

The feature is complete when all of the following are true:

### Core functionality

1. **JSONStore implementation**: A filesystem-based store correctly saves and loads all data types
2. **Store interface**: `Store` interface is comprehensive and type-safe
3. **Agent integration**: `Agent` constructor accepts optional `store` parameter
4. **Automatic persistence**: Session data is saved on `agent_end` when store is provided
5. **Resume capability**: `Agent.resume()` reconstructs full session state from store

### Data integrity

6. **Message persistence**: All messages (system, user, assistant) are appended and retrieved correctly
7. **Message queries**: Filter by role, limit, and time range works correctly
8. **Todo persistence**: Todo state is saved and restored accurately
9. **Metadata persistence**: Agent info (model, config, timestamps) is preserved
10. **Serialization**: `AgentState` ↔ JSON conversion is lossless for all supported types

### API quality

11. **Type safety**: All interfaces have complete TypeScript definitions
12. **Error handling**: All storage methods include proper error types and messages
13. **No breaking changes**: Existing code without `store` parameter works identically
14. **Documentation**: Public API has inline JSDoc comments

### Testing coverage

15. **Unit tests**: JSONStore methods have >90% coverage
16. **Integration tests**: Agent + Store interactions are tested
17. **Edge cases**: Empty sessions, missing files, corrupt data are handled
18. **Serialization tests**: All `AgentState` types round-trip correctly

## Validation

### Unit tests

- `JSONStore.saveMessages()` / `loadMessages()` round-trip
- `JSONStore.loadMessages({role: 'assistant'})` filters correctly
- `JSONStore.loadMessages({limit: 10})` returns correct count
- `JSONStore.loadMessages({since: timestamp})` filters by time
- `JSONStore.saveTodos()` / `loadTodos()` round-trip
- `JSONStore.saveInfo()` / `loadInfo()` round-trip
- `JSONStore.list()` returns all session IDs
- `JSONStore.delete()` removes all session data
- `JSONStore.exists()` checks presence accurately

### Integration tests

- Agent with store saves state on end
- Agent.resume() reconstructs full session
- Messages are appended during session
- Todo state changes are persisted
- Missing sessions return null/undefined appropriately

### Error handling tests

- Invalid JSON in store files throws `CorruptDataError`
- Loading non-existent session throws `NotFoundError`
- Filesystem errors propagate as `StoreError`

### Manual validation

- Create an agent with JSONStore
- Run a multi-turn conversation
- End session and verify files exist
- Resume session and verify all state restored
- Query messages/todos/info and verify accuracy

### Breaking change verification

- Run existing test suite without store parameter
- Verify all tests pass identically to baseline
- Confirm no API changes in public signatures

## Open questions

1. **Event streaming**: Should the Store interface include an async iterable for reading messages/events (like the reference design's `readEvents()`), or is simple `loadMessages()` sufficient for now?

2. **Snapshots**: Should we support named snapshots (e.g., `saveSnapshot(agentId, 'checkpoint1')`) in the initial implementation, or defer this to a future iteration?

3. **Tool call records**: The reference design includes `saveToolCallRecords()` and `loadToolCallRecords()`. Is this needed for our current Agent implementation, or should we defer until tool call tracking is formalized?

4. **Store creation API**: Should `JSONStore.create()` accept options for custom file naming, compression, or subdirectory structure, or keep it minimal with sensible defaults?
