/**
 * Sonar kitchen transactional outbox (coordination fabric T4).
 *
 * Three proofs (never collapse):
 * 1. Outbox row committed with domain mutation (or reconcile from completed jobs)
 * 2. Broker/transport accepted publish (relay marks published only after accept)
 * 3. Consumer acted (Score inbox / ops) — out of scope here; never implied by (1) or (2)
 *
 * Never inline-publish-and-swallow. Pull is a valid week-0–2 transport.
 */

import { createHash, randomUUID } from "node:crypto";

import { caip10ForJob } from "./ownership-ready.js";
import type { IngestJobRecord } from "./types.js";

export const OWNERSHIP_READY_EVENT_TYPE = "ownership.ready" as const;

export type OutboxPublishState =
  | "pending"
  | "publishing"
  | "published"
  | "failed_terminal";

export type OwnershipReadyEnvelope = {
  schema_version: 1;
  event_type: typeof OWNERSHIP_READY_EVENT_TYPE;
  event_id: string;
  idempotency_key: string;
  occurred_at: string;
  producer: "sonar_kitchen";
  plane: "sonar_kitchen_ownership";
  subject: {
    caip10: string;
    network_namespace: string;
    network_reference: string;
    address: string;
    token_standard: string;
    physical_job_id: string;
    prepare_adapter_id: string;
  };
};

export type KitchenOutboxRow = {
  event_id: string;
  event_type: string;
  idempotency_key: string;
  aggregate_id: string;
  payload: OwnershipReadyEnvelope;
  publish_state: OutboxPublishState;
  attempt: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};

export function ownershipReadyIdempotencyKey(job: IngestJobRecord): string {
  const material = [
    OWNERSHIP_READY_EVENT_TYPE,
    job.physicalJobId,
    job.deployment.deployment_id.digest,
    job.capabilityVersion,
  ].join("|");
  return createHash("sha256").update(material).digest("hex");
}

export function buildOwnershipReadyEnvelope(
  job: IngestJobRecord,
  args?: { eventId?: string; occurredAtMs?: number },
): OwnershipReadyEnvelope {
  const occurredAtMs = args?.occurredAtMs ?? job.updatedAtMs;
  return {
    schema_version: 1,
    event_type: OWNERSHIP_READY_EVENT_TYPE,
    event_id: args?.eventId ?? randomUUID(),
    idempotency_key: ownershipReadyIdempotencyKey(job),
    occurred_at: new Date(occurredAtMs).toISOString(),
    producer: "sonar_kitchen",
    plane: "sonar_kitchen_ownership",
    subject: {
      caip10: caip10ForJob(job),
      network_namespace: job.deployment.network.network_namespace,
      network_reference: job.deployment.network.network_reference,
      address: job.deployment.normalized_address,
      token_standard: job.tokenStandard,
      physical_job_id: job.physicalJobId,
      prepare_adapter_id: job.prepareAdapterId,
    },
  };
}

/** Transport port — accept ≠ consumer acted. Swallowing errors is forbidden. */
export type OutboxTransport = {
  /** Return ok only when the broker/pull sink durably accepted the envelope. */
  accept(envelope: OwnershipReadyEnvelope): Promise<{ ok: true } | { ok: false; error: string }>;
};

/** Pull sink: durable accept = recorded for consumers to fetch (not Score mutation). */
export function createPullBufferTransport(buffer: OwnershipReadyEnvelope[]): OutboxTransport {
  return {
    async accept(envelope) {
      buffer.push(envelope);
      return { ok: true };
    },
  };
}

/** Failing transport for tests — must leave outbox pending/failed, never pretend published. */
export function createFailingTransport(error = "transport_unavailable"): OutboxTransport {
  return {
    async accept() {
      return { ok: false, error };
    },
  };
}

export async function relayOutboxRow(args: {
  row: KitchenOutboxRow;
  transport: OutboxTransport;
  markPublishing: (eventId: string) => Promise<void>;
  markPublished: (eventId: string, publishedAtMs: number) => Promise<void>;
  markFailed: (eventId: string, error: string, terminal: boolean) => Promise<void>;
  nowMs?: number;
  maxAttempts?: number;
}): Promise<"published" | "failed" | "skipped"> {
  if (args.row.publish_state === "published") return "skipped";
  if (args.row.publish_state === "failed_terminal") return "skipped";

  await args.markPublishing(args.row.event_id);
  const result = await args.transport.accept(args.row.payload);
  if (result.ok) {
    await args.markPublished(args.row.event_id, args.nowMs ?? Date.now());
    return "published";
  }

  const attempt = args.row.attempt + 1;
  const max = args.maxAttempts ?? 8;
  await args.markFailed(args.row.event_id, result.error, attempt >= max);
  return "failed";
}
