/**
 * seed-from-extraction.ts — feed the per-community extraction-loop output into the registry (FR-8, H-7, T6.1).
 *
 * The extraction loop (context/community-address-attribution-extraction-prompt.md) is operator/Codex-run
 * tooling; its CSV/JSON output flows through the SAME ingestion seam as everything else — no write bypass
 * (H-7). v1 instance: Pythenians. The live address data is operator-fed; this module + its tests build and
 * pin the path.
 */
import { ingestLabels, type IngestOptions } from "./ingest";
import type { EntityType, IngestResult, LabelInput, LabelMethod } from "./types";

/** One row of the extraction-loop output (the prompt's OUTPUT schema). */
export interface ExtractionRow {
  address: string;
  chain: string;
  collection?: string | null; // → collection_scope (null = global)
  label: string;
  entity?: string; // canonical entity id; defaults to label
  entity_type: string;
  method: string;
  source?: string | null;
  confidence?: number;
  validity_window?: string | null; // open instant; null → now() at upsert
  evidence_ref: string;
  signature?: string | null;
  signing_key_id?: string | null;
  notes?: string | null;
}

/** validity_window in the extraction schema may be a SLOT descriptor ("from_slot:N -> open") or an ISO
 *  instant. validity_from is timestamptz, so use it only when it parses to a real timestamp; otherwise
 *  default to now() (the slot is already preserved in evidence_ref / notes). */
function isoOrUndefined(v?: string | null): string | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/**
 * `collectionKey` (the stable registry key) OVERRIDES the per-row `collection` field for `collection_scope`.
 * The extraction's `collection` is a NAME ("Pythenians") and must NOT become the infra key (a consumer
 * queries `collection_scope` by the stable slug); the caller passes the registry key so the name can't leak
 * into the key (the infra/presentation split). When omitted, falls back to per-row `collection` (legacy).
 */
export function toLabelInputs(rows: ExtractionRow[], collectionKey?: string): LabelInput[] {
  return rows.map((r) => {
    const validityFrom = isoOrUndefined(r.validity_window);
    // if the window was a non-ISO descriptor, keep it in notes so the slot bound isn't lost
    const windowNote = r.validity_window && !validityFrom ? `validity_window: ${r.validity_window}` : null;
    const notes = [r.notes ?? null, windowNote].filter(Boolean).join(" · ") || null;
    return {
      address: r.address,
      chain: r.chain,
      collectionScope: collectionKey ?? r.collection ?? null,
      entity: r.entity ?? r.label,
      label: r.label,
      entityType: r.entity_type as EntityType,
      method: r.method as LabelMethod,
      source: r.source ?? null,
      evidenceRef: r.evidence_ref,
      confidence: r.confidence,
      validityFrom,
      signature: r.signature ?? null,
      signingKeyId: r.signing_key_id ?? null,
      notes,
    };
  });
}

/** Ingest an extraction batch through the seam (validate → steps → idempotent upsert → audit).
 *  Pass `collectionKey` (the stable registry slug) so `collection_scope` is the infra key, never the name. */
export async function seedFromExtraction(
  rows: ExtractionRow[],
  opts: IngestOptions & { collectionKey?: string },
): Promise<IngestResult> {
  return ingestLabels(toLabelInputs(rows, opts.collectionKey), opts);
}
