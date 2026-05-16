# @bookingcare/infa

Sandbox execution for process-isolated agent tools with resource limits.

## Installation

```bash
pnpm add @bookingcare/infa
```

## Usage

```typescript
import { createSandbox } from "@bookingcare/infa";

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
