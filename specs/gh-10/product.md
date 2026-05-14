# BreakpointManager — pause/resume for agent loop stages - Product Spec

## Summary

Introduce a `BreakpointManager` that provides coarse-grained pause/resume control over the `Agent` loop at eight well-defined lifecycle stages. This enables programmatic inspection of agent state, conditional halting, and controlled stepping through multi-turn agent execution without tearing down the entire run.

## Problem

The agent loop is run-to-completion for each `prompt()` call; the only control surface is `AbortSignal`, which discards all in-flight work. There is no way for a consumer to:

- Pause execution before a tool call to inspect arguments
- Step through multi-tool-call turns one tool at a time
- Break on a specific iteration count or when a tool is invoked
- Resume a paused agent without restarting the entire session

## Goals

1. Define eight named lifecycle stages that map to the existing loop execution flow
2. Provide `agent.setBreakpoint(stage, condition?)` to register stage-level breakpoints
3. Provide `agent.pause()` to pause at the next stage boundary
4. Provide `agent.resume()` to continue from a paused state
5. Emit `onBreakpoint` callbacks with context snapshot when a breakpoint is hit
6. Zero breaking changes to existing `Agent` API behavior

## Non-goals

- Time-travel debugging (replay of previous states)
- UI integration widgets (programmatic API only)
- Persistence of breakpoints across process restarts
- Step-back or reverse execution
- Network-level proxy breakpoints (outgoing LLM requests)

## Figma / design references

Not applicable — programmatic API with no UI components.

## User experience

### Default behavior (no changes)

When no breakpoints are set, `Agent` continues its run-to-completion behavior with no latency or API changes:

```typescript
const agent = new Agent({ model: claudeModel, tools });
await agent.prompt("Hello"); // runs to completion as before
```

### Setting a breakpoint

Register a breakpoint on any of the eight supported stages:

```typescript
// Unconditional — pauses every time the stage is reached
agent.setBreakpoint("pre_tool");

// Conditional — pauses only when condition returns true
agent.setBreakpoint("pre_tool", (context) => context.tools.some((t) => t.name === "bash"));

await agent.prompt("Run a command");
// Loop pauses before executing tool calls
```

### Programmatic pause/resume

A consumer can pause and resume mid-run:

```typescript
agent.subscribe(async (event) => {
  if (event.type === "message_end") {
    const text = typeof event.message.content === "string" ? event.message.content : "...";
    if (text.includes("bash")) {
      agent.pause(); // pause at next stage boundary
    }
  }
});

await agent.prompt("...");
// Agent pauses at next relevant stage

// Later, after external review:
await agent.resume(); // continues from where it paused
```

### Breakpoint callback

When a breakpoint is hit, the consumer receives details:

```typescript
agent.onBreakpoint = (hit) => {
  console.log(`Paused at stage: ${hit.stage}`);
  console.log(`Messages in context: ${hit.context.messages.length}`);
  console.log(`Tools registered: ${hit.context.tools.length}`);
  // Optionally resume after inspection
  setTimeout(() => agent.resume(), 1000);
};
```

### Breakpoint stages

| #   | Stage          | When reached                                               |
| --- | -------------- | ---------------------------------------------------------- |
| 1   | `pre_stream`   | Before the LLM stream request is initiated                 |
| 2   | `streaming`    | First `message_start` event emitted                        |
| 3   | `post_stream`  | `message_end` event emitted                                |
| 4   | `pre_tool`     | Before `executeToolCalls` begins                           |
| 5   | `tool_exec`    | Immediately after each individual tool's `execute` starts  |
| 6   | `post_tool`    | After all tools in a turn complete (`turn_end` emitted)    |
| 7   | `pre_followup` | Before `getFollowUpMessages` / `getSteeringMessages` drain |
| 8   | `complete`     | `agent_end` event emitted                                  |

### Dual pause modes

When an agent is paused, it is in one of two pause source modes:

1. **Breakpoint pause**: caused by a registered `setBreakpoint(stage, condition?)` matching the current stage and condition, or a `pause()` call.
2. **Agent completes naturally**: an unconditional breakpoint on `complete` always fires at loop termination.

Only one pause is active at a time. Calling `pause()` when already paused is a no-op. Calling `resume()` when not paused is a no-op.

### Clearing breakpoints

```typescript
agent.clearBreakpoint("pre_tool"); // remove breakpoint for a stage
agent.clearAllBreakpoints(); // remove all breakpoints
```

### Error during pause

If the abort signal fires while paused, the loop terminates cleanly with `agent_end` carrying the reason `"aborted"`.

## Success criteria

### Core functionality

1. All eight stages are identifiable and reachable in a normal loop
2. `setBreakpoint(stage)` without condition pauses unconditionally
3. `setBreakpoint(stage, condition)` pauses only when condition returns true
4. `pause()` can pause at the next stage boundary from event listeners
5. `resume()` continues execution from the exact point of pause
6. Breakpoint hit data includes stage name, context snapshot, and state snapshot
7. `clearBreakpoint(stage)` removes a specific stage's breakpoint
8. `clearAllBreakpoints()` removes all registered breakpoints

### State correctness

9. Pausing does not corrupt the message transcript
10. Pausing does not drop or duplicate events
11. Resume restores the exact `messages` array at the point of pause
12. Tool call IDs remain consistent across a pause/resume boundary

### API contracts

13. `agent.subscribe()` still works identically during breakpoint usage
14. No new required constructor options — breakpoints are opt-in
15. Breakpoint callbacks receive a clean `AgentContext` snapshot

### Edge cases

16. Multiple listeners subscribing to `onBreakpoint` receive the same hit data
17. Setting a breakpoint on an already-paused stage does not trigger until next iteration
18. Aborting while paused produces clean `agent_end` — no dangling state
19. Calling `pause()` inside `agent_end` listener is a no-op (loop already done)
20. Conditional breakpoints receive the current tool list and messages at evaluation time

## Validation

### Unit / integration tests

- Unconditional breakpoint on `pre_stream` pauses before LLM request
- Unconditional breakpoint on `post_stream` pauses after `message_end`
- Unconditional breakpoint on `pre_tool` pauses before tool execution batch
- Unconditional breakpoint on `tool_exec` pauses before each individual tool runs
- Unconditional breakpoint on `complete` fires exactly once per run
- Conditional breakpoint only fires when condition returns true
- `pause()` called from subscriber halts at next boundary
- `resume()` resumes from exact pause point with correct message transcript
- `clearBreakpoint(stage)` stops matching that stage
- `clearAllBreakpoints()` stops all matching
- Abort during pause terminates cleanly
- No duplicate events after resume

### Manual validation

1. Create agent with a breakpoint on `pre_tool`
2. Prompt with a message that triggers a tool call
3. Verify loop pauses before tool execution
4. Inspect `onBreakpoint` context — verify messages/tools arrays match expected
5. `resume()` — verify tool executes and loop completes
6. Repeat with conditional breakpoint that uses message position to skip some hits

### Regression testing

- Existing `agent-loop.test.ts` passes without modification
- Existing `agent.test.ts` passes without modification
- Agent without breakpoints behaves identically to pre-feature baseline

## Open questions

1. **Should `tool_exec` stage pause once per batch or once per tool?** The issue says `"tool_execution_start" / "tool_execution_end"` which implies per-tool. The proposed design is per-tool (one pause per individual tool call).

2. **Thread-safety of `pause()`/`resume()`**: Is calling `pause()` from an event listener (which is awaited synchronously) sufficiently safe, or should pause/resume be Promise-based to support async breakpoint handlers?

3. **Should pre_stream have access to the prepared LLM request payload?** The context at `pre_stream` is the `AgentContext` before conversion. Should we also expose the computed `llmMessages` (after convertToLlm + system prompt prep) for richer conditional logic?

4. **What is the expected behavior if a subscriber's listener throws when pause is triggered?** Should the pause still happen, or should the error propagate and abort? (Current design: error propagates and aborts.)
