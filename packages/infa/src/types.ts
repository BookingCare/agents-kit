export type SandboxKind = "local";

export interface SandboxOptions {
  kind: SandboxKind;
  workdir: string;
  timeout?: number;
  maxMemory?: number;
  maxOutput?: number;
  env?: Record<string, string>;
}

export interface SandboxExecOptions {
  timeout?: number;
  maxOutput?: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed?: boolean;
  killedBy?: "timeout" | "memory" | "output";
}

export interface Sandbox {
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxResult>;
  readFile(path: string, limit?: number): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  editFile(path: string, oldText: string, newText: string): Promise<string>;
}
