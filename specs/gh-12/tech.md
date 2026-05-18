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
- `listeners` (line ~195-197): `Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>` — single firehose listener set
- `subscribe()` (line ~225-240): Adds to `listeners`, returns unsubscribe function
- `processEvents()` (line ~470-530): Iterates `listeners` and awaits them in Set insertion order
- `runWithLifecycle()` (line ~420-470): Provides the `AbortSignal` to `processEvents`

## Current state

### Event flow

```
Agent processEvents(event)
  → switch(event.type) to update internal state
  → for each listener in listeners Set:
    → await listener(event, signal)
```

All listeners receive all events. The `Set` preserves insertion order.

### Listener contract

```typescript
(event: AgentEvent, signal: AbortSignal) => Promise<void> | void
```

The `subscribe()` return value removes the listener from the Set.

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
  private channels: Record<Channel, Set<ChannelListener>> = {
    lifecycle: new Set(),
    streaming: new Set(),
    tools: new Set(),
  };

  private legacyListeners = new Set<ChannelListener>();

  private static getChannel(event: AgentEvent): Channel | undefined {
    switch (event.type) {
      case "agent_end":
        return "lifecycle";
      case "message_start":
      case "message_update":
      case "message_end":
        return "streaming";
      case "tool_execution_start":
      case "tool_execution_end":
      case "turn_end":
        return "tools";
      default:
        return undefined;
    }
  }

  on(channel: Channel, listener: ChannelListener): () => void {
    this.channels[channel].add(listener);
    return () => this.channels[channel].delete(listener);
  }

  once(channel: Channel, listener: ChannelListener): () => void {
    let triggered = false;
    const wrapped: ChannelListener = async (event, signal) => {
      if (triggered) return;
      triggered = true;
      this.channels[channel].delete(wrapped);
      await listener(event, signal);
    };
    this.channels[channel].add(wrapped);
    return () => this.channels[channel].delete(wrapped);
  }

  /** Backward compatibility: subscribe to ALL events. */
  subscribeLegacy(listener: ChannelListener): () => void {
    this.legacyListeners.add(listener);
    return () => this.legacyListeners.delete(listener);
  }

  /** Remove all listeners from all channels and legacy set. */
  clear(): void {
    for (const channel of Object.values(this.channels)) {
      channel.clear();
    }
    this.legacyListeners.clear();
  }

  /** Emit an event to its channel listeners and legacy listeners. */
  async emit(event: AgentEvent, signal: AbortSignal): Promise<void> {
    const channel = EventBus.getChannel(event);
    let firstError: unknown | undefined;

    const runListeners = async (listeners: Iterable<ChannelListener>): Promise<void> => {
      for (const listener of Array.from(listeners)) {
        try {
          await listener(event, signal);
        } catch (error) {
          if (firstError === undefined) {
            firstError = error;
          }
          break;
        }
      }
    };

    if (channel) {
      await runListeners(this.channels[channel]);
    }

    await runListeners(this.legacyListeners);

    if (firstError !== undefined) {
      throw firstError;
    }
  }
}
```

This design:

- `eventBus.on(channel, listener)` → channel-specific, only receives that channel's events
- `eventBus.once(channel, listener)` → same, but auto-removes after first call
- `eventBus.subscribeLegacy(listener)` → all events (backward compat)
- `eventBus.emit(event, signal)` → routes to the matching channel first, then legacy listeners; each subscription group aborts on its first error and the first error is rethrown after both groups have been given the event

### Agent class changes (packages/agent/src/agent.ts)

**1. Add `eventBus` property:**

```typescript
class Agent {
  public readonly eventBus: EventBus;
  // Replace the existing `listeners` Set
  // private readonly listeners = new Set<...>(); // REMOVE

  constructor(options: AgentOptions = {}) {
    // ... existing ...
    this.eventBus = new EventBus();
  }
}
```

**2. Update `subscribe()` to use EventBus:**

```typescript
/**
 * Subscribe to agent lifecycle events (receives all events).
 * @deprecated Use `agent.eventBus.on(channel, listener)` for targeted subscriptions.
 */
subscribe(
  listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
): () => void {
  return this.eventBus.subscribeLegacy(listener);
}
```

**3. Update `processEvents()` to use EventBus:**

Replace the listener iteration at the bottom of `processEvents`:

```typescript
// OLD:
// for (const listener of this.listeners) {
//   try { await listener(event, signal); } catch (e) { ... }
// }

// NEW:
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
    → processEvents calls eventBus.emit(event, signal)
      → getChannel("message_start") → "streaming"
      → streamHandler(event, signal) called
      → toolHandler NOT called (different channel)
  → tool_execution_start event
    → getChannel("tool_execution_start") → "tools"
    → toolHandler called
    → streamHandler NOT called
  → agent_end event
    → getChannel("agent_end") → "lifecycle"
    → neither handler called (they subscribed to different channels)
```

### Legacy subscription

```
User: agent.subscribe(legacyHandler)
User: agent.prompt("Hello")
  → loop runs
  → any event
    → eventBus.emit routes to channel-specific listeners
    → legacyHandler is ALSO called via legacyListeners
```

## Risks and mitigations

### Risk 1: Breaking listener error semantics

**Problem**: A channel listener failure must not prevent backward-compatible `agent.subscribe()` handlers from seeing the same event, but the failure still needs to surface.

**Mitigation**: Keep channel listeners and legacy listeners in separate subscription groups. Each group aborts on its first failing listener, but `EventBus.emit()` always gives both groups a chance to observe the event and rethrows the first error after delivery completes. `agent_end` uses the same path as every other event.

### Risk 2: Memory leak from un-removed listeners

**Problem**: If consumers forget to call unsubscribe, listeners accumulate.

**Mitigation**: This is the same risk as the current `subscribe` API. No regression. Document that `once` is preferred for one-off subscriptions.

### Risk 3: Cross-channel ordering

**Problem**: With separate channel sets, the relative ordering of a `streaming` listener and a `tools` listener is undefined.

**Mitigation**: Document that channel execution order is not guaranteed. Consumers that need ordering should use `agent.subscribe()` (legacy) or subscribe to a single channel.

### Risk 4: Type narrowing for channel listeners

**Problem**: A listener on `"streaming"` channel still receives the full `AgentEvent` type, so it must narrow by `event.type` inside the handler.

**Mitigation**: This matches current patterns. Consumers can use type guards to narrow as needed.

## Testing and validation

### Unit tests (packages/agent/test/event-bus.test.ts)

- `on("streaming", fn)` receives only streaming events
- `on("tools", fn)` receives only tool events
- `on("lifecycle", fn)` receives only agent_end
- `once("streaming", fn)` fires once and unsubscribes
- `subscribeLegacy(fn)` receives all events
- Unsubscribe removes from correct channel
- Listener error aborts the current subscription group but still allows the other group to receive the same event
- Listener errors are rethrown after event delivery completes
- Empty channel emits to no channel-specific listeners
- Multiple listeners on same channel execute in order

### Regression tests

- `agent-loop.test.ts` passes without modification
- `agent.test.ts` passes without modification
- Existing `subscribe()` calls work identically

## Follow-ups

1. **Typed channel-specific events**: Refine `ChannelListener` so `on("streaming", fn)` strongly types `event` as streaming events only (requires narrowing the event type in the handler signature).
2. **Additional channels**: Consider adding `"debug"`, `"telemetry"`, or `"persistence"` channels for specialized consumers.
3. **Event buffering**: Buffer events emitted before any listeners are attached, replay on first subscription.
