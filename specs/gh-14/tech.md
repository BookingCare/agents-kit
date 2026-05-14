# Sandbox — process-isolated tool execution with resource limits - Tech Spec

## Problem

The current tool execution in `createToolDispatch()` runs everything in-process:

- `execSync` for bash commands (line tools.ts ~170)
- `readFileSync`/`writeFileSync` for file operations (line tools.ts ~175-200)
- `safePath()` prevents basic traversal but misses symlinks and case-insensitive issues

A malicious or buggy tool can:

- Crash the agent process via memory exhaustion
- Block the event loop with long-running synchronous operations
- Access files outside the workspace via symlinks
- Read sensitive environment variables inherited from the parent process

## Relevant code

### packages/agent/src/tools.ts

- `runBash()` (line ~170-179): Uses `execSync` with `timeout: 30_000`, `maxBuffer: 1024 * 1024`
- `runRead()` (line ~182-193): Uses `readFileSync` + `safePath`
- `runWrite()` (line ~196-201): Uses `writeFileSync` + `safePath`
- `runEdit()` (line ~204-217): Uses `readFileSync`/`writeFileSync` + `safePath`
- `safePath()` (line ~35-44): `resolve(root, path)` then checks `relative(root, resolved).startsWith("..")`
- `createToolDispatch()` (line ~245-280): Assembles tools and dispatch map

### packages/agent/src/types.ts

- `AgentTool` (line ~100-112): Tool definition with `execute()` method
- `AgentLoopConfig` (line ~86-112): Loop configuration

## Current state

### Tool dispatch flow

```
createToolDispatch(workdir, skillsDir)
  → builds ToolDispatch { tools: Tool[], dispatch: Record<string, ToolHandler> }
  → dispatch map contains sync handler functions
  → agentLoop() maps dispatch to AgentTool[].execute()
```

The `bash` tool handler is synchronous:

```typescript
function runBash(command: string, workdir: string): string {
  return execSync(command, {
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    cwd: workdir,
  });
}
```

### Path validation

```typescript
function safePath(path: string, workdir: string): string {
  const root = resolve(workdir);
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  return resolved;
}
```

This has known gaps:

1. Symlinks: `safePath("link-to-etc")` resolves to `workdir/link-to-etc` (which is safe) but when reading, the symlink may point outside the workspace
2. Case-insensitive filesystems: `workdir/..\secret` on Windows may bypass the `startsWith("..")` check
3. Empty path components: `workdir/foo/../etc/passwd` — `resolve()` handles this but the check happens after resolution

## Proposed changes

### New types (packages/agent/src/types.ts)

Add near `AgentToolResult`:

```typescript
export interface SandboxOptions {
  cwd?: string;
  timeout?: number;
  maxMemory?: number;
  maxOutput?: number;
  env?: Record<string, string>;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed?: boolean;
  killedBy?: "timeout" | "memory" | "output";
}
```

### Sandbox class (packages/agent/src/sandbox.ts)

```typescript
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname } from "node:path";

export interface SandboxConfig {
  workdir: string;
  timeout?: number;
  maxMemory?: number;
  maxOutput?: number;
  env?: Record<string, string>;
}

export class Sandbox {
  private readonly workdir: string;
  private readonly timeout: number;
  private readonly maxOutput: number;
  private readonly env: Record<string, string>;

  constructor(config: SandboxConfig) {
    this.workdir = resolve(config.workdir);
    this.timeout = config.timeout ?? 30_000;
    this.maxOutput = config.maxOutput ?? 1024 * 1024;
    this.env = config.env ?? {};
    mkdirSync(this.workdir, { recursive: true });
  }

  /** Validate and resolve a path within the sandbox. */
  private resolvePath(inputPath: string): string {
    if (isAbsolute(inputPath)) {
      throw new Error(`Absolute paths are not allowed: ${inputPath}`);
    }

    const resolved = resolve(this.workdir, inputPath);

    // Resolve symlinks
    let realPath: string;
    try {
      realPath = realpathSync(resolved);
    } catch {
      // File doesn't exist yet — check parent directory
      const parentDir = dirname(resolved);
      try {
        const realParent = realpathSync(parentDir);
        realPath = resolve(realParent, inputPath.split(/[/\\]/).pop() || "");
      } catch {
        throw new Error(`Path escapes workspace: ${inputPath}`);
      }
    }

    // Validate still within workdir after symlink resolution
    const rel = relative(this.workdir, realPath);
    const normalizedRel = rel.toLowerCase(); // case-insensitive check
    if (normalizedRel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path escapes workspace: ${inputPath}`);
    }

    return realPath;
  }

  /** Execute a command in an isolated child process. */
  async exec(command: string, opts?: Partial<SandboxConfig>): Promise<SandboxResult> {
    const timeout = opts?.timeout ?? this.timeout;
    const maxOutput = opts?.maxOutput ?? this.maxOutput;

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;
      let killedBy: SandboxResult["killedBy"];

      const child = spawn("sh", ["-c", command], {
        cwd: opts?.cwd ?? this.workdir,
        env: opts?.env ?? this.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const killTimer = setTimeout(() => {
        killed = true;
        killedBy = "timeout";
        child.kill("SIGTERM");
        // Force kill after grace period
        setTimeout(() => child.kill("SIGKILL"), 5000);
      }, timeout);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
        if (Buffer.byteLength(stdout, "utf-8") + Buffer.byteLength(stderr, "utf-8") > maxOutput) {
          killed = true;
          killedBy = "output";
          child.kill("SIGTERM");
          clearTimeout(killTimer);
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
        if (Buffer.byteLength(stdout, "utf-8") + Buffer.byteLength(stderr, "utf-8") > maxOutput) {
          killed = true;
          killedBy = "output";
          child.kill("SIGTERM");
          clearTimeout(killTimer);
        }
      });

      child.on("close", (exitCode) => {
        clearTimeout(killTimer);
        resolve({
          stdout: stdout.slice(0, maxOutput),
          stderr: stderr.slice(0, maxOutput),
          exitCode: exitCode ?? (killed ? -1 : 0),
          killed,
          killedBy,
        });
      });

      child.on("error", () => {
        clearTimeout(killTimer);
        resolve({ stdout, stderr, exitCode: -1, killed: true });
      });
    });
  }

  /** Read a file within the sandbox. */
  readFile(inputPath: string, limit?: number): string {
    const safe = this.resolvePath(inputPath);
    const text = readFileSync(safe, "utf-8");
    if (limit != null && limit > 0) {
      return text.split("\n").slice(0, limit).join("\n");
    }
    return text.slice(0, 50_000);
  }

  /** Write a file within the sandbox. */
  writeFile(inputPath: string, content: string): void {
    const safe = this.resolvePath(inputPath);
    mkdirSync(dirname(safe), { recursive: true });
    writeFileSync(safe, content, "utf-8");
  }
}
```

**Notes on `exec` implementation:**

- Uses `spawn("sh", ["-c", command])` for cross-platform shell execution
- `sh` is available on Unix/macOS but not Windows. For Windows, use `cmd.exe /c`.
- Environment is explicitly set to the whitelist — no inheritance from parent
- Output limit is checked on each `data` chunk. Implementation truncates output to `maxOutput` on close.
- Memory limit (`maxMemory`) is not directly enforceable via Node.js `spawn` API without OS-specific tools (cgroups on Linux, `ulimit` on macOS, Job Objects on Windows).

**Memory limit implementation (platform-specific):**

```typescript
// Platform-specific memory limit via pre-spawn wrapper
private buildEnvWithMemoryLimit(maxMemory?: number): Record<string, string> | undefined {
  if (!maxMemory) return undefined;
  const platform = process.platform;
  // This is a rough approach; actual implementation needs careful platform handling
  if (platform === "linux") {
    // Use cgexec or ulimit wrapper
    return undefined;
  }
  if (platform === "darwin") {
    // Use ulimit -v
    return undefined;
  }
  // Windows: not easily enforceable
  return undefined;
}
```

For the initial implementation, document that `maxMemory` is best-effort and may not be enforceable on all platforms.

### Tool dispatch changes (packages/agent/src/tools.ts)

Modify `createToolDispatch` to accept an optional `Sandbox`:

```typescript
export function createToolDispatch(
  workdir: string = process.cwd(),
  skillsDir?: string,
  sandbox?: Sandbox,
): ToolDispatch {
  // ... existing setup (skillLoader, todoManager, etc.) ...

  const dispatch: Record<string, ToolHandler> = {
    bash: (args) => {
      if (sandbox) {
        return sandbox.exec(args.command as string).then((r) => r.stdout);
      }
      return runBash(args.command as string, workdir);
    },
    read_file: (args) => {
      if (sandbox) {
        return sandbox.readFile(args.path as string, args.limit as number | undefined);
      }
      return runRead(args.path as string, workdir, args.limit as number | undefined);
    },
    write_file: (args) => {
      if (sandbox) {
        sandbox.writeFile(args.path as string, args.content as string);
        return `Wrote ${(args.content as string).length} bytes to ${args.path}`;
      }
      return runWrite(args.path as string, args.content as string, workdir);
    },
    edit_file: (args) => {
      if (sandbox) {
        // Read, modify, write
        const content = sandbox.readFile(args.path as string);
        const index = content.indexOf(args.old_text as string);
        if (index === -1) throw new Error(`old_text not found`);
        if (content.indexOf(args.old_text as string, index + 1) !== -1) {
          throw new Error(`old_text is not unique`);
        }
        const updated =
          content.slice(0, index) +
          (args.new_text as string) +
          content.slice(index + (args.old_text as string).length);
        sandbox.writeFile(args.path as string, updated);
        return `Edited ${args.path}`;
      }
      return runEdit(
        args.path as string,
        args.old_text as string,
        args.new_text as string,
        workdir,
      );
    },
    todo: (args) => todoManager.update(args.items as TodoItem[]),
    ...(skillLoader && {
      load_skill: (args) => skillLoader.getContent(args.name as string),
    }),
  };

  // ... existing ...
}
```

Wait — `bash` handler's return type changes from `string` to `Promise<string>` when sandbox is used. The dispatch map is `Record<string, ToolHandler>` where `ToolHandler = (args) => string`. This doesn't work for async.

We need to either:

1. Change `ToolHandler` to support async: `(args) => string | Promise<string>`
2. Or handle the async at the AgentTool level (where `execute()` is already async)

Option 2 is better: keep `ToolHandler` sync, and in the `AgentTool` mapping inside `agentLoop()`, handle the async sandbox.exec.

But wait — `agentLoop()` maps `ToolHandler` to `AgentTool[].execute()`:

```typescript
const agentTools: AgentTool[] = tools.map((t) => {
  const handler = dispatch[t.name];
  return {
    name: t.name,
    // ...
    execute: handler
      ? async (_toolCallId, params) => ({ content: handler(params as Record<string, unknown>) })
      : async () => ({ content: `Unknown tool: ${t.name}`, isError: true }),
  };
});
```

Since `execute` is already async, we can await inside it. So the `AgentTool.execute` function can handle async dispatch handlers. We just need to make the wrapper async:

```typescript
execute: async (_toolCallId, params) => {
  try {
    const result = await handler(params as Record<string, unknown>);
    return { content: result };
  } catch (e) {
    return { content: `Error: ${(e as Error).message}`, isError: true };
  }
};
```

This requires changing `ToolHandler` or updating the mapping. Since the current code does `handler(params)` (sync call), if `handler` returns a Promise, we'd get `[object Promise]`. So we need to update the mapping to handle async.

**The cleanest approach**: Update `ToolHandler` to support Promises:

```typescript
// packages/agent/src/types.ts
export type ToolHandler = (args: Record<string, unknown>) => string | Promise<string>;
```

And update `agentLoop()` mapping:

```typescript
execute: async (_toolCallId, params) => {
  const result = await handler(params as Record<string, unknown>);
  return { content: result };
};
```

But this changes the type of `ToolHandler` — any consuming code that has a sync `ToolHandler` would need updating. Actually, `string | Promise<string>` is backward-compatible for callers — they can still return synchronously.

**Actually**, since `agentLoop()` is in this package and `ToolHandler` is exported, external consumers using custom handlers would be fine since `string` is still assignable to `string | Promise<string>`.

So the change is safe. We'll update `ToolHandler` to `string | Promise<string>`.

### Agent class changes (packages/agent/src/agent.ts)

**1. Add `sandbox` to `AgentOptions`:**

```typescript
export interface AgentOptions {
  // ... existing ...
  sandbox?: import("./sandbox.js").Sandbox;
}
```

**2. Add `sandbox` to `Agent` class:**

```typescript
class Agent {
  public sandbox?: Sandbox;
  // ...
  constructor(options: AgentOptions = {}) {
    // ... existing ...
    this.sandbox = options.sandbox;
  }
}
```

**3. Pass `sandbox` to `createToolDispatch`:**

The `Agent` class doesn't directly call `createToolDispatch`. `createToolDispatch` is called by the higher-level `agentLoop()` function. The `Agent` class uses `AgentTool[]` directly.

So `sandbox` is more relevant to the high-level `agentLoop()` API than the `Agent` class. When using the `Agent` class, users configure tools externally and pass them in. The sandbox integration is primarily through `createToolDispatch()`.

For the `Agent` class, the integration path is: users call `createToolDispatch(workdir, skillsDir, sandbox)` to get tools, then pass those tools to `Agent`.

So we update `createToolDispatch` signature:

```typescript
export function createToolDispatch(
  workdir?: string,
  skillsDir?: string,
  sandbox?: Sandbox,
): ToolDispatch;
```

And consumers use:

```typescript
const { tools, dispatch } = createToolDispatch("./workspace", "./skills", sandbox);
const agent = new Agent({ model, tools: agentTools });
```

### Export changes (packages/agent/src/index.ts)

```typescript
export type { SandboxConfig, SandboxResult } from "./sandbox.js";
export { Sandbox } from "./sandbox.js";
```

## End-to-end flow

### With Sandbox

```
User: const sandbox = new Sandbox({ workdir: "/tmp/workspace" })
User: const { tools, dispatch } = createToolDispatch("/tmp/workspace", undefined, sandbox)
User: const agent = new Agent({ model, tools }); // agent constructed with AgentTool[], not ToolHandler

User: agent.prompt("List files")
  → LLM responds with tool call: bash "ls"
  → executeToolCalls
    → AgentTool["bash"].execute() is the async wrapper
    → calls dispatch["bash"]() which is sandbox.exec()
    → spawn("sh", ["-c", "ls"], { cwd: "/tmp/workspace", env: whitelisted })
    → returns stdout
    → AgentTool returns { content: stdout }
```

### Without Sandbox (unchanged)

```
User: const { tools, dispatch } = createToolDispatch("./workspace") // no sandbox
  → bash tool uses runBash (execSync)
  → file tools use readFileSync/writeFileSync
  → behavior identical to today
```

## Risks and mitigations

### Risk 1: Async ToolHandler type change

**Problem**: Changing `ToolHandler` return type from `string` to `string | Promise<string>` is a type-level change.

**Mitigation**: `string` is assignable to `string | Promise<string>`, so existing sync handlers compile without change. Only the internal wrapping in `agentLoop()` changes to `await`.

### Risk 2: Windows compatibility for spawn

**Problem**: `spawn("sh", ["-c", command])` only works on Unix-like systems. On Windows, `sh` is not available by default.

**Mitigation**: Use `process.platform` to select the shell:

```typescript
const isWindows = process.platform === "win32";
const shell = isWindows ? "cmd.exe" : "sh";
const shellArgs = isWindows ? ["/c", command] : ["-c", command];
const child = spawn(shell, shellArgs, { ... });
```

This makes the sandbox work on Windows, macOS, and Linux.

### Risk 3: Path sandboxing gaps

**Problem**: `realpathSync` may not resolve all symlinks, particularly on Windows with junction points.

**Mitigation**: `realpathSync` from Node.js `fs` module uses the OS's realpath implementation, which handles both symlinks and junction points on Windows. The `relative()` check after resolution catches remaining escapes.

### Risk 4: Memory limit not enforceable

**Problem**: Node.js `child_process` API does not expose memory cgroup limits or `ulimit` setting.

**Mitigation**: Document `maxMemory` as best-effort. On Linux, implement via `prlimit` or `cgcreate` wrapper if available. On unsupported platforms, memory limits are a no-op but timeout and output limits still provide safety.

### Risk 5: Performance overhead

**Problem**: Spawning a child process per bash command is orders of magnitude slower than `execSync`.

**Mitigation**: Document the trade-off: Sandbox is for untrusted code. For trusted environments, use the default `createToolDispatch()` without a sandbox. The overhead is acceptable for security-sensitive workflows.

### Risk 6: Environment whitelist too restrictive

**Problem**: Whitelisting only explicit env vars may break tools that depend on standard env vars like `HOME`, `USER`, `SHELL`.

**Mitigation**: Provide a sensible default env that includes `PATH`, `HOME`, `LANG`, and `NODE_ENV`. Consumers can override via the `env` config option.

## Testing and validation

### Unit tests (packages/agent/test/sandbox.test.ts)

- Sandbox constructor creates workdir if missing
- `exec()` runs simple command and returns stdout
- `exec()` respects timeout and kills long command
- `exec()` respects maxOutput and kills chatty command
- `readFile()` reads file within workdir
- `readFile()` rejects path outside workdir
- `readFile()` rejects symlink pointing outside workdir
- `writeFile()` writes file and creates parent dirs
- `writeFile()` rejects path outside workdir
- Path with `..` components is validated
- Absolute path is rejected
- `env` is passed correctly to spawned process
- Default `env` (empty) is safe

### Integration tests

- Agent with sandbox executes bash tool successfully
- Agent with sandbox enforces timeout
- Agent with sandbox enforces output limit
- Agent with sandbox prevents path escape via `../../`
- Agent without sandbox behaves identically to pre-feature baseline

### Regression tests

- `agent-loop.test.ts` passes
- `agent.test.ts` passes
- `tools.test.ts` passes

## Follow-ups

1. **Memory limit enforcement**: Platform-specific implementation using cgroups on Linux, `launchctl limit` on macOS, Job Objects on Windows.
2. **Network sandboxing**: Restrict outbound network access from spawned processes.
3. **Container integration**: Optional Docker-based execution for maximum isolation.
4. **Audit logging**: Log all sandboxed executions with parameters, results, and resource usage.
