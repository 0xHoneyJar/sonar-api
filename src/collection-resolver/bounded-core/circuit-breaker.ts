import { Effect } from "effect";
import type { CircuitBreakerPort, CircuitState } from "./ports.js";
import type { BoundedResolverConfig } from "./schemas.js";

interface BreakerBucket {
  state: CircuitState;
  failures: number;
  opened_at_ms: number;
  half_open_probes: number;
}

const keyOf = (network_key: string, operation: string): string =>
  `${network_key}::${operation}`;

/**
 * Per network+operation circuit breaker with closed/open/half-open transitions.
 * Uses monotonic server time. CR-101 disable/security is enforced by the
 * orchestrator BEFORE consulting the breaker (disable takes precedence).
 */
export const createMemoryCircuitBreaker = (
  config: BoundedResolverConfig["circuit_breaker"],
): CircuitBreakerPort => {
  const buckets = new Map<string, BreakerBucket>();

  const get = (network_key: string, operation: string): BreakerBucket => {
    const key = keyOf(network_key, operation);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        state: "closed",
        failures: 0,
        opened_at_ms: 0,
        half_open_probes: 0,
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const transition = (bucket: BreakerBucket, now_ms: number): CircuitState => {
    if (bucket.state === "open") {
      if (now_ms - bucket.opened_at_ms >= config.open_ms) {
        bucket.state = "half_open";
        bucket.half_open_probes = 0;
      }
    }
    return bucket.state;
  };

  return {
    beforeCall: ({ network_key, operation, now_ms }) =>
      Effect.sync(() => {
        const bucket = get(network_key, operation);
        const state = transition(bucket, now_ms);
        if (state === "open") {
          const retry_after_ms = Math.max(0, config.open_ms - (now_ms - bucket.opened_at_ms));
          return { allow: false as const, state, retry_after_ms };
        }
        if (state === "half_open") {
          if (bucket.half_open_probes >= config.half_open_max_probes) {
            return {
              allow: false as const,
              state,
              retry_after_ms: config.open_ms,
            };
          }
          bucket.half_open_probes += 1;
          return { allow: true as const, state };
        }
        return { allow: true as const, state };
      }),

    recordSuccess: ({ network_key, operation, now_ms }) =>
      Effect.sync(() => {
        const bucket = get(network_key, operation);
        transition(bucket, now_ms);
        bucket.state = "closed";
        bucket.failures = 0;
        bucket.half_open_probes = 0;
      }),

    recordFailure: ({ network_key, operation, now_ms }) =>
      Effect.sync(() => {
        const bucket = get(network_key, operation);
        transition(bucket, now_ms);
        if (bucket.state === "half_open") {
          bucket.state = "open";
          bucket.opened_at_ms = now_ms;
          bucket.half_open_probes = 0;
          bucket.failures = config.failure_threshold;
          return;
        }
        bucket.failures += 1;
        if (bucket.failures >= config.failure_threshold) {
          bucket.state = "open";
          bucket.opened_at_ms = now_ms;
        }
      }),

    getState: ({ network_key, operation, now_ms }) => {
      const bucket = get(network_key, operation);
      return transition(bucket, now_ms);
    },
  };
};
