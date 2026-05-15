# PermissionManager — centralized tool permission system - Product Spec

## Summary

Add a centralized, rule-based `PermissionManager` alongside the existing `beforeToolCall` hook. This provides JSON-serializable permission rules for agent tools with allow / deny / ask semantics, and enables UI-friendly approval flows.

## Problem

The current permission model is a per-call callback (`beforeToolCall`) that returns `continue | skip | replace`. There is no:

- Persistent rule configuration
- Centralized rule inspection (`listRules()`)
- Scope-based restrictions (e.g., deny `write_file` outside `src/`)
- Per-tool default policies
- UI-friendly pending approval flow

## Goals

1. Provide a `PermissionManager` with a `PermissionRule` data model
2. Support three actions: `allow`, `deny`, `ask`
3. Support scoped restrictions (paths, commands) with deterministic matching
4. Provide default rules for built-in tools (`read_file` allow, `bash` ask, etc.)
5. Integrate with `Agent` via `AgentOptions.permissionManager`
6. The `beforeToolCall` hook runs _after_ permission check (composable)
7. Emit a `permission_needed` event for `ask` decisions so UIs can respond
8. Allow persisted rules to be rehydrated from JSON without custom migration code
9. Zero breaking changes to existing `beforeToolCall` behavior

## Non-goals

- Role-based access control (RBAC) or multi-user permissions
- Approval timeout / auto-deny logic
- Cryptographic signing of permission grants
- Permission groups or inheritance hierarchies
- Per-session temporary overrides that aren't rules

## Figma / design references

Not applicable — programmatic API with no UI components.

## User experience

### Default behavior (no changes)

Without a `PermissionManager`, `beforeToolCall` operates exactly as today:

```typescript
const agent = new Agent({
  model: claudeModel,
  tools,
  beforeToolCall: async (ctx) => {
    if (ctx.toolName === "bash") return { action: "skip" };
    return { action: "continue" };
  },
});
```

### Enabling PermissionManager

```typescript
import { Agent, PermissionManager } from "@bookingcare/agent";

const pm = new PermissionManager();
pm.grant({ tool: "read_file", action: "allow" });
pm.grant({ tool: "bash", action: "ask" });
pm.grant({ tool: "write_file", action: "deny", scope: { paths: ["/etc"] } });

const agent = new Agent({
  model: claudeModel,
  tools,
  permissionManager: pm,
});
```

### Default rules

If no rules are explicitly configured, `PermissionManager` uses `DEFAULT_RULES`:

| Tool           | Action  |
| -------------- | ------- |
| `read_file`    | `allow` |
| `bash`         | `ask`   |
| `write_file`   | `ask`   |
| `edit_file`    | `ask`   |
| `*` (wildcard) | `deny`  |

```typescript
const pm = new PermissionManager(); // uses DEFAULT_RULES automatically
console.log(pm.listRules());
// → [{ tool: "read_file", action: "allow" }, ...]
```

### Rule evaluation order

Rules are evaluated in reverse registration order (last added wins). `grant()` appends a new rule.

```typescript
pm.grant({ tool: "bash", action: "deny" });
pm.grant({ tool: "bash", action: "allow", scope: { commands: ["ls", "cat"] } });

// "ls" → allow (second rule matches and is more specific)
// "rm" → deny (first rule matches)
```

### The `ask` action

When a rule evaluates to `ask`, the tool call is suspended and a `permission_needed` event is emitted:

```typescript
agent.subscribe(async (event) => {
  if (event.type === "permission_needed") {
    const decision = await showDialog(event.toolName, event.args);
    event.resolve(decision); // "allow" | "deny"
  }
});
```

If no listener resolves the event, the tool call stays pending until a listener responds or the agent run is aborted; there is no timeout-based auto-deny.

### Scope matching

Paths use normalized absolute-path prefix matching:

```typescript
pm.grant({
  tool: "write_file",
  action: "deny",
  scope: { paths: ["/etc"] },
});

// matches /etc/passwd and /etc/hosts
// does not match /etc2/config
```

Commands use executable-name matching after whitespace tokenization:

```typescript
pm.grant({
  tool: "bash",
  action: "allow",
  scope: { commands: ["ls", "cat", "echo"] },
});

// matches "ls -la", "cat file.txt", "echo hello"
// does not match "sqls" or "concatenate"
```

### Persistence

`PermissionRule` objects are plain JSON. `PermissionManager.listRules()` returns them in evaluation order, so callers can persist the array externally (for example with `packages/db`) and rehydrate the manager later:

```typescript
const savedRules = await loadPermissionRules(); // PermissionRule[]
const pm = new PermissionManager({ rules: savedRules });
```

By default the manager is in-memory only; persistence is caller-owned.

### Revoking rules

```typescript
pm.revoke("bash"); // removes all rules for "bash"
pm.revoke("write_file"); // removes all rules for "write_file"
```

### Listing rules

```typescript
const rules = pm.listRules();
// → Array<PermissionRule>
```

### Composing with beforeToolCall

Permission check runs before `beforeToolCall`. A denied permission short-circuits and never reaches `beforeToolCall`. If `ask` is resolved with `allow`, `beforeToolCall` runs normally.

```typescript
// 1. PermissionManager evaluates → allow/deny/ask
// 2. If allow, beforeToolCall hook runs (if present)
// 3. If ask, event emitted, waits for resolve()
// 4. If deny, returns error result immediately
```

## Success criteria

### Rule evaluation

1. `PermissionManager` applies `DEFAULT_RULES` when constructed without explicit rules
2. `PermissionManager` can be initialized from a persisted `PermissionRule[]`
3. `grant(rule)` adds a rule to the registry
4. `revoke(tool)` removes all rules for that tool
5. `listRules()` returns all registered rules in evaluation order
6. `evaluate(toolName, args)` returns a `PermissionDecision`
7. Last-matching rule wins for a given tool
8. Wildcard `*` rule matches any unmatched tool

### Decision actions

9. `allow` decision permits the tool to execute
10. `deny` decision returns an error `ToolResult` immediately
11. `ask` decision emits `permission_needed` and suspends execution until resolved
12. `resolve("allow")` on an `ask` permits execution
13. `resolve("deny")` on an `ask` returns an error `ToolResult`

### Scope matching

14. `scope.paths` matches when the normalized `path` argument is the same as, or nested under, any listed path
15. `scope.commands` matches when the first whitespace-delimited token of the `command` argument equals any listed command
16. Rule without scope matches unconditionally for that tool
17. Non-string `path` or `command` arguments bypass scope matching

### Integration

18. Permission check runs before `beforeToolCall` hook
19. `deny` decision skips `beforeToolCall` entirely
20. Agent without `permissionManager` behaves identically to baseline
21. `permission_needed` event includes `toolName`, `args`, `toolCallId`, `resolve`, and `rule`; `resolve` accepts only `"allow"` or `"deny"`

### Edge cases

22. No rules match a tool: wildcard `*` rule returns `deny`
23. Multiple matching rules for same tool: last registered wins; grants append rather than replace existing rules
24. Revoking a tool with no existing rules is a no-op
25. Granting the same tool twice appends a new rule; later matching rules take precedence

## Validation

### Unit tests (packages/agent/test/)

Add `permission-manager.test.ts`:

- Default rules match all built-in tools correctly
- `grant()` adds a rule
- `revoke()` removes rules for a tool
- `listRules()` returns rules in evaluation order
- `PermissionManager` can be constructed from persisted rules
- `evaluate("bash", { command: "ls -la" })` returns allow with default rules
- `evaluate("unknown_tool", {})` returns deny (wildcard)
- Last-matching rule wins
- Scope path prefix matching on normalized paths (allow `/home` but deny `/home/secret`)
- Scope command-name matching
- Non-string args bypass scope matching
- `ask` decision emits `permission_needed` event
- `resolve("allow")` permits execution
- `resolve("deny")` returns error
- `listRules()` output can be JSON-stringified and reloaded

### Integration tests

- Agent with PermissionManager allows permitted tools
- Agent with PermissionManager denies prohibited tools
- Agent with PermissionManager asks for ambiguous tools
- `beforeToolCall` runs after allow decision
- `beforeToolCall` does NOT run after permission deny
- `permission_needed` event fires with correct toolName/args/toolCallId
- Listener calling `resolve("allow")` permits execution
- Listener calling `resolve("deny")` denies execution
- Pending ask stays suspended until resolved
- Agent without PermissionManager runs identically to baseline

### Regression tests

- `agent-loop.test.ts` passes without modification
- `agent.test.ts` passes without modification
