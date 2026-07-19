import type {
  CollectionIndexStatus,
  CollectionKey,
  CollectionStatusResponse,
  IngestJobRecord,
} from "./types.js";

export interface IndexReadinessCoverage {
  physicalJobId: string;
  deploymentId: string;
  capabilityId: string;
  capabilityVersion: string;
  requiredFloor: number;
  processedThroughBlock: number;
  requiredThroughBlock: number;
  coverageMode: "full_from_required_floor" | "partial_operator_approved";
  configDigest: string;
  tokenRows: number;
  holderRows: number;
}

export interface IndexReadinessEvidence {
  state: "ready";
  kind: "indexed_rows" | "registration_marker" | "sync_marker";
  observedAtMs: number;
  /** Mission 5 — present when readiness is coverage-attributable. */
  coverage?: IndexReadinessCoverage;
}

export interface IndexedSnapshot {
  holderCount: number;
  indexedAtMs: number | null;
  /** Raw aggregates retained for attributable coverage evidence. */
  tokenCount?: number;
  trackedHolderCount?: number;
  readiness?: IndexReadinessEvidence;
}

export function isIndexedSnapshotReady(snapshot: IndexedSnapshot): boolean {
  return snapshot.readiness?.state === "ready";
}

export function resolveCollectionStatus(args: {
  indexed: IndexedSnapshot;
  job?: IngestJobRecord;
}): CollectionIndexStatus {
  if (isIndexedSnapshotReady(args.indexed) || args.job?.status === "completed") return "indexed";
  if (args.job?.status === "failed") return "failed";
  if (args.job?.status === "queued" || args.job?.status === "indexing") return "indexing";
  return "missing";
}

export function toStatusResponse(
  status: Exclude<CollectionIndexStatus, "missing">,
  indexed: IndexedSnapshot,
): CollectionStatusResponse {
  const response: CollectionStatusResponse = { status };
  if (status === "indexed") {
    response.holder_count = indexed.holderCount;
    if (indexed.indexedAtMs !== null) {
      response.indexed_at = new Date(indexed.indexedAtMs).toISOString();
    }
  }
  return response;
}

export interface CollectionStatusReader {
  readIndexedSnapshot(key: CollectionKey): Promise<IndexedSnapshot>;
  /**
   * Bounded bulk path used by readiness scans. Implementations should preserve
   * input identity and return one entry per key.
   */
  readIndexedSnapshots?(
    keys: CollectionKey[],
  ): Promise<Map<string, IndexedSnapshot>>;
}
