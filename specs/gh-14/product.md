# Sandbox — process-isolated tool execution with resource limits - Product Spec

## Summary

Add a factory-created `Sandbox` in `packages/infa` that runs commands and file operations outside the agent process while keeping the default agent flow unchanged.

## Problem

Current tool execution in `packages/agent` is synchronous and in-process:

- `bash` uses `execSync` directly
- file tools rely on `readFileSync` / `writeFileSync`
- path checks only cover basic traversal, not symlinks or case-insensitive filesystems
- environment variables are inherited from the agent process

## Goals

1. Create a `createSandbox()` factory with a current `local` sandbox kind
2. Replace in-process command execution with child-process execution
3. Add resource limits: timeout, maxMemory, maxOutput
4. Improve path sandboxing: resolve symlinks and reject escape paths
5. Whitelist environment variables instead of inheriting the parent env
6. Preserve existing tool behavior when no Sandbox is configured
7. Keep the `Agent` constructor unchanged when no Sandbox is provided

## Non-goals

- Full container / Docker isolation
- Network sandboxing (firewall rules, packet filtering)
- Seccomp / AppArmor / SELinux profiles
- chroot or filesystem namespacing
- Windows-specific isolation primitives beyond Node.js process execution

## User experience

### Default behavior

When no `Sandbox` is provided, tools behave as they do today:

```typescript
const agent = new Agent({ model: claudeModel, tools });
```

### Using the Sandbox

```typescript
import { createSandbox } from "@bookingcare/infa";
import { Agent, createToolDispatch } from "@bookingcare/agent";

const sandbox = createSandbox({
  kind: "local",
  workdir: "/my-project",
  timeout: 30_000,
  maxMemory: 256 * 1024 * 1024,
  maxOutput: 1024 * 1024,
  env: {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/sandbox-home",
  },
});

const { tools } = createToolDispatch("/my-project", undefined, sandbox);
const agent = new Agent({ model: claudeModel, tools });
```

### Bash tool with sandbox

When a Sandbox is configured, the `bash` tool delegates to `Sandbox.exec()`:

```typescript
sandbox.exec(command, { timeout, maxOutput });
```

### File operations with sandbox

File read/write operations are validated against the sandbox's path constraints:

```typescript
const content = await sandbox.readFile("src/app.ts");
await sandbox.writeFile("src/new.ts", "export const x = 1;");
```

Paths are resolved relative to the sandbox's `workdir`.

### Resource limit enforcement

| Limit       | Behavior on exceed                                                           |
| ----------- | ---------------------------------------------------------------------------- |
| `timeout`   | Process is terminated, then force-killed after a grace period                |
| `maxMemory` | Best-effort enforcement where the local runtime can apply it                 |
| `maxOutput` | Process is killed when combined stdout + stderr exceeds the configured limit |

### Path sandboxing

The `Sandbox` enforces that all file paths remain within the configured `workdir`:

1. Resolve relative paths against `workdir`
2. Resolve the nearest existing ancestor with `realpath`
3. Compare the canonical path against `workdir`, using case-insensitive comparison rules on filesystems that need it
4. Reject paths that escape the workspace

```typescript
sandbox.readFile("../../../etc/passwd"); // → Error: Path escapes workspace
```

`writeFile()` validates the target path first, then creates missing parent directories inside the sandbox before writing.

### Environment variable whitelist

Only explicitly provided env vars are available to spawned processes:

```typescript
const sandbox = createSandbox({
  kind: "local",
  workdir: "/workspace",
  env: {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: "development",
    // API keys and tokens from the parent process are NOT inherited
  },
});
```

## Success criteria

1. `createSandbox({ kind: "local", ... })` returns a working sandbox
2. `Sandbox.exec()` spawns a child process for the given command
3. `Sandbox.exec()` returns stdout when command completes successfully
4. `Sandbox.readFile()` reads file contents within `workdir`
5. `Sandbox.writeFile()` writes file contents and creates parent directories
6. `createToolDispatch()` accepts an optional Sandbox parameter
7. When sandbox is provided, `bash` uses `Sandbox.exec()`
8. When sandbox is provided, file tools use `Sandbox.readFile()` / `Sandbox.writeFile()`
9. When sandbox is not provided, existing tool behavior is unchanged
10. `Agent` remains unchanged when no Sandbox is configured
11. `Sandbox` accepts `workdir`, `timeout`, `maxMemory`, `maxOutput`, and `env`
12. Paths escaping `workdir` via `..` or symlinks are rejected

## Validation

### Unit tests (`packages/infa/test/`)

- `createSandbox({ kind: "local" })` creates a sandbox
- unsupported sandbox kinds fail fast
- `exec()` returns correct stdout for a simple command
- `exec()` with `timeout` kills a long-running command
- `exec()` with `maxOutput` kills a command with large output
- `readFile()` reads text files correctly
- `writeFile()` writes and creates parent directories
- path validation rejects relative path escaping `workdir`
- path validation resolves the nearest existing ancestor before checking bounds
- path validation rejects absolute paths
- `env` is passed to spawned processes correctly
- default env is empty and safe

### Integration tests (`packages/agent/test/`)

- Agent with Sandbox executes bash tool in an isolated process
- Agent with Sandbox reads and writes files within `workdir`
- Agent without Sandbox uses existing behavior
- timeout enforcement works through the tool dispatch flow
- output limit enforcement works through the tool dispatch flow

## Open questions

1. None for the current local sandbox kind. Additional kinds can be added behind the same factory later.
