import type {
  CollectionIndexStatus,
  CollectionKey,
  CollectionStatusResponse,
  IngestJobRecord,
} from "./types";

export interface IndexedSnapshot {
  holderCount: number;
  indexedAtMs: number | null;
}

export function resolveCollectionStatus(args: {
  indexed: IndexedSnapshot;
  job?: IngestJobRecord;
}): CollectionIndexStatus {
  if (args.indexed.holderCount > 0) return "indexed";
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
}
