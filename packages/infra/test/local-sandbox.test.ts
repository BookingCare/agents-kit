import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSandbox } from "../src/index.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("LocalSandbox", () => {
  it("exec returns stdout for a simple command", async () => {
    const workdir = createTempDir("infra-exec-");
    const sandbox = createSandbox({ kind: "local", workdir });

    const result = await sandbox.exec(`"${process.execPath}" -e "process.stdout.write('hello')"`);

    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.killed).toBeUndefined();
    expect(result.killedBy).toBeUndefined();
  });

  it("rejects maxMemory values smaller than 1 KiB", () => {
    const workdir = createTempDir("infra-memory-");

    expect(() => createSandbox({ kind: "local", workdir, maxMemory: 512 })).toThrow(
      "Invalid maxMemory: 512. Must be at least 1024 bytes.",
    );
  });

  it("exec kills a long-running command on timeout", async () => {
    const workdir = createTempDir("infra-timeout-");
    const sandbox = createSandbox({ kind: "local", workdir });

    const result = await sandbox.exec(`"${process.execPath}" -e "while(true){}"`, {
      timeout: 50,
    });

    expect(result.killed).toBe(true);
    expect(result.killedBy).toBe("timeout");
  });

  it("kills descendant processes on timeout", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workdir = createTempDir("infra-tree-timeout-");
    const sandbox = createSandbox({ kind: "local", workdir });
    const marker = join(workdir, "timeout-child.txt");

    const result = await sandbox.exec(
      `"${process.execPath}" -e "setTimeout(() => require('node:fs').writeFileSync('timeout-child.txt', 'alive'), 300); setInterval(() => {}, 1000)"`,
      { timeout: 50 },
    );

    expect(result.killed).toBe(true);
    expect(result.killedBy).toBe("timeout");
    await wait(400);
    expect(existsSync(marker)).toBe(false);
  });

  it("exec kills a command that exceeds maxOutput", async () => {
    const workdir = createTempDir("infra-output-");
    const sandbox = createSandbox({ kind: "local", workdir });

    const result = await sandbox.exec(
      `"${process.execPath}" -e "process.stdout.write('x'.repeat(5000))"`,
      { maxOutput: 100 },
    );

    expect(result.killed).toBe(true);
    expect(result.killedBy).toBe("output");
    expect(result.stdout.length).toBeLessThanOrEqual(100);
  });

  it("kills descendant processes on maxOutput", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workdir = createTempDir("infra-tree-output-");
    const sandbox = createSandbox({ kind: "local", workdir });
    const marker = join(workdir, "output-child.txt");

    const result = await sandbox.exec(
      `"${process.execPath}" -e "setTimeout(() => require('node:fs').writeFileSync('output-child.txt', 'alive'), 300); process.stdout.write('x'.repeat(5000)); setInterval(() => {}, 1000)"`,
      { maxOutput: 100 },
    );

    expect(result.killed).toBe(true);
    expect(result.killedBy).toBe("output");
    await wait(400);
    expect(existsSync(marker)).toBe(false);
  });

  it("readFile returns file contents and respects line limits", async () => {
    const workdir = createTempDir("infra-read-");
    const sandbox = createSandbox({ kind: "local", workdir });
    const filePath = join(workdir, "notes.txt");

    writeFileSync(filePath, "one\ntwo\nthree\n");

    await expect(sandbox.readFile("notes.txt")).resolves.toBe("one\ntwo\nthree\n");
    await expect(sandbox.readFile("notes.txt", 2)).resolves.toBe("one\ntwo");
  });

  it("writeFile creates missing parent directories", async () => {
    const workdir = createTempDir("infra-write-");
    const sandbox = createSandbox({ kind: "local", workdir });

    await sandbox.writeFile("nested/dir/file.txt", "hello");

    expect(existsSync(join(workdir, "nested/dir/file.txt"))).toBe(true);
    expect(readFileSync(join(workdir, "nested/dir/file.txt"), "utf-8")).toBe("hello");
  });

  it("rejects absolute paths", async () => {
    const workdir = createTempDir("infra-abs-");
    const sandbox = createSandbox({ kind: "local", workdir });

    await expect(sandbox.readFile(join(workdir, "escape.txt"))).rejects.toThrow(
      "Path escapes workspace",
    );
    await expect(sandbox.readFile("/etc/passwd")).rejects.toThrow("Path escapes workspace");
  });

  it("rejects relative path escapes", async () => {
    const workdir = createTempDir("infra-relative-");
    const sandbox = createSandbox({ kind: "local", workdir });

    await expect(sandbox.readFile("../escape.txt")).rejects.toThrow("Path escapes workspace");
  });

  it("rejects symlink escapes", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workdir = createTempDir("infra-symlink-");
    const outside = createTempDir("infra-outside-");
    const sandbox = createSandbox({ kind: "local", workdir });

    symlinkSync(outside, join(workdir, "link"));

    await expect(sandbox.readFile("link/file.txt")).rejects.toThrow("Path escapes workspace");
  });

  it("passes explicit env vars to spawned processes and does not inherit parent env", async () => {
    const workdir = createTempDir("infra-env-");
    const sandbox = createSandbox({ kind: "local", workdir, env: { CUSTOM_VAR: "sandboxed" } });

    const previousSecret = process.env.SUPER_SECRET;
    process.env.SUPER_SECRET = "do-not-leak";

    try {
      const explicit = await sandbox.exec(
        `"${process.execPath}" -e "process.stdout.write(process.env.CUSTOM_VAR ?? '')"`,
      );
      const inherited = await sandbox.exec(
        `"${process.execPath}" -e "process.stdout.write(process.env.SUPER_SECRET ?? '')"`,
      );

      expect(explicit.stdout).toBe("sandboxed");
      expect(inherited.stdout).toBe("");
    } finally {
      if (previousSecret === undefined) {
        delete process.env.SUPER_SECRET;
      } else {
        process.env.SUPER_SECRET = previousSecret;
      }
    }
  });
});
