# Changelog

## [Unreleased]

## [0.5.2] - 2026-07-04

## [0.5.1] - 2026-06-16

### Added

- Added MCP Streamable HTTP transport support with per-server request headers.

## [0.5.0] - 2026-06-04

### Breaking Changes

- `McpServerConfig` now only supports `stdio` and `sse` transports; removed the unused `auth` and `websocket` fields.

### Added

- `AgentPool` for managing in-memory `Agent` instances by ID with create/get/list/delete/shutdown
- MCP (Model Context Protocol) server support with SSE and stdio transports
- `McpRegistry` for managing multiple MCP server connections
- JSON Schema to TypeBox adapter for MCP tool schemas (`convertJsonSchemaToTypeBox`)
- MCP configuration file loading from `.mcp.json` and `.mcp/config.json`
- `AgentOptions.mcpServers` and `AgentOptions.mcpConfigPath` for MCP integration
- `AgentOptions.loadMcpConfig` to auto-load MCP config from workspace
- `createToolDispatch()` now accepts optional `mcpRegistry` parameter
- `message_update` events now include the structured `assistantMessageEvent` payload.

### Changed

- `createToolDispatch()` is now async (breaking change for direct callers)
- MCP tools are prefixed with server name (e.g., `filesystem:read_file`) to avoid conflicts

### Fixed

- `Agent.state.errorMessage` now updates when assistant stream failures end without a `turn_end` event

### Dependencies

- Added `@modelcontextprotocol/sdk@^1.29.0` for MCP protocol implementation

### Internal

- Added `packages/agent/src/mcp/` module with client, registry, schema-adapter, and config utilities
- Added 21 tests covering MCP client, registry, schema adapter, config, and agent integration

## [0.4.1] - 2026-05-18

### Added

- Typed `EventBus` with lifecycle, streaming, and tools channels plus `on()`/`once()` subscriptions; `Agent.subscribe()` now delegates to all channels and is deprecated.

## [0.4.0] - 2026-05-18

### Breaking Changes

- Replaced the separate `@bookingcare/db` and `@bookingcare/infa` infrastructure packages with `@bookingcare/infra`.

## [0.3.0] - 2026-05-17

### Changed

- `ContextManager` now uses actual `usage.input` from assistant messages instead of estimating all tokens (more accurate for assistant messages)
- Documented the explicit env and PATH requirements for local sandboxes in the README.

### Added

- `PermissionManager` — rule-based tool approval with allow / deny / ask decisions, scoped path/command matching, and `permission_needed` events on `Agent`
- Optional `store` parameter on `Agent` — accepts a `@bookingcare/db` `Store` for automatic session persistence
- Optional `todoManager` parameter on `Agent` — todo state is persisted to the store alongside messages
- `Agent.resume()` static method — reconstructs an agent from a previously persisted session (loads messages, metadata, and todo state)
- `sessionId` is auto-generated when `store` is provided and no `sessionId` is given
- State is persisted automatically on each `agent_end` event when a `store` is configured
- Optional `sandbox` parameter on `createToolDispatch()` — bash, read_file, write_file, and edit_file route through `@bookingcare/infa` when provided
- Tool dispatch handlers are async-aware so sandbox-backed commands can be awaited in the agent loop
- Sandboxed `read_file` preserves the existing 50 KB default cap when no explicit line limit is provided

### Fixed

- Bash sandbox failures now include the sandbox kill reason and exit code in thrown errors.
- Restored the sandbox test helper import so package type-check passes.

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
