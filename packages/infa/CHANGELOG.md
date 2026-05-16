# Changelog

## [Unreleased]

### Added

- `@bookingcare/infa` sandbox package — factory-created `Sandbox` abstraction for process-isolated tool execution with resource limits
- `createSandbox()` factory with initial `local` sandbox kind
- `Sandbox` interface with `exec()`, `readFile()`, and `writeFile()` methods
- Path sandboxing that resolves symlinks and rejects escape paths
- Local sandbox resource limits for timeout, maxOutput, and best-effort maxMemory support
