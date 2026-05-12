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
| `todo`       | Update task list for multi-step tracking |
| `load_skill` | Load a skill body on demand              |

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

## Todo Tracking

The agent tracks its own progress via a `todo` tool. When the loop starts, a `TodoManager` is created automatically and the `todo` tool is added to the dispatch.

```typescript
import { TodoManager } from "@bookingcare/agent";

const mgr = new TodoManager();
mgr.update([
  { id: "1", text: "Plan the feature", status: "completed" },
  { id: "2", text: "Write code", status: "in_progress" },
  { id: "3", text: "Write tests", status: "pending" },
]);

console.log(mgr.render());
// [x] #1: Plan the feature
// [>] #2: Write code
// [ ] #3: Write tests
//
// (1/3 completed)
```

### Nag reminder

If the model doesn't update its todos for 3 consecutive rounds of tool calls, a `<reminder>Update your todos.</reminder>` message is injected to nudge it back on track. This keeps the agent's progress visible without scripting its route.

Constraints:

- Maximum 20 items
- Only one item can be `in_progress` at a time
- Valid statuses: `pending`, `in_progress`, `completed`

## Agent Class

Stateful wrapper around the streaming agent loop. Owns the transcript, emits lifecycle events, executes tools, and exposes queueing APIs.

```typescript
import { Agent } from "@bookingcare/agent";
import { getModel } from "@bookingcare/ai";

const agent = new Agent({
  initialState: {
    model: getModel("gpt-5.4-nano")!,
    systemPrompt: "You are a helpful assistant.",
    tools: [],
    messages: [],
    thinkingLevel: "off",
  },
});

// Subscribe to events
agent.subscribe((event, signal) => {
  if (event.type === "message_end") {
    console.log("Got message:", event.message);
  }
});

// Prompt the agent
await agent.prompt("What is 2+2?");

// State is preserved between calls
console.log(agent.state.messages);
```

### Events

| Event                  | Description                                |
| ---------------------- | ------------------------------------------ |
| `message_start`        | Stream started (partial message)           |
| `message_update`       | Text delta received (partial message)      |
| `message_end`          | Full message received                      |
| `tool_execution_start` | Tool execution began                       |
| `tool_execution_end`   | Tool execution finished                    |
| `turn_end`             | Assistant message + tool results processed |
| `agent_end`            | Agent finished (full transcript)           |

### Steering and Follow-up Queues

- **`steer(message)`** — inject after the current assistant turn
- **`followUp(message)`** — run after the agent would otherwise stop
- **`abort()`** — abort the current run
- **`waitForIdle()`** — resolve when the current run finishes
- **`reset()`** — clear transcript, runtime state, and queues

### Queue Modes

`steeringMode` and `followUpMode` control how queued messages are drained:

- `"one-at-a-time"` (default) — one message per poll
- `"all"` — drain all queued messages at once

## AgentTool

Extends `Tool` from `@bookingcare/ai` with execution capabilities:

```typescript
import { AgentTool } from "@bookingcare/agent";
import { Type, Static } from "@bookingcare/ai";

const ReadFileParams = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});

type ReadFileArgs = Static<typeof ReadFileParams>;

const readFileTool: AgentTool<typeof ReadFileParams> = {
  name: "read_file",
  description: "Read file contents",
  parameters: ReadFileParams,
  label: "Read File",
  prepareArguments: (args) => {
    // Shim for raw LLM arguments before schema validation
    return args as ReadFileArgs;
  },
  execute: async (toolCallId, params, signal) => {
    const content = fs.readFileSync(params.path, "utf-8");
    return { content };
  },
  executionMode: "sequential", // per-tool override
};
```

### AgentTool Fields

| Field                                             | Description                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `name`, `description`, `parameters`               | Inherited from `Tool`                                                       |
| `label`                                           | Human-readable label for UI display                                         |
| `prepareArguments?`                               | Shim for raw tool-call arguments before validation                          |
| `execute(toolCallId, params, signal?, onUpdate?)` | Execute the tool call. Throw on failure. Returns `Promise<AgentToolResult>` |
| `executionMode?`                                  | Per-tool override (`"parallel"` or `"sequential"`)                          |

## Architecture

```
src/
  types.ts          — all public types
  agent-loop.ts     — merged loop: agentLoop (simple) + runAgentLoop/runAgentLoopContinue (streaming)
  agent.ts          — Agent class: state, events, queues, abort
  tools.ts          — tool schemas, handlers, and createToolDispatch()
  skill-loader.ts   — SkillLoader: scan, describe, load skills
  todo-manager.ts   — TodoManager: structured state for task tracking
  index.ts          — barrel export
```
