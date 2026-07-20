/**
 * Sonar kitchen — ownership_ready inventory (Shannon).
 *
 * Completed Kitchen prepare jobs are ownership-ready subjects for ops intake
 * and Score *candidates*. They must NOT imply Score Machine C active.
 *
 * See freeside-dashboard grimoires/pub/freeside-event-catalog.md · sonar-api#238
 */

import type { IngestJobRecord } from "./types.js";

export type OwnershipReadyRow = {
  caip10: string;
  network_namespace: string;
  network_reference: string;
  address: string;
  token_standard: string;
  physical_job_id: string;
  prepare_adapter_id: string;
  kitchen_job_status: "completed";
  completed_at: string;
  holder_count: number | null;
  indexed_at: string | null;
};

export type OwnershipReadyInventory = {
  schema_version: 1;
  observed_at: string;
  /** Shannon: Sonar kitchen product plane — not Score catalog. */
  plane: "sonar_kitchen_ownership";
  count: number;
  subjects: OwnershipReadyRow[];
};

export function caip10ForJob(job: IngestJobRecord): string {
  const ns = job.deployment.network.network_namespace;
  const ref = job.deployment.network.network_reference;
  const addr = job.deployment.normalized_address;
  return `${ns}:${ref}:${addr}`;
}

export function jobToOwnershipReadyRow(
  job: IngestJobRecord,
  enrich?: { holderCount: number | null; indexedAtMs: number | null },
): OwnershipReadyRow | null {
  if (job.status !== "completed") return null;
  return {
    caip10: caip10ForJob(job),
    network_namespace: job.deployment.network.network_namespace,
    network_reference: job.deployment.network.network_reference,
    address: job.deployment.normalized_address,
    token_standard: job.tokenStandard,
    physical_job_id: job.physicalJobId,
    prepare_adapter_id: job.prepareAdapterId,
    kitchen_job_status: "completed",
    completed_at: new Date(job.updatedAtMs).toISOString(),
    holder_count: enrich?.holderCount ?? null,
    indexed_at:
      enrich?.indexedAtMs != null ? new Date(enrich.indexedAtMs).toISOString() : null,
  };
}

export async function buildOwnershipReadyInventory(args: {
  listCompleted: (limit?: number) => Promise<IngestJobRecord[]>;
  enrich?: (
    job: IngestJobRecord,
  ) => Promise<{ holderCount: number | null; indexedAtMs: number | null }>;
  limit?: number;
  nowMs?: number;
}): Promise<OwnershipReadyInventory> {
  const limit = args.limit ?? 500;
  const jobs = await args.listCompleted(limit);
  const subjects: OwnershipReadyRow[] = [];
  for (const job of jobs) {
    const enrich = args.enrich ? await args.enrich(job) : undefined;
    const row = jobToOwnershipReadyRow(job, enrich);
    if (row) subjects.push(row);
  }
  subjects.sort((a, b) => b.completed_at.localeCompare(a.completed_at));
  return {
    schema_version: 1,
    observed_at: new Date(args.nowMs ?? Date.now()).toISOString(),
    plane: "sonar_kitchen_ownership",
    count: subjects.length,
    subjects,
  };
}
