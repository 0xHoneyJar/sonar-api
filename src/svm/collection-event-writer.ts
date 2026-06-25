/**
 * collection-event-writer.ts — batched Hasura upsert for SVM collection events.
 *
 * Sibling of the snapshot pipe's writer (pythians-collection-indexer.ts): same `hasura()` helper shape,
 * batching, and error surfacing. Writes `CollectionEvent`s to `svm.collection_event` keyed on the
 * content-addressed PK `{tx_signature}:{nft_mint}:{instruction_index}` (idempotent — backfill + webhook
 * converge; SDD §2.1). The PK string is the only collision surface, so a batch is de-duplicated by `id`
 * BEFORE the insert — Postgres rejects two rows sharing the conflict target in one `ON CONFLICT` insert.
 */

import type { CollectionEvent } from "./collection-event-source";

const UPSERT_BATCH = 500;

const HASURA = (process.env.SVM_HASURA_ENDPOINT ?? "").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";

// Hasura ROOT field is schema_table-named (svm.collection_event -> svm_collection_event); the Postgres
// PK CONSTRAINT is named after the bare table (collection_event_pkey), matching the
// svm.collection_nft / collection_nft_pkey convention of the sibling snapshot pipe.
const UPSERT = `mutation Up($objects: [svm_collection_event_insert_input!]!) {
  insert_svm_collection_event(objects: $objects,
    on_conflict: { constraint: collection_event_pkey,
      update_columns: [collection_key, collection_mint, nft_mint, kind, from, to, instruction_index, price, marketplace, slot, block_time, tx_signature] }
  ) { affected_rows }
}`;

export type EventSource = "helius-backfill" | "helius-webhook";

export interface CollectionEventRow {
  id: string; // '{tx_signature}:{nft_mint}:{instruction_index}'
  collection_key: string;
  collection_mint: string;
  nft_mint: string;
  kind: string;
  from: string | null;
  to: string | null;
  instruction_index: number;
  price: number | null;
  marketplace: string | null;
  slot: number;
  block_time: string; // ISO 8601 (timestamptz)
  tx_signature: string;
  source: EventSource;
}

/** Content-addressed PK for an event leg. */
export function eventId(e: Pick<CollectionEvent, "txSignature" | "nftMint" | "instructionIndex">): string {
  return `${e.txSignature}:${e.nftMint}:${e.instructionIndex}`;
}

/** Map events to Hasura rows. Exported for tests. `blockTime` (unix seconds) → ISO timestamptz. */
export function toRows(
  events: readonly CollectionEvent[],
  collectionKey: string,
  collectionMint: string,
  source: EventSource = "helius-backfill",
): CollectionEventRow[] {
  return events.map((e) => ({
    id: eventId(e),
    collection_key: collectionKey,
    collection_mint: collectionMint,
    nft_mint: e.nftMint,
    kind: e.kind,
    from: e.from,
    to: e.to,
    instruction_index: e.instructionIndex,
    price: e.price,
    marketplace: e.marketplace,
    slot: e.slot,
    block_time: new Date(e.blockTime * 1000).toISOString(),
    tx_signature: e.txSignature,
    source,
  }));
}

/** De-duplicate rows by PK `id` (last write wins) — a single ON CONFLICT insert cannot touch a row twice. */
export function dedupeById(rows: readonly CollectionEventRow[]): CollectionEventRow[] {
  const byId = new Map<string, CollectionEventRow>();
  for (const r of rows) byId.set(r.id, r);
  return [...byId.values()];
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function hasura<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${HASURA}/v1/graphql`, {
    method: "POST",
    headers: { "x-hasura-admin-secret": SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`hasura: HTTP ${res.status} ${body.slice(0, 200)}`); // surface 401/5xx clearly
  }
  const d = (await res.json()) as { data?: T; errors?: unknown };
  if (d.errors) throw new Error(`hasura: ${JSON.stringify(d.errors)}`);
  return d.data as T;
}

/**
 * Upsert events into svm.collection_event in batches. De-dupes by PK first. Returns total affected_rows.
 * Insert-only/idempotent — no destructive op (unlike the snapshot reconcile); safe to re-run.
 */
export async function upsertCollectionEvents(
  events: readonly CollectionEvent[],
  collectionKey: string,
  collectionMint: string,
  source: EventSource = "helius-backfill",
): Promise<number> {
  const rows = dedupeById(toRows(events, collectionKey, collectionMint, source));
  let affected = 0;
  for (const batch of chunk(rows, UPSERT_BATCH)) {
    const d = await hasura<{ insert_svm_collection_event: { affected_rows: number } }>(UPSERT, { objects: batch });
    affected += d.insert_svm_collection_event.affected_rows;
  }
  return affected;
}
