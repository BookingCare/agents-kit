# Changelog

## [Unreleased]

### Changed

- `ContextManager` now uses actual `usage.input` from assistant messages instead of estimating all tokens (more accurate for assistant messages)

### Added

- Optional `store` parameter on `Agent` — accepts a `@bookingcare/db` `Store` for automatic session persistence
- Optional `todoManager` parameter on `Agent` — todo state is persisted to the store alongside messages
- `Agent.resume()` static method — reconstructs an agent from a previously persisted session (loads messages, metadata, and todo state)
- `sessionId` is auto-generated when `store` is provided and no `sessionId` is given
- State is persisted automatically on each `agent_end` event when a `store` is configured

## [0.2.0] - 2026-05-13

### Added

- `Agent` class — stateful wrapper around the streaming agent loop with lifecycle events, steering/follow-up message queues, abort support, and mid-loop model/tool updates
- `AgentTool` interface — extends `Tool` from `@bookingcare/ai` with `execute()`, `prepareArguments()`, `label`, and per-tool `executionMode`
- `AgentToolResult` and `AgentToolUpdateCallback` types for typed tool execution
- `StreamingAssistantMessage` type for streaming partial messages
- Streaming agent loop: `runAgentLoop()` and `runAgentLoopContinue()` — event-driven alternative to `agentLoop()`
- `QueueMode` type (`"all"` | `"one-at-a-time"`) for steering/follow-up drain behavior
- Agent event types: `AgentEvent` union with `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`, `turn_end`, `agent_end`
- `AgentState`, `AgentContext` types for Agent class state management
- Hook types: `BeforeToolCallContext`, `BeforeToolCallResult`, `AfterToolCallContext`, `AfterToolCallResult`
- `AgentLoopConfig` for full streaming loop configuration
- `TodoManager` class for structured task tracking with validation (max 20 items, single in_progress)
- `todo` tool that lets the agent plan and track multi-step tasks
- Nag reminder: injects `<reminder>Update your todos.</reminder>` after 3 rounds without a todo update
- `todoTool` schema export for custom dispatch composition
- `TodoItem` type export
- `todoManager` field on `ToolDispatch` for external access
- `load_skill` tool for on-demand skill loading via `tool_result`
- `SkillLoader` class that scans a directory for `SKILL.md` files with YAML frontmatter
- Two-layer skill injection: names+descriptions in system prompt, full body on demand
- `skillsDir` option on `AgentLoopOptions` and `createToolDispatch()`
- `src/types.ts` — centralized type definitions
- Agent loop with tool dispatch, file tools (`bash`, `read_file`, `write_file`, `edit_file`), and examples

### Changed

- Merged `agent-loop-stream.ts` into `agent-loop.ts` — `agentLoop()` is now a thin wrapper around the streaming core, eliminating code duplication
- `AgentMessage` is now `type AgentMessage = Message` (alias for `@bookingcare/ai` Message union) instead of a separate interface
- `StopReason` from `@bookingcare/ai` used throughout instead of raw `string`
- Tool execution in the streaming loop now calls `AgentTool.execute()` instead of a separate `handler` function
- Agent state syncs full transcript from `agent_end` events

### Fixed

- Hardened `safePath` against path traversal and edge cases
- Emit `agent_end` event on early loop exit
- Log swallowed listener errors during `agent_end`
- Improved error handling and safety across agent package
