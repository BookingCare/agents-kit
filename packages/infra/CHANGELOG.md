# Changelog

## [Unreleased]

### Added

- Added `createStore()` factory for JSON and MySQL persistence backends.
- Added `MySQLStore` as a MySQL-backed `Store` implementation for session persistence.
- Added `Store.getMetrics()` for operation, latency, and storage snapshots.

## [0.4.1] - 2026-05-18

## [0.4.0] - 2026-05-18

### Added

- Persistence APIs moved into `@bookingcare/infra`, including `Store`, `JSONStore`, `serializeAgentState()`, `createTodoSnapshot()`, and storage errors.

## [0.3.0] - 2026-05-17

### Breaking Changes

- `SandboxResult.killedBy` no longer advertises `memory`; the local sandbox only reports `timeout` and `output`.

### Added

- `@bookingcare/infa` sandbox package — factory-created `Sandbox` abstraction for process-isolated tool execution with resource limits
- `createSandbox()` factory with initial `local` sandbox kind
- `Sandbox` interface with `exec()`, `readFile()`, `writeFile()`, and `editFile()` methods
- Path sandboxing that resolves symlinks and rejects escape paths
- Local sandbox resource limits for timeout, maxOutput, and best-effort maxMemory support
- Local sandbox operation serialization so file validation and use cannot interleave across sandbox calls
- Local sandbox process-group termination so timeout/output kills stop descendant commands, not just the shell

### Fixed

- Reject `maxMemory` values below 1 KiB instead of generating `ulimit -v 0`.
