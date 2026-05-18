import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSandbox } from "../src/index.js";
import type { SandboxOptions } from "../src/types.js";

let workdir: string | undefined;

afterEach(() => {
  if (workdir) {
    rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  }
});

describe("createSandbox", () => {
  it("creates a local sandbox and workdir", () => {
    workdir = join(tmpdir(), `infra-factory-${Date.now()}`);
    const sandbox = createSandbox({ kind: "local", workdir });

    expect(existsSync(workdir)).toBe(true);
    expect(sandbox).toHaveProperty("exec");
    expect(sandbox).toHaveProperty("readFile");
    expect(sandbox).toHaveProperty("writeFile");
    expect(sandbox).toHaveProperty("editFile");
  });

  it("fails fast for unsupported kinds", () => {
    workdir = join(tmpdir(), `infra-factory-${Date.now()}`);
    expect(() => createSandbox({ kind: "bogus" as never, workdir } as SandboxOptions)).toThrow(
      "Unsupported sandbox kind: bogus",
    );
  });
});
