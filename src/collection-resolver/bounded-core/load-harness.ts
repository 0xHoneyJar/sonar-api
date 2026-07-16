/**
 * Deterministic load/benchmark harness for CR-102.
 *
 * Proves successful uncached and mixed workloads with independent / deliberately
 * partitioned cache+query scenarios and explicit warm/cold phases.
 * Failures and rate-limits are included in the denominator — never omitted.
 *
 * Acceptance cannot be lowered by caller options: `uncached_fanout_met` uses
 * cold-phase adapter calls only against a non-configurable floor derived from
 * cold iterations × expected healthy targets. Warm cache/coalescing metrics
 * remain separate observations.
 */
import { Effect, Exit } from "effect";
import {
  createHermeticBoundedDeps,
  hermeticResolveRequest,
  MULTI_CHAIN_EVM_ADDRESS,
} from "./fixtures.js";
import { percentile } from "./metrics.js";
import { resolveBounded } from "./resolve-bounded.js";
import { defaultBoundedResolverConfig } from "./config.js";
import type { BoundedResolverConfig } from "./schemas.js";
import {
  SCRIPT_EVM_ERC721,
  SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
  SCRIPT_ZERO_CANDIDATES,
} from "../hermetic-fixtures.js";
import { createVirtualClock } from "./clock.js";

/** Expected healthy EVM targets in the hermetic multi-chain fixture. */
export const LOAD_HARNESS_EXPECTED_HEALTHY_TARGETS = 2;

/**
 * Non-configurable acceptance floor ratio for representative cold workload
 * success. Callers cannot lower this away.
 */
export const LOAD_HARNESS_SUCCESS_RATIO_FLOOR = 0.75;

export interface LoadHarnessReport {
  readonly iterations: number;
  /** Successful resolve completions across cold+warm (candidates path or conclusive zero). */
  readonly successful_completions: number;
  /** Failures + rate-limited (included in denominator). */
  readonly failure_or_rate_limited: number;
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly max_ms: number;
  readonly timeout_count: number;
  readonly partial_count: number;
  /** Aggregate adapter calls (cold + warm observations). */
  readonly adapter_calls: number;
  /** Cold-phase adapter calls only — acceptance floor input. */
  readonly cold_adapter_calls: number;
  /** Cold-phase successful completions only. */
  readonly cold_successful_completions: number;
  /** Expected minimum cold adapter calls: cold_iterations × expected healthy targets. */
  readonly expected_adapter_calls_min: number;
  readonly peak_concurrency: number;
  readonly cache_positive_hit: number;
  readonly cache_positive_miss: number;
  readonly cache_negative_hit: number;
  readonly cache_negative_miss: number;
  readonly coalesced: number;
  readonly cold_phase_iterations: number;
  readonly warm_phase_iterations: number;
  /** Warm-phase adapter calls (observation only — not acceptance). */
  readonly warm_adapter_calls: number;
  readonly within_four_second_budget: boolean;
  readonly virtual_elapsed_ms: number;
  /**
   * Acceptance: documented representative workload success floor AND cold
   * uncached fanout; denominator includes every failure/rate-limit.
   * `min_successful` is derived (not caller-lowerable).
   */
  readonly acceptance: {
    readonly min_successful: number;
    readonly successful_met: boolean;
    readonly uncached_fanout_met: boolean;
    readonly denominator: number;
  };
}

/**
 * Run partitioned cold (uncached) then warm phases against independent caches
 * so contradictory scripts never share one negative-cache identity incorrectly.
 *
 * `min_successful` is intentionally NOT accepted from callers — acceptance uses
 * a fixed floor derived from iterations × LOAD_HARNESS_SUCCESS_RATIO_FLOOR.
 */
export const runDeterministicLoadHarness = (input?: {
  readonly iterations?: number;
  readonly config?: BoundedResolverConfig;
  readonly workMsPerProbe?: number;
  /**
   * @deprecated Ignored — acceptance floor is non-configurable.
   * Retained only so accidental callers cannot lower the criterion.
   */
  readonly min_successful?: number;
}): LoadHarnessReport => {
  const iterations = input?.iterations ?? 64;
  const coldCount = Math.ceil(iterations / 2);
  const warmCount = iterations - coldCount;
  const workMs = input?.workMsPerProbe ?? 5;
  // Non-configurable floor — caller `min_successful` cannot lower acceptance.
  const min_successful = Math.floor(iterations * LOAD_HARNESS_SUCCESS_RATIO_FLOOR);
  const config = input?.config ?? defaultBoundedResolverConfig();
  const expectedHealthyTargets = LOAD_HARNESS_EXPECTED_HEALTHY_TARGETS;

  // Shared virtual clock across phases for aggregate elapsed budget.
  const clock = createVirtualClock({ originMs: 0 });
  const wallStart = clock.nowMs();

  // Phase A — cold uncached fanout on an isolated cache (positive multi-chain).
  const cold = createHermeticBoundedDeps({
    clock,
    config,
    script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
    workMsByNetwork: { "eip155:1": workMs, "eip155:8453": workMs },
  });

  let successful_completions = 0;
  let failure_or_rate_limited = 0;
  let cold_successful_completions = 0;

  for (let i = 0; i < coldCount; i++) {
    const active =
      i === 0
        ? cold
        : createHermeticBoundedDeps({
            clock,
            config,
            script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
            workMsByNetwork: { "eip155:1": workMs, "eip155:8453": workMs },
            capabilitySnapshot: cold.deps.capabilitySnapshot,
          });
    // Distinct caller buckets avoid artificial rate-limit skew in the cold phase.
    const exit = Effect.runSyncExit(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, `cold-${i}`),
        config: active.config,
        deps: {
          ...active.deps,
          metrics: cold.deps.metrics,
          rateLimiter: cold.deps.rateLimiter,
        },
      }),
    );
    if (Exit.isSuccess(exit)) {
      successful_completions += 1;
      cold_successful_completions += 1;
    } else if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      failure_or_rate_limited += 1;
      if (exit.cause.error._tag === "ResolverRateLimitedError") {
        cold.deps.metrics.incr("rate_limited");
      }
    } else {
      failure_or_rate_limited += 1;
    }
  }

  const coldSnap = cold.deps.metrics.snapshot();
  const cold_adapter_calls = coldSnap.adapter_calls;

  // Phase B — warm mixed workload on a SEPARATE cache/query partition so
  // zero-candidate scripts cannot poison the positive cold identity.
  const warm = createHermeticBoundedDeps({
    clock,
    config: {
      ...config,
      // Partition rate limits so warm-phase 429s are measurable but don't erase cold successes.
      caller_rate_limit: { limit: 8, window_ms: 60_000, max_cardinality: 100 },
      global_rate_limit: { limit: 2_000, window_ms: 1_000 },
    },
    script: SCRIPT_EVM_ERC721,
    workMsByNetwork: { "eip155:1": workMs, "eip155:8453": workMs },
  });
  // Aggregate warm metrics separately; cold metrics stay authoritative for fanout.
  const warmMetrics = warm.deps.metrics;

  for (let i = 0; i < warmCount; i++) {
    const useZero = i % 4 === 3;
    const active = useZero
      ? createHermeticBoundedDeps({
          clock,
          config: warm.config,
          script: SCRIPT_ZERO_CANDIDATES,
          workMsByNetwork: { "eip155:1": workMs, "eip155:8453": workMs },
        })
      : warm;

    const exit = Effect.runSyncExit(
      resolveBounded({
        request: hermeticResolveRequest(
          MULTI_CHAIN_EVM_ADDRESS,
          // Deliberately collide some buckets to exercise rate-limit denominator.
          i % 5 === 0 ? "warm-shared" : `warm-${i}`,
        ),
        config: active.config,
        deps: {
          ...active.deps,
          metrics: warmMetrics,
          rateLimiter: warm.deps.rateLimiter,
        },
      }),
    );
    if (Exit.isSuccess(exit)) {
      successful_completions += 1;
    } else {
      failure_or_rate_limited += 1;
      if (
        Exit.isFailure(exit) &&
        exit.cause._tag === "Fail" &&
        exit.cause.error._tag === "ResolverRateLimitedError"
      ) {
        warmMetrics.incr("rate_limited");
      }
    }
  }

  const warmSnap = warmMetrics.snapshot();
  const warm_adapter_calls = warmSnap.adapter_calls;
  const adapter_calls = cold_adapter_calls + warm_adapter_calls;

  // Representative uncached fanout: COLD calls only (cold iterations × healthy targets).
  const expected_adapter_calls_min = coldCount * expectedHealthyTargets;
  const uncached_fanout_met = cold_adapter_calls >= expected_adapter_calls_min;

  const virtual_elapsed_ms = clock.nowMs() - wallStart;
  const allLatencies = [...coldSnap.latencies_ms, ...warmSnap.latencies_ms];
  const p50_ms = percentile(allLatencies, 50);
  const p95_ms = percentile(allLatencies, 95);
  const max_ms = allLatencies.length === 0 ? 0 : Math.max(...allLatencies);
  const denominator = successful_completions + failure_or_rate_limited;
  const successful_met = successful_completions >= min_successful;
  const within_four_second_budget =
    virtual_elapsed_ms <= 4_000 &&
    max_ms <= 4_000 &&
    successful_met &&
    uncached_fanout_met &&
    denominator === iterations;

  return {
    iterations,
    successful_completions,
    failure_or_rate_limited,
    p50_ms,
    p95_ms,
    max_ms,
    timeout_count: coldSnap.timeouts + warmSnap.timeouts,
    partial_count: coldSnap.partials + warmSnap.partials,
    adapter_calls,
    cold_adapter_calls,
    cold_successful_completions,
    expected_adapter_calls_min,
    peak_concurrency: Math.max(coldSnap.peak_concurrency, warmSnap.peak_concurrency),
    cache_positive_hit: coldSnap.cache_positive_hit + warmSnap.cache_positive_hit,
    cache_positive_miss: coldSnap.cache_positive_miss + warmSnap.cache_positive_miss,
    cache_negative_hit: coldSnap.cache_negative_hit + warmSnap.cache_negative_hit,
    cache_negative_miss: coldSnap.cache_negative_miss + warmSnap.cache_negative_miss,
    coalesced: coldSnap.coalesced + warmSnap.coalesced,
    cold_phase_iterations: coldCount,
    warm_phase_iterations: warmCount,
    warm_adapter_calls,
    within_four_second_budget,
    virtual_elapsed_ms,
    acceptance: {
      min_successful,
      successful_met,
      uncached_fanout_met,
      denominator,
    },
  };
};

/**
 * Adversarial cold-only probe: 23/24 cold requests rate-limited must fail
 * acceptance regardless of warm calls or attempted min_successful lowering.
 */
export const runColdRateLimitDenialHarness = (input?: {
  readonly cold_iterations?: number;
  readonly allowed_cold_successes?: number;
}): LoadHarnessReport => {
  const cold_iterations = input?.cold_iterations ?? 24;
  const allowed = input?.allowed_cold_successes ?? 1;
  const config = {
    ...defaultBoundedResolverConfig(),
    caller_rate_limit: {
      limit: allowed,
      window_ms: 60_000,
      max_cardinality: 10,
    },
    global_rate_limit: { limit: 2_000, window_ms: 1_000 },
  };
  // Force a single shared caller bucket so 23/24 are rate-limited after `allowed` successes.
  const clock = createVirtualClock({ originMs: 0 });
  const cold = createHermeticBoundedDeps({
    clock,
    config,
    script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
    workMsByNetwork: { "eip155:1": 1, "eip155:8453": 1 },
  });

  let successful_completions = 0;
  let failure_or_rate_limited = 0;
  let cold_successful_completions = 0;

  for (let i = 0; i < cold_iterations; i++) {
    const exit = Effect.runSyncExit(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "cold-shared"),
        config: cold.config,
        deps: cold.deps,
      }),
    );
    if (Exit.isSuccess(exit)) {
      successful_completions += 1;
      cold_successful_completions += 1;
    } else {
      failure_or_rate_limited += 1;
    }
  }

  const snap = cold.deps.metrics.snapshot();
  const cold_adapter_calls = snap.adapter_calls;
  const expected_adapter_calls_min = cold_iterations * LOAD_HARNESS_EXPECTED_HEALTHY_TARGETS;
  const min_successful = Math.floor(cold_iterations * LOAD_HARNESS_SUCCESS_RATIO_FLOOR);
  const denominator = successful_completions + failure_or_rate_limited;
  const successful_met = successful_completions >= min_successful;
  const uncached_fanout_met = cold_adapter_calls >= expected_adapter_calls_min;

  return {
    iterations: cold_iterations,
    successful_completions,
    failure_or_rate_limited,
    p50_ms: percentile(snap.latencies_ms, 50),
    p95_ms: percentile(snap.latencies_ms, 95),
    max_ms: snap.latencies_ms.length === 0 ? 0 : Math.max(...snap.latencies_ms),
    timeout_count: snap.timeouts,
    partial_count: snap.partials,
    adapter_calls: cold_adapter_calls,
    cold_adapter_calls,
    cold_successful_completions,
    expected_adapter_calls_min,
    peak_concurrency: snap.peak_concurrency,
    cache_positive_hit: snap.cache_positive_hit,
    cache_positive_miss: snap.cache_positive_miss,
    cache_negative_hit: snap.cache_negative_hit,
    cache_negative_miss: snap.cache_negative_miss,
    coalesced: snap.coalesced,
    cold_phase_iterations: cold_iterations,
    warm_phase_iterations: 0,
    warm_adapter_calls: 0,
    within_four_second_budget: false,
    virtual_elapsed_ms: clock.nowMs(),
    acceptance: {
      min_successful,
      successful_met,
      uncached_fanout_met,
      denominator,
    },
  };
};
