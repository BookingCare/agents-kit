import type { AssistantMessage, AssistantMessageEvent } from "../types.js";

// === Generic Event Stream ===

/**
 * A generic push-based async iterable event stream with a typed final result.
 *
 * The producer calls `push()` to emit events and `end()` when done.
 * The consumer iterates with `for await...of` and can await `result()`
 * to get the typed final value extracted from the completing event.
 */
export class EventStream<T, R = void> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void)[] = [];
  private done = false;
  private finalResultPromise: Promise<R>;
  private resolveFinalResult!: (result: R) => void;

  constructor(
    private isComplete: (event: T) => boolean,
    private extractResult: (event: T) => R,
  ) {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  /** Push an event into the stream. No-op once settled. */
  push(event: T): void {
    if (this.done) return;

    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  /** Close the stream manually. Optionally provide the final result directly. */
  end(result?: R): void {
    this.done = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      this.waiting.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  /** Await the typed final result extracted from the completing event or `end()`. */
  result(): Promise<R> {
    return this.finalResultPromise;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) =>
          this.waiting.push(resolve),
        );
        if (result.done) return;
        yield result.value;
      }
    }
  }
}

// === Assistant Message Event Stream ===

export class AssistantMessageEventStream extends EventStream<
  AssistantMessageEvent,
  AssistantMessage
> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        return (event as { type: "error"; reason: unknown; error: AssistantMessage }).error;
      },
    );
  }
}

/** Factory function for AssistantMessageEventStream. */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
}
