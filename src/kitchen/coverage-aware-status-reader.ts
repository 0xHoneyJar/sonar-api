/**
 * Mission 5 — attributable, bulk coverage-aware readiness.
 *
 * A physical job completes only when its deployment/capability/config binding
 * matches the floor registry and chain progress is within the configured
 * tip-follow lag. Entity rows are descriptive; they are never the coverage
 * proof. A fully covered zero-row collection completes via a sync marker.
 */

import { collectionKeyId } from "./normalize.js";
import type { CollectionStatusReader, IndexedSnapshot } from "./status.js";
import type { CollectionKey } from "./types.js";
import {
  bindFloorToObservation,
  evaluateCoverageReadiness,
  type CoverageFloorRecord,
} from "./coverage-readiness.js";

export interface ChainProgress {
  processedThroughBlock: number;
  headBlock: number;
  sensorFailed?: boolean;
}

export type ChainProgressReader = (
  chainIds: number[],
) => Promise<Map<number, ChainProgress>>;

export interface CoverageJobBinding {
  physicalJobId: string;
  deploymentId: string;
  configDigest: string;
  capabilityId: string;
  capabilityVersion: string;
}

export type JobBindingResolver = (
  keys: CollectionKey[],
) => Promise<Map<string, CoverageJobBinding>>;

function withoutUnprovenReadiness(snapshot: IndexedSnapshot): IndexedSnapshot {
  return {
    holderCount: snapshot.holderCount,
    indexedAtMs: snapshot.indexedAtMs,
    ...(snapshot.tokenCount === undefined ? {} : { tokenCount: snapshot.tokenCount }),
    ...(snapshot.trackedHolderCount === undefined
      ? {}
      : { trackedHolderCount: snapshot.trackedHolderCount }),
  };
}

async function readInnerBatch(
  reader: CollectionStatusReader,
  keys: CollectionKey[],
): Promise<Map<string, IndexedSnapshot>> {
  if (reader.readIndexedSnapshots) {
    return reader.readIndexedSnapshots(keys);
  }
  const rows = await Promise.all(
    keys.map(async (key) => [
      collectionKeyId(key),
      await reader.readIndexedSnapshot(key),
    ] as const),
  );
  return new Map(rows);
}

export function createCoverageAwareStatusReader(args: {
  inner: CollectionStatusReader;
  resolveFloor: (key: CollectionKey) => CoverageFloorRecord | null;
  /** Registry-blocked contracts are governed but can never become ready. */
  isBlocked?: (key: CollectionKey) => boolean;
  readChainProgress: ChainProgressReader;
  resolveJobBindings: JobBindingResolver;
  tipLagBlocks?: number;
}): CollectionStatusReader {
  const tipLagBlocks = Math.max(0, args.tipLagBlocks ?? 500);

  async function readIndexedSnapshots(
    keys: CollectionKey[],
  ): Promise<Map<string, IndexedSnapshot>> {
    const inner = await readInnerBatch(args.inner, keys);
    const snapshots = new Map(inner);
    for (const key of keys) {
      if (!args.isBlocked?.(key)) continue;
      const id = collectionKeyId(key);
      snapshots.set(
        id,
        withoutUnprovenReadiness(
          inner.get(id) ?? { holderCount: 0, indexedAtMs: null },
        ),
      );
    }
    const coveredKeys = keys.filter((key) => args.resolveFloor(key) !== null);
    if (coveredKeys.length === 0) return snapshots;

    const [bindings, progressByChain] = await Promise.all([
      args.resolveJobBindings(coveredKeys),
      args.readChainProgress([
        ...new Set(coveredKeys.map((key) => Number(key.chainId))),
      ]),
    ]);
    for (const key of coveredKeys) {
      const id = collectionKeyId(key);
      const snapshot =
        inner.get(id) ?? { holderCount: 0, indexedAtMs: null };
      const floor = args.resolveFloor(key);
      const binding = bindings.get(id);
      const progress = progressByChain.get(key.chainId);
      if (!floor || !binding || !progress || progress.sensorFailed) {
        snapshots.set(id, withoutUnprovenReadiness(snapshot));
        continue;
      }

      const requiredThroughBlock = Math.max(
        floor.requiredFloor,
        progress.headBlock - tipLagBlocks,
      );
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
          requiredThroughBlock,
          tokenRows: snapshot.tokenCount ?? snapshot.holderCount,
          holderRows:
            snapshot.trackedHolderCount ?? snapshot.holderCount,
          observedAtMs: snapshot.indexedAtMs ?? Date.now(),
        },
      });
      if ("ready" in bound) {
        snapshots.set(id, withoutUnprovenReadiness(snapshot));
        continue;
      }

      const decision = evaluateCoverageReadiness(bound);
      if (!decision.ready) {
        snapshots.set(id, withoutUnprovenReadiness(snapshot));
        continue;
      }

      snapshots.set(id, {
        ...withoutUnprovenReadiness(snapshot),
        indexedAtMs: decision.evidence.observedAtMs,
        readiness: {
          state: "ready",
          kind: decision.evidence.kind,
          observedAtMs: decision.evidence.observedAtMs,
          coverage: decision.evidence.coverage,
        },
      });
    }

    return snapshots;
  }

  return {
    async readIndexedSnapshot(key: CollectionKey): Promise<IndexedSnapshot> {
      const snapshots = await readIndexedSnapshots([key]);
      return (
        snapshots.get(collectionKeyId(key)) ?? {
          holderCount: 0,
          indexedAtMs: null,
        }
      );
    },
    readIndexedSnapshots,
  };
}
