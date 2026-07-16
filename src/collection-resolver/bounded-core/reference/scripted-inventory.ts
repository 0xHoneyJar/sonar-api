import { Effect } from "effect";
import type {
  InventoryEnrichmentPort,
  InventoryEnrichmentRequest,
  InventoryEnrichmentResult,
} from "../ports.js";
import type { MonotonicClock, VirtualClock } from "../clock.js";

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const createScriptedInventoryPort = (input: {
  readonly results?: ReadonlyArray<InventoryEnrichmentResult>;
  readonly byDeployment?: Readonly<Record<string, InventoryEnrichmentResult>>;
  readonly clock?: MonotonicClock;
  readonly workMs?: number;
  /** Real wall-clock sleep for non-cooperative Inventory deadline probes. */
  readonly realSleepMs?: number;
  /** When true, ignore abort and finish scripted work anyway. */
  readonly ignoreAbort?: boolean;
  readonly onAbort?: () => void;
  readonly failWith?: Extract<InventoryEnrichmentResult, { kind: "error" | "timeout" }>;
  /** Track enrich invocations for single-execution assertions. */
  readonly callLog?: string[];
}): InventoryEnrichmentPort & {
  readonly lastAbortObserved: () => boolean;
  readonly calls: () => ReadonlyArray<string>;
} => {
  let lastAbortObserved = false;
  const calls: string[] = input.callLog ?? [];

  const finish = (request: InventoryEnrichmentRequest): InventoryEnrichmentResult[] => {
    if (input.failWith !== undefined) {
      return [input.failWith];
    }
    if (input.results !== undefined) return [...input.results];
    if (input.byDeployment !== undefined) {
      return request.deployment_ids.map(
        (id) =>
          input.byDeployment![id] ??
          ({ kind: "miss" } as const),
      );
    }
    return request.deployment_ids.map(() => ({ kind: "miss" as const }));
  };

  const recordCall = (request: InventoryEnrichmentRequest): void => {
    calls.push(`enrich:${request.deployment_ids.length}`);
  };

  return {
    lastAbortObserved: () => lastAbortObserved,
    calls: () => [...calls],
    enrich: (request: InventoryEnrichmentRequest) => {
      const ignoreAbort = input.ignoreAbort === true;
      const aborted = (): boolean =>
        request.abort.aborted || request.abort.signal.aborted;

      if (input.realSleepMs !== undefined && input.realSleepMs > 0) {
        return Effect.promise(async () => {
          recordCall(request);
          if (!ignoreAbort && aborted()) {
            lastAbortObserved = true;
            input.onAbort?.();
            return [
              {
                kind: "timeout" as const,
                safe_message: "inventory enrichment aborted",
              },
            ];
          }
          const onAbortEvent = () => {
            lastAbortObserved = true;
            input.onAbort?.();
          };
          if (!ignoreAbort) {
            request.abort.signal.addEventListener("abort", onAbortEvent, { once: true });
          }
          try {
            await realSleep(input.realSleepMs!);
          } finally {
            if (!ignoreAbort) {
              request.abort.signal.removeEventListener("abort", onAbortEvent);
            }
          }
          if (!ignoreAbort && aborted()) {
            lastAbortObserved = true;
            input.onAbort?.();
            return [
              {
                kind: "timeout" as const,
                safe_message: "inventory enrichment aborted",
              },
            ];
          }
          if (!ignoreAbort && input.clock !== undefined && input.clock.nowMs() >= request.deadline_at_ms) {
            return [
              {
                kind: "timeout" as const,
                safe_message: "inventory enrichment deadline exceeded",
              },
            ];
          }
          return finish(request);
        });
      }

      return Effect.sync(() => {
        recordCall(request);
        if (!ignoreAbort && aborted()) {
          lastAbortObserved = true;
          input.onAbort?.();
          return [
            {
              kind: "timeout" as const,
              safe_message: "inventory enrichment aborted",
            },
          ];
        }
        if (input.workMs !== undefined && input.workMs > 0 && input.clock && "advanceMs" in input.clock) {
          (input.clock as VirtualClock).advanceMs(input.workMs);
        }
        if (!ignoreAbort && input.clock !== undefined && input.clock.nowMs() >= request.deadline_at_ms) {
          return [
            {
              kind: "timeout" as const,
              safe_message: "inventory enrichment deadline exceeded",
            },
          ];
        }
        return finish(request);
      });
    },
  };
};
