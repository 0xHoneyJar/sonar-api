import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CollectionKey, IngestJobRecord, IngestRequestBody } from "./types";
import { collectionKeyId, makeIngestJobId } from "./normalize";

/**
 * Ingest job store for kitchen upstream coordination.
 *
 * Ponder's `db` from `ponder:api` is read-only, so ingest queue state lives here
 * until wired to an external queue. File-backed persistence survives process
 * restarts on a single instance; multi-instance deploys still need a shared queue.
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

  /** Replace in-memory map (file store load / tests). */
  replaceAll(records: IngestJobRecord[]): void {
    this.jobs.clear();
    for (const record of records) {
      this.jobs.set(collectionKeyId(record.key), record);
    }
  }

  snapshot(): IngestJobRecord[] {
    return [...this.jobs.values()];
  }

  clearForTests(): void {
    this.jobs.clear();
  }
}

export class FileIngestJobStore extends IngestJobStore {
  constructor(private readonly filePath: string) {
    super();
    this.load();
  }

  override upsertQueued(key: CollectionKey, body: IngestRequestBody, nowMs = Date.now()): IngestJobRecord {
    const record = super.upsertQueued(key, body, nowMs);
    this.persist();
    return record;
  }

  override markFailed(key: CollectionKey, nowMs = Date.now()): IngestJobRecord | undefined {
    const record = super.markFailed(key, nowMs);
    if (record) this.persist();
    return record;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as { jobs?: IngestJobRecord[] };
      this.replaceAll(raw.jobs ?? []);
    } catch (err) {
      throw new Error(
        `ingest job index corrupt at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ jobs: this.snapshot() }, null, 2), "utf-8");
  }
}

const defaultPath =
  process.env.INGEST_JOBS_PATH?.trim() ||
  join(process.cwd(), ".data", "kitchen-ingest-jobs.json");

/** Shared store — file-backed for restart durability (single-instance). */
export const ingestJobStore: IngestJobStore = new FileIngestJobStore(defaultPath);
