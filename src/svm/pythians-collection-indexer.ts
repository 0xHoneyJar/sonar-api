/**
 * pythians-collection-indexer.ts — SVM ownership indexer for the "pythians" NFT collection.
 *
 * Sibling of genesis-stone-indexer.ts. Reads a current-state ownership SNAPSHOT (every member NFT →
 * its holder) from an `NftCollectionSource` (Helius DAS v1; HyperSync later — same seam) and writes it
 * to `svm_collection_nft` via Hasura, keyed on the NFT mint (idempotent). Because ownership is
 * current-state, each run UPSERTs present members with the snapshot slot, then RECONCILES by deleting
 * rows for this collection whose slot is older — so transferred-out / burnt NFTs drop out.
 *
 * Collection: Pythians = pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru (Metaplex collection mint,
 * grounded on-chain 2026-06-23: classic SPL mint, supply 1, decimals 0). NOTE: the pump.fun token
 * 7C9…pump was the WRONG address — Pythians is this NFT collection, not a fungible token.
 *
 * Table DDL: grimoires/loa/specs/2026-06-23-svm-pythians-collection-design.md (apply before first run).
 *
 * Run (snapshot): SOLANA_RPC_URL=<helius-DAS> HASURA_GRAPHQL_ADMIN_SECRET=<secret> \
 *                 npx tsx src/svm/pythians-collection-indexer.ts
 */

import {
  DasNftCollectionSource,
  type CollectionSnapshot,
  type NftCollectionSource,
} from "./nft-collection-source";

// ── CONFIG (the only collection-specific surface) ───────────────────────────
export const PYTHIANS_COLLECTION = "pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru";
export const COLLECTION_KEY = "pythians";
const UPSERT_BATCH = 500;

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const HASURA = (process.env.SVM_HASURA_ENDPOINT ?? "https://belt-hasura-selfhost-production.up.railway.app").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";

const UPSERT = `mutation Up($objects: [svm_collection_nft_insert_input!]!) {
  insert_svm_collection_nft(objects: $objects,
    on_conflict: { constraint: svm_collection_nft_pkey,
      update_columns: [collection_key, collection_mint, nft_mint, owner, name, compressed, slot, source, updated_at] }
  ) { affected_rows }
}`;

const RECONCILE = `mutation Rec($ck: String!, $slot: bigint!) {
  delete_svm_collection_nft(where: { collection_key: { _eq: $ck }, slot: { _lt: $slot } }) { affected_rows }
}`;

type NftRow = {
  id: string; // nft mint
  collection_key: string;
  collection_mint: string;
  nft_mint: string;
  owner: string;
  name: string | null;
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
    name: m.name,
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
 * Index an ownership snapshot into Hasura: batched upsert of current members, then reconcile (delete
 * rows for this collection older than the snapshot slot). Returns {upserted, removed, slot}.
 */
export async function indexSnapshot(
  source: NftCollectionSource,
  collectionKey: string,
  nowIso: string = new Date().toISOString(),
): Promise<{ upserted: number; removed: number; slot: number }> {
  const snap = await source.snapshot();
  const rows = toRows(snap, collectionKey, nowIso);

  // Safety: an empty snapshot is almost always a DAS/RPC issue, not "the collection vanished".
  // Reconciling on it would DELETE every member. Refuse to wipe.
  if (rows.length === 0) {
    console.warn(`⚠ ${collectionKey}: snapshot returned 0 members @ slot ${snap.slot} — skipping upsert+reconcile to avoid wiping the table (treat as a DAS/RPC issue)`);
    return { upserted: 0, removed: 0, slot: snap.slot };
  }

  let upserted = 0;
  for (const batch of chunk(rows, UPSERT_BATCH)) {
    const d = await hasura<{ insert_svm_collection_nft: { affected_rows: number } }>(UPSERT, { objects: batch });
    upserted += d.insert_svm_collection_nft.affected_rows;
    console.log(`  …upserted ${upserted}/${rows.length} NFTs`);
  }

  const rec = await hasura<{ delete_svm_collection_nft: { affected_rows: number } }>(RECONCILE, {
    ck: collectionKey,
    slot: snap.slot,
  });
  return { upserted, removed: rec.delete_svm_collection_nft.affected_rows, slot: snap.slot };
}

async function main(): Promise<void> {
  if (!SECRET) throw new Error("HASURA_GRAPHQL_ADMIN_SECRET required");
  const src: NftCollectionSource = new DasNftCollectionSource(RPC, PYTHIANS_COLLECTION);
  const h = await src.health();
  console.log(`source health: ${h.ok ? "ok" : "DEGRADED"} (${h.detail}) · rpc=${RPC.replace(/\?.*/, "")}`);
  if (!h.ok) throw new Error(`DAS source unhealthy (need a Helius/DAS-capable SOLANA_RPC_URL): ${h.detail}`);
  console.log(`snapshotting ${COLLECTION_KEY} collection ownership (${PYTHIANS_COLLECTION})…`);
  const { upserted, removed, slot } = await indexSnapshot(src, COLLECTION_KEY);
  console.log(`✅ DONE — ${COLLECTION_KEY}: ${upserted} NFTs upserted, ${removed} stale removed @ slot ${slot}`);
}

// run only when invoked directly (so indexSnapshot/toRows stay importable/testable)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
