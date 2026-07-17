import { Effect } from "effect";
import type { CoalescePort, CoalesceSealedResult } from "./ports.js";

type InflightEntry = {
  readonly promise: Promise<CoalesceSealedResult>;
  readonly resolve: (result: CoalesceSealedResult) => void;
  settled: boolean;
};

/**
 * Coalesce identical in-flight demand so repeated submits cannot amplify fanout.
 *
 * The in-flight registry stores one shared immutable promise/result per canonical
 * request key. Followers await the leader result (or an honest bounded timeout).
 * The entry is cleaned exactly once after the leader settles.
 */
export const createMemoryCoalesce = (input: {
  readonly isNegativeCached: (key: string) => boolean;
}): CoalescePort => {
  const inflight = new Map<string, InflightEntry>();

  return {
    begin: (coalesceKey) =>
      Effect.sync(() => {
        if (input.isNegativeCached(coalesceKey)) {
          return { kind: "negative_cached" as const };
        }
        const existing = inflight.get(coalesceKey);
        if (existing !== undefined) {
          return {
            kind: "follower" as const,
            wait_for_leader: true as const,
            shared: existing.promise,
          };
        }
        let resolve!: (result: CoalesceSealedResult) => void;
        const promise = new Promise<CoalesceSealedResult>((r) => {
          resolve = r;
        });
        inflight.set(coalesceKey, { promise, resolve, settled: false });
        return { kind: "leader" as const };
      }),

    complete: (coalesceKey, result) =>
      Effect.sync(() => {
        const entry = inflight.get(coalesceKey);
        if (entry === undefined) return;
        if (!entry.settled) {
          entry.settled = true;
          // Freeze a shallow copy so followers observe an immutable sealed result.
          entry.resolve(Object.freeze({ ...result }) as CoalesceSealedResult);
        }
        inflight.delete(coalesceKey);
      }),
  };
};
