# EventBus — typed multi-channel event system - Product Spec

## Summary

Replace the single-listener firehose with a typed `EventBus` that organizes `AgentEvent`s into logical channels (lifecycle, streaming, tools). This allows consumers to subscribe selectively, reduces unnecessary event processing, and improves separation of concerns.

## Problem

The current `Agent.subscribe(listener)` API delivers every event to every listener. A UI component that only cares about streaming text deltas/updates, a telemetry exporter that only wants tool events, and a persistence handler that only wants `agent_end` all process every event type, leading to noisy filtering logic and wasted CPU.

## Goals

1. Define three event channels: `lifecycle`, `streaming`, `tools`
2. Map each `AgentEvent` type to exactly one channel
3. Provide `eventBus.on(channel, listener)` and `eventBus.once(channel, listener)` APIs
4. Maintain backward compatibility: `agent.subscribe(listener)` still works (maps to all channels)
5. Mark `Agent.subscribe` as deprecated in favor of `eventBus.on`
6. Preserve the existing synchronous-in-order listener execution semantics
7. Zero breaking changes to `Agent` behavior

## Non-goals

- Persistent event log or event replay
- Cross-agent event broadcasting
- Named channels beyond the three defined ones
- Dynamic channel creation at runtime
- Changing the `AgentEvent` type definitions (only routing changes)

## Figma / design references

Not applicable — programmatic API with no UI components.

## User experience

### Default behavior (no changes)

Existing code continues to work:

```typescript
const agent = new Agent({ model: claudeModel, tools });

// Still works, subscribes to all events
agent.subscribe(async (event, signal) => {
  console.log(event.type);
});
```

### Channel-based subscription

Subscribe to individual channels:

```typescript
const agent = new Agent({ model: claudeModel, tools });

// Only streaming events
agent.eventBus.on("streaming", async (event) => {
  switch (event.type) {
    case "message_start":
      showSpinner(true);
      break;
    case "message_update":
      appendText(event.message.content);
      break;
    case "message_end":
      showSpinner(false);
      finalizeText(event.message);
      break;
  }
});

// Only tool events
agent.eventBus.on("tools", async (event) => {
  switch (event.type) {
    case "tool_execution_start":
      markToolPending(event.toolCallId);
      break;
    case "tool_execution_end":
      markToolDone(event.toolCallId);
      break;
    case "turn_end":
      recordToolResults(event.toolResults);
      break;
  }
});

// Only lifecycle events
agent.eventBus.on("lifecycle", async (event) => {
  switch (event.type) {
    case "agent_end":
      saveSession();
      break;
  }
});
```

### One-shot subscription

```typescript
// Unsubscribe automatically after first event
agent.eventBus.once("streaming", (event) => {
  console.log("First streaming event:", event.type);
});
```

### Channel event mapping

| Channel     | Event Types                                              |
| ----------- | -------------------------------------------------------- |
| `lifecycle` | `agent_end`                                              |
| `streaming` | `message_start`, `message_update`, `message_end`         |
| `tools`     | `tool_execution_start`, `tool_execution_end`, `turn_end` |

### Subscribing to all events (backward compatibility)

`agent.subscribe()` is a convenience that internally delegates to all three channels:

```typescript
// These two are equivalent:
agent.subscribe((event, signal) => { ... });

agent.eventBus.on("lifecycle", (event, signal) => { ... });
agent.eventBus.on("streaming", (event, signal) => { ... });
agent.eventBus.on("tools", (event, signal) => { ... });
```

### Unsubscribing

```typescript
const unsubscribe = agent.eventBus.on("streaming", handler);
// Later:
unsubscribe();
```

The returned function removes the listener from only that channel.

## Success criteria

### Core routing

1. Every `AgentEvent` is emitted through exactly one channel
2. `eventBus.on(channel, listener)` adds a listener only to that channel
3. `eventBus.once(channel, listener)` removes the listener after first event
4. `eventBus.emit(event)` routes the event to the correct channel's listeners
5. `agent.subscribe(listener)` still works and receives all events
6. Unsubscribe function returned by `on`/`once` removes only that listener

### Execution semantics

7. Listeners within a channel execute in subscription order
8. All listener promises are awaited sequentially within each channel
9. Cross-channel ordering is not guaranteed (channels may execute in parallel or sequence)
10. AbortSignal is passed to all listeners (backward compatible with `subscribe` signature)

### Types and API

11. Channel names are typed as a literal union (`"lifecycle" | "streaming" | "tools"`)
12. Listener type is `AgentEvent` for all channels (subscribers refine by event.type)
13. No new required constructor options

### Edge cases

14. Subscribing after a run starts receives subsequent events on that channel
15. Unsubscribing during event emission does not affect the current emission
16. Listener that throws aborts the current subscription group, but other subscription groups still receive the same event
17. No-op unsubscribe if listener was already removed
18. `once` listener unsubscribes itself after its first invocation completes

## Validation

### Unit tests (packages/agent/test/)

Add `event-bus.test.ts`:

- Event routes to correct channel based on its type
- `on` adds listener to specified channel only
- `once` adds listener that fires once then removes itself
- `subscribe` adds listener to all three channels
- Listeners execute in subscription order per channel
- Unsubscribe removes only the specified listener
- Unsubscribe of non-existent listener is a no-op
- Listener exceptions abort the current subscription group without blocking legacy `agent.subscribe()` listeners
- `agent_end` routes to `lifecycle` channel
- `message_start`/`message_update`/`message_end` route to `streaming` channel
- `tool_execution_start`/`tool_execution_end`/`turn_end` route to `tools` channel
- Backward compatible: `agent.subscribe()` receives all events correctly

### Integration tests

- Agent with channel subscriptions completes a full turn correctly
- Multiple channel subscribers and legacy subscribers coexist without interference

### Regression tests

- `agent-loop.test.ts` passes without modification
- `agent.test.ts` passes without modification
- Existing `subscribe()` calls work identically

### Manual validation

1. Create agent with subscribers on all three channels + a general `subscribe`
2. Run a prompt that triggers a tool call
3. Verify each channel subscriber receives only its mapped events
4. Verify general subscriber receives all events
5. Verify unsubscribe works correctly

## Open questions

1. **Should channels execute in parallel or sequence?** Sequential per-channel is simpler and matches current behavior. Parallel could improve throughput but risks ordering issues for stateful listeners.

2. **Should the `turn_end` event be split between tools and streaming?** Currently `turn_end` contains both the assistant message and tool results. It is mapped to `tools` since tool results are primary, but the assistant message is secondary.

3. **Should we add a `"debug"` channel for future extensibility?** This would make adding channels easier but introduces a catch-all that re-creates the firehose problem.

4. **What is the unsubscribe behavior during emission?** If listener A unsubscribes listener B during emission, should B still receive the current event? (Standard pattern: yes, since the listener collection was snapshotted at emission start.)
