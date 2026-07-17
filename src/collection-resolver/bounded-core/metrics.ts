import type { BoundedResolverMetrics, MetricsPort } from "./ports.js";

export const createMemoryMetrics = (): MetricsPort => {
  const state: BoundedResolverMetrics = {
    adapter_calls: 0,
    peak_concurrency: 0,
    cache_positive_hit: 0,
    cache_positive_miss: 0,
    cache_readiness_hit: 0,
    cache_readiness_miss: 0,
    cache_negative_hit: 0,
    cache_negative_miss: 0,
    coalesced: 0,
    timeouts: 0,
    partials: 0,
    rate_limited: 0,
    latencies_ms: [],
  };

  return {
    snapshot: () => ({
      ...state,
      latencies_ms: [...state.latencies_ms],
    }),
    recordLatency: (ms) => {
      state.latencies_ms.push(ms);
    },
    incr: (field, by = 1) => {
      state[field] += by;
    },
    observeConcurrency: (current) => {
      if (current > state.peak_concurrency) {
        state.peak_concurrency = current;
      }
    },
  };
};

export const percentile = (samples: ReadonlyArray<number>, p: number): number => {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
};
