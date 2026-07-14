/**
 * pythians-collection-indexer.ts — SVM ownership indexer for the "pythians" NFT collection.
 *
 * Sibling of genesis-stone-indexer.ts. Reads a current-state ownership SNAPSHOT (every member NFT →
 * its holder) from an `NftCollectionSource` (Helius DAS v1; HyperSync later — same seam) and writes it
 * to `svm.collection_nft` via Hasura, keyed on the NFT mint (idempotent). Because ownership is
 * current-state, each run UPSERTs present members stamped with a single per-run `updated_at`, then
 * RECONCILES by deleting rows for this collection whose `updated_at` is older than this run — so
 * transferred-out / burnt NFTs drop out.
 *
 * Collection: Pythenians = pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru (on-chain name "Pythenians" / $PTN;
 * Metaplex collection mint, grounded on-chain 2026-06-23: classic SPL mint, supply 1, decimals 0). NOTE:
 * the pump.fun token 7C9…pump was the WRONG address — Pythenians is this NFT collection, not a token.
 *
 * SAFETY (BB review): reconcile uses a self-controlled per-run marker (`updated_at`, NOT the RPC `slot`,
 * which isn't monotonic across load-balanced nodes — M1), and is GUARDED two ways against deleting real
 * holders on a bad read: skip on a 0-member snapshot, and skip if the snapshot shrinks the holder set
 * below RECONCILE_MIN_RATIO of the existing rows (a partial/short DAS page — B2).
 *
 * Table DDL: grimoires/loa/specs/2026-06-23-svm-pythians-collection-design.md (apply before first run).
 *
 * Run (snapshot): SOLANA_RPC_URL=<helius-DAS> HASURA_GRAPHQL_ADMIN_SECRET=<secret> \
 *                 SVM_HASURA_ENDPOINT=<svm-hasura> npx tsx src/svm/pythians-collection-indexer.ts
 */

import { fileURLToPath } from "node:url";
import { installMeterExitLog } from "./helius-meter";
import {
  DasNftCollectionSource,
  type CollectionSnapshot,
  type NftCollectionSource,
} from "./nft-collection-source";

// ── CONFIG (the only collection-specific surface) ───────────────────────────
export const PYTHIANS_COLLECTION = "pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru";
export const COLLECTION_KEY = "pythians";
const UPSERT_BATCH = 500;
/** Refuse to reconcile if a snapshot shrinks the holder set below this fraction of existing rows (B2). */
const RECONCILE_MIN_RATIO = 0.5;

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
// No production default — a committed prod URL invites accidental dev→prod writes (BB review L3).
const HASURA = (process.env.SVM_HASURA_ENDPOINT ?? "").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";

// Hasura ROOT fields are schema_table-named (svm.collection_nft -> svm_collection_nft); the Postgres
// PK CONSTRAINT is named after the bare table (collection_nft_pkey), matching the svm.genesis_stone /
// genesis_stone_pkey convention of the sibling pipe. (Root-field name != constraint name.)
const UPSERT = `mutation Up($objects: [svm_collection_nft_insert_input!]!) {
  insert_svm_collection_nft(objects: $objects,
    on_conflict: { constraint: collection_nft_pkey,
      update_columns: [collection_key, collection_mint, nft_mint, owner, delegate, name, image, uri, compressed, slot, source, updated_at] }
  ) { affected_rows }
}`;

const RECONCILE = `mutation Rec($ck: String!, $runIso: timestamptz!) {
  delete_svm_collection_nft(where: { collection_key: { _eq: $ck }, updated_at: { _lt: $runIso } }) { affected_rows }
}`;

const COUNT = `query Cnt($ck: String!) {
  svm_collection_nft_aggregate(where: { collection_key: { _eq: $ck } }) { aggregate { count } }
}`;

type NftRow = {
  id: string; // nft mint
  collection_key: string;
  collection_mint: string;
  nft_mint: string;
  owner: string;
  delegate: string | null;
  name: string | null;
  image: string | null;
  uri: string | null;
  compressed: boolean;
  slot: number;
  source: string;
  updated_at: string;
};

async function hasura<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${HASURA}/v1/graphql`, {
    method: "POST",
    headers: { "x-hasura-admin-secret": SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`hasura: HTTP ${res.status} ${body.slice(0, 200)}`); // 401/5xx surfaced clearly (BB L1)
  }
  const d = (await res.json()) as { data?: T; errors?: unknown };
  if (d.errors) throw new Error(`hasura: ${JSON.stringify(d.errors)}`);
  return d.data as T;
}

/** Map an ownership snapshot to Hasura rows (keyed on the NFT mint). Exported for tests. */
export function toRows(snap: CollectionSnapshot, collectionKey: string, nowIso: string): NftRow[] {
  return snap.members.map((m) => ({
    id: m.nftMint,
    collection_key: collectionKey,
    collection_mint: snap.collectionMint,
    nft_mint: m.nftMint,
    owner: m.owner,
    delegate: m.delegate,
    name: m.name,
    image: m.image,
    uri: m.uri,
    compressed: m.compressed,
    slot: snap.slot,
    source: snap.source,
    updated_at: nowIso,
  }));
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Index an ownership snapshot into Hasura: batched upsert of current members (stamped with a single
 * per-run `nowIso`), then reconcile (delete rows for this collection with an older `updated_at`).
 * Returns {upserted, removed, slot}. Reconcile is skipped if the snapshot is empty or shrinks the
 * holder set below RECONCILE_MIN_RATIO (likely a partial DAS read — upserts are kept, deletes are not).
 */
export async function indexSnapshot(
  source: NftCollectionSource,
  collectionKey: string,
  nowIso: string = new Date().toISOString(),
): Promise<{ upserted: number; removed: number; slot: number }> {
  const snap = await source.snapshot();
  const rows = toRows(snap, collectionKey, nowIso);

  // Guard 1 — a fully-empty snapshot is a DAS/RPC failure, not "the collection vanished".
  if (rows.length === 0) {
    console.warn(`⚠ ${collectionKey}: snapshot returned 0 members @ slot ${snap.slot} — skipping upsert+reconcile to avoid wiping the table (treat as a DAS/RPC issue)`);
    return { upserted: 0, removed: 0, slot: snap.slot };
  }

  // Snapshot the pre-run row count up front (for the proportional reconcile guard, B2).
  const before = await hasura<{ svm_collection_nft_aggregate: { aggregate: { count: number } } }>(COUNT, { ck: collectionKey });
  const countBefore = before.svm_collection_nft_aggregate.aggregate.count;

  let upserted = 0;
  for (const batch of chunk(rows, UPSERT_BATCH)) {
    const d = await hasura<{ insert_svm_collection_nft: { affected_rows: number } }>(UPSERT, { objects: batch });
    upserted += d.insert_svm_collection_nft.affected_rows;
    console.log(`  …upserted ${upserted}/${rows.length} NFTs`);
  }

  // Guard 2 — a partial (short/dropped-page) read passes guard 1 but would delete the unread holders.
  // Refuse to reconcile if the snapshot is suspiciously smaller than what's already stored.
  if (countBefore > 0 && rows.length < countBefore * RECONCILE_MIN_RATIO) {
    console.warn(`⚠ ${collectionKey}: snapshot has ${rows.length} members but ${countBefore} rows exist (< ${Math.round(RECONCILE_MIN_RATIO * 100)}%) — SKIPPING reconcile to avoid deleting holders from a likely-partial read. Upserts kept.`);
    return { upserted, removed: 0, slot: snap.slot };
  }

  const rec = await hasura<{ delete_svm_collection_nft: { affected_rows: number } }>(RECONCILE, {
    ck: collectionKey,
    runIso: nowIso,
  });
  return { upserted, removed: rec.delete_svm_collection_nft.affected_rows, slot: snap.slot };
}

async function main(): Promise<void> {
  installMeterExitLog("ownership-snapshot"); // KF-018/#122: credit-burn ledger line, crash paths included
  if (!SECRET) throw new Error("HASURA_GRAPHQL_ADMIN_SECRET required");
  if (!HASURA) throw new Error("SVM_HASURA_ENDPOINT required (no prod default — set it explicitly)");
  // --collection <key> genericizes the snapshot pipe (registry-resolved; default pythians —
  // exports above stay for back-compat importers). Snapshot-first onboarding: ~50cr/collection.
  const ci = process.argv.indexOf("--collection");
  const cfg = ci >= 0 ? (await import("./collection-registry.js")).resolveCollection(process.argv[ci + 1] ?? "") : null;
  const collectionMint = cfg?.collectionMint ?? PYTHIANS_COLLECTION;
  const collectionKey = cfg?.collectionKey ?? COLLECTION_KEY;
  const src: NftCollectionSource = new DasNftCollectionSource(RPC, collectionMint);
  const h = await src.health();
  console.log(`source health: ${h.ok ? "ok" : "DEGRADED"} (${h.detail}) · rpc=${RPC.replace(/\?.*/, "")}`);
  if (!h.ok) throw new Error(`DAS source unhealthy (need a Helius/DAS-capable SOLANA_RPC_URL): ${h.detail}`);
  console.log(`snapshotting ${collectionKey} collection ownership (${collectionMint})…`);
  const { upserted, removed, slot } = await indexSnapshot(src, collectionKey);
  console.log(`✅ DONE — ${collectionKey}: ${upserted} NFTs upserted, ${removed} stale removed @ slot ${slot}`);
}

// run only when invoked directly (so indexSnapshot/toRows stay importable/testable). Compare resolved
// paths, not raw file:// strings — the latter percent-encodes and silently mis-matches (BB review M3).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
