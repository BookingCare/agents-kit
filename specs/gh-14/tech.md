# Sandbox — process-isolated tool execution with resource limits - Tech Spec

## Problem

The current tool execution path in `packages/agent` runs in-process:

- `bash` uses `execSync`
- file tools use `readFileSync` / `writeFileSync`
- `safePath()` only checks lexical traversal, not symlinks or case-insensitive filesystem behavior

A buggy or malicious tool can block the event loop, escape the workspace through a symlink, or inherit the parent process environment.

## Relevant code

### `packages/agent/src/tools.ts`

- `runBash()`, `runRead()`, `runWrite()`, `runEdit()`
- `safePath()`
- `createToolDispatch()`

### `packages/agent/src/agent.ts`

- `agentLoop()` turns tool dispatch entries into executable agent tools
- tool execution is currently sync-first

### `packages/agent/src/types.ts`

- `ToolHandler`
- `AgentTool`
- `AgentLoopConfig`

## Current state

- Tool handlers are synchronous.
- There is no sandbox package.
- `writeFile()` semantics already expect parent directories to be created, but the current path validator is not symlink-aware.
- `maxMemory` is only a planned capability, not a guaranteed cross-platform limit.

## Proposed changes

### 1. New package: `packages/infa`

Move sandboxing into a separate workspace package, `packages/infa` (the renamed replacement for the old `packages/db` slot). Publish it as `@bookingcare/infa`.

The package is the construction boundary for sandbox implementations. It currently supports one kind: `local`.

Suggested layout:

```text
packages/infa/
  src/
    index.ts
    types.ts
    factory.ts
    local/
      local-sandbox.ts
      path.ts
  test/
    factory.test.ts
    local-sandbox.test.ts
```

### 2. Factory-based public API

`packages/infa` exports a factory, not a public concrete constructor.

```typescript
export type SandboxKind = "local";

export interface SandboxOptions {
  kind: SandboxKind;
  workdir: string;
  timeout?: number;
  maxMemory?: number;
  maxOutput?: number;
  env?: Record<string, string>;
}

export interface SandboxExecOptions {
  timeout?: number;
  maxOutput?: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed?: boolean;
  killedBy?: "timeout" | "memory" | "output";
}

export interface Sandbox {
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxResult>;
  readFile(path: string, limit?: number): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export function createSandbox(options: SandboxOptions): Sandbox;
```

`createSandbox()` picks an implementation from a registry keyed by `kind`. For now, the registry only contains `local`.

### 3. Local sandbox implementation

`LocalSandbox` is the only implementation in the initial release.

Behavior:

- create `workdir` on construction
- run commands with `spawn()`, not `execSync()`
- do not inherit the parent environment wholesale
- enforce `timeout` and `maxOutput` by terminating the child process
- keep `cwd` fixed to the configured `workdir`
- resolve file paths under `workdir`
- create missing parent directories on `writeFile()`
- keep `maxMemory` as best-effort until the platform can enforce it reliably

### 4. Path validation

Path validation is shared by `readFile()` and `writeFile()`.

Rules:

1. reject absolute paths
2. resolve the requested path relative to `workdir`
3. resolve the nearest existing ancestor with `realpath`
4. confirm the resolved ancestor stays under `workdir`
5. allow new nested files and directories inside `workdir`
6. reject paths that escape via `..` or symlinks

`writeFile()` must validate first, then create missing parents under `workdir`, then write the file. It must not reject a path just because the parent directories do not exist yet.

### 5. Agent integration

`packages/agent/src/tools.ts` accepts an optional `Sandbox` instance. When present:

- `bash` delegates to `sandbox.exec()`
- `read_file` delegates to `sandbox.readFile()`
- `write_file` delegates to `sandbox.writeFile()`
- `edit_file` is read → modify → write through the sandbox

Tool dispatch handlers become async-aware so the agent loop can await sandbox results. `Agent` stays a stateful loop wrapper; sandbox selection lives at the dispatch layer, not in the constructor.

## Risks and mitigations

1. **Async tool dispatch changes the handler contract.**
   - Mitigation: widen `ToolHandler` to accept `Promise<string>` and await it in `agentLoop()`.

2. **`maxMemory` is not portable.**
   - Mitigation: keep the API surface, document it as best-effort for the initial local implementation.

3. **Shell compatibility differs across platforms.**
   - Mitigation: choose the platform shell in the local implementation.

4. **Symlink checks must be done on the resolved path, not the lexical path.**
   - Mitigation: validate the nearest existing ancestor with `realpath`.

## Testing and validation

### Unit tests (`packages/infa/test/`)

- `createSandbox({ kind: "local" })` returns a working sandbox
- unsupported kinds fail fast
- `exec()` returns stdout for a simple command
- `exec()` respects timeout
- `exec()` respects maxOutput
- `readFile()` reads inside `workdir`
- `writeFile()` creates missing parent directories
- absolute paths are rejected
- symlink escapes are rejected

### Integration tests (`packages/agent/test/`)

- `createToolDispatch(..., sandbox)` routes bash and file tools through the sandbox
- tool execution still works without a sandbox
- async sandbox results are awaited correctly

## Follow-ups

- additional sandbox kinds can register in the factory without changing callers
- platform-specific memory enforcement can be added behind the same `maxMemory` option
- audit logging can be added at the factory boundary
