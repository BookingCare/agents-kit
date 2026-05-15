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
      if (!rule || rule.tool !== toolName) continue;
      if (rule.scope && !this.matchesScope(rule.scope, args)) continue;
      return { action: rule.action, rule };
    }

    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i];
      if (!rule || rule.tool !== "*") continue;
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
      for (const rulePath of scope.paths) {
        const normalizedRulePath = path.resolve(rulePath);
        const boundary = normalizedRulePath.endsWith(path.sep)
          ? normalizedRulePath
          : `${normalizedRulePath}${path.sep}`;
        if (argPath === normalizedRulePath || argPath.startsWith(boundary)) {
          return true;
        }
      }
    }

    if (scope.commands?.length && typeof args.command === "string") {
      const [commandName = ""] = args.command.trim().split(/\s+/);
      if (scope.commands.includes(commandName)) {
        return true;
      }
    }

    return false;
  }
}
