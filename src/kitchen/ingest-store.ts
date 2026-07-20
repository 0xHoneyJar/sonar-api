import { resolvePreparationCapability } from "./capability.js";
import {
  collectionKeyFromDeployment,
  collectionKeyId,
  deploymentFromCollectionKey,
  makePhysicalJobId,
  physicalJobKey,
} from "./normalize.js";
import {
  buildOwnershipReadyEnvelope,
  ownershipReadyIdempotencyKey,
  type KitchenOutboxRow,
  type OutboxPublishState,
  type OwnershipReadyEnvelope,
} from "./outbox.js";
import type {
  AdmissionRequest,
  AdmissionResult,
  CollectionKey,
  IngestJobRecord,
  IngestJobStatus,
  IngestRequestBody,
  JobCorrelation,
  MigrationAuthorityState,
} from "./types.js";

export interface IngestJobStorePort {
  get(key: CollectionKey): Promise<IngestJobRecord | undefined>;
  getByPhysicalJobId(physicalJobId: string): Promise<IngestJobRecord | undefined>;
  admit(request: AdmissionRequest, nowMs?: number): Promise<AdmissionResult>;
  upsertQueued(key: CollectionKey, body: IngestRequestBody, nowMs?: number): Promise<IngestJobRecord>;
  listByStatus(
    status: IngestJobStatus,
    limit?: number,
    opts?: { unleasedOnly?: boolean },
  ): Promise<IngestJobRecord[]>;
  /** Counts rows with a physical job id per status (operator dashboards). */
  countByStatus(): Promise<Partial<Record<IngestJobStatus, number>>>;
  claimQueued(args: {
    workerId: string;
    limit?: number;
    leaseMs?: number;
    nowMs?: number;
  }): Promise<IngestJobRecord[]>;
  renewLease(args: {
    physicalJobId: string;
    lease: { owner: string; epoch: number };
    leaseMs?: number;
    nowMs?: number;
  }): Promise<IngestJobRecord | undefined>;
  updateStatus(
    physicalJobId: string,
    status: IngestJobStatus,
    args?: {
      errorCode?: string;
      errorMessage?: string;
      nowMs?: number;
      releaseLease?: boolean;
      expectedLease?: { owner: string; epoch: number };
      /** When true, CAS fails if any leaseOwner is present (ack / unleased paths). */
      expectedAbsentLease?: boolean;
      expectedStatus?: IngestJobStatus;
    },
  ): Promise<IngestJobRecord | undefined>;
  getMigrationAuthority(): Promise<MigrationAuthorityState>;
  listCorrelations(physicalJobId: string): Promise<JobCorrelation[]>;
  /**
   * Fail closed on active drain candidates that still lack canonical physical
   * identity once parity proof is expected. Legacy/dual_write rows remain
   * owned by admission/backfill — not silently skipped by the worker.
   */
  reconcileUnbackfilledActiveJobs(nowMs?: number): Promise<number>;
  /** Idempotent insert of ownership.ready outbox intent (proof 1). */
  enqueueOwnershipReady(job: IngestJobRecord, nowMs?: number): Promise<KitchenOutboxRow>;
  listOutbox(args?: {
    publishState?: OutboxPublishState | OutboxPublishState[];
    limit?: number;
  }): Promise<KitchenOutboxRow[]>;
  markOutboxPublishing(eventId: string, nowMs?: number): Promise<void>;
  markOutboxPublished(eventId: string, publishedAtMs?: number): Promise<void>;
  markOutboxFailed(eventId: string, error: string, terminal: boolean, nowMs?: number): Promise<void>;
  /** Reconcile completed jobs missing outbox rows (no shared TX with indexer). */
  reconcileOwnershipReadyOutbox(limit?: number, nowMs?: number): Promise<number>;
}

function cloneJob(job: IngestJobRecord): IngestJobRecord {
  return structuredClone(job);
}

/** Atomic in-memory reference implementation used by hermetic tests and local development. */
export class MemoryIngestJobStore implements IngestJobStorePort {
  private readonly jobsByKey = new Map<string, IngestJobRecord>();
  private readonly jobsById = new Map<string, IngestJobRecord>();
  private readonly legacyAliases = new Map<string, string>();
  private readonly correlations = new Map<string, JobCorrelation>();
  private readonly outboxById = new Map<string, KitchenOutboxRow>();
  private readonly outboxByIdempotency = new Map<string, string>();
  private authority: MigrationAuthorityState = {
    phase: "canonical",
    divergence: false,
    updatedAtMs: 0,
  };
  private serial: Promise<void> = Promise.resolve();

  private async atomic<A>(operation: () => A | Promise<A>): Promise<A> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async get(key: CollectionKey): Promise<IngestJobRecord | undefined> {
    const physicalJobId = this.legacyAliases.get(collectionKeyId(key));
    const record = physicalJobId ? this.jobsById.get(physicalJobId) : undefined;
    return record ? cloneJob(record) : undefined;
  }

  async getByPhysicalJobId(physicalJobId: string): Promise<IngestJobRecord | undefined> {
    const record = this.jobsById.get(physicalJobId);
    return record ? cloneJob(record) : undefined;
  }

  async admit(request: AdmissionRequest, nowMs = Date.now()): Promise<AdmissionResult> {
    return this.atomic(() => {
      if (this.authority.divergence) {
        return {
          ok: false,
          code: "migration_divergence",
          reasonClass: "integrity_compromise",
          reason: this.authority.reason ?? "legacy and canonical job identity diverged",
        };
      }
      if (!request.capability.enabled || request.capability.health === "disabled") {
        const unsupportedStandard = request.capability.reason.includes("generic Kitchen");
        const unsupportedNetwork = request.capability.reason.includes("network ");
        return {
          ok: false,
          code: unsupportedStandard
            ? "unsupported_standard"
            : unsupportedNetwork
              ? "unsupported_network"
              : "capability_disabled",
          reasonClass: request.capability.reasonClass,
          reason: request.capability.reason,
        };
      }
      if (request.capability.health === "degraded") {
        return {
          ok: false,
          code: "capability_degraded",
          reasonClass: request.capability.reasonClass,
          reason: request.capability.reason,
        };
      }

      const canonicalKey = physicalJobKey({
        deployment: request.deployment,
        capabilityId: request.capability.capabilityId,
        capabilityVersion: request.capability.capabilityVersion,
      });
      let record = this.jobsByKey.get(canonicalKey);
      let created = false;

      if (!record) {
        const physicalJobId = makePhysicalJobId({
          deployment: request.deployment,
          capabilityVersion: request.capability.capabilityVersion,
        });
        record = {
          physicalJobId,
          jobId: physicalJobId,
          deployment: request.deployment,
          key: collectionKeyFromDeployment(request.deployment),
          capabilityId: request.capability.capabilityId,
          capabilityVersion: request.capability.capabilityVersion,
          tokenStandard: request.tokenStandard,
          prepareAdapterId: request.capability.prepareAdapterId,
          prepareAdapterVersion: request.capability.prepareAdapterVersion,
          sourceSequence: request.capability.sourceSequence,
          finalityPolicyVersion: request.capability.finalityPolicyVersion,
          status: "queued",
          attempt: 1,
          leaseEpoch: 0,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        };
        this.jobsByKey.set(canonicalKey, record);
        this.jobsById.set(physicalJobId, record);
        if (record.key) this.legacyAliases.set(collectionKeyId(record.key), physicalJobId);
        created = true;
      } else if (record.status === "failed") {
        record.status = "queued";
        record.attempt += 1;
        record.errorCode = undefined;
        record.errorMessage = undefined;
        record.leaseOwner = undefined;
        record.leaseUntilMs = undefined;
        record.updatedAtMs = nowMs;
      }

      if (request.correlation) {
        const correlationKey = `${record.physicalJobId}:${request.correlation.source}:${request.correlation.correlationId}`;
        if (!this.correlations.has(correlationKey)) {
          this.correlations.set(correlationKey, {
            physicalJobId: record.physicalJobId,
            source: request.correlation.source,
            correlationId: request.correlation.correlationId,
            createdAtMs: nowMs,
          });
        }
      }

      return { ok: true, job: cloneJob(record), created };
    });
  }

  async upsertQueued(
    key: CollectionKey,
    body: IngestRequestBody,
    nowMs = Date.now(),
  ): Promise<IngestJobRecord> {
    const deployment = await deploymentFromCollectionKey(key);
    const capability = await resolvePreparationCapability({
      network: deployment.network,
      tokenStandard: "erc721",
    });
    const result = await this.admit(
      {
        deployment,
        tokenStandard: "erc721",
        capability,
        correlation: { source: body.source, correlationId: body.order_id },
      },
      nowMs,
    );
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
    return result.job;
  }

  async listByStatus(
    status: IngestJobStatus,
    limit = 50,
    opts?: { unleasedOnly?: boolean },
  ): Promise<IngestJobRecord[]> {
    return [...this.jobsById.values()]
      .filter((job) => job.status === status)
      .filter((job) => !opts?.unleasedOnly || !job.leaseOwner)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .slice(0, limit)
      .map(cloneJob);
  }

  async countByStatus(): Promise<Partial<Record<IngestJobStatus, number>>> {
    const out: Partial<Record<IngestJobStatus, number>> = {};
    for (const job of this.jobsById.values()) {
      out[job.status] = (out[job.status] ?? 0) + 1;
    }
    return out;
  }

  async claimQueued(args: {
    workerId: string;
    limit?: number;
    leaseMs?: number;
    nowMs?: number;
  }): Promise<IngestJobRecord[]> {
    return this.atomic(() => {
      if (this.authority.divergence) return [];
      const nowMs = args.nowMs ?? Date.now();
      const leaseMs = args.leaseMs ?? 30_000;
      const claimed: IngestJobRecord[] = [];
      for (const job of [...this.jobsById.values()].sort((a, b) => a.createdAtMs - b.createdAtMs)) {
        if (claimed.length >= (args.limit ?? 10)) break;
        if (job.status !== "queued") continue;
        if (job.leaseUntilMs !== undefined && job.leaseUntilMs > nowMs) continue;
        job.leaseOwner = args.workerId;
        job.leaseUntilMs = nowMs + leaseMs;
        job.leaseEpoch += 1;
        job.updatedAtMs = nowMs;
        claimed.push(cloneJob(job));
      }
      return claimed;
    });
  }

  async updateStatus(
    physicalJobId: string,
    status: IngestJobStatus,
    args?: {
      errorCode?: string;
      errorMessage?: string;
      nowMs?: number;
      releaseLease?: boolean;
      expectedLease?: { owner: string; epoch: number };
      expectedAbsentLease?: boolean;
      expectedStatus?: IngestJobStatus;
    },
  ): Promise<IngestJobRecord | undefined> {
    return this.atomic(() => {
      if (args?.expectedAbsentLease && args.expectedLease) {
        throw new Error("expectedAbsentLease and expectedLease are mutually exclusive");
      }
      const record = this.jobsById.get(physicalJobId);
      if (!record) return undefined;
      const nowMs = args?.nowMs ?? Date.now();
      if (args?.expectedStatus !== undefined && record.status !== args.expectedStatus) {
        return undefined;
      }
      if (args?.expectedAbsentLease && record.leaseOwner) {
        return undefined;
      }
      if (
        args?.expectedLease &&
        (
          record.leaseOwner !== args.expectedLease.owner ||
          record.leaseEpoch !== args.expectedLease.epoch ||
          record.leaseUntilMs === undefined ||
          record.leaseUntilMs <= nowMs
        )
      ) {
        return undefined;
      }
      record.status = status;
      record.errorCode = args?.errorCode;
      record.errorMessage = args?.errorMessage;
      record.updatedAtMs = nowMs;
      if (args?.releaseLease !== false) {
        record.leaseOwner = undefined;
        record.leaseUntilMs = undefined;
      }
      const cloned = cloneJob(record);
      if (status === "completed") {
        this.enqueueOwnershipReadySync(cloned, nowMs);
      }
      return cloned;
    });
  }

  async renewLease(args: {
    physicalJobId: string;
    lease: { owner: string; epoch: number };
    leaseMs?: number;
    nowMs?: number;
  }): Promise<IngestJobRecord | undefined> {
    return this.atomic(() => {
      const record = this.jobsById.get(args.physicalJobId);
      const nowMs = args.nowMs ?? Date.now();
      if (
        !record ||
        record.status !== "queued" ||
        record.leaseOwner !== args.lease.owner ||
        record.leaseEpoch !== args.lease.epoch ||
        record.leaseUntilMs === undefined ||
        record.leaseUntilMs <= nowMs
      ) {
        return undefined;
      }
      record.leaseUntilMs = nowMs + (args.leaseMs ?? 30_000);
      record.updatedAtMs = nowMs;
      return cloneJob(record);
    });
  }

  async getMigrationAuthority(): Promise<MigrationAuthorityState> {
    return { ...this.authority };
  }

  async listCorrelations(physicalJobId: string): Promise<JobCorrelation[]> {
    return [...this.correlations.values()]
      .filter((correlation) => correlation.physicalJobId === physicalJobId)
      .map((correlation) => ({ ...correlation }));
  }

  async reconcileUnbackfilledActiveJobs(_nowMs?: number): Promise<number> {
    return 0;
  }

  private enqueueOwnershipReadySync(job: IngestJobRecord, nowMs: number): KitchenOutboxRow {
    const idempotency = ownershipReadyIdempotencyKey(job);
    const existingId = this.outboxByIdempotency.get(idempotency);
    if (existingId) {
      const existing = this.outboxById.get(existingId);
      if (existing) return structuredClone(existing);
    }
    const payload: OwnershipReadyEnvelope = buildOwnershipReadyEnvelope(job, {
      occurredAtMs: nowMs,
    });
    const row: KitchenOutboxRow = {
      event_id: payload.event_id,
      event_type: payload.event_type,
      idempotency_key: payload.idempotency_key,
      aggregate_id: job.physicalJobId,
      payload,
      publish_state: "pending",
      attempt: 0,
      last_error: null,
      created_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
      published_at: null,
    };
    this.outboxById.set(row.event_id, row);
    this.outboxByIdempotency.set(idempotency, row.event_id);
    return structuredClone(row);
  }

  async enqueueOwnershipReady(job: IngestJobRecord, nowMs?: number): Promise<KitchenOutboxRow> {
    return this.atomic(() => this.enqueueOwnershipReadySync(job, nowMs ?? Date.now()));
  }

  async listOutbox(args?: {
    publishState?: OutboxPublishState | OutboxPublishState[];
    limit?: number;
  }): Promise<KitchenOutboxRow[]> {
    const states = args?.publishState
      ? new Set(Array.isArray(args.publishState) ? args.publishState : [args.publishState])
      : null;
    const rows = [...this.outboxById.values()]
      .filter((r) => (states ? states.has(r.publish_state) : true))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, args?.limit ?? 500)
      .map((r) => structuredClone(r));
    return rows;
  }

  async markOutboxPublishing(eventId: string, nowMs?: number): Promise<void> {
    return this.atomic(() => {
      const row = this.outboxById.get(eventId);
      if (!row || row.publish_state === "published" || row.publish_state === "failed_terminal") {
        return;
      }
      row.publish_state = "publishing";
      row.attempt += 1;
      row.updated_at = new Date(nowMs ?? Date.now()).toISOString();
    });
  }

  async markOutboxPublished(eventId: string, publishedAtMs?: number): Promise<void> {
    return this.atomic(() => {
      const row = this.outboxById.get(eventId);
      if (!row) return;
      const at = publishedAtMs ?? Date.now();
      row.publish_state = "published";
      row.published_at = new Date(at).toISOString();
      row.updated_at = new Date(at).toISOString();
      row.last_error = null;
    });
  }

  async markOutboxFailed(
    eventId: string,
    error: string,
    terminal: boolean,
    nowMs?: number,
  ): Promise<void> {
    return this.atomic(() => {
      const row = this.outboxById.get(eventId);
      if (!row || row.publish_state === "published") return;
      row.publish_state = terminal ? "failed_terminal" : "pending";
      row.last_error = error;
      row.updated_at = new Date(nowMs ?? Date.now()).toISOString();
    });
  }

  async reconcileOwnershipReadyOutbox(limit = 100, nowMs?: number): Promise<number> {
    return this.atomic(() => {
      const at = nowMs ?? Date.now();
      let n = 0;
      for (const job of this.jobsById.values()) {
        if (n >= limit) break;
        if (job.status !== "completed") continue;
        const key = ownershipReadyIdempotencyKey(job);
        if (this.outboxByIdempotency.has(key)) continue;
        this.enqueueOwnershipReadySync(job, at);
        n += 1;
      }
      return n;
    });
  }

  setMigrationDivergenceForTests(reason?: string): void {
    this.authority = {
      phase: "parity",
      divergence: true,
      reason,
      updatedAtMs: Date.now(),
    };
  }

  markFailed(key: CollectionKey, nowMs = Date.now()): IngestJobRecord | undefined {
    const physicalJobId = this.legacyAliases.get(collectionKeyId(key));
    const record = physicalJobId ? this.jobsById.get(physicalJobId) : undefined;
    if (!record) return undefined;
    record.status = "failed";
    record.updatedAtMs = nowMs;
    return cloneJob(record);
  }

  clearForTests(): void {
    this.jobsByKey.clear();
    this.jobsById.clear();
    this.legacyAliases.clear();
    this.correlations.clear();
    this.outboxById.clear();
    this.outboxByIdempotency.clear();
    this.authority = { phase: "canonical", divergence: false, updatedAtMs: 0 };
    this.serial = Promise.resolve();
  }
}
