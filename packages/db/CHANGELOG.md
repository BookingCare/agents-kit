# Changelog

## [Unreleased]

### Added

- `Store` interface — pluggable abstraction for persisting agent sessions (messages, todos, metadata)
- `JSONStore` provider — filesystem-based store that writes `{baseDir}/{sessionId}/messages.json`, `todos.json`, and `info.json`
- `LoadMessagesOptions` — query messages by role, limit, or timestamp
- `AgentInfo` — metadata record with model ID, provider, system prompt, timestamps, and message count
- `TodoSnapshot` and `TodoItem` types for persisting todo state
- `serializeAgentState()` — extracts messages and metadata from agent state (transient fields excluded)
- `createTodoSnapshot()` — builds a serializable todo snapshot from items and rendered text
- Error hierarchy: `StoreError` (base), `NotFoundError` (missing session), `CorruptDataError` (invalid JSON)
- `JSONStore.create()` factory that ensures the base directory exists
