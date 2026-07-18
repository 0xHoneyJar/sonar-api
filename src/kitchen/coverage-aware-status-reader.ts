/**
 * Mission 5 — wrap the Hasura row reader with coverage-aware readiness.
 *
 * When a floor record is supplied, positive rows alone cannot complete a job:
 * processed_through must cover required_floor..required_through, and digests
 * must bind. Zero-row collections may complete via sync_marker.
 *
 * Enabled when createCoverageAwareStatusReader is used (see server.ts env gate).
 */

import type { CollectionKey } from "./types.js";
import type { CollectionStatusReader, IndexedSnapshot } from "./status.js";
import {
  bindFloorToObservation,
  evaluateCoverageReadiness,
  type CoverageFloorRecord,
} from "./coverage-readiness.js";

export type ChainProgressReader = (chainId: number) => Promise<{
  processedThroughBlock: number;
  sensorFailed?: boolean;
} | null>;

export function createCoverageAwareStatusReader(args: {
  inner: CollectionStatusReader;
  /** Lookup floor by chainId + lowercase contract. */
  resolveFloor: (key: CollectionKey) => CoverageFloorRecord | null;
  readChainProgress: ChainProgressReader;
  /** Fixed end of coverage window; defaults to processed tip (catch-up to head). */
  requiredThroughBlock?: number;
  /** Job binding digests — when omitted, coverage path is skipped (inner only). */
  resolveJobBinding?: (key: CollectionKey) => {
    physicalJobId: string;
    deploymentId: string;
    configDigest: string;
    capabilityId: string;
    capabilityVersion: string;
  } | null;
}): CollectionStatusReader {
  return {
    async readIndexedSnapshot(key: CollectionKey): Promise<IndexedSnapshot> {
      const inner = await args.inner.readIndexedSnapshot(key);
      const floor = args.resolveFloor(key);
      if (!floor) {
        // No floor binding → do not invent coverage readiness; keep inner evidence.
        return inner;
      }

      const binding = args.resolveJobBinding?.(key) ?? null;
      if (!binding) {
        // Floor known but job digests unavailable → refuse green from rows alone.
        return { holderCount: inner.holderCount, indexedAtMs: inner.indexedAtMs };
      }

      const progress = await args.readChainProgress(key.chainId);
      if (!progress || progress.sensorFailed) {
        return { holderCount: inner.holderCount, indexedAtMs: null };
      }

      const requiredThrough =
        args.requiredThroughBlock ?? progress.processedThroughBlock;

      const bound = bindFloorToObservation({
        floor,
        observation: {
          physicalJobId: binding.physicalJobId,
          deploymentId: binding.deploymentId,
          chainId: key.chainId,
          contract: key.contract,
          configDigest: binding.configDigest,
          capabilityId: binding.capabilityId,
          capabilityVersion: binding.capabilityVersion,
          processedThroughBlock: progress.processedThroughBlock,
          requiredThroughBlock: requiredThrough,
          tokenRows: inner.holderCount > 0 ? inner.holderCount : 0,
          holderRows: inner.holderCount,
          observedAtMs: inner.indexedAtMs ?? Date.now(),
        },
      });

      if ("ready" in bound && bound.ready === false) {
        return { holderCount: inner.holderCount, indexedAtMs: inner.indexedAtMs };
      }

      const decision = evaluateCoverageReadiness(bound as Parameters<typeof evaluateCoverageReadiness>[0]);
      if (!decision.ready) {
        return { holderCount: inner.holderCount, indexedAtMs: inner.indexedAtMs };
      }

      return {
        holderCount: inner.holderCount,
        indexedAtMs: decision.evidence.observedAtMs,
        readiness: {
          state: "ready",
          kind: decision.evidence.kind,
          observedAtMs: decision.evidence.observedAtMs,
          coverage: decision.evidence.coverage,
        },
      };
    },
  };
}
