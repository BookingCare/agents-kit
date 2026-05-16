import type { Tool } from "@bookingcare/ai";
import { Type, tool } from "@bookingcare/ai";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { SkillLoader } from "./skill-loader.js";
import { TodoManager } from "./todo-manager.js";
import type { TodoItem } from "./todo-manager.js";
import type { Sandbox } from "@bookingcare/infa";
import type { ToolHandler, ToolDispatch } from "./types.js";

export type { ToolHandler, ToolDispatch } from "./types.js";

// --- Path sandboxing ---

function safePath(path: string, workdir: string): string {
  const root = resolve(workdir);
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  return resolved;
}

// --- Tool definitions (schemas) ---

export const bashTool = tool({
  name: "bash",
  description: "Run a bash command and return its stdout.",
  parameters: Type.Object({
    command: Type.String({ description: "The bash command to run" }),
  }),
});

export const readFileTool = tool({
  name: "read_file",
  description:
    "Read the contents of a file. Returns the text content, optionally truncated to a line limit.",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to workspace" }),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return" })),
  }),
});

export const writeFileTool = tool({
  name: "write_file",
  description:
    "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to workspace" }),
    content: Type.String({ description: "Content to write" }),
  }),
});

export const editFileTool = tool({
  name: "edit_file",
  description:
    "Replace an exact text segment in a file. Fails if old_text is not found or is not unique.",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to workspace" }),
    old_text: Type.String({ description: "Exact text to find (must be unique in the file)" }),
    new_text: Type.String({ description: "Replacement text" }),
  }),
});

export const loadSkillTool = tool({
  name: "load_skill",
  description:
    "Load a skill by name. Returns the full skill instructions. Use this when you need domain-specific guidance for a task.",
  parameters: Type.Object({
    name: Type.String({ description: "The skill name to load" }),
  }),
});

// --- Tool handlers ---

function runBash(command: string, workdir: string): string {
  const stdout = execSync(command, {
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    cwd: workdir,
  });
  return stdout || "(no output)";
}

function runRead(path: string, workdir: string, limit?: number): string {
  const safe = safePath(path, workdir);
  const text = readFileSync(safe, "utf-8");
  if (limit != null) {
    if (limit < 1) {
      throw new Error(`Invalid limit: ${limit}. Must be >= 1.`);
    }
    const lines = text.split("\n");
    return lines.slice(0, limit).join("\n");
  }
  return text.slice(0, 50_000);
}

function runWrite(path: string, content: string, workdir: string): string {
  const safe = safePath(path, workdir);
  mkdirSync(dirname(safe), { recursive: true });
  writeFileSync(safe, content, "utf-8");
  return `Wrote ${content.length} bytes to ${path}`;
}

function runEdit(path: string, oldText: string, newText: string, workdir: string): string {
  const safe = safePath(path, workdir);
  const content = readFileSync(safe, "utf-8");
  const index = content.indexOf(oldText);
  if (index === -1) {
    throw new Error(`old_text not found in ${path}`);
  }
  const secondIndex = content.indexOf(oldText, index + 1);
  if (secondIndex !== -1) {
    throw new Error(`old_text is not unique in ${path} (found at multiple positions)`);
  }
  const updated = content.slice(0, index) + newText + content.slice(index + oldText.length);
  writeFileSync(safe, updated, "utf-8");
  return `Edited ${path}: replaced ${oldText.length} chars with ${newText.length} chars`;
}

async function runBashWithSandbox(command: string, sandbox: Sandbox): Promise<string> {
  const result = await sandbox.exec(command);
  if (result.exitCode !== 0 || result.killed) {
    throw new Error(result.stderr || `Command failed with exit code ${result.exitCode}`);
  }
  return result.stdout || "(no output)";
}

async function runReadWithSandbox(path: string, sandbox: Sandbox, limit?: number): Promise<string> {
  if (limit != null) {
    return await sandbox.readFile(path, limit);
  }

  const content = await sandbox.readFile(path);
  return content.slice(0, 50_000);
}

async function runWriteWithSandbox(
  path: string,
  content: string,
  sandbox: Sandbox,
): Promise<string> {
  await sandbox.writeFile(path, content);
  return `Wrote ${content.length} bytes to ${path}`;
}

async function runEditWithSandbox(
  path: string,
  oldText: string,
  newText: string,
  sandbox: Sandbox,
): Promise<string> {
  return await sandbox.editFile(path, oldText, newText);
}

// --- Todo tool ---

export const todoTool = tool({
  name: "todo",
  description:
    "Update the task list to track progress on multi-step tasks. Mark in_progress before starting work, completed when done.",
  parameters: Type.Object({
    items: Type.Array(
      Type.Object({
        id: Type.String({ description: "Unique identifier for the task" }),
        text: Type.String({ description: "Task description" }),
        status: Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
        ]),
      }),
      { description: "The full list of todo items (replaces previous list)" },
    ),
  }),
});

// --- Dispatch ---

const baseTools = [bashTool, readFileTool, writeFileTool, editFileTool, todoTool];

/**
 * Create a tool dispatch table bound to a workspace directory.
 * If a skillsDir is provided, the load_skill tool is added automatically.
 * If a sandbox is provided, bash and file tools route through it.
 * Adding a tool = add a handler + add a schema entry. The loop never changes.
 */
export function createToolDispatch(
  workdir: string = process.cwd(),
  skillsDir?: string,
  sandbox?: Sandbox,
): ToolDispatch {
  const skillLoader = skillsDir ? new SkillLoader(skillsDir) : undefined;

  const todoManager = new TodoManager();

  const dispatch: Record<string, ToolHandler> = sandbox
    ? {
        bash: (args) => runBashWithSandbox(args.command as string, sandbox),
        read_file: (args) =>
          runReadWithSandbox(args.path as string, sandbox, args.limit as number | undefined),
        write_file: (args) =>
          runWriteWithSandbox(args.path as string, args.content as string, sandbox),
        edit_file: (args) =>
          runEditWithSandbox(
            args.path as string,
            args.old_text as string,
            args.new_text as string,
            sandbox,
          ),
        todo: (args) => todoManager.update(args.items as TodoItem[]),
        ...(skillLoader && {
          load_skill: (args) => skillLoader.getContent(args.name as string),
        }),
      }
    : {
        bash: (args) => runBash(args.command as string, workdir),
        read_file: (args) =>
          runRead(args.path as string, workdir, args.limit as number | undefined),
        write_file: (args) => runWrite(args.path as string, args.content as string, workdir),
        edit_file: (args) =>
          runEdit(args.path as string, args.old_text as string, args.new_text as string, workdir),
        todo: (args) => todoManager.update(args.items as TodoItem[]),
        ...(skillLoader && {
          load_skill: (args) => skillLoader.getContent(args.name as string),
        }),
      };

  const tools = skillLoader ? [...baseTools, loadSkillTool] : [...baseTools];

  return { tools, dispatch, skillLoader, todoManager };
}
