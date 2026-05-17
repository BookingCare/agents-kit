# Changelog

## [Unreleased]

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
