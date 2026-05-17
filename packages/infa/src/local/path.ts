import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function isWithinRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveSandboxPath(workdir: string, inputPath: string): string {
  if (isAbsolute(inputPath)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }

  const resolved = resolve(workdir, inputPath);
  let current = resolved;

  for (;;) {
    if (existsSync(current)) {
      const canonicalCurrent = realpathSync(current);
      const canonicalWorkdir = realpathSync(workdir);
      if (!isWithinRoot(canonicalCurrent, canonicalWorkdir)) {
        throw new Error(`Path escapes workspace: ${inputPath}`);
      }
      return resolved;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Path escapes workspace: ${inputPath}`);
    }
    current = parent;
  }
}
