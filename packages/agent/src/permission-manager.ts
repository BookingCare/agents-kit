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

const SHELL_CONTROL_OPERATORS = new Set(["|", "&", ";", "<", ">", "(", ")"]);
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;

function parseShellCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escapeNext = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (const char of command) {
    if (char === "\n" || char === "\r") {
      return null;
    }

    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\") {
        escapeNext = true;
      } else if (char === "$") {
        return null;
      } else if (char === "`") {
        return null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\\") {
      escapeNext = true;
      continue;
    }

    if (char === "'") {
      quote = "'";
      continue;
    }

    if (char === '"') {
      quote = '"';
      continue;
    }

    if (char === " " || char === "\t" || char === "\v" || char === "\f") {
      pushCurrent();
      continue;
    }

    if (SHELL_CONTROL_OPERATORS.has(char) || char === "`" || char === "$") {
      return null;
    }

    current += char;
  }

  if (escapeNext || quote !== null) {
    return null;
  }

  pushCurrent();
  return tokens.length > 0 ? tokens : null;
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export class PermissionManager {
  private readonly workspaceRoot?: string;
  private rules: PermissionRule[];

  constructor(options: PermissionManagerOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
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

  private resolveWorkspacePath(targetPath: string): string {
    if (path.isAbsolute(targetPath)) {
      return path.resolve(targetPath);
    }

    if (!this.workspaceRoot) {
      throw new Error("PermissionManager requires workspaceRoot to resolve relative file paths.");
    }

    return path.resolve(this.workspaceRoot, targetPath);
  }

  private matchesScope(scope: PermissionScope, args: Record<string, unknown>): boolean {
    if (scope.paths?.length && typeof args.path === "string") {
      const argPath = this.resolveWorkspacePath(args.path);
      for (const rulePath of scope.paths) {
        const normalizedRulePath = this.resolveWorkspacePath(rulePath);
        if (argPath === normalizedRulePath || isPathInside(argPath, normalizedRulePath)) {
          return true;
        }
      }
    }

    if (scope.commands?.length && typeof args.command === "string") {
      const argv = parseShellCommand(args.command);
      if (!argv) {
        return false;
      }

      const commandName = argv.find((token) => !ENV_ASSIGNMENT_PATTERN.test(token));
      if (commandName && scope.commands.includes(commandName)) {
        return true;
      }
    }

    return false;
  }
}
