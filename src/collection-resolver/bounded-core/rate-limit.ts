import { Effect } from "effect";
import type { RateLimitDecision, RateLimitDenied, RateLimiterPort } from "./ports.js";
import type { BoundedResolverConfig } from "./schemas.js";

interface WindowCounter {
  window_start_ms: number;
  count: number;
}

/**
 * Caller + global rate limits with bounded windows/cardinality and typed 429 metadata.
 */
export const createMemoryRateLimiter = (config: {
  readonly caller: BoundedResolverConfig["caller_rate_limit"];
  readonly global: BoundedResolverConfig["global_rate_limit"];
}): RateLimiterPort => {
  const callerBuckets = new Map<string, WindowCounter>();
  let globalWindow: WindowCounter = { window_start_ms: 0, count: 0 };

  const roll = (counter: WindowCounter, now_ms: number, window_ms: number): WindowCounter => {
    if (now_ms - counter.window_start_ms >= window_ms) {
      return { window_start_ms: now_ms, count: 0 };
    }
    return counter;
  };

  const retryAfter = (counter: WindowCounter, now_ms: number, window_ms: number): number =>
    Math.max(1, window_ms - (now_ms - counter.window_start_ms));

  return {
    tryAcquire: ({ caller_bucket_id, now_ms }) =>
      Effect.sync(() => {
        globalWindow = roll(globalWindow, now_ms, config.global.window_ms);
        if (globalWindow.count >= config.global.limit) {
          const denied: RateLimitDenied = {
            allowed: false,
            scope: "global",
            retry_after_ms: retryAfter(globalWindow, now_ms, config.global.window_ms),
            limit: config.global.limit,
            window_ms: config.global.window_ms,
          };
          return denied;
        }

        let caller = callerBuckets.get(caller_bucket_id);
        if (caller === undefined) {
          if (callerBuckets.size >= config.caller.max_cardinality) {
            // Evict oldest window (deterministic: first inserted key).
            const first = callerBuckets.keys().next().value;
            if (first !== undefined) callerBuckets.delete(first);
          }
          caller = { window_start_ms: now_ms, count: 0 };
        } else {
          caller = roll(caller, now_ms, config.caller.window_ms);
        }

        if (caller.count >= config.caller.limit) {
          callerBuckets.set(caller_bucket_id, caller);
          const denied: RateLimitDenied = {
            allowed: false,
            scope: "caller",
            retry_after_ms: retryAfter(caller, now_ms, config.caller.window_ms),
            limit: config.caller.limit,
            window_ms: config.caller.window_ms,
          };
          return denied;
        }

        caller = { ...caller, count: caller.count + 1 };
        callerBuckets.set(caller_bucket_id, caller);
        globalWindow = { ...globalWindow, count: globalWindow.count + 1 };

        const allowed: RateLimitDecision = { allowed: true };
        return allowed;
      }),
  };
};
