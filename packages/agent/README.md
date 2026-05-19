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

### Sandbox integration

Pass a sandbox from `@bookingcare/infra` to route bash and file tools through process-isolated execution. Local sandboxes do not inherit the parent environment, so include a safe `PATH` (and on Windows, `SystemRoot`/`ComSpec` when needed) if commands need external binaries:

```typescript
import { createSandbox } from "@bookingcare/infra";

const sandbox = createSandbox({
  kind: "local",
  workdir: "/workspace",
  env: {
    PATH: "/usr/local/bin:/usr/bin:/bin",
  },
});
const { tools, dispatch } = createToolDispatch("/workspace", undefined, sandbox);
```

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

// Subscribe to specific channels
agent.eventBus.on("streaming", (event) => {
  if (event.type === "message_end") {
    console.log("Got message:", event.message);
  }
});

// Legacy API still works, but is deprecated
agent.subscribe((event) => {
  console.log(event.type);
});

// Prompt the agent
await agent.prompt("What is 2+2?");

// State is preserved between calls
console.log(agent.state.messages);
```

### Events

| Channel     | Event types                                                                   |
| ----------- | ----------------------------------------------------------------------------- |
| `lifecycle` | `context_trimmed`, `agent_end`                                                |
| `streaming` | `message_start`, `message_update`, `message_end`                              |
| `tools`     | `permission_needed`, `tool_execution_start`, `tool_execution_end`, `turn_end` |

`agent.eventBus.once(channel, listener)` is available for one-shot subscriptions. `agent.subscribe()` remains available for backward compatibility and subscribes the handler to all channels.

### PermissionManager

`Agent` can gate tool calls with a rule-based `PermissionManager`.

```typescript
import { Agent, PermissionManager } from "@bookingcare/agent";
import { getModel } from "@bookingcare/ai";

const permissions = new PermissionManager();
permissions.grant({ tool: "read_file", action: "allow" });
permissions.grant({ tool: "bash", action: "ask" });

const agent = new Agent({
  initialState: {
    model: getModel("gpt-5.4-nano")!,
    systemPrompt: "You are a coding assistant.",
    tools: [],
    messages: [],
    thinkingLevel: "off",
  },
  permissionManager: permissions,
});

agent.subscribe((event) => {
  if (event.type === "permission_needed") {
    event.resolve("allow");
  }
});
```

- `allow` and `deny` are checked before `beforeToolCall`
- `ask` emits `permission_needed` and waits for `resolve("allow" | "deny")`
- Default rules: `read_file` allow, `bash`/`write_file`/`edit_file` ask, wildcard deny

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

## Persistence

`Agent` can persist its session state to an external `Store` (e.g. `JSONStore` from `@bookingcare/infra`). When a `store` is provided, the agent automatically saves the full transcript, todo state, and metadata to the store on every `agent_end` event.

```typescript
import { Agent } from "@bookingcare/agent";
import { JSONStore } from "@bookingcare/infra";

const store = await JSONStore.create({ baseDir: "./data" });

const agent = new Agent({
  initialState: { model, systemPrompt: "You are helpful.", tools: [] },
  store, // sessionId is auto-generated if not provided
  todoManager: new TodoManager(), // optional — persists todo state too
});

await agent.prompt("Plan this project");

// Later, resume the session
const resumed = await Agent.resume({
  sessionId: agent.sessionId!,
  store,
  model, // optional — will be resolved from saved model ID if omitted
  todoManager: new TodoManager(), // optional — restores todo state
});

await resumed.prompt("Continue from where we left off");
```

**Notes on resumption**:

- Tools are not persisted (they contain function references). Re-register tools after `resume()`.
- `sessionId` must be provided or auto-generated to persist. Without a `store`, the agent is purely in-memory and `sessionId` may be `undefined`.
- Streaming state (`streamingMessage`, `pendingToolCalls`) is intentionally not persisted. If the process crashes mid-run, the last completed `agent_end` state is what gets restored.

## MCP Transport Support

The MCP client currently supports `stdio` and `sse` transports. WebSocket transport is intentionally disabled until `@modelcontextprotocol/sdk` exports `WebSocketClientTransport`.

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
