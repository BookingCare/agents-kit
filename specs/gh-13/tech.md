# PermissionManager — centralized tool permission system - Tech Spec

## Problem

Tool permissions are currently handled ad-hoc via the `beforeToolCall` hook. There is no centralized rule system, no scope-based restrictions, and no persistent policy. We need to:

1. Define a rule-based permission system with allow/deny/ask actions
2. Integrate it before the existing `beforeToolCall` hook in the tool execution flow
3. Support scoped rules (path prefixes, command substrings)
4. Emit a `permission_needed` event for the `ask` action

## Relevant code

### packages/agent/src/types.ts

- `BeforeToolCallContext` (line ~80-83): `{ toolName, args, toolCallId }`
- `BeforeToolCallResult` (line ~85-91): `{ action: "continue" } | { action: "skip"; result? } | { action: "replace"; args }`
- `AgentTool` (line ~100-112): Tool definition with `execute()` method
- `AgentLoopConfig` (line ~86-112): Contains `beforeToolCall` hook
- `AgentEvent` (line ~117-126): Event types — may need `permission_needed`

### packages/agent/src/agent-loop.ts

- `executeToolCalls()` (line ~315-420): Tool dispatch function
- Line ~360-380: `beforeToolCall` hook invocation
- Line ~395-405: Tool execution block

### packages/agent/src/agent.ts

- `Agent` class (line ~185-end)
- `beforeToolCall` property (line ~210-215): Configurable hook
- `processEvents()` (line ~470-530): Event emission

## Current state

### Tool execution flow

```
executeToolCalls(toolCalls, tools, config, emit, signal)
  → for each toolCall:
    → parse args from JSON
    → if config.beforeToolCall:
      → call beforeToolCall(context, signal)
      → handle return: skip → return ToolResult immediately
      → handle return: replace → update args
      → handle return: continue → proceed
    → emit tool_execution_start
    → find toolDef
    → execute toolDef.execute()
    → emit tool_execution_end
    → build ToolResult message
```

The `beforeToolCall` hook is currently the only permission gate.

## Proposed changes

### New types (packages/agent/src/types.ts)

Add below `AfterToolCallResult`:

```typescript
export interface PermissionScope {
  paths?: string[];
  commands?: string[];
}

export interface PermissionRule {
  tool: string;
  action: "allow" | "deny" | "ask";
  scope?: PermissionScope;
}

export interface PermissionDecision {
  action: "allow" | "deny" | "ask";
  rule: PermissionRule;
}

export type PermissionResolver = (decision: "allow" | "deny") => void;

export interface PermissionNeededEvent {
  type: "permission_needed";
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
  rule: PermissionRule;
  resolve: PermissionResolver;
}
```

### PermissionManager class (packages/agent/src/permission-manager.ts)

```typescript
import type { PermissionRule, PermissionDecision, PermissionScope } from "./types.js";

export const DEFAULT_RULES: PermissionRule[] = [
  { tool: "read_file", action: "allow" },
  { tool: "bash", action: "ask" },
  { tool: "write_file", action: "ask" },
  { tool: "edit_file", action: "ask" },
  { tool: "*", action: "deny" },
];

export class PermissionManager {
  private rules: PermissionRule[] = [...DEFAULT_RULES];

  grant(rule: PermissionRule): void {
    // Remove any existing rule for the exact same tool (no-scope comparison)
    const existingIdx = this.rules.findIndex((r) => r.tool === rule.tool);
    if (existingIdx !== -1) {
      // Don't remove — append and let last-match win
      // This allows overlapping rules (scoped vs unscoped)
    }
    this.rules.push(rule);
  }

  revoke(tool: string): void {
    this.rules = this.rules.filter((r) => r.tool !== tool);
  }

  listRules(): readonly PermissionRule[] {
    return this.rules.slice();
  }

  evaluate(toolName: string, args: Record<string, unknown>): PermissionDecision {
    // Evaluate in reverse order (last match wins)
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i];
      if (rule.tool !== toolName && rule.tool !== "*") continue;
      if (rule.scope && !this.matchesScope(rule.scope, args)) continue;
      return { action: rule.action, rule };
    }

    // Fallback to deny via wildcard
    const wildcard = this.rules.find((r) => r.tool === "*");
    if (wildcard) {
      return { action: wildcard.action, rule: wildcard };
    }

    // Ultimate fallback
    return { action: "deny", rule: { tool: "*", action: "deny" } };
  }

  private matchesScope(scope: PermissionScope, args: Record<string, unknown>): boolean {
    if (scope.paths && typeof args.path === "string") {
      if (scope.paths.some((p) => (args.path as string).startsWith(p))) {
        return true;
      }
    }
    if (scope.commands && typeof args.command === "string") {
      if (scope.commands.some((c) => (args.command as string).includes(c))) {
        return true;
      }
    }
    return false;
  }
}
```

**Note**: Scope matching is inclusive (rule matches if scope matches). This means a `deny` with `paths: ["/etc"]` denies anything under `/etc`. If we need an `allow` with a more specific path to override, the more specific `allow` must be added after the broad `deny` (i.e., later in the list) so last-match wins.

### Agent loop integration (packages/agent/src/agent-loop.ts)

Modify `executeToolCalls` to run permission check before `beforeToolCall`.

The permission check needs access to the `PermissionManager` from `AgentLoopConfig`. Add to config:

```typescript
// packages/agent/src/types.ts in AgentLoopConfig
permissionManager?: PermissionManager;
```

Then modify the execute function in `executeToolCalls`:

```typescript
async function executeToolCalls(
  toolCalls: ToolCall[],
  tools: AgentTool[],
  config: AgentLoopConfig,
  emit: (event: AgentEvent) => Promise<void>,
  signal: AbortSignal,
): Promise<AgentMessage[]> {
  // ... existing setup ...

  const execute = async (toolCall: ToolCall): Promise<AgentMessage | null> => {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.arguments) as Record<string, unknown>;
    } catch (e) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        isError: true,
        timestamp: Date.now(),
      };
    }

    // === Permission check (runs BEFORE beforeToolCall) ===
    if (config.permissionManager) {
      const decision = config.permissionManager.evaluate(toolCall.name, args);

      if (decision.action === "deny") {
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: `Permission denied by rule: ${decision.rule.tool}` }],
          isError: true,
          timestamp: Date.now(),
        };
      }

      if (decision.action === "ask") {
        // Emit permission_needed event and wait
        const { promise, resolve } = createResolvable<"allow" | "deny">();

        await emit({
          type: "permission_needed",
          toolName: toolCall.name,
          args,
          toolCallId: toolCall.id,
          rule: decision.rule,
          resolve,
        } as AgentEvent);

        const answer = await promise;
        if (answer === "deny") {
          return {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: "Permission denied by user." }],
            isError: true,
            timestamp: Date.now(),
          };
        }
        // allow → continue to execution
      }
    }

    // === Existing beforeToolCall hook ===
    if (config.beforeToolCall) {
      const before = await config.beforeToolCall(
        { toolName: toolCall.name, args, toolCallId: toolCall.id },
        signal,
      );
      // ... existing skip/replace/continue handling ...
    }

    // ... rest of existing execution ...
  };

  // ... rest of existing parallel/sequential dispatch ...
}
```

Wait — `AgentEvent` union does not include `permission_needed`. We need to add it. But `emit()` expects an `AgentEvent`. Let me add it to the union.

Actually, the issue with the `emit` of `permission_needed` is that it requires `await emit({ type: "permission_needed", ... })` inside `executeToolCalls`, which is inside the loop. But the loop's `emit` function goes to `processEvents` in Agent, which then calls listeners. If listeners are supposed to call `resolve()`, they can do so synchronously.

However, there's a problem: `emit` is async and awaited. If `emit({ type: "permission_needed" })` is awaited, then the listener has the opportunity to call `resolve()`. BUT — the listener is async, and if it awaits something (like a dialog), the `emit` call won't complete until the listener's promise resolves. In that case, the listener should call `resolve()` inside its own async body, and the `await emit()` will only complete after all listeners complete.

Wait, no. The pattern needs to be:

```typescript
// In the agent loop (executeToolCalls):
const deferred = createDeferred<"allow" | "deny">();
await emit({
  type: "permission_needed",
  toolName: "...",
  resolve: deferred.resolve,
});
// But await emit() awaits ALL listeners
// If a listener opens a dialog and delays, then resolve() won't be called until user responds
// And emit() won't return until that listener finishes
// So the flow blocks until the listener resolves
```

This is actually correct! The listener handles the dialog asynchronously and calls `resolve()` when done. The `await emit()` blocks until all listeners finish. Since the permission-needed listener is awaiting the dialog, the whole tool execution is suspended until the user responds.

But what if no listener handles the event? Then `emit()` returns immediately (no listeners), `deferred.resolve` is never called, and `await promise` blocks forever.

**Solution**: Add a timeout or default behavior in `executeToolCalls`:

```typescript
// Race between user resolution and a timeout
const answer = await Promise.race([
  promise,
  new Promise<"deny">((_, reject) => {
    setTimeout(() => reject(new Error("Permission timeout")), 30000);
  }),
]).catch(() => "deny" as const);
```

Or simpler: use a default deny if no one resolves within a reasonable time.

Actually, for the initial implementation, let's make it simpler: the event's `resolve` callback must be called by a listener. If it's not called, the execution stays blocked. This matches the issue's requirement that UIs handle the `ask` flow. We can document this clearly.

For safety, we can add an optional timeout parameter:

```typescript
export interface PermissionManagerOptions {
  defaultRules?: PermissionRule[];
  askTimeoutMs?: number; // default: 30000
}
```

Let me revise the permission event to use a promise-based pattern:

```typescript
export interface PermissionNeededEvent {
  type: "permission_needed";
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
  rule: PermissionRule;
  resolve: (decision: "allow" | "deny") => void;
}
```

And the usage:

```typescript
// In agent.ts subscribe handler
agent.subscribe(async (event) => {
  if (event.type === "permission_needed") {
    const userResponse = await showDialog(event.toolName, event.args);
    event.resolve(userResponse); // "allow" or "deny"
  }
});
```

This is clean. The listener is responsible for calling `resolve()`. The `emit()` call waits for the listener to finish, which means if the listener opens a dialog, `emit()` blocks until the dialog resolves. The tool execution is naturally suspended.

But what if there are multiple listeners and one of them is NOT the permission handler? That listener will run and complete quickly, but the permission handler listener might be slow. `emit()` awaits all listeners in order. If the permission handler is the second listener, the first one must complete before the second runs. That's fine — but the timeout issue remains if there are no permission handlers.

**A cleaner architecture**: Make the resolve accessible before emitting:

```typescript
let resolvePermission: ((decision: "allow" | "deny") => void) | undefined;
const permissionPromise = new Promise<"allow" | "deny">((resolve) => {
  resolvePermission = resolve;
});

await emit({
  type: "permission_needed",
  toolName: "...",
  resolve: resolvePermission!,
});

const answer = await Promise.race([
  permissionPromise,
  new Promise<"deny">((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000)),
]).catch(() => "deny" as const);
```

This is robust. The listener receives the `resolve` function. If at least one listener calls it, the promise resolves. If no one calls it within 30s, the tool is denied.

Let's go with this approach. It's safer and doesn't rely on listener completion timing.

### `createDeferred` utility (packages/agent/src/utils/deferred.ts or inline)

```typescript
export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
```

### Updating AgentEvent union (packages/agent/src/types.ts)

Update `AgentEvent` to include `PermissionNeededEvent`:

```typescript
export type AgentEvent =
  | { type: "message_start"; message: StreamingAssistantMessage }
  | { type: "message_update"; message: StreamingAssistantMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string }
  | { type: "tool_execution_end"; toolCallId: string }
  | { type: "turn_end"; message: AgentMessage; toolResults: AgentMessage[] }
  | { type: "agent_end"; messages: AgentMessage[] }
  | PermissionNeededEvent;
```

Also add a `ContextTrimmedEvent` if it was added for #11. If not done yet, we need to handle both.

### Agent class changes (packages/agent/src/agent.ts)

**1. Add `permissionManager` to `AgentOptions`:**

```typescript
export interface AgentOptions {
  // ... existing ...
  permissionManager?: PermissionManager;
}
```

**2. Add property and pass to loop config:**

```typescript
class Agent {
  public permissionManager?: PermissionManager;
  // ...
  constructor(options: AgentOptions = {}) {
    // ...
    this.permissionManager = options.permissionManager;
  }
}
```

**3. Pass to loop config:**

```typescript
private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
  // ... existing ...
  return {
    // ... existing fields ...
    permissionManager: this.permissionManager,
  };
}
```

**4. Handle `permission_needed` in `processEvents()`:**

No internal state needs updating for `permission_needed`. It falls through to listeners just like any other event. The switch needs an explicit case or default:

```typescript
case "permission_needed":
  break;
```

### Export changes (packages/agent/src/index.ts)

```typescript
export type {
  // ... existing ...
  PermissionRule,
  PermissionDecision,
  PermissionScope,
} from "./types.js";

export { PermissionManager, DEFAULT_RULES } from "./permission-manager.js";
```

## End-to-end flow

### Allow decision

```
Agent: executes tool "read_file" with args { path: "foo.txt" }
  → executeToolCalls
    → parse args
    → permissionManager.evaluate("read_file", { path: "foo.txt" })
      → matches DEFAULT_RULES[0]: { tool: "read_file", action: "allow" }
      → returns { action: "allow" }
    → proceed to beforeToolCall (if configured)
    → emit tool_execution_start
    → execute tool
    → emit tool_execution_end
    → return tool result
```

### Deny decision

```
Agent: executes tool "bash" with args { command: "rm -rf /" }
  → executeToolCalls
    → parse args
    → permissionManager.evaluate("bash", { command: "rm -rf /" })
      → matches DEFAULT_RULES[1]: { tool: "bash", action: "ask" }
      → returns { action: "ask" }
    → emit permission_needed event
    → no listener resolves (or timeout)
    → auto-deny after timeout
    → returns error ToolResult: "Permission denied."
```

### Ask decision resolved by listener

```
Agent: executes tool "write_file" with args { path: "src/app.ts" }
  → executeToolCalls
    → parse args
    → permissionManager.evaluate("write_file", { path: "src/app.ts" })
      → matches DEFAULT_RULES[2]: { tool: "write_file", action: "ask" }
      → returns { action: "ask" }
    → emit permission_needed event with resolve fn
    → listener receives event, shows dialog
    → user clicks "Allow"
    → listener calls event.resolve("allow")
    → permissionPromise resolves to "allow"
    → proceed to beforeToolCall
    → execute tool
```

## Risks and mitigations

### Risk 1: Deadlock if no listener resolves ask

**Problem**: If no subscriber handles `permission_needed`, the execution blocks forever.

**Mitigation**: Implement a `Promise.race` with a `setTimeout` (default 30s, configurable). Auto-deny if no resolution within timeout. Document clearly that consumers must implement a handler.

### Risk 2: beforeToolCall bypass permissions

**Problem**: A custom `beforeToolCall` that returns `replace` with malicious args could circumvent a denied permission.

**Mitigation**: Permission check runs BEFORE `beforeToolCall`. `deny` short-circuits immediately. `allow` passes through to `beforeToolCall`. `ask` with resolve("allow") also passes through. The existing `beforeToolCall` semantics remain unchanged.

### Risk 3: Scope matching on non-string args

**Problem**: `scope.paths` and `scope.commands` assume `args.path` and `args.command` are strings. A tool might pass arrays or objects.

**Mitigation**: Scope matching checks `typeof` before comparing. Non-string args fail scope matching, and the rule's action only applies when scope matches. For non-string args, the next rule (or wildcard) applies.

### Risk 4: Performance with many rules

**Problem**: Reverse linear scan of rules for every tool call. If there are 100+ rules, each tool call is O(n).

**Mitigation**: For the initial implementation, a simple array scan is acceptable. If performance becomes an issue, rules can be indexed by tool name in a follow-up.

## Testing and validation

### Unit tests (packages/agent/test/permission-manager.test.ts)

- Default rules allow `read_file`, ask for `bash`/`write_file`/`edit_file`, deny rest
- `grant()` appends rule
- `revoke()` removes all rules for a tool
- `evaluate()` returns correct action for matching rules
- Last-registered rule wins for same tool
- Scope path prefix matching works
- Scope command substring matching works
- Non-string args bypass scope matching
- Wildcard `*` matches any tool

### Integration tests

- Agent with PermissionManager allows permitted tools
- Agent with PermissionManager denies denied tools
- `beforeToolCall` runs after permission allow
- `beforeToolCall` does NOT run after permission deny
- `permission_needed` event fires with correct toolName/args
- Listener calling `resolve("allow")` permits execution
- Listener calling `resolve("deny")` denies execution
- No handler + timeout → auto-deny

### Regression tests

- `agent-loop.test.ts` passes without modification
- `agent.test.ts` passes without modification
- Agent without permissionManager runs identically

## Follow-ups

1. **Rule persistence**: Save/load rules to/from `packages/db`.
2. **Per-session override cache**: Cache user allow/deny decisions for the session duration.
3. **Rule index optimization**: Index rules by tool name for O(1) lookup.
4. **Glob/regex scope matching**: Support more powerful scope patterns.
