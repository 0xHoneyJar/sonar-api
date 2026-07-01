import pg from "pg";

import type { CollectionKey, IngestJobRecord, IngestJobStatus, IngestRequestBody } from "./types.js";
import { collectionKeyId, makeIngestJobId } from "./normalize.js";
import type { IngestJobStorePort } from "./ingest-store.js";

const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS kitchen_ingest_jobs (
  chain_id int NOT NULL,
  contract text NOT NULL,
  job_id text NOT NULL,
  order_id text NOT NULL,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  contact_email text,
  community_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract)
);
`;

type JobRow = {
  chain_id: number;
  contract: string;
  job_id: string;
  order_id: string;
  source: string;
  status: string;
  contact_email: string | null;
  community_name: string | null;
  created_at: Date;
  updated_at: Date;
};

function rowToRecord(row: JobRow): IngestJobRecord {
  return {
    jobId: row.job_id,
    key: {
      chainId: row.chain_id,
      contract: row.contract as `0x${string}`,
    },
    orderId: row.order_id,
    source: row.source,
    contactEmail: row.contact_email ?? undefined,
    communityName: row.community_name ?? undefined,
    status: row.status as IngestJobStatus,
    createdAtMs: row.created_at.getTime(),
    updatedAtMs: row.updated_at.getTime(),
  };
}

export async function ensureKitchenIngestTable(pool: pg.Pool): Promise<void> {
  await pool.query(ENSURE_TABLE_SQL);
}

export class PostgresIngestJobStore implements IngestJobStorePort {
  constructor(private readonly pool: pg.Pool) {}

  async get(key: CollectionKey): Promise<IngestJobRecord | undefined> {
    const result = await this.pool.query<JobRow>(
      `SELECT chain_id, contract, job_id, order_id, source, status,
              contact_email, community_name, created_at, updated_at
       FROM kitchen_ingest_jobs
       WHERE chain_id = $1 AND lower(contract) = lower($2)`,
      [key.chainId, key.contract],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async upsertQueued(
    key: CollectionKey,
    body: IngestRequestBody,
    nowMs = Date.now(),
  ): Promise<IngestJobRecord> {
    const existing = await this.get(key);
    if (existing) return existing;

    const jobId = makeIngestJobId(key);
    const result = await this.pool.query<JobRow>(
      `INSERT INTO kitchen_ingest_jobs
         (chain_id, contract, job_id, order_id, source, status, contact_email, community_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, to_timestamp($8 / 1000.0), to_timestamp($8 / 1000.0))
       ON CONFLICT (chain_id, contract) DO NOTHING
       RETURNING chain_id, contract, job_id, order_id, source, status,
                 contact_email, community_name, created_at, updated_at`,
      [
        key.chainId,
        key.contract,
        jobId,
        body.order_id,
        body.source,
        body.contact_email ?? null,
        body.community_name ?? null,
        nowMs,
      ],
    );

    const inserted = result.rows[0];
    if (inserted) return rowToRecord(inserted);

    const raced = await this.get(key);
    if (!raced) {
      throw new Error(`ingest upsert lost race for ${collectionKeyId(key)}`);
    }
    return raced;
  }
}

export function kitchenDatabaseUrlFromEnv(): string | undefined {
  const direct = process.env.KITCHEN_DATABASE_URL?.trim();
  if (direct) return direct;

  const host = process.env.ENVIO_PG_HOST?.trim();
  const port = process.env.ENVIO_PG_PORT?.trim();
  const user = process.env.ENVIO_PG_USER?.trim();
  const password = process.env.ENVIO_PG_PASSWORD?.trim();
  const database = process.env.ENVIO_PG_DATABASE?.trim();
  if (!host || !user || !database) return undefined;

  const encodedPassword = password ? encodeURIComponent(password) : "";
  const auth = encodedPassword ? `${user}:${encodedPassword}` : user;
  return `postgresql://${auth}@${host}:${port ?? "5432"}/${database}`;
}

function pgPoolConfig(connectionString: string): pg.PoolConfig {
  const sslMode = process.env.ENVIO_PG_SSL_MODE?.trim();
  const config: pg.PoolConfig = { connectionString };
  if (sslMode && sslMode !== "disable") {
    // Railway Postgres uses an internal CA; accept for belt-private networking.
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

export async function createPostgresIngestJobStore(
  connectionString: string,
): Promise<PostgresIngestJobStore> {
  const pool = new pg.Pool(pgPoolConfig(connectionString));
  await ensureKitchenIngestTable(pool);
  return new PostgresIngestJobStore(pool);
}
