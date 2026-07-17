/**
 * Reference NetworkAdapterPort for hermetic CR-102 proofs.
 *
 * Supports scripted outcomes, artificial work units (virtual clock advance via
 * callback), abort honor, non-cooperative ignore-abort, and real-timer sleeps
 * for deadline-race proofs.
 */
import { Effect } from "effect";
import { networkIdentityKey } from "../../capability-registry/keys.js";
import type { NetworkRef } from "../../protocol.js";
import type { ProbeOutcome } from "../../candidate.js";
import type { AdapterProbeRequest, NetworkAdapterPort } from "../ports.js";
import type { MonotonicClock, VirtualClock } from "../clock.js";

export type ScriptedAdapterOutcome =
  | ProbeOutcome
  | ((request: AdapterProbeRequest) => ProbeOutcome);

export interface ScriptedAdapterOptions {
  readonly script: Readonly<Record<string, ScriptedAdapterOutcome>>;
  readonly clock?: MonotonicClock;
  /** Work units (ms) to advance virtual clock per probe before returning. */
  readonly workMsByNetwork?: Readonly<Record<string, number>>;
  /**
   * Real wall-clock sleep (ms) via setTimeout — used for non-cooperative
   * real-timer deadline probes. Independent of virtual clock advance.
   */
  readonly realSleepMsByNetwork?: Readonly<Record<string, number>>;
  /** When true, ignore abort.signal and continue until scripted work finishes. */
  readonly ignoreAbort?: boolean;
  /** Invoked when abort is observed before/during work (cooperative only). */
  readonly onAbort?: (network: NetworkRef) => void;
  /** Track calls for assertions. */
  readonly callLog?: string[];
  /**
   * When set, permute completion order among concurrent probes by sorting keys
   * with this seed — used to prove fanout order cannot affect canonical result.
   */
  readonly completionNoise?: number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const createScriptedNetworkAdapter = (
  options: ScriptedAdapterOptions,
): NetworkAdapterPort & {
  readonly calls: () => ReadonlyArray<string>;
  readonly lastAbortObserved: () => boolean;
  /** Peak overlapping external probe executions (sync or async). */
  readonly peakExternalConcurrency: () => number;
  /** Total external probe starts (must equal calls().length). */
  readonly externalStarts: () => number;
} => {
  const calls: string[] = options.callLog ?? [];
  let lastAbortObserved = false;
  let inflight = 0;
  let peakExternal = 0;
  let externalStarts = 0;

  const beginExternal = (key: string): void => {
    calls.push(key);
    externalStarts += 1;
    inflight += 1;
    if (inflight > peakExternal) peakExternal = inflight;
  };

  const endExternal = (): void => {
    inflight = Math.max(0, inflight - 1);
  };

  return {
    calls: () => [...calls],
    lastAbortObserved: () => lastAbortObserved,
    peakExternalConcurrency: () => peakExternal,
    externalStarts: () => externalStarts,
    probe: (request) => {
      const key = networkIdentityKey(request.network);
      const work = options.workMsByNetwork?.[key] ?? 0;
      const realSleepMs = options.realSleepMsByNetwork?.[key] ?? 0;
      const ignoreAbort = options.ignoreAbort === true;

      const finish = (): ProbeOutcome => {
        const scripted = options.script[key];
        if (scripted === undefined) {
          return { kind: "miss" } as const;
        }
        return typeof scripted === "function" ? scripted(request) : scripted;
      };

      const aborted = (): boolean =>
        request.abort.aborted || request.abort.signal.aborted;

      // Real-timer path (async) — non-cooperative probes sleep wall time.
      if (realSleepMs > 0) {
        return Effect.promise(async () => {
          beginExternal(key);
          try {
            if (!ignoreAbort && aborted()) {
              lastAbortObserved = true;
              options.onAbort?.(request.network);
              return { kind: "timeout" } as const;
            }
            const onAbortEvent = () => {
              lastAbortObserved = true;
              options.onAbort?.(request.network);
            };
            if (!ignoreAbort) {
              request.abort.signal.addEventListener("abort", onAbortEvent, { once: true });
            }
            try {
              await realSleep(realSleepMs);
            } finally {
              if (!ignoreAbort) {
                request.abort.signal.removeEventListener("abort", onAbortEvent);
              }
            }
            if (!ignoreAbort && aborted()) {
              lastAbortObserved = true;
              options.onAbort?.(request.network);
              return { kind: "timeout" } as const;
            }
            if (!ignoreAbort && options.clock !== undefined && options.clock.nowMs() >= request.deadline_at_ms) {
              return { kind: "timeout" } as const;
            }
            return finish();
          } finally {
            endExternal();
          }
        });
      }

      return Effect.sync(() => {
        beginExternal(key);
        try {
          if (!ignoreAbort && aborted()) {
            lastAbortObserved = true;
            options.onAbort?.(request.network);
            return { kind: "timeout" } as const;
          }

          if (work > 0 && options.clock !== undefined && "advanceMs" in options.clock) {
            // Chunk work so abort can be observed mid-flight under virtual time.
            const chunk = Math.max(1, Math.floor(work / 3));
            let remaining = work;
            while (remaining > 0) {
              if (!ignoreAbort && aborted()) {
                lastAbortObserved = true;
                options.onAbort?.(request.network);
                return { kind: "timeout" } as const;
              }
              const step = Math.min(chunk, remaining);
              (options.clock as VirtualClock).advanceMs(step);
              remaining -= step;
              if (!ignoreAbort && options.clock.nowMs() >= request.deadline_at_ms) {
                return { kind: "timeout" } as const;
              }
            }
          }

          if (!ignoreAbort && aborted()) {
            lastAbortObserved = true;
            options.onAbort?.(request.network);
            return { kind: "timeout" } as const;
          }

          if (!ignoreAbort && options.clock !== undefined && options.clock.nowMs() >= request.deadline_at_ms) {
            return { kind: "timeout" } as const;
          }

          return finish();
        } finally {
          endExternal();
        }
      });
    },
  };
};
