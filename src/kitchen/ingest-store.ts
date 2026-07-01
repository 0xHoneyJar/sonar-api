import type {
  CollectionKey,
  IngestJobRecord,
  IngestJobStatus,
  IngestRequestBody,
} from "./types.js";
import { collectionKeyId, makeIngestJobId } from "./normalize.js";

export interface IngestJobStorePort {
  get(key: CollectionKey): Promise<IngestJobRecord | undefined>;
  upsertQueued(key: CollectionKey, body: IngestRequestBody, nowMs?: number): Promise<IngestJobRecord>;
  listByStatus(status: IngestJobStatus, limit?: number): Promise<IngestJobRecord[]>;
  updateStatus(
    key: CollectionKey,
    status: IngestJobStatus,
    args?: { errorMessage?: string; nowMs?: number },
  ): Promise<IngestJobRecord | undefined>;
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
    if (existing) {
      if (existing.status !== "failed") return existing;
      existing.status = "queued";
      existing.orderId = body.order_id;
      existing.source = body.source;
      existing.contactEmail = body.contact_email;
      existing.communityName = body.community_name;
      existing.updatedAtMs = nowMs;
      return existing;
    }

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

  async listByStatus(status: IngestJobStatus, limit = 50): Promise<IngestJobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.status === status)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .slice(0, limit);
  }

  async updateStatus(
    key: CollectionKey,
    status: IngestJobStatus,
    args?: { errorMessage?: string; nowMs?: number },
  ): Promise<IngestJobRecord | undefined> {
    const record = this.jobs.get(collectionKeyId(key));
    if (!record) return undefined;
    record.status = status;
    record.errorMessage = args?.errorMessage;
    record.updatedAtMs = args?.nowMs ?? Date.now();
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
