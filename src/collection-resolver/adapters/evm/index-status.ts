/**
 * Kitchen index-status seam wrapper for CR-103.
 *
 * Maps Kitchen CollectionIndexStatus → CollectionCandidate index_status.
 * Capability `index_support` is applied by the adapter (not this port).
 */
import { Effect } from "effect";
import {
  resolveCollectionStatus,
  type CollectionStatusReader,
  type IndexedSnapshot,
} from "../../../kitchen/status.js";
import type { CollectionKey, IngestJobRecord } from "../../../kitchen/types.js";
import type { CollectionCandidate } from "../../protocol.js";
import type {
  DeadlineTimerPort,
  MonotonicClock,
} from "../../bounded-core/clock.js";
import type { ChainQualifiedIndexStatusPort } from "./ports.js";

export type KitchenJobLookup = (
  key: CollectionKey,
) => Promise<IngestJobRecord | undefined>;

const mapKitchenStatus = (
  status: ReturnType<typeof resolveCollectionStatus>,
): CollectionCandidate["index_status"] => {
  switch (status) {
    case "indexed":
      return "indexed";
    case "indexing":
      return "indexing";
    case "failed":
      return "failed";
    case "missing":
      return "missing";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
};

/**
 * Wrap Kitchen reader (+ optional ingest job store) as an abort-aware Effect port.
 */
export const createKitchenIndexStatusPort = (deps: {
  readonly reader: CollectionStatusReader;
  readonly getJob?: KitchenJobLookup;
  readonly clock: MonotonicClock & DeadlineTimerPort;
}): ChainQualifiedIndexStatusPort => ({
  lookup: (input) =>
    Effect.promise(async () => {
      if (input.abort.aborted || deps.clock.nowMs() >= input.deadline_at_ms) {
        return "unknown";
      }
      const key: CollectionKey = {
        chainId: input.chain_id,
        contract: input.normalized_address,
      };
      return new Promise<CollectionCandidate["index_status"]>((resolve) => {
        let settled = false;
        let cancelDeadline = (): void => undefined;
        const finish = (status: CollectionCandidate["index_status"]): void => {
          if (settled) return;
          settled = true;
          cancelDeadline();
          input.abort.removeEventListener("abort", onAbort);
          resolve(status);
        };
        const onAbort = (): void => finish("unknown");

        input.abort.addEventListener("abort", onAbort, { once: true });
        cancelDeadline = deps.clock.scheduleAt(input.deadline_at_ms, () =>
          finish("unknown"),
        );

        void (async () => {
          try {
            const indexed: IndexedSnapshot =
              await deps.reader.readIndexedSnapshot(key);
            if (
              input.abort.aborted ||
              deps.clock.nowMs() >= input.deadline_at_ms
            ) {
              finish("unknown");
              return;
            }
            const job = deps.getJob ? await deps.getJob(key) : undefined;
            if (
              input.abort.aborted ||
              deps.clock.nowMs() >= input.deadline_at_ms
            ) {
              finish("unknown");
              return;
            }
            finish(mapKitchenStatus(resolveCollectionStatus({ indexed, job })));
          } catch {
            finish("unknown");
          }
        })();
      });
    }),
});

/** Hermetic scripted index status by `chainId:address`. */
export const createScriptedIndexStatusPort = (
  script: Readonly<Record<string, CollectionCandidate["index_status"]>>,
): ChainQualifiedIndexStatusPort => ({
  lookup: (input) =>
    Effect.sync(() => {
      if (input.abort.aborted) return "unknown";
      const key = `${input.chain_id}:${input.normalized_address}`;
      return script[key] ?? "missing";
    }),
});

/**
 * Apply capability index_support bound: without support, never claim indexed /
 * indexing for readiness — report unsupported.
 */
export const applyIndexSupportBound = (
  observed: CollectionCandidate["index_status"],
  indexSupport: boolean,
): CollectionCandidate["index_status"] => {
  if (!indexSupport) {
    if (observed === "indexed" || observed === "indexing" || observed === "missing") {
      return "unsupported";
    }
  }
  return observed;
};
