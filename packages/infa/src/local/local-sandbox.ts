import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Sandbox, SandboxExecOptions, SandboxOptions, SandboxResult } from "../types.js";
import { resolveSandboxPath } from "./path.js";

const KILL_GRACE_MS = 1000;
const MEMORY_LIMIT_BYTES_PER_KIB = 1024;

function formatExecCommand(command: string, maxMemory?: number): string {
  if (maxMemory === undefined || process.platform === "win32") {
    return command;
  }

  const memoryLimitKb = Math.floor(maxMemory / MEMORY_LIMIT_BYTES_PER_KIB);
  return `ulimit -v ${memoryLimitKb}; ${command}`;
}

function mergeEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...(env ?? {}) };
}

function isMissingProcessError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
      return;
    }

    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

export class LocalSandbox implements Sandbox {
  private readonly workdir: string;
  private readonly timeout?: number;
  private readonly maxMemory?: number;
  private readonly maxOutput?: number;
  private readonly env: NodeJS.ProcessEnv;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: SandboxOptions) {
    if (options.maxMemory !== undefined && options.maxMemory < MEMORY_LIMIT_BYTES_PER_KIB) {
      throw new Error(
        `Invalid maxMemory: ${options.maxMemory}. Must be at least ${MEMORY_LIMIT_BYTES_PER_KIB} bytes.`,
      );
    }

    this.workdir = resolve(options.workdir);
    mkdirSync(this.workdir, { recursive: true });
    this.timeout = options.timeout;
    this.maxMemory = options.maxMemory;
    this.maxOutput = options.maxOutput;
    this.env = mergeEnv(options.env);
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  public async exec(command: string, options?: SandboxExecOptions): Promise<SandboxResult> {
    return await this.runExclusive(() => this.execInternal(command, options));
  }

  public async readFile(path: string, limit?: number): Promise<string> {
    return await this.runExclusive(() => this.readFileInternal(path, limit));
  }

  public async writeFile(path: string, content: string): Promise<void> {
    await this.runExclusive(() => this.writeFileInternal(path, content));
  }

  public async editFile(path: string, oldText: string, newText: string): Promise<string> {
    return await this.runExclusive(() => this.editFileInternal(path, oldText, newText));
  }

  private async execInternal(
    command: string,
    options?: SandboxExecOptions,
  ): Promise<SandboxResult> {
    const timeout = options?.timeout ?? this.timeout;
    const maxOutput = options?.maxOutput ?? this.maxOutput;
    const shellCommand = formatExecCommand(command, this.maxMemory);

    return await new Promise<SandboxResult>((resolveResult, rejectResult) => {
      const child = spawn(shellCommand, {
        shell: true,
        detached: process.platform !== "win32",
        cwd: this.workdir,
        env: this.env,
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let combinedBytes = 0;
      let killed = false;
      let killedBy: SandboxResult["killedBy"];
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;

      const clearTimers = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
      };

      const finish = (result: SandboxResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        resolveResult(result);
      };

      const killChild = (reason: NonNullable<SandboxResult["killedBy"]>) => {
        if (settled || killed || child.pid === undefined) {
          return;
        }
        killed = true;
        killedBy = reason;

        try {
          killProcessGroup(child.pid, "SIGTERM");
        } catch (error) {
          settled = true;
          clearTimers();
          rejectResult(error);
          return;
        }

        forceKillTimer = setTimeout(() => {
          if (child.pid !== undefined) {
            try {
              killProcessGroup(child.pid, "SIGKILL");
            } catch (error) {
              if (!settled) {
                settled = true;
                clearTimers();
                rejectResult(error);
              }
            }
          }
        }, KILL_GRACE_MS);
      };

      const appendChunk = (target: Buffer[], chunk: Buffer) => {
        if (maxOutput === undefined) {
          target.push(chunk);
          combinedBytes += chunk.length;
          return;
        }

        const remaining = maxOutput - combinedBytes;
        if (remaining <= 0) {
          killChild("output");
          return;
        }

        if (chunk.length <= remaining) {
          target.push(chunk);
          combinedBytes += chunk.length;
          return;
        }

        target.push(chunk.subarray(0, remaining));
        combinedBytes += remaining;
        killChild("output");
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        appendChunk(stdoutChunks, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        appendChunk(stderrChunks, chunk);
      });

      if (timeout !== undefined) {
        timeoutTimer = setTimeout(() => {
          killChild("timeout");
        }, timeout);
      }

      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        rejectResult(error);
      });

      child.once("exit", (code, signal) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const exitCode = code ?? (signal ? 1 : 0);
        finish({
          stdout,
          stderr,
          exitCode,
          ...(killed && { killed: true }),
          ...(killedBy && { killedBy }),
        });
      });
    });
  }

  private async readFileInternal(path: string, limit?: number): Promise<string> {
    if (limit !== undefined && limit < 1) {
      throw new Error(`Invalid limit: ${limit}. Must be >= 1.`);
    }

    const safePath = resolveSandboxPath(this.workdir, path);
    const content = await readFile(safePath, "utf-8");
    if (limit === undefined) {
      return content;
    }

    return content.split("\n").slice(0, limit).join("\n");
  }

  private async writeFileInternal(path: string, content: string): Promise<void> {
    const safePath = resolveSandboxPath(this.workdir, path);
    await mkdir(resolve(safePath, ".."), { recursive: true });
    await writeFile(safePath, content, "utf-8");
  }

  private async editFileInternal(path: string, oldText: string, newText: string): Promise<string> {
    const safePath = resolveSandboxPath(this.workdir, path);
    const content = await readFile(safePath, "utf-8");
    const index = content.indexOf(oldText);
    if (index === -1) {
      throw new Error(`old_text not found in ${path}`);
    }
    const secondIndex = content.indexOf(oldText, index + 1);
    if (secondIndex !== -1) {
      throw new Error(`old_text is not unique in ${path} (found at multiple positions)`);
    }
    const updated = content.slice(0, index) + newText + content.slice(index + oldText.length);
    await writeFile(safePath, updated, "utf-8");
    return `Edited ${path}: replaced ${oldText.length} chars with ${newText.length} chars`;
  }
}
