import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Sandbox, SandboxExecOptions, SandboxOptions, SandboxResult } from "../types.js";
import { resolveSandboxPath } from "./path.js";

const KILL_GRACE_MS = 1000;
const DEFAULT_MEMORY_LIMIT_KB_DIVISOR = 1024;

function formatExecCommand(command: string, maxMemory?: number): string {
  if (maxMemory === undefined || process.platform === "win32") {
    return command;
  }

  const memoryLimitKb = Math.floor(maxMemory / DEFAULT_MEMORY_LIMIT_KB_DIVISOR);
  return `ulimit -v ${memoryLimitKb}; ${command}`;
}

function mergeEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...(env ?? {}) };
}

export class LocalSandbox implements Sandbox {
  private readonly workdir: string;
  private readonly timeout?: number;
  private readonly maxMemory?: number;
  private readonly maxOutput?: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: SandboxOptions) {
    this.workdir = resolve(options.workdir);
    mkdirSync(this.workdir, { recursive: true });
    this.timeout = options.timeout;
    this.maxMemory = options.maxMemory;
    this.maxOutput = options.maxOutput;
    this.env = mergeEnv(options.env);
  }

  public async exec(command: string, options?: SandboxExecOptions): Promise<SandboxResult> {
    const timeout = options?.timeout ?? this.timeout;
    const maxOutput = options?.maxOutput ?? this.maxOutput;
    const shellCommand = formatExecCommand(command, this.maxMemory);

    return await new Promise<SandboxResult>((resolveResult, rejectResult) => {
      const child = spawn(shellCommand, {
        shell: true,
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
        if (settled || killed) {
          return;
        }
        killed = true;
        killedBy = reason;
        child.kill();
        forceKillTimer = setTimeout(() => {
          child.kill("SIGKILL");
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

  public async readFile(path: string, limit?: number): Promise<string> {
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

  public async writeFile(path: string, content: string): Promise<void> {
    const safePath = resolveSandboxPath(this.workdir, path);
    await mkdir(resolve(safePath, ".."), { recursive: true });
    await writeFile(safePath, content, "utf-8");
  }
}
