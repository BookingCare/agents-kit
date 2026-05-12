import type { Tool } from "@bookingcare/ai";
import { Type, tool } from "@bookingcare/ai";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { SkillLoader } from "./skill-loader.js";
import type { ToolHandler, ToolDispatch } from "./types.js";

export type { ToolHandler, ToolDispatch } from "./types.js";

// --- Path sandboxing ---

function safePath(path: string, workdir: string): string {
  const resolved = resolve(workdir, path);
  if (!resolved.startsWith(resolve(workdir))) {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  return resolved;
}

// --- Tool definitions (schemas) ---

export const bashTool = tool({
  name: "bash",
  description: "Run a bash command and return its stdout and stderr.",
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
  try {
    const stdout = execSync(command, {
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      cwd: workdir,
    });
    return stdout || "(no output)";
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const parts: string[] = [];
    if (e.stdout) parts.push(e.stdout);
    if (e.stderr) parts.push(e.stderr);
    if (!parts.length && e.message) parts.push(e.message);
    return parts.join("\n") || "(error)";
  }
}

function runRead(path: string, workdir: string, limit?: number): string {
  const safe = safePath(path, workdir);
  const text = readFileSync(safe, "utf-8");
  if (limit != null) {
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
    return `Error: old_text not found in ${path}`;
  }
  const secondIndex = content.indexOf(oldText, index + 1);
  if (secondIndex !== -1) {
    return `Error: old_text is not unique in ${path} (found at multiple positions)`;
  }
  const updated = content.slice(0, index) + newText + content.slice(index + oldText.length);
  writeFileSync(safe, updated, "utf-8");
  return `Edited ${path}: replaced ${oldText.length} chars with ${newText.length} chars`;
}

// --- Dispatch ---

const baseTools = [bashTool, readFileTool, writeFileTool, editFileTool];

/**
 * Create a tool dispatch table bound to a workspace directory.
 * If a skillsDir is provided, the load_skill tool is added automatically.
 * Adding a tool = add a handler + add a schema entry. The loop never changes.
 */
export function createToolDispatch(
  workdir: string = process.cwd(),
  skillsDir?: string,
): ToolDispatch {
  const skillLoader = skillsDir ? new SkillLoader(skillsDir) : undefined;

  const dispatch: Record<string, ToolHandler> = {
    bash: (args) => runBash(args.command as string, workdir),
    read_file: (args) => runRead(args.path as string, workdir, args.limit as number | undefined),
    write_file: (args) => runWrite(args.path as string, args.content as string, workdir),
    edit_file: (args) =>
      runEdit(args.path as string, args.old_text as string, args.new_text as string, workdir),
    ...(skillLoader && {
      load_skill: (args) => skillLoader.getContent(args.name as string),
    }),
  };

  const tools = skillLoader ? [...baseTools, loadSkillTool] : [...baseTools];

  return { tools, dispatch, skillLoader };
}
