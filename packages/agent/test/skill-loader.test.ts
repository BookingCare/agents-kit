import { describe, it, expect } from "vitest";
import { SkillLoader } from "../src/skill-loader.js";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const FIXTURES = resolve(import.meta.dirname, "fixtures/skills");

// --- Unit tests ---

describe("SkillLoader", () => {
  describe("scanning and loading", () => {
    it("loads skills from a directory", () => {
      const loader = new SkillLoader(FIXTURES);

      expect(loader.listNames()).toContain("greeter");
      expect(loader.listNames()).toContain("code-review");
    });

    it("uses directory name as fallback when frontmatter has no name", () => {
      const loader = new SkillLoader(FIXTURES);

      expect(loader.listNames()).toContain("no-frontmatter");
    });

    it("has() checks skill existence", () => {
      const loader = new SkillLoader(FIXTURES);

      expect(loader.has("greeter")).toBe(true);
      expect(loader.has("nonexistent")).toBe(false);
    });
  });

  describe("getDescriptions (Layer 1)", () => {
    it("returns short descriptions for all skills", () => {
      const loader = new SkillLoader(FIXTURES);
      const desc = loader.getDescriptions();

      expect(desc).toContain("greeter:");
      expect(desc).toContain("Generates friendly greetings in various languages");
      expect(desc).toContain("code-review:");
      expect(desc).toContain("Perform structured code reviews with a checklist");
    });
  });

  describe("getContent (Layer 2)", () => {
    it("returns full skill body wrapped in tags", () => {
      const loader = new SkillLoader(FIXTURES);
      const content = loader.getContent("greeter");

      expect(content).toContain('<skill name="greeter">');
      expect(content).toContain("Ask for the person's name");
      expect(content).toContain("</skill>");
    });

    it("returns error for unknown skill", () => {
      const loader = new SkillLoader(FIXTURES);
      const content = loader.getContent("nonexistent");

      expect(content).toContain("Unknown skill 'nonexistent'");
      expect(content).toContain("Available skills:");
    });
  });

  describe("edge cases", () => {
    it("handles missing skills directory gracefully", () => {
      const loader = new SkillLoader("/nonexistent/path");

      expect(loader.listNames()).toEqual([]);
      expect(loader.getDescriptions()).toBe("");
    });

    it("handles directory with no SKILL.md files", () => {
      const dir = resolve(tmpdir(), `skill-test-empty-${Date.now()}`);
      mkdirSync(resolve(dir, "subdir"), { recursive: true });
      try {
        const loader = new SkillLoader(dir);
        expect(loader.listNames()).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("handles frontmatter with extra fields", () => {
      const dir = resolve(tmpdir(), `skill-test-extra-${Date.now()}`);
      const skillDir = resolve(dir, "extra");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        resolve(skillDir, "SKILL.md"),
        "---\nname: extra\nversion: 1.0\nauthor: test\n---\nExtra skill body",
      );
      try {
        const loader = new SkillLoader(dir);
        expect(loader.has("extra")).toBe(true);
        const content = loader.getContent("extra");
        expect(content).toContain("Extra skill body");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("handles SKILL.md with empty frontmatter", () => {
      const dir = resolve(tmpdir(), `skill-test-emptyfm-${Date.now()}`);
      const skillDir = resolve(dir, "emptyfm");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(resolve(skillDir, "SKILL.md"), "---\n---\nJust body text");
      try {
        const loader = new SkillLoader(dir);
        // Falls back to directory name since no name in frontmatter
        expect(loader.has("emptyfm")).toBe(true);
        const content = loader.getContent("emptyfm");
        expect(content).toContain("Just body text");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
