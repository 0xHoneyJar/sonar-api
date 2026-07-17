import { Effect } from "effect";
import type { CircuitBreakerPort, CircuitState, RecognitionObserverPort } from "./ports.js";
import type { BoundedResolverConfig } from "./schemas.js";

interface BreakerBucket {
  state: CircuitState;
  failures: number;
  opened_at_ms: number;
  half_open_probes: number;
}

const keyOf = (network_key: string, operation: string): string =>
  `${network_key}::${operation}`;

export interface CircuitBreakerOptions {
  /**
   * Observability hook for closed/open/half_open transitions.
   * Receives network_key + from/to only — never couples to a concrete exporter.
   */
  readonly onTransition?: (event: {
    readonly network_key: string;
    readonly from: CircuitState;
    readonly to: CircuitState;
  }) => void;
  /**
   * Optional observer — emits typed circuit_transition events through the same
   * strict decode / identity / network_key allowlist enforcement as resolveBounded.
   */
  readonly observer?: RecognitionObserverPort;
}

/**
 * Per network+operation circuit breaker with closed/open/half-open transitions.
 * Uses monotonic server time. CR-101 disable/security is enforced by the
 * orchestrator BEFORE consulting the breaker (disable takes precedence).
 * Transient breaker health is NEVER converted into a capability disable.
 */
export const createMemoryCircuitBreaker = (
  config: BoundedResolverConfig["circuit_breaker"],
  options: CircuitBreakerOptions = {},
): CircuitBreakerPort => {
  const buckets = new Map<string, BreakerBucket>();

  const emitTransition = (
    network_key: string,
    from: CircuitState,
    to: CircuitState,
  ): void => {
    if (from === to) return;
    options.onTransition?.({ network_key, from, to });
    options.observer?.record({
      kind: "circuit_transition",
      network_key,
      circuit_from: from,
      circuit_to: to,
    });
  };

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

  const transition = (
    network_key: string,
    bucket: BreakerBucket,
    now_ms: number,
  ): CircuitState => {
    if (bucket.state === "open") {
      if (now_ms - bucket.opened_at_ms >= config.open_ms) {
        const from = bucket.state;
        bucket.state = "half_open";
        bucket.half_open_probes = 0;
        emitTransition(network_key, from, "half_open");
      }
    }
    return bucket.state;
  };

  return {
    beforeCall: ({ network_key, operation, now_ms }) =>
      Effect.sync(() => {
        const bucket = get(network_key, operation);
        const state = transition(network_key, bucket, now_ms);
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
        transition(network_key, bucket, now_ms);
        const from = bucket.state;
        bucket.state = "closed";
        bucket.failures = 0;
        bucket.half_open_probes = 0;
        if (from !== "closed") {
          emitTransition(network_key, from, "closed");
        }
      }),

    recordFailure: ({ network_key, operation, now_ms }) =>
      Effect.sync(() => {
        const bucket = get(network_key, operation);
        transition(network_key, bucket, now_ms);
        if (bucket.state === "half_open") {
          const from = bucket.state;
          bucket.state = "open";
          bucket.opened_at_ms = now_ms;
          bucket.half_open_probes = 0;
          bucket.failures = config.failure_threshold;
          emitTransition(network_key, from, "open");
          return;
        }
        bucket.failures += 1;
        if (bucket.failures >= config.failure_threshold) {
          const from = bucket.state;
          bucket.state = "open";
          bucket.opened_at_ms = now_ms;
          emitTransition(network_key, from, "open");
        }
      }),

    getState: ({ network_key, operation, now_ms }) => {
      const bucket = get(network_key, operation);
      return transition(network_key, bucket, now_ms);
    },
  };
};
