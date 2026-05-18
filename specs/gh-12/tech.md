# EventBus — typed multi-channel event system - Tech Spec

## Problem

The `Agent` class stores listeners in a plain `Set` and passes every event to every listener. Subscribers that only care about specific event types must filter manually. We need to:

1. Split events into logical channels
2. Route events to only the listeners subscribed to their channel
3. Maintain backward compatibility with `Agent.subscribe()`
4. Preserve the existing sequential, promise-awaiting listener semantics

## Relevant code

### packages/agent/src/types.ts

- `AgentEvent` (line ~117-126): Union of `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`, `turn_end`, `agent_end`
- `AgentContext`, `AgentState`: Related state types

### packages/agent/src/agent.ts

- `Agent` class (line ~185-end)
- `eventBus` property: typed multi-channel listener registry
- `subscribe()` (line ~225-240): Registers wrappers on all three channels and returns a combined unsubscribe function
- `processEvents()` (line ~470-530): Updates local state, then awaits `eventBus.emit(event, signal)`
- `runWithLifecycle()` (line ~420-470): Provides the `AbortSignal` to `processEvents`

## Current state

### Event flow

```
Agent processEvents(event)
  → switch(event.type) to update internal state
  → await eventBus.emit(event, signal)
```

Each event is routed to exactly one channel. Channel listeners preserve insertion order.

### Listener contract

```typescript
(event: AgentEvent, signal: AbortSignal) => Promise<void> | void
```

`Agent.subscribe()` registers the same callback on all three channels and returns a combined unsubscribe function.

## Proposed changes

### New types (packages/agent/src/types.ts)

Add near `AgentEvent`:

```typescript
export type Channel = "lifecycle" | "streaming" | "tools";

export type ChannelListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;
```

### EventBus class (packages/agent/src/event-bus.ts)

```typescript
import type { AgentEvent, Channel, ChannelListener } from "./types.js";

export class EventBus {
  private readonly channels: Record<Channel, Set<ChannelListener>> = {
    lifecycle: new Set(),
    streaming: new Set(),
    tools: new Set(),
  };

  on(channel: Channel, listener: ChannelListener): () => void {
    this.channels[channel].add(listener);
    return () => {
      this.channels[channel].delete(listener);
    };
  }

  once(channel: Channel, listener: ChannelListener): () => void {
    const wrapped: ChannelListener = async (event, signal) => {
      try {
        await listener(event, signal);
      } finally {
        this.channels[channel].delete(wrapped);
      }
    };

    this.channels[channel].add(wrapped);
    return () => {
      this.channels[channel].delete(wrapped);
    };
  }

  async emit(event: AgentEvent, signal: AbortSignal): Promise<void> {
    const listeners = Array.from(this.channels[channelForEvent(event)]);

    for (const listener of listeners) {
      try {
        await listener(event, signal);
      } catch (error) {
        if (event.type === "agent_end") {
          console.warn(
            `[agent] listener error during agent_end: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        throw error;
      }
    }
  }
}
```

`channelForEvent(event)` routes:

- `lifecycle`: `context_trimmed`, `agent_end`
- `streaming`: `message_start`, `message_update`, `message_end`
- `tools`: `permission_needed`, `tool_execution_start`, `tool_execution_end`, `turn_end`

This design:

- `eventBus.on(channel, listener)` → channel-specific, only receives that channel's events
- `eventBus.once(channel, listener)` → same, but auto-removes after first call
- `eventBus.emit(event, signal)` → routes to the matching channel, preserves listener order, and matches existing `agent_end` error-swallowing behavior

### Agent class changes (packages/agent/src/agent.ts)

**1. Add `eventBus` property:**

```typescript
class Agent {
  public readonly eventBus: EventBus;

  constructor(options: AgentOptions = {}) {
    // ... existing ...
    this.eventBus = new EventBus();
  }
}
```

**2. Update `subscribe()` to use EventBus:**

```typescript
/**
 * Subscribe to agent lifecycle events.
 * @deprecated Use `agent.eventBus.on(channel, listener)` for targeted subscriptions.
 */
subscribe(
  listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
): () => void {
  const lifecycleListener = (event: AgentEvent, signal: AbortSignal) => listener(event, signal);
  const streamingListener = (event: AgentEvent, signal: AbortSignal) => listener(event, signal);
  const toolsListener = (event: AgentEvent, signal: AbortSignal) => listener(event, signal);

  const unsubscribeLifecycle = this.eventBus.on("lifecycle", lifecycleListener);
  const unsubscribeStreaming = this.eventBus.on("streaming", streamingListener);
  const unsubscribeTools = this.eventBus.on("tools", toolsListener);

  return () => {
    unsubscribeLifecycle();
    unsubscribeStreaming();
    unsubscribeTools();
  };
}
```

**3. Update `processEvents()` to use EventBus:**

Replace the listener iteration at the bottom of `processEvents`:

```typescript
if (!this.activeRun) {
  throw new Error("Agent listener invoked outside active run");
}

await this.eventBus.emit(event, signal);
```

### Export changes (packages/agent/src/index.ts)

```typescript
export type {
  // ... existing ...
  Channel,
  ChannelListener,
} from "./types.js";

export { EventBus } from "./event-bus.js";
```

## End-to-end flow

### Channel subscription

```
User: agent.eventBus.on("tools", toolHandler)
User: agent.eventBus.on("streaming", streamHandler)
User: agent.prompt("Hello")
  → loop runs
  → message_start event
    → streamHandler(event, signal) called
    → toolHandler NOT called (different channel)
  → tool_execution_start event
    → toolHandler called
    → streamHandler NOT called
  → agent_end event
    → lifecycle listeners run
```

### Legacy subscription

```
User: agent.subscribe(legacyHandler)
User: agent.prompt("Hello")
  → loop runs
  → any event
    → legacyHandler is registered on all three channels
    → receives each event once through the matching channel
```

## Risks and mitigations

### Risk 1: Breaking listener error semantics

**Problem**: Listener errors on `agent_end` should not mask the run completion path.

**Mitigation**: Preserve the existing `agent_end` behavior by logging and continuing after listener failures during lifecycle delivery.

### Risk 2: Memory leak from un-removed listeners

**Problem**: If consumers forget to call unsubscribe, listeners accumulate.

**Mitigation**: This is the same risk as the current `subscribe` API. No regression. Document that `once` is preferred for one-off subscriptions.

### Risk 3: Cross-channel ordering

**Problem**: With separate channel sets, the relative ordering of channel-specific listeners is undefined across channels.

**Mitigation**: Document that channel execution order is not guaranteed. Consumers that need ordering should use a single channel or `agent.subscribe()`.

### Risk 4: Type narrowing for channel listeners

**Problem**: A listener on `"streaming"` channel still receives the full `AgentEvent` type, so it must narrow by `event.type` inside the handler.

**Mitigation**: This matches current patterns. Consumers can use type guards to narrow as needed.

## Testing and validation

### Unit tests (packages/agent/test/event-bus.test.ts)

- `on("streaming", fn)` receives only streaming events
- `on("tools", fn)` receives only tool events
- `on("lifecycle", fn)` receives `context_trimmed` and `agent_end`
- `permission_needed` routes to `tools`
- `once("streaming", fn)` fires once and unsubscribes
- `agent.subscribe(fn)` receives all events via all channels
- Unsubscribe removes from correct channel
- Listener error aborts the current channel when it is not `agent_end`
- `agent_end` listener errors are logged and do not stop later lifecycle listeners
- Multiple listeners on the same channel execute in order

### Regression tests

- `agent-loop.test.ts` passes without modification
- `agent.test.ts` passes without modification
- Existing `subscribe()` calls work identically

## Follow-ups

1. **Typed channel-specific events**: Refine `ChannelListener` so `on("streaming", fn)` strongly types `event` as streaming events only.
2. **Additional channels**: Consider adding `"debug"`, `"telemetry"`, or `"persistence"` channels for specialized consumers.
3. **Event buffering**: Buffer events emitted before any listeners are attached, replay on first subscription.
