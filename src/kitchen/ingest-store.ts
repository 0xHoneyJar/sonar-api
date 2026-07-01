import type { CollectionKey, IngestJobRecord, IngestRequestBody } from "./types.js";
import { collectionKeyId, makeIngestJobId } from "./normalize.js";

export interface IngestJobStorePort {
  get(key: CollectionKey): Promise<IngestJobRecord | undefined>;
  upsertQueued(key: CollectionKey, body: IngestRequestBody, nowMs?: number): Promise<IngestJobRecord>;
}

/** In-memory store for tests and local dev without Postgres. */
export class MemoryIngestJobStore implements IngestJobStorePort {
  private readonly jobs = new Map<string, IngestJobRecord>();

  async get(key: CollectionKey): Promise<IngestJobRecord | undefined> {
    return this.jobs.get(collectionKeyId(key));
  }

  async upsertQueued(
    key: CollectionKey,
    body: IngestRequestBody,
    nowMs = Date.now(),
  ): Promise<IngestJobRecord> {
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
