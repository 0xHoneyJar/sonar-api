import type { CollectionKey, IngestJobRecord, IngestRequestBody } from "./types";
import { collectionKeyId, makeIngestJobId } from "./normalize";

/**
 * Process-local ingest queue. Ponder's `db` from `ponder:api` is read-only, so
 * ingest jobs live here until wired to an external queue / GitHub automation.
 */
export class IngestJobStore {
  private readonly jobs = new Map<string, IngestJobRecord>();

  get(key: CollectionKey): IngestJobRecord | undefined {
    return this.jobs.get(collectionKeyId(key));
  }

  upsertQueued(key: CollectionKey, body: IngestRequestBody, nowMs = Date.now()): IngestJobRecord {
    const id = collectionKeyId(key);
    const existing = this.jobs.get(id);
    if (existing) return existing;

    const record: IngestJobRecord = {
      jobId: makeIngestJobId(key),
      key,
      orderId: body.order_id,
      source: body.source,
      contactEmail: body.contact_email,
      communityName: body.community_name,
      status: "queued",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.jobs.set(id, record);
    return record;
  }

  markFailed(key: CollectionKey, nowMs = Date.now()): IngestJobRecord | undefined {
    const record = this.jobs.get(collectionKeyId(key));
    if (!record) return undefined;
    record.status = "failed";
    record.updatedAtMs = nowMs;
    return record;
  }

  clearForTests(): void {
    this.jobs.clear();
  }
}

/** Shared store instance for the running API process. */
export const ingestJobStore = new IngestJobStore();
