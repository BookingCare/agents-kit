import type { AgentContext, BreakpointCondition, BreakpointStage } from "./types.js";

const createResumePromise = (): {
  promise: Promise<void>;
  resolve: () => void;
} => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

export class BreakpointManager {
  private breakpoints = new Map<BreakpointStage, BreakpointCondition | null>();
  private paused = false;
  private resumeState?: {
    promise: Promise<void>;
    resolve: () => void;
  };

  setBreakpoint(stage: BreakpointStage, condition?: BreakpointCondition): void {
    this.breakpoints.set(stage, condition ?? null);
  }

  clearBreakpoint(stage: BreakpointStage): void {
    this.breakpoints.delete(stage);
  }

  clearAllBreakpoints(): void {
    this.breakpoints.clear();
  }

  isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.resumeState = createResumePromise();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resumeState?.resolve();
    this.resumeState = undefined;
  }

  get resumeWait(): Promise<void> | undefined {
    return this.resumeState?.promise;
  }

  shouldPauseAt(stage: BreakpointStage, context: AgentContext): boolean {
    if (this.paused) return true;

    const condition = this.breakpoints.get(stage);
    if (condition === undefined) return false;
    if (condition === null) return true;
    return condition(context);
  }
}
