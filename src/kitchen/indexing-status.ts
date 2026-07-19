/**
 * Operator indexing snapshot — chain sync progress + Kitchen preparation jobs.
 * Service-auth only (see GET /v2/indexing-status).
 */

import type pg from "pg";

import type { IngestJobRecord, IngestJobStatus } from "./types.js";

export type ChainProgressRow = {
  chain_id: number;
  start_block: number;
  latest_processed_block: number;
  latest_fetched_block_number: number;
  num_events_processed: number;
  num_batches_fetched: number;
};

export type IndexingJobRow = {
  physical_job_id: string;
  status: IngestJobStatus;
  network_namespace: string;
  network_reference: string;
  address: string;
  token_standard: string;
  prepare_adapter_id: string;
  attempt: number;
  created_at: string;
  updated_at: string;
  correlation_source?: string;
  correlation_id?: string;
};

export type IndexingStatusBody = {
  schema_version: 1;
  observed_at: string;
  chains: ChainProgressRow[];
  jobs: {
    by_status: Partial<Record<IngestJobStatus, number>>;
    active: IndexingJobRow[];
  };
};

export function jobToIndexingRow(job: IngestJobRecord): IndexingJobRow {
  return {
    physical_job_id: job.physicalJobId,
    status: job.status,
    network_namespace: job.deployment.network.network_namespace,
    network_reference: job.deployment.network.network_reference,
    address: job.deployment.normalized_address,
    token_standard: job.tokenStandard,
    prepare_adapter_id: job.prepareAdapterId,
    attempt: job.attempt,
    created_at: new Date(job.createdAtMs).toISOString(),
    updated_at: new Date(job.updatedAtMs).toISOString(),
    ...(job.correlation
      ? {
          correlation_source: job.correlation.source,
          correlation_id: job.correlation.correlationId,
        }
      : {}),
  };
}

export async function readChainProgress(pool: pg.Pool): Promise<ChainProgressRow[]> {
  try {
    const result = await pool.query<{
      chain_id: number | string;
      start_block: number | string;
      latest_processed_block: number | string;
      latest_fetched_block_number: number | string;
      num_events_processed: number | string;
      num_batches_fetched: number | string;
    }>(
      `SELECT chain_id, start_block, latest_processed_block, latest_fetched_block_number,
              num_events_processed, num_batches_fetched
       FROM chain_metadata
       ORDER BY chain_id ASC`,
    );
    return result.rows.map((row) => ({
      chain_id: Number(row.chain_id),
      start_block: Number(row.start_block),
      latest_processed_block: Number(row.latest_processed_block),
      latest_fetched_block_number: Number(row.latest_fetched_block_number),
      num_events_processed: Number(row.num_events_processed),
      num_batches_fetched: Number(row.num_batches_fetched),
    }));
  } catch {
    // Table absent (e.g. hermetic memory / Kitchen DB isolated from belt).
    return [];
  }
}

export async function buildIndexingStatus(args: {
  countByStatus: () => Promise<Partial<Record<IngestJobStatus, number>>>;
  listByStatus: (status: IngestJobStatus, limit?: number) => Promise<IngestJobRecord[]>;
  readChains: () => Promise<ChainProgressRow[]>;
  activeJobLimit?: number;
  nowMs?: number;
}): Promise<IndexingStatusBody> {
  const limit = args.activeJobLimit ?? 500;
  const byStatus = await args.countByStatus();
  const [queued, indexing] = await Promise.all([
    args.listByStatus("queued", limit),
    args.listByStatus("indexing", limit),
  ]);
  const active = [...queued, ...indexing]
    .map(jobToIndexingRow)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  return {
    schema_version: 1,
    observed_at: new Date(args.nowMs ?? Date.now()).toISOString(),
    chains: await args.readChains(),
    jobs: {
      by_status: byStatus,
      active,
    },
  };
}
