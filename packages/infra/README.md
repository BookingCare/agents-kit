# @bookingcare/infra

Sandbox execution for process-isolated agent tools with resource limits.

## Installation

```bash
pnpm add @bookingcare/infra
```

## Usage

```typescript
import { createSandbox } from "@bookingcare/infra";

const sandbox = createSandbox({
  kind: "local",
  workdir: "/workspace",
  timeout: 30_000,
  maxOutput: 1024 * 1024,
  env: {
    PATH: "/usr/local/bin:/usr/bin:/bin",
  },
});

const result = await sandbox.exec("echo hello");
```

Sandboxed processes do not inherit the parent environment. Pass a safe `PATH` (and on Windows, `SystemRoot`/`ComSpec`) in `env` when commands need external binaries.

`Sandbox` also exposes `readFile()`, `writeFile()`, and `editFile()` for workspace-scoped file operations.

## Persistence

`@bookingcare/infra` exports persistence helpers from the root package and the `./persistence` subpath.

```typescript
import { createStore } from "@bookingcare/infra";

const jsonStore = await createStore({
  type: "json",
  baseDir: "./data",
});

const mysqlStore = await createStore({
  type: "mysql",
  options: {
    host: "127.0.0.1",
    user: "agents",
    password: process.env.MYSQL_PASSWORD,
    database: "agents",
  },
});
```
