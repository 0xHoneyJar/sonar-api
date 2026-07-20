import pg from "pg";

import { decodeCollectionDeploymentRef, type CollectionDeploymentRef } from "../collection-resolver/protocol.js";
import type { IngestJobStorePort } from "./ingest-store.js";
import {
  collectionKeyId,
  deploymentFromCollectionKey,
  makePhysicalJobId,
  physicalJobKey,
} from "./normalize.js";
import { resolvePreparationCapability } from "./capability.js";
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
  TokenStandard,
} from "./types.js";
import { Effect } from "effect";

/**
 * Runtime bootstrap is expand-only. Authority flips and constraints live in
 * ordered migration artifacts and must never be inferred at service startup.
 */
const ENSURE_EXPANDED_SQL = `
CREATE TABLE IF NOT EXISTS kitchen_ingest_jobs (
  chain_id int,
  contract text,
  job_id text,
  order_id text,
  source text,
  status text NOT NULL DEFAULT 'queued',
  contact_email text,
  community_name text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS physical_job_id text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS deployment_id text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS deployment_json jsonb;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS capability_id text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS capability_version text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS token_standard text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS prepare_adapter_id text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS prepare_adapter_version text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS source_sequence text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS finality_policy_version text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS attempt int NOT NULL DEFAULT 1;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE kitchen_ingest_jobs ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF to_regclass('kitchen_job_identity_migration_state') IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS kitchen_ingest_jobs_legacy_key_uq
      ON kitchen_ingest_jobs (chain_id, contract)
      WHERE chain_id IS NOT NULL AND contract IS NOT NULL;
  ELSIF EXISTS (
    SELECT 1 FROM kitchen_job_identity_migration_state
    WHERE singleton = true AND phase IN ('legacy', 'dual_write', 'parity')
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS kitchen_ingest_jobs_legacy_key_uq
      ON kitchen_ingest_jobs (chain_id, contract)
      WHERE chain_id IS NOT NULL AND contract IS NOT NULL;
  END IF;
END $$;
DO $$
DECLARE
  legacy_pk name;
BEGIN
  SELECT constraint_name INTO legacy_pk
  FROM (
    SELECT c.conname AS constraint_name,
           array_agg(a.attname ORDER BY key_columns.ordinality) AS columns
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
      ON true
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid AND a.attnum = key_columns.attnum
    WHERE c.conrelid = 'kitchen_ingest_jobs'::regclass AND c.contype = 'p'
    GROUP BY c.conname
  ) primary_keys
  WHERE columns = ARRAY['chain_id', 'contract']::name[];

  IF legacy_pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE kitchen_ingest_jobs DROP CONSTRAINT %I', legacy_pk);
  END IF;
END $$;

ALTER TABLE kitchen_ingest_jobs ALTER COLUMN chain_id DROP NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN contract DROP NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE kitchen_ingest_jobs ALTER COLUMN source DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS kitchen_ingest_jobs_physical_identity_uq
  ON kitchen_ingest_jobs (deployment_id, capability_id, capability_version)
  WHERE deployment_id IS NOT NULL AND capability_id IS NOT NULL AND capability_version IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS kitchen_ingest_jobs_physical_job_id_uq
  ON kitchen_ingest_jobs (physical_job_id)
  WHERE physical_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS kitchen_ingest_jobs_legacy_evm_idx
  ON kitchen_ingest_jobs (chain_id, lower(contract))
  WHERE chain_id IS NOT NULL AND contract IS NOT NULL;

CREATE TABLE IF NOT EXISTS kitchen_job_correlations (
  physical_job_id text NOT NULL,
  source text NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (physical_job_id, source, correlation_id)
);

CREATE TABLE IF NOT EXISTS kitchen_job_identity_migration_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  phase text NOT NULL CHECK (phase IN ('legacy', 'dual_write', 'parity', 'canonical', 'constrained')),
  divergence boolean NOT NULL DEFAULT false,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

/** Always applied — even when identity migration phase is constrained (#236/#238). */
const ENSURE_OUTBOX_SQL = `
CREATE TABLE IF NOT EXISTS kitchen_outbox (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  publish_state text NOT NULL CHECK (
    publish_state IN ('pending', 'publishing', 'published', 'failed_terminal')
  ),
  attempt integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX IF NOT EXISTS kitchen_outbox_publish_state_updated_idx
  ON kitchen_outbox (publish_state, updated_at);
`;

type JobRow = {
  chain_id: number | null;
  contract: string | null;
  job_id: string | null;
  order_id: string | null;
  source: string | null;
  physical_job_id: string | null;
  deployment_id: string | null;
  deployment_json: unknown | null;
  capability_id: "ownership_index.v1" | null;
  capability_version: string | null;
  token_standard: TokenStandard | null;
  prepare_adapter_id: IngestJobRecord["prepareAdapterId"] | null;
  prepare_adapter_version: string | null;
  source_sequence: string | null;
  finality_policy_version: string | null;
  status: IngestJobStatus;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  lease_owner: string | null;
  lease_until: Date | null;
  lease_epoch: string | number;
  created_at: Date;
  updated_at: Date;
};

const JOB_COLUMNS = `chain_id, contract, job_id, order_id, source, physical_job_id, deployment_id, deployment_json, capability_id,
  capability_version, token_standard, prepare_adapter_id, prepare_adapter_version,
  source_sequence, finality_policy_version, status, attempt, error_code, error_message,
  lease_owner, lease_until, lease_epoch, created_at, updated_at`;

async function rowToRecord(row: JobRow): Promise<IngestJobRecord> {
  if (
    row.physical_job_id === null ||
    row.deployment_json === null ||
    row.capability_id === null ||
    row.capability_version === null ||
    row.token_standard === null ||
    row.prepare_adapter_id === null ||
    row.prepare_adapter_version === null ||
    row.source_sequence === null ||
    row.finality_policy_version === null
  ) {
    return legacyRowToRecord(row);
  }
  const deployment = await Effect.runPromise(decodeCollectionDeploymentRef(row.deployment_json));
  return {
    physicalJobId: row.physical_job_id,
    jobId: row.physical_job_id,
    deployment,
    ...(row.chain_id !== null && row.contract !== null
      ? { key: { chainId: row.chain_id, contract: row.contract.toLowerCase() as `0x${string}` } }
      : {}),
    capabilityId: row.capability_id,
    capabilityVersion: row.capability_version,
    tokenStandard: row.token_standard,
    prepareAdapterId: row.prepare_adapter_id,
    prepareAdapterVersion: row.prepare_adapter_version,
    sourceSequence: row.source_sequence,
    finalityPolicyVersion: row.finality_policy_version,
    status: row.status,
    attempt: row.attempt,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseUntilMs: row.lease_until?.getTime(),
    leaseEpoch: Number(row.lease_epoch),
    createdAtMs: row.created_at.getTime(),
    updatedAtMs: row.updated_at.getTime(),
  };
}

async function legacyRowToRecord(row: JobRow): Promise<IngestJobRecord> {
  if (row.chain_id === null || row.contract === null || row.job_id === null) {
    throw new Error("legacy Kitchen row lacks chain_id, contract, or job_id");
  }
  const key: CollectionKey = {
    chainId: row.chain_id,
    contract: row.contract.toLowerCase() as `0x${string}`,
  };
  const deployment = await deploymentFromCollectionKey(key);
  const capability = await resolvePreparationCapability({
    network: deployment.network,
    tokenStandard: "erc721",
  });
  return {
    physicalJobId: row.job_id,
    jobId: row.job_id,
    deployment,
    key,
    capabilityId: capability.capabilityId,
    capabilityVersion: capability.capabilityVersion,
    tokenStandard: "erc721",
    prepareAdapterId: capability.prepareAdapterId,
    prepareAdapterVersion: capability.prepareAdapterVersion,
    sourceSequence: capability.sourceSequence,
    finalityPolicyVersion: capability.finalityPolicyVersion,
    status: row.status,
    attempt: row.attempt,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseUntilMs: row.lease_until?.getTime(),
    leaseEpoch: Number(row.lease_epoch),
    createdAtMs: row.created_at.getTime(),
    updatedAtMs: row.updated_at.getTime(),
  };
}

export async function ensureKitchenIngestTable(pool: pg.Pool): Promise<void> {
  // Outbox must exist even when identity bootstrap short-circuits on constrained.
  await pool.query(ENSURE_OUTBOX_SQL);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('kitchen.bootstrap.physical-job.v1'))",
    );
    const before = await client.query<{ existed: boolean }>(
      `SELECT to_regclass('public.kitchen_job_identity_migration_state') IS NOT NULL AS existed`,
    );
    const stateTableExisted = before.rows[0]?.existed === true;
    if (stateTableExisted) {
      const authority = await client.query<{ phase: MigrationAuthorityState["phase"] }>(
        `SELECT phase FROM kitchen_job_identity_migration_state WHERE singleton = true`,
      );
      if (!authority.rows[0] || authority.rows[0].phase === "constrained") {
        await client.query("COMMIT");
        return;
      }
    }
    await client.query(ENSURE_EXPANDED_SQL);
    if (!stateTableExisted) {
      await client.query(
        `INSERT INTO kitchen_job_identity_migration_state (singleton, phase, divergence)
         VALUES (true, 'legacy', false)`,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function unavailableAdmission(request: AdmissionRequest): AdmissionResult | undefined {
  if (!request.capability.enabled || request.capability.health === "disabled") {
    return {
      ok: false,
      code: request.capability.reason.includes("generic Kitchen")
        ? "unsupported_standard"
        : request.capability.reason.includes("network ")
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
  return undefined;
}

export class PostgresIngestJobStore implements IngestJobStorePort {
  constructor(private readonly pool: pg.Pool) {}

  async get(key: CollectionKey): Promise<IngestJobRecord | undefined> {
    // Legacy v1 status semantics are intentionally the first admitted job for
    // this collection key. Version-aware/current-capability callers must use
    // the v2 physical-job route and getByPhysicalJobId; do not silently turn
    // this compatibility read into a moving "latest" pointer during migration.
    const result = await this.pool.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM kitchen_ingest_jobs
       WHERE chain_id = $1 AND lower(contract) = lower($2)
       ORDER BY created_at ASC LIMIT 1`,
      [key.chainId, key.contract],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  async getByPhysicalJobId(physicalJobId: string): Promise<IngestJobRecord | undefined> {
    const result = await this.pool.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM kitchen_ingest_jobs
       WHERE physical_job_id = $1 OR (physical_job_id IS NULL AND job_id = $1)
       ORDER BY physical_job_id NULLS LAST LIMIT 1`,
      [physicalJobId],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  async admit(request: AdmissionRequest, nowMs = Date.now()): Promise<AdmissionResult> {
    const unavailable = unavailableAdmission(request);
    if (unavailable) return unavailable;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const key = physicalJobKey({
        deployment: request.deployment,
        capabilityId: request.capability.capabilityId,
        capabilityVersion: request.capability.capabilityVersion,
      });
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);

      const authority = await client.query<{
        phase: MigrationAuthorityState["phase"];
        divergence: boolean;
        reason: string | null;
      }>(
        `SELECT phase, divergence, reason FROM kitchen_job_identity_migration_state
         WHERE singleton = true FOR SHARE`,
      );
      const authorityRow = authority.rows[0];
      if (!authorityRow || authorityRow.divergence) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          code: "migration_divergence",
          reasonClass: "integrity_compromise",
          reason: authorityRow?.reason ?? "migration authority row is missing",
        };
      }

      const existingResult = await client.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM kitchen_ingest_jobs
         WHERE deployment_id = $1 AND capability_id = $2 AND capability_version = $3
         FOR UPDATE`,
        [
          request.deployment.deployment_id.digest,
          request.capability.capabilityId,
          request.capability.capabilityVersion,
        ],
      );
      let row = existingResult.rows[0];
      let created = false;
      const legacy =
        request.deployment.network.network_namespace === "eip155"
          ? {
              chainId: Number(request.deployment.network.network_reference),
              contract: request.deployment.normalized_address,
            }
          : undefined;

      if (!row && legacy) {
        const legacyResult = await client.query<JobRow>(
          `SELECT ${JOB_COLUMNS} FROM kitchen_ingest_jobs
           WHERE chain_id = $1 AND lower(contract) = lower($2)
           ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
          [legacy.chainId, legacy.contract],
        );
        const legacyRow = legacyResult.rows[0];
        if (legacyRow?.physical_job_id === null) {
          if (!legacyRow.job_id) throw new Error(`legacy job_id missing for ${legacy.chainId}:${legacy.contract}`);
          const upgraded = await client.query<JobRow>(
            `UPDATE kitchen_ingest_jobs SET
               physical_job_id = job_id,
               deployment_id = $3,
               deployment_json = $4::jsonb,
               capability_id = $5,
               capability_version = $6,
               token_standard = $7,
               prepare_adapter_id = $8,
               prepare_adapter_version = $9,
               source_sequence = $10,
               finality_policy_version = $11,
               updated_at = to_timestamp($12 / 1000.0)
             WHERE chain_id = $1 AND lower(contract) = lower($2) AND physical_job_id IS NULL
             RETURNING ${JOB_COLUMNS}`,
            [
              legacy.chainId,
              legacy.contract,
              request.deployment.deployment_id.digest,
              JSON.stringify(request.deployment),
              request.capability.capabilityId,
              request.capability.capabilityVersion,
              request.tokenStandard,
              request.capability.prepareAdapterId,
              request.capability.prepareAdapterVersion,
              request.capability.sourceSequence,
              request.capability.finalityPolicyVersion,
              nowMs,
            ],
          );
          row = upgraded.rows[0];
          if (row && legacyRow.source && legacyRow.order_id) {
            await client.query(
              `INSERT INTO kitchen_job_correlations (physical_job_id, source, correlation_id, created_at)
               VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
              [row.physical_job_id, legacyRow.source, legacyRow.order_id, legacyRow.created_at],
            );
          }
        } else if (
          legacyRow &&
          legacyRow.deployment_id === request.deployment.deployment_id.digest &&
          legacyRow.capability_id === request.capability.capabilityId &&
          legacyRow.capability_version === request.capability.capabilityVersion
        ) {
          // Backfill or another compatible writer upgraded the legacy row after
          // the first canonical lookup. Join the same physical job.
          row = legacyRow;
        } else if (
          legacyRow &&
          authorityRow.phase !== "canonical" &&
          authorityRow.phase !== "constrained"
        ) {
          await client.query("ROLLBACK");
          return {
            ok: false,
            code: "capability_version_mismatch",
            reasonClass: "operator_policy",
            reason: "legacy-key authority cannot represent a second capability version before cutover",
          };
        }
      }

      if (!row) {
        const physicalJobId = makePhysicalJobId({
          deployment: request.deployment,
          capabilityVersion: request.capability.capabilityVersion,
        });
        const inserted = await client.query<JobRow>(
          `INSERT INTO kitchen_ingest_jobs (
             chain_id, contract, job_id, physical_job_id, deployment_id, deployment_json,
             capability_id, capability_version, token_standard, prepare_adapter_id,
             prepare_adapter_version, source_sequence, finality_policy_version,
             status, attempt, lease_epoch, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12,
             'queued', 1, 0, to_timestamp($13 / 1000.0), to_timestamp($13 / 1000.0)
           ) RETURNING ${JOB_COLUMNS}`,
          [
            legacy?.chainId ?? null,
            legacy?.contract ?? null,
            physicalJobId,
            request.deployment.deployment_id.digest,
            JSON.stringify(request.deployment),
            request.capability.capabilityId,
            request.capability.capabilityVersion,
            request.tokenStandard,
            request.capability.prepareAdapterId,
            request.capability.prepareAdapterVersion,
            request.capability.sourceSequence,
            request.capability.finalityPolicyVersion,
            nowMs,
          ],
        );
        row = inserted.rows[0];
        created = true;
      } else if (row.status === "failed") {
        const updated = await client.query<JobRow>(
          `UPDATE kitchen_ingest_jobs SET status = 'queued', attempt = attempt + 1,
             error_code = NULL, error_message = NULL, lease_owner = NULL, lease_until = NULL,
             updated_at = to_timestamp($2 / 1000.0)
           WHERE physical_job_id = $1 RETURNING ${JOB_COLUMNS}`,
          [row.physical_job_id, nowMs],
        );
        row = updated.rows[0];
      }
      if (!row) throw new Error(`physical job admission failed for ${key}`);

      if (request.correlation) {
        await client.query(
          `INSERT INTO kitchen_job_correlations (physical_job_id, source, correlation_id, created_at)
           VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
           ON CONFLICT DO NOTHING`,
          [row.physical_job_id, request.correlation.source, request.correlation.correlationId, nowMs],
        );
      }
      await client.query("COMMIT");
      return { ok: true, job: await rowToRecord(row), created };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertQueued(key: CollectionKey, body: IngestRequestBody, nowMs = Date.now()): Promise<IngestJobRecord> {
    const deployment = await deploymentFromCollectionKey(key);
    const capability = await resolvePreparationCapability({ network: deployment.network, tokenStandard: "erc721" });
    const result = await this.admit({
      deployment,
      tokenStandard: "erc721",
      capability,
      correlation: { source: body.source, correlationId: body.order_id },
    }, nowMs);
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
    return result.job;
  }

  async listByStatus(
    status: IngestJobStatus,
    limit = 50,
    opts?: { unleasedOnly?: boolean },
  ): Promise<IngestJobRecord[]> {
    const result = await this.pool.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM kitchen_ingest_jobs
       WHERE status = $1 AND physical_job_id IS NOT NULL
         AND ($3::boolean IS NOT TRUE OR lease_owner IS NULL)
       ORDER BY created_at ASC LIMIT $2`,
      [status, limit, opts?.unleasedOnly === true],
    );
    return Promise.all(result.rows.map(rowToRecord));
  }

  async countByStatus(): Promise<Partial<Record<IngestJobStatus, number>>> {
    const result = await this.pool.query<{ status: IngestJobStatus; n: string | number }>(
      `SELECT status, count(*)::int AS n FROM kitchen_ingest_jobs
       WHERE physical_job_id IS NOT NULL
       GROUP BY status`,
    );
    const out: Partial<Record<IngestJobStatus, number>> = {};
    for (const row of result.rows) {
      out[row.status] = Number(row.n);
    }
    return out;
  }

  /** Expose pool for operator reads that join belt chain_metadata (same DB today). */
  getPool(): pg.Pool {
    return this.pool;
  }

  async claimQueued(args: {
    workerId: string;
    limit?: number;
    leaseMs?: number;
    nowMs?: number;
  }): Promise<IngestJobRecord[]> {
    const nowMs = args.nowMs ?? Date.now();
    const leaseMs = args.leaseMs ?? 30_000;
    const result = await this.pool.query<JobRow>(
      `WITH candidates AS (
         SELECT physical_job_id FROM kitchen_ingest_jobs
         WHERE status = 'queued' AND physical_job_id IS NOT NULL
           AND (lease_until IS NULL OR lease_until <= to_timestamp($1 / 1000.0))
           AND EXISTS (
             SELECT 1 FROM kitchen_job_identity_migration_state
             WHERE singleton = true AND divergence = false
           )
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE kitchen_ingest_jobs jobs
       SET lease_owner = $3,
           lease_until = to_timestamp(($1 + $4) / 1000.0),
           lease_epoch = jobs.lease_epoch + 1,
           updated_at = to_timestamp($1 / 1000.0)
       FROM candidates
       WHERE jobs.physical_job_id = candidates.physical_job_id
       RETURNING ${JOB_COLUMNS.split(",").map((column) => `jobs.${column.trim()}`).join(", ")}`,
      [nowMs, args.limit ?? 10, args.workerId, leaseMs],
    );
    return Promise.all(result.rows.map(rowToRecord));
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
    if (args?.expectedAbsentLease && args.expectedLease) {
      throw new Error("expectedAbsentLease and expectedLease are mutually exclusive");
    }
    const nowMs = args?.nowMs ?? Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<JobRow>(
        `UPDATE kitchen_ingest_jobs SET status = $2, error_code = $3, error_message = $4,
           lease_owner = CASE WHEN $6 THEN NULL ELSE lease_owner END,
           lease_until = CASE WHEN $6 THEN NULL ELSE lease_until END,
           updated_at = to_timestamp($5 / 1000.0)
         WHERE physical_job_id = $1
           AND ($9::text IS NULL OR status = $9)
           AND ($10::boolean IS NOT TRUE OR lease_owner IS NULL)
           AND (
             $7::text IS NULL OR (
               lease_owner = $7 AND lease_epoch = $8
               AND lease_until > to_timestamp($5 / 1000.0)
             )
           )
         RETURNING ${JOB_COLUMNS}`,
        [
          physicalJobId,
          status,
          args?.errorCode ?? null,
          args?.errorMessage ?? null,
          nowMs,
          args?.releaseLease !== false,
          args?.expectedLease?.owner ?? null,
          args?.expectedLease?.epoch ?? null,
          args?.expectedStatus ?? null,
          args?.expectedAbsentLease === true,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const record = await rowToRecord(row);
      if (status === "completed") {
        await insertOwnershipReadyOutbox(client, record, nowMs);
      }
      await client.query("COMMIT");
      return record;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async renewLease(args: {
    physicalJobId: string;
    lease: { owner: string; epoch: number };
    leaseMs?: number;
    nowMs?: number;
  }): Promise<IngestJobRecord | undefined> {
    const nowMs = args.nowMs ?? Date.now();
    const result = await this.pool.query<JobRow>(
      `UPDATE kitchen_ingest_jobs
       SET lease_until = to_timestamp(($4 + $5) / 1000.0),
           updated_at = to_timestamp($4 / 1000.0)
       WHERE physical_job_id = $1 AND status = 'queued'
         AND lease_owner = $2 AND lease_epoch = $3
         AND lease_until > to_timestamp($4 / 1000.0)
       RETURNING ${JOB_COLUMNS}`,
      [args.physicalJobId, args.lease.owner, args.lease.epoch, nowMs, args.leaseMs ?? 30_000],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  async getMigrationAuthority(): Promise<MigrationAuthorityState> {
    const result = await this.pool.query<{
      phase: MigrationAuthorityState["phase"];
      divergence: boolean;
      reason: string | null;
      updated_at: Date;
    }>(
      `SELECT phase, divergence, reason, updated_at
       FROM kitchen_job_identity_migration_state WHERE singleton = true`,
    );
    const row = result.rows[0];
    if (!row) return { phase: "legacy", divergence: true, reason: "migration authority row missing", updatedAtMs: 0 };
    return {
      phase: row.phase,
      divergence: row.divergence,
      reason: row.reason ?? undefined,
      updatedAtMs: row.updated_at.getTime(),
    };
  }

  async listCorrelations(physicalJobId: string): Promise<JobCorrelation[]> {
    const result = await this.pool.query<{
      physical_job_id: string;
      source: string;
      correlation_id: string;
      created_at: Date;
    }>(
      `SELECT physical_job_id, source, correlation_id, created_at
       FROM kitchen_job_correlations WHERE physical_job_id = $1 ORDER BY created_at`,
      [physicalJobId],
    );
    return result.rows.map((row) => ({
      physicalJobId: row.physical_job_id,
      source: row.source,
      correlationId: row.correlation_id,
      createdAtMs: row.created_at.getTime(),
    }));
  }

  async reconcileUnbackfilledActiveJobs(nowMs = Date.now()): Promise<number> {
    const result = await this.pool.query<{ job_id: string }>(
      `UPDATE kitchen_ingest_jobs SET
         status = 'failed',
         error_code = 'identity_unbackfilled',
         error_message = 'physical job identity requires kitchen-backfill-job-identity before worker drain',
         lease_owner = NULL,
         lease_until = NULL,
         updated_at = to_timestamp($1 / 1000.0)
       WHERE physical_job_id IS NULL
         AND job_id IS NOT NULL
         AND status IN ('queued', 'indexing')
         AND EXISTS (
           SELECT 1 FROM kitchen_job_identity_migration_state
           WHERE singleton = true
             AND divergence = false
             AND phase IN ('parity', 'canonical', 'constrained')
         )
       RETURNING job_id`,
      [nowMs],
    );
    return result.rowCount ?? 0;
  }

  async enqueueOwnershipReady(job: IngestJobRecord, nowMs?: number): Promise<KitchenOutboxRow> {
    const at = nowMs ?? Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await insertOwnershipReadyOutbox(client, job, at);
      await client.query("COMMIT");
      return row;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listOutbox(args?: {
    publishState?: OutboxPublishState | OutboxPublishState[];
    limit?: number;
  }): Promise<KitchenOutboxRow[]> {
    const states = args?.publishState
      ? Array.isArray(args.publishState)
        ? args.publishState
        : [args.publishState]
      : null;
    const limit = args?.limit ?? 500;
    const result = states
      ? await this.pool.query<OutboxDbRow>(
          `SELECT event_id, event_type, idempotency_key, aggregate_id, payload,
                  publish_state, attempt, last_error, created_at, updated_at, published_at
           FROM kitchen_outbox
           WHERE publish_state = ANY($1::text[])
           ORDER BY created_at ASC
           LIMIT $2`,
          [states, limit],
        )
      : await this.pool.query<OutboxDbRow>(
          `SELECT event_id, event_type, idempotency_key, aggregate_id, payload,
                  publish_state, attempt, last_error, created_at, updated_at, published_at
           FROM kitchen_outbox
           ORDER BY created_at ASC
           LIMIT $1`,
          [limit],
        );
    return result.rows.map(mapOutboxRow);
  }

  async markOutboxPublishing(eventId: string, nowMs?: number): Promise<void> {
    const at = nowMs ?? Date.now();
    await this.pool.query(
      `UPDATE kitchen_outbox
       SET publish_state = 'publishing',
           attempt = attempt + 1,
           updated_at = to_timestamp($2 / 1000.0)
       WHERE event_id = $1
         AND publish_state NOT IN ('published', 'failed_terminal')`,
      [eventId, at],
    );
  }

  async markOutboxPublished(eventId: string, publishedAtMs?: number): Promise<void> {
    const at = publishedAtMs ?? Date.now();
    await this.pool.query(
      `UPDATE kitchen_outbox
       SET publish_state = 'published',
           published_at = to_timestamp($2 / 1000.0),
           updated_at = to_timestamp($2 / 1000.0),
           last_error = NULL
       WHERE event_id = $1`,
      [eventId, at],
    );
  }

  async markOutboxFailed(
    eventId: string,
    error: string,
    terminal: boolean,
    nowMs?: number,
  ): Promise<void> {
    const at = nowMs ?? Date.now();
    await this.pool.query(
      `UPDATE kitchen_outbox
       SET publish_state = $3,
           last_error = $2,
           updated_at = to_timestamp($4 / 1000.0)
       WHERE event_id = $1
         AND publish_state <> 'published'`,
      [eventId, error, terminal ? "failed_terminal" : "pending", at],
    );
  }

  async reconcileOwnershipReadyOutbox(limit = 100, nowMs?: number): Promise<number> {
    const at = nowMs ?? Date.now();
    const completed = await this.listByStatus("completed", limit);
    let n = 0;
    for (const job of completed) {
      const before = await this.pool.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM kitchen_outbox WHERE idempotency_key = $1
         ) AS exists`,
        [ownershipReadyIdempotencyKey(job)],
      );
      if (before.rows[0]?.exists) continue;
      await this.enqueueOwnershipReady(job, at);
      n += 1;
    }
    return n;
  }
}

type OutboxDbRow = {
  event_id: string;
  event_type: string;
  idempotency_key: string;
  aggregate_id: string;
  payload: OwnershipReadyEnvelope;
  publish_state: OutboxPublishState;
  attempt: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
};

function mapOutboxRow(row: OutboxDbRow): KitchenOutboxRow {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    idempotency_key: row.idempotency_key,
    aggregate_id: row.aggregate_id,
    payload: row.payload,
    publish_state: row.publish_state,
    attempt: row.attempt,
    last_error: row.last_error,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    published_at: row.published_at ? row.published_at.toISOString() : null,
  };
}

async function insertOwnershipReadyOutbox(
  client: pg.PoolClient,
  job: IngestJobRecord,
  nowMs: number,
): Promise<KitchenOutboxRow> {
  const payload = buildOwnershipReadyEnvelope(job, { occurredAtMs: nowMs });
  const result = await client.query<OutboxDbRow>(
    `INSERT INTO kitchen_outbox (
       event_id, event_type, idempotency_key, aggregate_id, payload,
       publish_state, attempt, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb, 'pending', 0,
       to_timestamp($6 / 1000.0), to_timestamp($6 / 1000.0)
     )
     ON CONFLICT (idempotency_key) DO UPDATE
       SET updated_at = kitchen_outbox.updated_at
     RETURNING event_id, event_type, idempotency_key, aggregate_id, payload,
               publish_state, attempt, last_error, created_at, updated_at, published_at`,
    [
      payload.event_id,
      payload.event_type,
      payload.idempotency_key,
      job.physicalJobId,
      JSON.stringify(payload),
      nowMs,
    ],
  );
  return mapOutboxRow(result.rows[0]!);
}

export {
  resolveKitchenDatabaseUrl as kitchenDatabaseUrlFromEnv,
  envioPgUrlFromEnv,
  kitchenSharesBeltWipeTarget,
} from "./kitchen-database-url.js";

function pgPoolConfig(connectionString: string): pg.PoolConfig {
  const sslMode = process.env.ENVIO_PG_SSL_MODE?.trim();
  const config: pg.PoolConfig = { connectionString };
  if (sslMode && sslMode !== "disable") config.ssl = { rejectUnauthorized: false };
  return config;
}

export async function createPostgresIngestJobStore(connectionString: string): Promise<PostgresIngestJobStore> {
  const pool = new pg.Pool(pgPoolConfig(connectionString));
  await ensureKitchenIngestTable(pool);
  return new PostgresIngestJobStore(pool);
}
