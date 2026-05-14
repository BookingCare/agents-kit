# PermissionManager — centralized tool permission system - Product Spec

## Summary

Replace the ad-hoc `beforeToolCall` hook pattern with a centralized, rule-based `PermissionManager`. This provides persistent, declarative permission rules for agent tools with allow / deny / ask semantics, and enables UI-friendly permission flows.

## Problem

The current permission model is a per-call callback (`beforeToolCall`) that returns `continue | skip | replace`. There is no:

- Persistent permission configuration (rules reset every session)
- Centralized rule inspection (`listRules()`)
- Scope-based restrictions (e.g., deny `write_file` outside `src/`)
- Per-tool default policies
- UI-friendly "ask user" flow where permission can be granted interactively

## Goals

1. Provide a `PermissionManager` with a `PermissionRule` data model
2. Support three actions: `allow`, `deny`, `ask`
3. Support scoped restrictions (paths, commands, patterns)
4. Provide default rules for built-in tools (`read_file` allow, `bash` ask, etc.)
5. Integrate with `Agent` via `AgentOptions.permissionManager`
6. The `beforeToolCall` hook runs _after_ permission check (composable)
7. Emit a `permission_needed` event for `ask` decisions so UIs can respond
8. Zero breaking changes to existing `beforeToolCall` behavior

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

Rules are evaluated in reverse registration order (last added wins):

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
    // decision: "allow" | "deny"
    event.resolve(decision);
  }
});
```

If no listener resolves the `ask`, the tool call is denied after a timeout.

### Scope matching

Paths use prefix matching:

```typescript
pm.grant({
  tool: "write_file",
  action: "deny",
  scope: { paths: ["/etc/"] }, // denies /etc/passwd, /etc/hosts, etc.
});
```

Commands use substring matching for the `bash` tool:

```typescript
pm.grant({
  tool: "bash",
  action: "allow",
  scope: { commands: ["ls", "cat", "echo"] },
});
```

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

Permission check runs before `beforeToolCall`. A denied permission short-circuits and never reaches `beforeToolCall`.

```typescript
// 1. PermissionManager evaluates → allow/deny/ask
// 2. If allow, beforeToolCall hook runs (if present)
// 3. If ask, event emitted, waits for resolve()
// 4. If deny, returns error result immediately
```

## Success criteria

### Rule evaluation

1. `PermissionManager` applies `DEFAULT_RULES` when constructed without explicit rules
2. `grant(rule)` adds a rule to the registry
3. `revoke(tool)` removes all rules for that tool
4. `listRules()` returns all registered rules in evaluation order
5. `evaluate(toolName, args)` returns a `PermissionDecision`
6. Last-matching rule wins for a given tool
7. Wildcard `*` rule matches any unmatched tool

### Decision actions

8. `allow` decision permits the tool to execute
9. `deny` decision returns an error `ToolResult` immediately
10. `ask` decision emits `permission_needed` event and suspends execution
11. `resolve("allow")` on an `ask` permits execution
12. `resolve("deny")` on an `ask` returns an error `ToolResult`

### Scope matching

13. `scope.paths` matches when tool's `path` argument starts with any listed path
14. `scope.commands` matches when tool's `command` argument contains any listed command as a substring
15. Rule without scope matches unconditionally for that tool

### Integration

16. Permission check runs before `beforeToolCall` hook
17. `deny` decision skips `beforeToolCall` entirely
18. Agent without `permissionManager` behaves identically to baseline
19. `permission_needed` event includes `toolName`, `args`, `resolve`, and `reject`

### Edge cases

20. No rules match a tool: wildcard `*` rule returns `deny`
21. Multiple matching rules for same tool: last registered wins
22. Revoking a tool with no existing rules is a no-op
23. Granting a duplicate rule replaces the previous one for that tool

## Validation

### Unit tests (packages/agent/test/)

Add `permission-manager.test.ts`:

- Default rules match all built-in tools correctly
- `grant()` adds a rule
- `revoke()` removes rules for a tool
- `listRules()` returns rules in evaluation order
- `evaluate("bash", { command: "ls" })` returns allow with default rules
- `evaluate("unknown_tool", {})` returns deny (wildcard)
- Last-matching rule wins
- Scope path prefix matching (allow `/home` but deny `/home/secret`)
- Scope command substring matching
- `ask` decision emits `permission_needed` event
- `resolve("allow")` permits execution
- `resolve("deny")` returns error

### Integration tests

- Agent with PermissionManager allows permitted tools
- Agent with PermissionManager denies prohibited tools
- Agent with PermissionManager asks for ambiguous tools
- `beforeToolCall` runs after allow decision
- Agent without PermissionManager runs identically to baseline

### Regression tests

- `agent-loop.test.ts` passes without modification
- `agent.test.ts` passes without modification

## Open questions

1. **Should `ask` timeout?** If no listener resolves an `ask`, should it auto-deny after N seconds, or block forever? The current proposal says "denied after a timeout" but this adds async-complexity. Is an explicit `reject()` (e.g., via abort signal) sufficient?

2. **Should scope support glob patterns or regex?** Path prefix matching is simple but may not cover all use cases. Should we support `minimatch`-style globs?

3. **Should permission rules be serializable to JSON?** This is mentioned in the issue as a goal for persistence, but the `scope.commands` array is already serializable. Is there anything else needed?

4. **Should the `permission_needed` event type be added to `AgentEvent` union?** This is a new event type not emitted by the loop but by the permission system. How should it integrate with the existing event system?
