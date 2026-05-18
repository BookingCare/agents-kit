# Agents Kit

A TypeScript toolkit for building AI-powered agents with streaming, tool dispatch, skill loading, and todo tracking.

## Packages

| Package                              | Version                                                                                                         | Description                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [@bookingcare/ai](packages/ai)       | [![npm](https://img.shields.io/npm/v/@bookingcare/ai.svg)](https://www.npmjs.com/package/@bookingcare/ai)       | Unified multi-provider LLM API with streaming, tool calling, and cost tracking |
| [@bookingcare/agent](packages/agent) | [![npm](https://img.shields.io/npm/v/@bookingcare/agent.svg)](https://www.npmjs.com/package/@bookingcare/agent) | Agent loop with tool dispatch, file tools, skill loading, and todo tracking    |
| [@bookingcare/infa](packages/infa)   | [![npm](https://img.shields.io/npm/v/@bookingcare/infa.svg)](https://www.npmjs.com/package/@bookingcare/infa)   | Sandbox execution and persistence for process-isolated agent tools             |

## Quick Start

### LLM Streaming

```typescript
import { getModel, stream, complete } from "@bookingcare/ai";

const model = getModel("gpt-5.4-nano")!;
const result = await complete(model, {
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(result.text);
```

### Agent Loop

```typescript
import { agentLoop } from "@bookingcare/agent";
import { getModel } from "@bookingcare/ai";

const model = getModel("gpt-5.4-nano")!;
const { messages, iterations } = await agentLoop("Create a file called notes.txt", {
  model,
  workdir: "/path/to/workspace",
});
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules.

## Development

```bash
pnpm install        # Install all dependencies
pnpm run build      # Build all packages
pnpm run check      # Lint, format, and type check
```

> **Note:** `pnpm run check` requires `pnpm run build` to be run first.
