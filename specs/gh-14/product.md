# Sandbox — process-isolated tool execution with resource limits - Product Spec

## Summary

Upgrade the current synchronous, in-process tool execution to a `Sandbox` class that runs commands and file operations in process-isolated contexts with configurable resource limits (timeout, memory, output size, environment).

## Problem

Current tool execution in `packages/agent` runs synchronously within the agent's Node.js process:

- `bash` tool uses `execSync` directly — no process isolation
- No memory limits — a runaway command can exhaust process memory
- No output limits — a command with large stdout can exhaust `maxBuffer`
- `safePath()` prevents basic directory traversal but has gaps (symlinks, case-insensitive filesystems)
- No working directory constraint beyond the `workdir` parameter
- Environment variables are inherited from the agent process

## Goals

1. Replace `execSync` with `child_process.spawn` for process-isolated execution
2. Add resource limits: timeout, maxMemory, maxOutput
3. Improve path sandboxing: resolve symlinks, case-insensitive path validation
4. Scope working directory to workspace root
5. Whitelist environment variables (don't inherit agent's full env)
6. All existing tool behavior preserved when Sandbox is not configured
7. Zero breaking changes to `Agent` constructor when no Sandbox provided

## Non-goals

- Full container/Docker isolation
- Network sandboxing (firewall rules, packet filtering)
- Seccomp/AppArmor/SELinux profiles
- chroot or filesystem namespacing
- Windows-specific isolation primitives (this is a Node.js cross-platform package)

## Figma / design references

Not applicable — developer-facing API with no UI components.

## User experience

### Default behavior (no changes)

When no `Sandbox` is provided, tools execute as today:

```typescript
const agent = new Agent({ model: claudeModel, tools });
// bash uses execSync, file ops use fs.readFileSync, etc.
```

### Using the Sandbox

```typescript
import { Agent, Sandbox } from "@bookingcare/agent";

const sandbox = new Sandbox({
  workdir: "/my-project",
  timeout: 30_000,
  maxMemory: 256 * 1024 * 1024, // 256 MB
  maxOutput: 1024 * 1024, // 1 MB
  env: {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/sandbox-home",
  },
});

const agent = new Agent({
  model: claudeModel,
  tools,
  sandbox,
});
```

### Bash tool with sandbox

When a Sandbox is configured, the `bash` tool delegates to `Sandbox.exec()`:

```typescript
// Internally, tools.ts calls:
sandbox.exec(command, { cwd: workdir, timeout, maxOutput });
```

This spawns a child process instead of using `execSync`.

### File operations with sandbox

File read/write operations are validated against the sandbox's path constraints:

```typescript
const content = await sandbox.readFile("src/app.ts");
await sandbox.writeFile("src/new.ts", "export const x = 1;");
```

Paths are resolved relative to the sandbox's `workdir`.

### Resource limit enforcement

| Limit       | Behavior on exceed                                                              |
| ----------- | ------------------------------------------------------------------------------- |
| `timeout`   | Process killed with SIGTERM (SIGKILL after grace period), returns timeout error |
| `maxMemory` | Process killed when RSS exceeds limit, returns OOM error                        |
| `maxOutput` | Process killed when stdout+stderr exceeds limit, returns output-limit error     |

### Path sandboxing

The `Sandbox` enforces that all file paths remain within the `workdir`:

1. Resolve relative paths against `workdir`
2. Resolve all symlinks in the path
3. Verify resolved path is still under `workdir` (case-insensitive on Windows)
4. Reject paths that escape the workspace

```typescript
sandbox.readFile("../../../etc/passwd"); // → Error: Path escapes workspace
```

### Environment variable whitelist

Only explicitly provided env vars are available to spawned processes:

```typescript
const sandbox = new Sandbox({
  env: {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: "development",
    // API keys, tokens from parent process are NOT inherited
  },
});
```

## Success criteria

### Core execution

1. `Sandbox.exec()` spawns a child process for the given command
2. `Sandbox.exec()` returns stdout when command completes successfully
3. `Sandbox.readFile()` reads file contents within workdir
4. `Sandbox.writeFile()` writes file contents, creating parent dirs
5. `Sandbox` constructor accepts `workdir`, `timeout`, `maxMemory`, `maxOutput`, `env`

### Resource limits

6. `timeout` kills the process after N milliseconds
7. `maxMemory` kills the process when resident set size exceeds threshold
8. `maxOutput` kills the process when combined stdout+stderr exceeds threshold
9. All three limits produce clean error messages in tool results

### Path sandboxing

10. Relative paths are resolved against `workdir`
11. Absolute paths are rejected
12. Symlink paths are resolved to their real path before validation
13. Case-insensitive path checking on Windows
14. Path escaping `workdir` (via `..` or symlinks) is rejected

### Integration

15. `Agent` accepts `sandbox?: Sandbox` in constructor options
16. When sandbox is provided, `bash` tool uses `Sandbox.exec()`
17. When sandbox is provided, file tools use `Sandbox.readFile()` / `Sandbox.writeFile()`
18. When sandbox is not provided, existing tool behavior is unchanged
19. `createToolDispatch` accepts optional Sandbox parameter

### Edge cases

20. Empty command: returns empty string (not an error)
21. Command that outputs nothing: returns empty string
22. Sandbox with no `env`: spawned process has empty environment (safe default)
23. Nested symlinks: all resolved before path validation
24. Workdir that does not exist: created on Sandbox construction

## Validation

### Unit tests (packages/agent/test/)

Add `sandbox.test.ts`:

- `exec()` returns correct stdout for a simple command
- `exec()` with `timeout` kills a long-running command
- `exec()` with `maxOutput` kills a command with large output
- `readFile()` reads text file correctly
- `writeFile()` writes and creates parent directories
- Path validation rejects relative path escaping workdir
- Path validation resolves symlinks before checking bounds
- Path validation rejects absolute paths (or normalizes them against workdir)
- `env` is passed to spawned process correctly
- Default env (empty) is safe
- Complex command with arguments executes correctly

### Integration tests

- Agent with Sandbox executes bash tool in isolated process
- Agent with Sandbox reads and writes files within workdir
- Agent without Sandbox uses existing execSync behavior
- Timeout enforcement works through Agent prompt flow
- Output limit enforcement truncates and returns error

### Regression tests

- `agent-loop.test.ts` passes without modification
- `agent.test.ts` passes without modification
- `tools.test.ts` passes without modification

### Manual validation

1. Create Sandbox with `workdir: "/tmp/sandbox-test"`
2. Run `bash "pwd"` → verify output is within workdir
3. Run `bash "echo $PATH"` → verify only whitelisted env vars
4. Run `bash "sleep 60"` with timeout 1000ms → verify killed with timeout error
5. Try `read_file("../../../etc/passwd")` → verify path escape error
6. Create a symlink inside workdir pointing outside → verify resolved and rejected

## Open questions

1. **Memory limit implementation**: Node.js does not provide a cross-platform way to set memory limits on spawned processes. On Linux, we can use `ulimit -v` or cgroup v2. On macOS, `ulimit -v` works. Is it acceptable to implement memory limits only where supported and gracefully degrade on unsupported platforms?

2. **Should `safePath()` in `tools.ts` be replaced entirely or kept alongside Sandbox?** The issue says current path validation is insufficient. Should `tools.ts` always use `Sandbox` for path validation, or should `safePath()` be enhanced and `Sandbox` be additive?

3. **Max output enforcement**: Should we stream output and truncate when the limit is reached, or kill the process? Killing the process is simpler and safer. Truncation preserves partial results but may be confusing.

4. **Should the Sandbox validate executable paths?** Should `bash` tool commands be checked against a whitelist of allowed executables (e.g., only `/bin/ls`, `/usr/bin/cat`)? This would add significant security but might be overly restrictive.
