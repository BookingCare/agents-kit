import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import type { SkillMeta, Skill } from "./types.js";

export type { SkillMeta, Skill } from "./types.js";

// --- Frontmatter parsing ---

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Expects `---` delimiters at the start and end of the frontmatter block.
 */
function parseFrontmatter(text: string): { meta: SkillMeta; body: string } {
  const trimmed = text.trimStart();

  if (!trimmed.startsWith("---")) {
    return { meta: { name: "", description: "" }, body: text };
  }

  const end = trimmed.indexOf("---", 3);
  if (end === -1) {
    return { meta: { name: "", description: "" }, body: text };
  }

  const frontmatter = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 3).trim();

  const meta: SkillMeta = { name: "", description: "" };
  for (const line of frontmatter.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    meta[key] = value;
  }

  return { meta, body };
}

/**
 * Scans a directory for skill directories containing SKILL.md files.
 * Each subdirectory is a skill; the directory name serves as fallback identifier.
 *
 * ```
 * skills/
 *   pdf/
 *     SKILL.md
 *   code-review/
 *     SKILL.md
 * ```
 */
export class SkillLoader {
  private skills = new Map<string, Skill>();

  constructor(skillsDir: string) {
    this.scan(skillsDir);
  }

  private scan(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return; // no skills directory — that's fine
    }

    for (const entry of entries) {
      const entryPath = join(dir, entry);
      const stat = statSync(entryPath);
      if (!stat.isDirectory()) continue;

      const skillFile = resolve(entryPath, "SKILL.md");
      try {
        const text = readFileSync(skillFile, "utf-8");
        const { meta, body } = parseFrontmatter(text);
        const name = meta.name || entry;
        meta.name = name;
        this.skills.set(name, { meta, body });
      } catch {
        // no SKILL.md in this directory — skip
      }
    }
  }

  /** Layer 1: short descriptions for system prompt (cheap tokens) */
  getDescriptions(): string {
    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      const desc = skill.meta.description || "(no description)";
      lines.push(`  - ${name}: ${desc}`);
    }
    return lines.join("\n");
  }

  /** Layer 2: full skill body via tool_result (loaded on demand) */
  getContent(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      const available = [...this.skills.keys()].join(", ");
      return `Unknown skill '${name}'. Available skills: ${available}`;
    }
    return `<skill name="${skill.meta.name}">\n${skill.body}\n</skill>`;
  }

  /** List all skill names */
  listNames(): string[] {
    return [...this.skills.keys()];
  }

  /** Check if a skill exists */
  has(name: string): boolean {
    return this.skills.has(name);
  }
}
