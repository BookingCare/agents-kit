# @bookingcare/agent

Agent loop with tool dispatch, file operations, and on-demand skill loading.

## Installation

```bash
pnpm add @bookingcare/agent
```

## Quick Start

```typescript
import { agentLoop, createToolDispatch } from "@bookingcare/agent";
import { getModel } from "@bookingcare/ai";

const model = getModel("gpt-5.4-nano")!;

// Simple query — no tools
const { messages, iterations } = await agentLoop("What is 2+2?", { model });

// With file tools (bash, read_file, write_file, edit_file)
const result = await agentLoop("Create a file called notes.txt with 'hello'", {
  model,
  workdir: "/path/to/workspace",
});
```

## Agent Loop

The loop runs a conversation until the model stops calling tools or a max iteration limit is hit.

```typescript
const { messages, iterations } = await agentLoop(query, {
  model,
  system: "You are a coding assistant.", // optional system prompt
  workdir: "/workspace", // for file tool sandboxing
  maxTokens: 8000, // per-completion token limit
  maxIterations: 50, // safety cap
  onStreamResult: (result, i) => {
    // called after each iteration
    console.log(`Iteration ${i}:`, result.text);
  },
});
```

Returns `{ messages, iterations }` — the full message history and how many loop cycles ran.

## Tools

Four file tools are available when `workdir` is set (or passed to `createToolDispatch`):

| Tool         | Description                              |
| ------------ | ---------------------------------------- |
| `bash`       | Run a shell command                      |
| `read_file`  | Read file contents (optional line limit) |
| `write_file` | Write content to a file (creates dirs)   |
| `edit_file`  | Replace an exact, unique text segment    |

File paths are sandboxed to `workdir` — path traversal attempts throw.

### Custom dispatch

```typescript
import { createToolDispatch } from "@bookingcare/agent";

const { tools, dispatch } = createToolDispatch("/workspace");

// Pass to agentLoop with custom overrides
await agentLoop("do something", {
  model,
  tools,
  dispatch: {
    ...dispatch,
    my_tool: (args) => `result: ${args.input}`,
  },
});
```

## Skill Loading

On-demand knowledge injection. Skills live as `SKILL.md` files in a directory:

```
skills/
  code-review/
    SKILL.md
  greeter/
    SKILL.md
```

Each `SKILL.md` has YAML frontmatter:

```markdown
---
name: code-review
description: Perform structured code reviews with a checklist
---

# Code Review Skill

When reviewing code, use this checklist:
...
```

Two-layer design:

- **Layer 1** — Skill names and descriptions injected into the system prompt (~100 tokens/skill)
- **Layer 2** — Full skill body returned via `load_skill` tool call when the model needs it (~2000 tokens/skill)

```typescript
import { agentLoop } from "@bookingcare/agent";
import { SkillLoader } from "@bookingcare/agent";

// Automatic: pass skillsDir to agentLoop
await agentLoop("Review this code", {
  model,
  skillsDir: "./skills",
  workdir: "/workspace",
});

// Manual: use SkillLoader directly
const loader = new SkillLoader("./skills");
loader.getDescriptions(); // "  - code-review: Perform structured...\n  - greeter: ..."
loader.getContent("code-review"); // <skill name="code-review">...</skill>
```

When `skillsDir` is provided, the `load_skill` tool is added to the dispatch automatically and skill descriptions are appended to the system prompt.

## Architecture

```
src/
  types.ts          — all public types (AgentLoopOptions, ToolHandler, ToolDispatch, SkillMeta, Skill)
  agent-loop.ts     — the loop: query → complete → dispatch → repeat
  tools.ts          — tool schemas, handlers, and createToolDispatch()
  skill-loader.ts   — SkillLoader: scan, describe, load skills
  index.ts          — barrel export
```
