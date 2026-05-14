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

export type ChannelEvent = {
  lifecycle: Extract<AgentEvent, { type: "agent_end" }>;
  streaming: Extract<AgentEvent, { type: "message_start" | "message_update" | "message_end" }>;
  tools: Extract<AgentEvent, { type: "tool_execution_start" | "tool_execution_end" | "turn_end" }>;
};

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

  private static route(event: AgentEvent): Channel | undefined {
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
    const wrapped: ChannelListener = (event, signal) => {
      this.channels[channel].delete(wrapped);
      return listener(event, signal);
    };
    this.channels[channel].add(wrapped);
    return () => this.channels[channel].delete(wrapped);
  }

  async emit(event: AgentEvent, signal: AbortSignal): Promise<void> {
    const channel = EventBus.route(event);
    if (!channel) return;

    const listeners = Array.from(this.channels[channel]);
    // Also emit to legacy "all" subscribers
    for (const listener of listeners) {
      await listener(event, signal);
    }
  }

  /** Emit to all legacy subscribers (cross-channel). Used by Agent.subscribe(). */
  private legacyListeners = new Set<ChannelListener>();

  addLegacyListener(listener: ChannelListener): () => void {
    this.legacyListeners.add(listener);
    return () => this.legacyListeners.delete(listener);
  }

  /** Emit to all listeners: channel-targeted + legacy. */
  async emitAll(event: AgentEvent, signal: AbortSignal): Promise<void> {
    await this.emit(event, signal);
    for (const listener of Array.from(this.legacyListeners)) {
      await listener(event, signal);
    }
  }
}
```

Wait — this design has `emit` for channel-only and `emitAll` for channel + legacy. But the legacy subscribers also need events. The current `processEvents` calls listeners for every event. If we split into `emit` (channel) and `emitAll` (channel + legacy), we should always use `emitAll` in `processEvents` to preserve backward compatibility.

Cleaner design: Always emit to both. The `EventBus.emit()` handles routing to the channel AND to legacy subscribers. The `Agent.subscribe` adds to legacy listeners.

Actually, rethinking: The issue specifies backward compatibility as marking `subscribe` deprecated but functional. So `subscribe` should still work exactly like before, while `eventBus.on` is the new way.

```typescript
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

    // Emit to channel-specific subscribers
    if (channel) {
      for (const listener of Array.from(this.channels[channel])) {
        await listener(event, signal);
      }
    }

    // Emit to legacy subscribers (all events)
    for (const listener of Array.from(this.legacyListeners)) {
      await listener(event, signal);
    }
  }
}
```

This design:

- `eventBus.on(channel, listener)` → channel-specific, only receives that channel's events
- `eventBus.once(channel, listener)` → same, but auto-removes after first call
- `eventBus.subscribeLegacy(listener)` → all events (backward compat)
- `eventBus.emit(event, signal)` → routes to channel + legacy

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
await this.eventBus.emit(event, signal);
```

Wait — but we need to preserve the error handling behavior. Currently `processEvents` swallows listener errors during `agent_end` but throws otherwise. If `EventBus.emit` just awaits listeners, the error handling must either be in `emit` or in `processEvents`.

Better: keep the current error handling pattern but wrap the `emit` call:

```typescript
// In processEvents, after the switch statement:
if (!this.activeRun) {
  throw new Error("Agent listener invoked outside active run");
}

try {
  await this.eventBus.emit(event, signal);
} catch (e) {
  // Swallow listener errors during agent_end
  if (event.type !== "agent_end") {
    throw e;
  }
  console.warn(
    `[agent] listener error during agent_end: ${e instanceof Error ? e.message : String(e)}`,
  );
}
```

Actually, rethinking: The current error-swallow behavior is specific to `agent_end`. If `EventBus.emit` throws a listener error, we need to catch it at the Agent level during `agent_end` but rethrow it otherwise. Moving the catch from `processEvents` into `EventBus.emit` would change behavior (the error would never propagate). So the catch stays in `processEvents`.

But `EventBus.emit` just awaits listeners. If a listener throws, `emit` throws. Then `processEvents` catches it during `agent_end` and rethrows otherwise. This preserves existing behavior.

However, there's one issue: currently the error is caught per-listener in `processEvents` (the inner try/catch is inside the loop). If we move to `EventBus.emit`, we need to decide: does `emit` catch per-listener or let the first thrown error abort?

The current code:

```typescript
for (const listener of this.listeners) {
  try {
    await listener(event, signal);
  } catch (e) {
    if (event.type !== "agent_end") throw e;
    console.warn(...);
  }
}
```

So each listener's error is caught individually during `agent_end`. Other listeners still run. With `EventBus.emit`, if we let the first error abort, we lose this behavior.

**Solution**: `EventBus.emit` should catch per-listener and aggregate errors (or just log and continue during `agent_end`). But `EventBus.emit` doesn't know about `agent_end`.

Simpler approach: keep the error handling pattern in the emitter but pass an error handler:

```typescript
// EventBus.emit signature changes:
async emit(
  event: AgentEvent,
  signal: AbortSignal,
  options?: { onError?: (error: unknown, listener: ChannelListener) => void },
): Promise<void> { ... }
```

No, that's overcomplicating. The simplest correct design: `EventBus.emit` should NOT catch errors. The caller (`processEvents`) wraps the whole emit with a try/catch. During `agent_end`, the catch logs and swallows. For other events, the catch rethrows (which is the default if you don't catch). But then a listener error during non-agent_end would abort emission and not run subsequent listeners. That actually matches the CURRENT behavior for non-agent_end events — wait, let me re-read:

```typescript
for (const listener of this.listeners) {
  try {
    await listener(event, signal);
  } catch (e) {
    if (event.type !== "agent_end") { throw e; }
    console.warn(...);
  }
}
```

For non-agent_end events, if a listener throws, `throw e` exits the for loop and aborts the emission. Subsequent listeners do NOT run. For agent_end, the error is logged and the for loop continues to the next listener.

So with `EventBus.emit`, we need:

- Non-agent_end: first thrown error aborts, no further listeners
- agent_end: per-listener catch, continue to next listener

To preserve this exactly, we'd need `emit` to take an option about error handling or the caller to implement the pattern.

Simpler: `EventBus.emit` iterates listeners and throws on first error. The `agent_end` special case is handled by `processEvents` calling emit differently.

Actually, the simplest and cleanest approach:

```typescript
// EventBus.emit: standard behavior - throws on first error
async emit(event: AgentEvent, signal: AbortSignal): Promise<void> {
  const channel = EventBus.getChannel(event);
  if (channel) {
    for (const listener of Array.from(this.channels[channel])) {
      await listener(event, signal);
    }
  }
  for (const listener of Array.from(this.legacyListeners)) {
    await listener(event, signal);
  }
}

// In Agent.processEvents, use a wrapper:
private async emitEvent(event: AgentEvent, signal: AbortSignal): Promise<void> {
  if (event.type === "agent_end") {
    try {
      await this.eventBus.emit(event, signal);
    } catch (e) {
      console.warn(`[agent] listener error during agent_end: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    await this.eventBus.emit(event, signal);
  }
}
```

Wait, this changes behavior for `agent_end`. Currently, errors in individual listeners are caught and the loop continues. With the wrapper above, if `emit` throws on the FIRST listener error during `agent_end`, that listener's error aborts all remaining listeners. That's a breaking change.

**The fix**: `EventBus.emit` should handle the agent_end case internally. It should know about allowing errors to be swallowed? No, EventBus shouldn't know about agent semantics.

**Better fix**: Make `EventBus.emit` take an error mode:

```typescript
async emit(
  event: AgentEvent,
  signal: AbortSignal,
  errorMode: "throw" | "log-and-continue" = "throw",
): Promise<void> {
  // channel listeners
  if (channel) {
    for (const listener of Array.from(this.channels[channel])) {
      try {
        await listener(event, signal);
      } catch (e) {
        if (errorMode === "throw") throw e;
        // log
      }
    }
  }
  // legacy listeners
  for (const listener of Array.from(this.legacyListeners)) {
    try {
      await listener(event, signal);
    } catch (e) {
      if (errorMode === "throw") throw e;
      // log
    }
  }
}
```

Then in `processEvents`:

```typescript
if (event.type === "agent_end") {
  await this.eventBus.emit(event, signal, "log-and-continue");
} else {
  await this.eventBus.emit(event, signal, "throw");
}
```

This preserves exact behavior.

### Export changes (packages/agent/src/index.ts)

```typescript
export type {
  // ... existing ...
  Channel,
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
    → eventBus.emit adds event to channel-specific set
    → legacyHandler is ALSO called via legacyListeners
```

## Risks and mitigations

### Risk 1: Breaking listener error semantics

**Problem**: The existing per-listener error handling for `agent_end` must be preserved.

**Mitigation**: Add `errorMode` to `EventBus.emit` as described above. `agent_end` uses `"log-and-continue"`, all other events use `"throw"`. This matches the current behavior exactly.

### Risk 2: Memory leak from un-removed listeners

**Problem**: If consumers forget to call unsubscribe, listeners accumulate.

**Mitigation**: This is the same risk as the current `subscribe` API. No regression. Document that `once` is preferred for one-off subscriptions.

### Risk 3: Cross-channel ordering

**Problem**: With separate channel sets, the relative ordering of a `streaming` listener and a `tools` listener is undefined.

**Mitigation**: Document that channel execution order is not guaranteed. Consumers that need ordering should use `agent.subscribe()` (legacy) or subscribe to a single channel.

### Risk 4: Type narrowing for channel listeners

**Problem**: A listener on `"streaming"` channel still receives the full `AgentEvent` type, so it must narrow by `event.type` inside the handler.

**Mitigation**: This matches current patterns. The `ChannelEvent` type provides inference if we change the signature, but for backward compat with existing handler patterns, keeping `AgentEvent` as the parameter type is simpler.

## Testing and validation

### Unit tests (packages/agent/test/event-bus.test.ts)

- `on("streaming", fn)` receives only streaming events
- `on("tools", fn)` receives only tool events
- `on("lifecycle", fn)` receives only agent_end
- `once("streaming", fn)` fires once and unsubscribes
- `subscribeLegacy(fn)` receives all events
- Unsubscribe removes from correct channel
- Listener error in `throw` mode aborts emission
- Listener error in `log-and-continue` mode continues emission
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
