# PermissionManager — centralized tool permission system - Tech Spec

## Problem

Tool permissions are currently handled ad-hoc via the `beforeToolCall` hook. There is no centralized rule system, no safe scope matching, and no persisted policy loading. We need to:

1. Define a rule-based permission system with allow / deny / ask actions
2. Integrate it before the existing `beforeToolCall` hook in the tool execution flow
3. Support scoped rules with deterministic matching
4. Emit a `permission_needed` event for the `ask` action
5. Allow rule sets to be serialized and rehydrated as plain JSON

## Relevant code

### packages/agent/src/types.ts

- `BeforeToolCallContext` (line ~80-83): `{ toolName, args, toolCallId }`
- `BeforeToolCallResult` (line ~85-91): `{ action: "continue" } | { action: "skip"; result? } | { action: "replace"; args }`
- `AgentTool` (line ~100-112): Tool definition with `execute()` method
- `AgentLoopConfig` (line ~86-112): Contains `beforeToolCall` hook
- `AgentEvent` (line ~117-126): Event types — may need `permission_needed`

### packages/agent/src/agent-loop.ts

- `executeToolCalls()` (line ~315-420): Tool dispatch function
- `beforeToolCall` hook invocation inside the tool execution path
- Tool execution block that needs permission gating before execution

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

export interface PermissionManagerOptions {
  rules?: PermissionRule[];
}
```

`PermissionRule`, `PermissionDecision`, and `PermissionScope` remain plain JSON shapes so callers can persist them externally.

### PermissionManager class (packages/agent/src/permission-manager.ts)

```typescript
import path from "node:path";
import type {
  PermissionDecision,
  PermissionManagerOptions,
  PermissionRule,
  PermissionScope,
} from "./types.js";

export const DEFAULT_RULES: PermissionRule[] = [
  { tool: "read_file", action: "allow" },
  { tool: "bash", action: "ask" },
  { tool: "write_file", action: "ask" },
  { tool: "edit_file", action: "ask" },
  { tool: "*", action: "deny" },
];

export class PermissionManager {
  private rules: PermissionRule[];

  constructor(options: PermissionManagerOptions = {}) {
    this.rules = options.rules ? [...options.rules] : [...DEFAULT_RULES];
  }

  grant(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  revoke(tool: string): void {
    this.rules = this.rules.filter((rule) => rule.tool !== tool);
  }

  listRules(): readonly PermissionRule[] {
    return [...this.rules];
  }

  evaluate(toolName: string, args: Record<string, unknown>): PermissionDecision {
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i];
      if (rule.tool !== toolName && rule.tool !== "*") continue;
      if (rule.scope && !this.matchesScope(rule.scope, args)) continue;
      return { action: rule.action, rule };
    }

    return {
      action: "deny",
      rule: { tool: "*", action: "deny" },
    };
  }

  private matchesScope(scope: PermissionScope, args: Record<string, unknown>): boolean {
    if (scope.paths?.length && typeof args.path === "string") {
      const argPath = path.resolve(args.path);
      if (
        scope.paths.some((rulePath) => {
          const normalizedRulePath = path.resolve(rulePath);
          return (
            argPath === normalizedRulePath || argPath.startsWith(`${normalizedRulePath}${path.sep}`)
          );
        })
      ) {
        return true;
      }
    }

    if (scope.commands?.length && typeof args.command === "string") {
      const commandName = args.command.trim().split(/\s+/)[0];
      if (scope.commands.includes(commandName)) {
        return true;
      }
    }

    return false;
  }
}
```

Important behavior:

- `grant()` appends; it does not dedupe.
- Reverse scan makes the most recently matching rule win.
- Path checks are canonicalized with `path.resolve()` and boundary-aware prefix matching.
- Command checks compare the first whitespace-delimited token only; no substring matching.

### Persistence and serialization

`PermissionManager` has no hidden persistence layer. The source of truth is the plain `PermissionRule[]` returned by `listRules()`. Callers can stringify that array, store it with `packages/db`, and later rehydrate the manager with `new PermissionManager({ rules })`.

No migration format is needed for the initial implementation because the rule objects already match the public JSON shape.

### Agent loop integration (packages/agent/src/agent-loop.ts)

Modify `executeToolCalls` to run permission check before `beforeToolCall`.

```typescript
if (config.permissionManager) {
  const decision = config.permissionManager.evaluate(toolCall.name, args);

  if (decision.action === "deny") {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: "Permission denied." }],
      isError: true,
      timestamp: Date.now(),
    };
  }

  if (decision.action === "ask") {
    const deferred = createDeferred<"allow" | "deny">();

    await emit({
      type: "permission_needed",
      toolName: toolCall.name,
      args,
      toolCallId: toolCall.id,
      rule: decision.rule,
      resolve: deferred.resolve,
    } as AgentEvent);

    const answer = await deferred.promise;
    if (answer === "deny") {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Permission denied." }],
        isError: true,
        timestamp: Date.now(),
      };
    }
  }
}
```

The pending approval wait must observe the active `AbortSignal` so an aborted run exits cleanly. No timeout or auto-deny path is added.

A minimal deferred helper is sufficient:

```typescript
export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

`processEvents()` does not need additional state handling beyond an explicit `permission_needed` case or a default fallthrough.

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

No internal state needs updating for `permission_needed`.

```typescript
case "permission_needed":
  break;
```

### Export changes (packages/agent/src/index.ts)

```typescript
export type {
  PermissionManagerOptions,
  PermissionRule,
  PermissionDecision,
  PermissionScope,
  PermissionNeededEvent,
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
Agent: executes tool "unknown_tool" with args {}
  → executeToolCalls
    → parse args
    → permissionManager.evaluate("unknown_tool", {})
      → matches DEFAULT_RULES[4]: { tool: "*", action: "deny" }
      → returns { action: "deny" }
    → returns error ToolResult immediately
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
    → deferred promise resolves to "allow"
    → proceed to beforeToolCall
    → execute tool
```

## Risks and mitigations

### Risk 1: Pending ask with no handler

**Problem**: If no subscriber handles `permission_needed`, the execution remains suspended.

**Mitigation**: Require consumers that enable `ask` to register a `permission_needed` listener. The existing abort path cancels the wait when the run is aborted.

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
- `PermissionManager` can be initialized from persisted rules
- `listRules()` returns rules in evaluation order
- Last-registered rule wins for same tool
- Scope path prefix matching on normalized paths
- Scope command-name matching
- Non-string args bypass scope matching
- Wildcard `*` matches any tool
- `ask` decision emits `permission_needed` event
- `resolve("allow")` permits execution
- `resolve("deny")` returns error
- `listRules()` output can be JSON-stringified and reloaded

### Integration tests

- Agent with PermissionManager allows permitted tools
- Agent with PermissionManager denies denied tools
- `beforeToolCall` runs after permission allow
- `beforeToolCall` does NOT run after permission deny
- `permission_needed` event fires with correct toolName/args/toolCallId
- Listener calling `resolve("allow")` permits execution
- Listener calling `resolve("deny")` denies execution
- Pending ask stays suspended until resolved
- Agent without PermissionManager runs identically to baseline

### Regression tests

- `agent-loop.test.ts` passes without modification
- `agent.test.ts` passes without modification
- Agent without permissionManager runs identically
