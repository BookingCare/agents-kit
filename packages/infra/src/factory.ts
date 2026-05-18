import type { Sandbox, SandboxOptions } from "./types.js";
import { LocalSandbox } from "./local/local-sandbox.js";

const sandboxFactories = {
  local: (options: SandboxOptions) => new LocalSandbox(options),
} satisfies Record<SandboxOptions["kind"], (options: SandboxOptions) => Sandbox>;

export function createSandbox(options: SandboxOptions): Sandbox {
  const factory = sandboxFactories[options.kind];
  if (!factory) {
    throw new Error(`Unsupported sandbox kind: ${options.kind}`);
  }
  return factory(options);
}
