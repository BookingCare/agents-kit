import { performance } from "node:perf_hooks";
import type { StoreMetrics, StoreOperationKind, StoreStorageMetrics } from "../types.js";

const ZERO_OPERATIONS: StoreMetrics["operations"] = {
  saves: 0,
  loads: 0,
  queries: 0,
  deletes: 0,
};

const ZERO_PERFORMANCE: StoreMetrics["performance"] = {
  avgLatencyMs: 0,
  maxLatencyMs: 0,
  minLatencyMs: 0,
};

export class StoreMetricsTracker {
  private readonly operations: StoreMetrics["operations"] = { ...ZERO_OPERATIONS };
  private totalLatencyMs = 0;
  private maxLatencyMs = 0;
  private minLatencyMs = Number.POSITIVE_INFINITY;
  private totalOperations = 0;

  async track<T>(kind: StoreOperationKind, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();

    try {
      return await operation();
    } finally {
      this.record(kind, performance.now() - startedAt);
    }
  }

  snapshot(storage: StoreStorageMetrics): StoreMetrics {
    return {
      operations: { ...this.operations },
      performance:
        this.totalOperations === 0
          ? { ...ZERO_PERFORMANCE }
          : {
              avgLatencyMs: this.totalLatencyMs / this.totalOperations,
              maxLatencyMs: this.maxLatencyMs,
              minLatencyMs: this.minLatencyMs,
            },
      storage,
      collectedAt: Date.now(),
    };
  }

  private record(kind: StoreOperationKind, latencyMs: number): void {
    this.operations[kind] += 1;
    this.totalOperations += 1;
    this.totalLatencyMs += latencyMs;
    this.maxLatencyMs = Math.max(this.maxLatencyMs, latencyMs);
    this.minLatencyMs = Math.min(this.minLatencyMs, latencyMs);
  }
}
