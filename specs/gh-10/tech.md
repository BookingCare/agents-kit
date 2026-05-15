# BreakpointManager — pause/resume for agent loop stages - Tech Spec

## Problem

The `Agent` loop runs uninterrupted from `prompt()` to `agent_end`. There is no mechanism to pause mid-execution, inspect state, and resume cleanly. Implementing this requires:

1. Defining eight named stage checkpoints inside the loop
2. Synchronizing a pause signal between the loop and external consumption
3. Preserving full state across a pause/resume boundary

## Relevant code

### packages/agent/src/types.ts

- `AgentEvent` (line ~117-126): Event types including `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`, `turn_end`, `agent_end`
- `AgentContext` (line ~125): `{ systemPrompt, messages, tools }`
- `AgentState` (line ~99-112): Immutable state with `messages`, `tools`, `streamingMessage`, `pendingToolCalls`
- `BeforeToolCallContext`, `BeforeToolCallResult` (line ~80-96): Hook types — permissions system may reuse a similar pattern

### packages/agent/src/agent-loop.ts

- `loop()` (line ~140-230): Core loop orchestrating stream, tool execution, follow-ups, and steering
- `collectStreamIntoMessage()` (line ~235-310): Stream event collection emitting `message_start`, `message_update`, `message_end`
- `executeToolCalls()` (line ~315-420): Tool dispatch emitting `tool_execution_start`, `tool_execution_end`, and assembling `turn_end`
- `runAgentLoop()` (line ~115-120): Entry point for new prompt
- `runAgentLoopContinue()` (line ~123-128): Entry point for continuation

### packages/agent/src/agent.ts

- `Agent` class (line ~185-end): Main class that owns `MutableAgentState` and event listeners
- `subscribe()` (line ~225-240): Event listener registration
- `processEvents()` (line ~470-530): Event emission and state updates
- `runWithLifecycle()` (line ~420-470): Active run controller with `AbortController`
- `createContextSnapshot()` (line ~360-365): Creates `AgentContext` from current state
- `activeRun` (line ~180): `{ promise, resolve, abortController }` — controls the active run

## Current state

### Execution flow

```
prompt() → runWithLifecycle()
  → runAgentLoop(seedMessages, context, config, emit, signal)
    → loop(messages, context, config, emit, signal)
      → for (;;) {
        → [1] prepareNextTurn
        → [2] convertToLlm
        → [3] streamFn (LLM call)
          → emit message_start
          → emit message_update ...
          → emit message_end
        → [4] check tool calls / stop
        → [5] executeToolCalls (if tools)
          → for each tool: emit tool_execution_start
          → for each tool: emit tool_execution_end
          → emit turn_end
        → [6] getSteeringMessages
        → [7] getFollowUpMessages
      }
      → emit agent_end
```

### Event emission

`Agent.emit()` is async and awaited at every emission site in the loop. Currently, listener exceptions (except during `agent_end`) immediately abort the whole run. The loop is single-threaded and all emissions are sequential.

### State ownership

- `Agent` owns `_state` (mutable state)
- `loop()` receives a `messages` array and appends to it
- `context` holds references to tools and system prompt
- The `activeRun` controller (promise/resolve/AbortController) manages lifecycle

## Proposed changes

### New types (packages/agent/src/types.ts)

Add at the end of the file:

```typescript
export type BreakpointStage =
  | "pre_stream"
  | "streaming"
  | "post_stream"
  | "pre_tool"
  | "tool_exec"
  | "post_tool"
  | "pre_followup"
  | "complete";

export type BreakpointCondition = (context: AgentContext) => boolean;

export interface Breakpoint {
  stage: BreakpointStage;
  condition?: BreakpointCondition;
}

export interface BreakpointHit {
  stage: BreakpointStage;
  context: AgentContext;
  snapshot: AgentState;
}
```

### BreakpointManager class (packages/agent/src/breakpoint-manager.ts)

```typescript
import type { BreakpointStage, BreakpointCondition } from "./types.js";

type Unconditional = null;

export class BreakpointManager {
  private breakpoints = new Map<BreakpointStage, BreakpointCondition | Unconditional>();
  private paused = false;
  private resumePromise?: Promise<void>;
  private resumeResolve?: () => void;

  setBreakpoint(stage: BreakpointStage, condition?: BreakpointCondition): void {
    this.breakpoints.set(stage, condition ?? null);
  }

  clearBreakpoint(stage: BreakpointStage): void {
    this.breakpoints.delete(stage);
  }

  clearAll(): void {
    this.breakpoints.clear();
  }

  isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.resumePromise = new Promise((resolve) => {
      this.resumeResolve = resolve;
    });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resumeResolve?.();
    this.resumeResolve = undefined;
    this.resumePromise = undefined;
  }

  get resumeWait(): Promise<void> | undefined {
    return this.resumePromise;
  }

  /**
   * Check if a stage should trigger a pause.
   * Returns true if execution should pause.
   */
  shouldPauseAt(stage: BreakpointStage, context: AgentContext): boolean {
    if (!this.paused) {
      const condition = this.breakpoints.get(stage);
      if (condition === undefined) return false; // not set
      if (condition === null) return true; // unconditional
      return condition(context);
    }
    return true; // already paused — stay paused
  }
}
```

### Agent class changes (packages/agent/src/agent.ts)

**1. Add `breakpointManager` to `AgentOptions`:**

```typescript
export interface AgentOptions {
  // ... existing options ...
  breakpointManager?: BreakpointManager;
}
```

**2. Add `breakpointManager` and `onBreakpoint` properties to `Agent`:**

```typescript
class Agent {
  // ... existing ...
  public breakpointManager: BreakpointManager;
  public onBreakpoint?: (hit: BreakpointHit) => Promise<void> | void;

  constructor(options: AgentOptions = {}) {
    // ... existing ...
    this.breakpointManager = options.breakpointManager ?? new BreakpointManager();
  }
}
```

**3. Add convenience methods on `Agent`:**

```typescript
public setBreakpoint(stage: BreakpointStage, condition?: BreakpointCondition): void {
  this.breakpointManager.setBreakpoint(stage, condition);
}

public pause(): void {
  this.breakpointManager.pause();
}

public resume(): void {
  this.breakpointManager.resume();
}

public clearBreakpoint(stage: BreakpointStage): void {
  this.breakpointManager.clearBreakpoint(stage);
}

public clearAllBreakpoints(): void {
  this.breakpointManager.clearAll();
}
```

**4. Modify `runWithLifecycle()` (line ~420-470):**  
Run `runWithLifecycle` already runs an executor with the abort signal and run tracking. Pause/resume happens inside the loop itself. No change needed to the `runWithLifecycle` wrapper.

### Agent loop changes (packages/agent/src/agent-loop.ts)

Modify `loop()` to include stage checks at each of the eight boundaries. Before each stage, check the abort signal and the breakpoint manager.

**Stage 1: `pre_stream`**

Insert before the LLM call (after `prepareNextTurn` and LLM message prep):

```typescript
// After llmMessages are built, before streamFn is called
if (await checkBreakpoint(context.messages, "pre_stream")) return;
```

**Stage 2: `streaming`**

The stream collection is inside `collectStreamIntoMessage`. However, we don't want to modify that function deeply. Instead, intercept at the `emit` level in `loop()`:

```typescript
// Inside collectStreamIntoMessage's emit propagation
// Actually, better: wrap the emit function to detect message_start
```

Actually, a cleaner approach: wrap the `emit` function passed to `collectStreamIntoMessage` to intercept `message_start`:

```typescript
interface LoopInternalState {
  emit: (event: AgentEvent) => Promise<void>;
  config: AgentLoopConfig;
  context: { systemPrompt: string; tools: AgentTool[] };
  messages: AgentMessage[];
  breakpointManager?: BreakpointManager;
}
```

To keep it simpler, introduce a helper in `agent-loop.ts`:

```typescript
async function withBreakpointCheck(
  stage: BreakpointStage,
  breakpointManager: BreakpointManager | undefined,
  context: AgentContext,
  state: MutableAgentState,
  onBreakpoint: ((hit: BreakpointHit) => Promise<void> | void) | undefined,
): Promise<boolean> {
  if (!breakpointManager) return false;
  if (breakpointManager.isPaused() || breakpointManager.shouldPauseAt(stage, context)) {
    if (!breakpointManager.isPaused()) {
      breakpointManager.pause();
      if (onBreakpoint) {
        await onBreakpoint({
          stage,
          context,
          snapshot: { ...state } as AgentState, // or properly snapshot
        });
      }
    }
    // Wait for resume
    await breakpointManager.resumeWait;
  }
  return false; // don't abort
}
```

Wait — this has a problem. The `onBreakpoint` callback is on `Agent`, not inside `agent-loop.ts`. And `AgentState` is a separate type from `MutableAgentState`. We need a clean way to pass the breakpoint check from the Agent into the loop.

**Cleaner design**: Pass `beforeStage` callback into `AgentLoopConfig`:

```typescript
// Add to AgentLoopConfig (types.ts)
beforeStage?: (
  stage: BreakpointStage,
  context: AgentContext,
) => Promise<void> | void;
```

`beforeStage("pre_tool")` fires at the stage boundary before `executeToolCalls` begins, while `beforeToolCall` fires immediately before an individual tool is executed. Both can be active simultaneously — `beforeStage("pre_tool")` runs first, then the tool-execution loop begins, and `beforeToolCall` runs for each tool. The same ordering applies for `afterToolCall` (per-tool) and `afterStage("post_tool")` (stage boundary after all tools complete).

Then implement `beforeStage` in the Agent's `createLoopConfig()`:

```typescript
createLoopConfig(): AgentLoopConfig {
  // ... existing ...
  beforeStage: async (stage, context) => {
    if (this.breakpointManager.isPaused() || this.breakpointManager.shouldPauseAt(stage, context)) {
      if (!this.breakpointManager.isPaused()) {
        this.breakpointManager.pause();
        await this.onBreakpoint?.({
          stage,
          context,
          snapshot: this.createStateSnapshot(),
        });
      }
      // Wait for resume or abort
      const waitPromise = this.breakpointManager.resumeWait;
      if (waitPromise) {
        await Promise.race([
          waitPromise,
          new Promise<void>((_, reject) => {
            // Reject if abort signal fires while paused
            if (this.signal?.aborted) {
              reject(new Error("aborted"));
            } else {
              this.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            }
          }),
        ]);
      }
    }
  },
}
```

Then add stage hooks in `loop()`. Here's the modified loop flow:

```typescript
async function loop(
  messages: AgentMessage[],
  context: { systemPrompt: string; tools: AgentTool[] },
  config: AgentLoopConfig,
  emit: (event: AgentEvent) => Promise<void>,
  signal: AbortSignal,
  streamFn: StreamFn,
  maxIterations?: number,
): Promise<void> {
  let iterationCount = 0;

  // Helper to build AgentContext for breakpoint checks
  const buildContext = (): AgentContext => ({
    systemPrompt: context.systemPrompt,
    messages,
    tools: context.tools,
  });

  const checkStage = async (stage: BreakpointStage) => {
    if (config.beforeStage) {
      await config.beforeStage(stage, buildContext());
    }
  };

  const finishRun = async () => {
    await checkStage("complete");
    await emit({ type: "agent_end", messages: messages.slice() });
  };

  for (;;) {
    if (signal.aborted) {
      await finishRun();
      return;
    }
    if (maxIterations !== undefined && ++iterationCount > maxIterations) {
      await finishRun();
      return;
    }

    // Allow mid-loop updates (model swap, tool changes, etc.)
    const update = await config.prepareNextTurn?.(signal);
    if (update) {
      if (update.model) config.model = update.model;
      if (update.tools) context.tools = update.tools;
      if (update.systemPrompt !== undefined) context.systemPrompt = update.systemPrompt;
    }

    // Convert agent messages to LLM messages
    const llmMessages = await config.convertToLlm(messages);
    if (context.systemPrompt) {
      llmMessages.unshift({ role: "system", content: context.systemPrompt });
    }

    // Resolve API key
    const apiKey = await config.getApiKey?.(config.model.provider as string);

    // Build stream options
    const options: SimpleStreamOptions = {
      signal,
      ...(apiKey && { apiKey }),
      ...(config.sessionId && { sessionId: config.sessionId }),
      ...(config.onPayload && { onPayload: config.onPayload }),
      ...(config.onResponse && { onResponse: config.onResponse }),
      ...(config.transport && { transport: config.transport }),
      ...(config.maxRetryDelayMs !== undefined && { maxRetryDelayMs: config.maxRetryDelayMs }),
      ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
    };

    const tools: Tool[] = context.tools;

    // === STAGE 1: pre_stream ===
    await checkStage("pre_stream");
    if (signal.aborted) {
      await finishRun();
      return;
    }

    // Stream the assistant response
    const eventStream = streamFn(config.model, { messages: llmMessages, tools }, options);

    // === STAGE 2: streaming (intercepted via emit) ===
    let streamingStageChecked = false;
    const wrapperEmit = async (event: AgentEvent): Promise<void> => {
      if (event.type === "message_start" && !streamingStageChecked) {
        streamingStageChecked = true;
        await checkStage("streaming");
      }
      return emit(event);
    };

    const result = await collectStreamIntoMessage(eventStream, wrapperEmit, signal);

    // While paused at `streaming`, `wrapperEmit` blocks `collectStreamIntoMessage`'s
    // `for await` loop. This applies natural backpressure to the LLM stream — the
    // HTTP connection stays open and events buffer at the transport layer. For
    // pause durations under typical HTTP timeouts (~30-60s), no special handling
    // is needed. Persistent pauses here should be avoided in production.

    if (!result) {
      await finishRun();
      return;
    }

    const assistantMessage: AgentMessage = {
      role: "assistant",
      // ... existing message construction ...
    };

    await emit({ type: "message_end", message: assistantMessage });

    // === STAGE 3: post_stream ===
    await checkStage("post_stream");

    messages.push(assistantMessage);

    // If no tool calls or error, check for follow-ups then exit
    const hasToolCalls = result.toolCalls.length > 0;
    const isStop =
      result.stopReason !== "tool_use" &&
      result.stopReason !== "toolUse" &&
      result.stopReason !== "error" &&
      result.stopReason !== "aborted";

    if (isStop || !hasToolCalls) {
      // === STAGE 7: pre_followup ===
      await checkStage("pre_followup");

      // Drain follow-up queue
      const followUps = await config.getFollowUpMessages();
      if (followUps.length > 0) {
        messages.push(...followUps);
        continue;
      }

      await finishRun();
      return;
    }

    if (result.errorMessage) {
      await finishRun();
      return;
    }

    // === STAGE 4: pre_tool ===
    await checkStage("pre_tool");

    // Execute tool calls
    const toolResults = await executeToolCalls(
      result.toolCalls,
      context.tools,
      config,
      emit,
      signal,
      async () => {
        await checkStage("tool_exec");
      },
    );

    for (const tr of toolResults) {
      messages.push(tr);
    }

    await emit({ type: "turn_end", message: assistantMessage, toolResults });

    // === STAGE 6: post_tool ===
    await checkStage("post_tool");

    // === STAGE 7: pre_followup ===
    await checkStage("pre_followup");

    // Check for steering messages
    const steering = await config.getSteeringMessages();
    if (steering.length > 0) {
      messages.push(...steering);
    }

    // Check for follow-ups
    const followUps = await config.getFollowUpMessages();
    if (followUps.length > 0) {
      messages.push(...followUps);
    }
  }
}
```

The `tool_exec` checkpoint is evaluated in a serialized preflight pass before each tool promise is started. That keeps parallel tool execution from racing breakpoint waits while preserving parallel tool work after the checkpoint clears. For minimal diff, modify `executeToolCalls()` to accept an optional `onToolExec` callback:

```typescript
async function executeToolCalls(
  toolCalls: ToolCall[],
  tools: AgentTool[],
  config: AgentLoopConfig,
  emit: (event: AgentEvent) => Promise<void>,
  signal: AbortSignal,
  onToolExec?: (context: ToolExecutionContext) => Promise<void>,
): Promise<AgentMessage[]> {
  // This callback is invoked from the serialized preflight pass.
  // It runs before toolDef.execute() starts.
  if (onToolExec) {
    await onToolExec({ toolName: toolCall.name, args, toolCallId: toolCall.id });
  }
  // ... rest of execution
}
```

Then in `loop()`, pass:

```typescript
const toolResults = await executeToolCalls(
  result.toolCalls,
  context.tools,
  config,
  emit,
  signal,
  async () => {
    await checkStage("tool_exec");
  },
);
```

And add `AgentLoopConfig.beforeStage`:

```typescript
// packages/agent/src/types.ts
beforeStage?: (
  stage: BreakpointStage,
  context: AgentContext,
) => Promise<void> | void;
```

### Export changes (packages/agent/src/index.ts)

Export new types:

```typescript
export type {
  // ... existing ...
  BreakpointStage,
  Breakpoint,
  BreakpointHit,
} from "./types.js";

export { BreakpointManager } from "./breakpoint-manager.js";
```

## End-to-end flow

### Breakpoint on pre_stream

```
User: agent.setBreakpoint("pre_stream")
User: await agent.prompt("Hello")
  → runAgentLoop → loop()
  → for (;;) {
    → prepareNextTurn
    → build llmMessages
    → checkStage("pre_stream")
      → BreakpointManager.shouldPauseAt("pre_stream", context) → true
      → BreakpointManager.pause()
      → Agent.onBreakpoint({ stage: "pre_stream", context, snapshot })
    → loop waits on breakpointManager.resumeWait
      → (user inspects state via agent.state)
    → user: agent.resume()
      → BreakpointManager.resume() resolves resumeWait
    → loop continues
    → streamFn(config.model, ...)
    → ... rest of loop
  }
```

### Pause from event listener

```
User: agent.subscribe(async (event) => {
  if (event.type === "message_end" && looksSuspicious(event.message)) {
    agent.pause()
  }
})
User: await agent.prompt("Execute dangerous command")
  → loop runs
  → message_end event emitted
  → subscriber calls agent.pause()
  → BreakpointManager.pause()
  → next stage check fires at pre_tool
  → checkStage("pre_tool")
    → isPaused() → true
    → wait on resumeWait
  → loop pauses at pre_tool boundary
  → user calls agent.resume()
  → loop continues with tool execution
```

## Risks and mitigations

### Risk 1: Deadlock if `onBreakpoint` never resolves

**Problem**: If the `onBreakpoint` handler does not trigger `resume()`, the agent stays paused forever.

**Mitigation**: Document clearly that `onBreakpoint` must arrange for `resume()` to be called. Provide `pause()`/`resume()` as public API. In tests, always call `resume()` from `onBreakpoint`. Consumers can also abort via `agent.abort()` to unblock the loop.

### Risk 2: Abort during pause leaves stale state

**Problem**: If `AbortSignal` fires while the loop is blocked on `resumeWait`, the loop must exit cleanly.

**Mitigation**: `checkStage` waits on `resumeWait` and the abort signal without throwing. If abort wins the race, the loop returns through its normal `finishRun()` path so `complete` still runs before `agent_end`.

### Risk 3: Tool execution mode and partial pause

**Problem**: In parallel tool execution mode (`toolExecution === "parallel"`), pausing at `tool_exec` for one tool while others are in flight creates an inconsistent state.

**Mitigation**: The `tool_exec` checkpoint is evaluated in a serialized preflight pass before each tool promise is started. In parallel mode, the tools can still execute concurrently after they clear the gate, but only one tool can pause at the gate at a time.

### Risk 4: State snapshot correctness

**Problem**: `AgentState` is an immutable-like snapshot but `MutableAgentState` uses getters/setters that reference live arrays. Passing `this.state` directly would expose mutable references that can change after the snapshot is captured.

**Mitigation**: Implement `createStateSnapshot()` on `Agent` that returns a deep-cloned `AgentState`: copy `messages` with `messages.slice()`, copy `tools` with `tools.slice()`, and copy any other array/object fields. The `snapshot` in `BreakpointHit` must be a true point-in-time copy, not a live reference.

### Risk 5: Infinite loop if `resume()` is called before `checkStage`

**Problem**: If a subscriber calls `agent.resume()` before `checkStage` runs (e.g., during `message_end` when `pause()` was set during the previous tool call), the `isPaused()` check may be false but the `shouldPauseAt` check may still match.

**Mitigation**: In `checkStage`, always check `isPaused() || shouldPauseAt()`. If `isPaused()` is already true (from subscriber), we still go through the pause-and-wait flow. This correctly handles both entry points.

## Testing and validation

### Unit tests (packages/agent/test/)

Add `breakpoint.test.ts`:

- Unconditional breakpoint on `pre_stream` pauses before LLM call
- Unconditional breakpoint on `post_stream` pauses after `message_end`
- Conditional breakpoint fires for matching condition, skips for non-matching
- Conditional breakpoint receives correct `AgentContext` argument
- `agent.pause()` triggers pause at next boundary
- `agent.resume()` continues from pause point
- `clearBreakpoint(stage)` stops matching that stage
- `clearAllBreakpoints()` removes all breakpoints
- Subscriber calling `pause()` from `message_end` listener pauses at next stage
- `turn_end` message transcript is identical with and without breakpoints
- Parallel tool execution with breakpoints — each tool_exec check runs without race conditions
- Abort during pause emits clean `agent_end` with `stopReason: "aborted"`
- `complete` stage fires exactly once when agent finishes normally, immediately before `agent_end`

### Regression tests

- `agent-loop.test.ts` passes without modification (no breakpoints = no change)
- `agent.test.ts` passes without modification

### Manual validation

1. Set breakpoint on `pre_tool`
2. Prompt with a message that triggers a tool call
3. Verify `onBreakpoint` receives correct stage/context/snapshot
4. Resume and verify tool executes and loop completes

## Follow-ups

1. **Nested breakpoints**: Support hierarchical breakpoints that can break inside a paused handler.
2. **Breakpoint persistence**: Save/restore breakpoint configuration using `packages/db`.
3. **Dbg-adapter protocol**: Investigate protocol compliance for IDE integration.
