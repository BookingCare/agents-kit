# Agents Kit Harness Mono Repo

## All Packages

| Package | Description |
|---------|-------------|
| **[@BookingCare/ai](packages/ai)** | Unified multi-provider LLM API (openAI, Anthropic, etc.) |

## Contributing

See [CONTRIBUTTING.md](CONTRIBUTTING.md) for contributtion guidelines and [AGENTS.md](AGENTS.md) for project-specifice rules (for both humans and agents).

## Developement

```bash
pnpm install        # Install all dependencies
pnpm run build      # Build all packages
pnpm run check      # Lint, format, and type check
```

> **Note:** `pnpm run check` requires `pnpm run build` to be run first.