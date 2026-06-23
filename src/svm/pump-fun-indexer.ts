/**
 * pump-fun-indexer.ts — SVM holder indexer for the "pythians" pump.fun community token.
 *
 * Sibling of genesis-stone-indexer.ts. Reads a current-state holder SNAPSHOT from an
 * `SplHolderSource` (RPC v1; HyperSync later — same seam) and writes it to `svm_token_holder` via
 * Hasura, keyed on `<collection_key>:<owner>` (idempotent). Because holders are current-state (not
 * append-only events), each run UPSERTs the present holders with the snapshot slot, then RECONCILES
 * by deleting rows for this collection whose slot is older than the snapshot — so wallets that exited
 * the token drop out instead of lingering as stale balances.
 *
 * Token: Pythians = 7C9AvMCtsgbZoip9aMs8etFueo5YStXFnDtwrDg5pump (Token-2022, 6 decimals — grounded
 * on-chain 2026-06-23). Generic on the mint: any SPL/Token-2022 token can be indexed by changing the
 * three CONFIG constants (or factoring them to argv/env for a multi-token runner).
 *
 * Table DDL: grimoires/loa/specs/2026-06-23-svm-pump-fun-holders-design.md (apply to the SVM Hasura's
 * Postgres before first run).
 *
 * Run (snapshot): SOLANA_RPC_URL=<helius> HASURA_GRAPHQL_ADMIN_SECRET=<secret> \
 *                 npx tsx src/svm/pump-fun-indexer.ts
 */

import { Connection } from "@solana/web3.js";
import {
  RpcSplHolderSource,
  type HolderSnapshot,
  type SplHolderSource,
} from "./spl-holder-source";

// ── CONFIG (the only token-specific surface) ────────────────────────────────
export const PYTHIANS_MINT = "7C9AvMCtsgbZoip9aMs8etFueo5YStXFnDtwrDg5pump";
export const COLLECTION_KEY = "pythians";
const UPSERT_BATCH = 500;

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const HASURA = (process.env.SVM_HASURA_ENDPOINT ?? "https://belt-hasura-selfhost-production.up.railway.app").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";

const UPSERT = `mutation Up($objects: [svm_token_holder_insert_input!]!) {
  insert_svm_token_holder(objects: $objects,
    on_conflict: { constraint: svm_token_holder_pkey,
      update_columns: [collection_key, mint, owner, amount_raw, decimals, slot, source, updated_at] }
  ) { affected_rows }
}`;

const RECONCILE = `mutation Rec($ck: String!, $slot: bigint!) {
  delete_svm_token_holder(where: { collection_key: { _eq: $ck }, slot: { _lt: $slot } }) { affected_rows }
}`;

type HolderRow = {
  id: string;
  collection_key: string;
  mint: string;
  owner: string;
  amount_raw: string; // u64 as string (Hasura numeric)
  decimals: number;
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

/** Map a snapshot to Hasura rows. Exported for tests. */
export function toRows(snap: HolderSnapshot, collectionKey: string, nowIso: string): HolderRow[] {
  return snap.holders.map((h) => ({
    id: `${collectionKey}:${h.owner}`,
    collection_key: collectionKey,
    mint: snap.mint,
    owner: h.owner,
    amount_raw: h.amountRaw.toString(),
    decimals: snap.decimals,
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
 * Index a holder snapshot into Hasura: batched upsert of current holders, then reconcile (delete
 * rows for this collection older than the snapshot slot). Returns {upserted, removed}.
 */
export async function indexSnapshot(
  source: SplHolderSource,
  collectionKey: string,
  nowIso: string = new Date().toISOString(),
): Promise<{ upserted: number; removed: number; slot: number }> {
  const snap = await source.snapshot();
  const rows = toRows(snap, collectionKey, nowIso);

  // Safety: an empty snapshot is almost always an RPC throttle/failure, not "everyone sold".
  // Reconciling on it would DELETE every holder (all rows have slot < the new snapshot slot).
  // Refuse to wipe — skip both upsert and reconcile and surface it.
  if (rows.length === 0) {
    console.warn(`⚠ ${collectionKey}: snapshot returned 0 holders @ slot ${snap.slot} — skipping upsert+reconcile to avoid wiping the table (treat as an RPC issue)`);
    return { upserted: 0, removed: 0, slot: snap.slot };
  }

  let upserted = 0;
  for (const batch of chunk(rows, UPSERT_BATCH)) {
    const d = await hasura<{ insert_svm_token_holder: { affected_rows: number } }>(UPSERT, { objects: batch });
    upserted += d.insert_svm_token_holder.affected_rows;
    console.log(`  …upserted ${upserted}/${rows.length} holders`);
  }

  const rec = await hasura<{ delete_svm_token_holder: { affected_rows: number } }>(RECONCILE, {
    ck: collectionKey,
    slot: snap.slot,
  });
  return { upserted, removed: rec.delete_svm_token_holder.affected_rows, slot: snap.slot };
}

async function main(): Promise<void> {
  if (!SECRET) throw new Error("HASURA_GRAPHQL_ADMIN_SECRET required");
  const src: SplHolderSource = new RpcSplHolderSource(new Connection(RPC, "confirmed"), PYTHIANS_MINT);
  const h = await src.health();
  console.log(`source health: ${h.ok ? "ok" : "DEGRADED"} (${h.detail}) · rpc=${RPC.replace(/\?.*/, "")}`);
  console.log(`snapshotting ${COLLECTION_KEY} holders (${PYTHIANS_MINT})…`);
  const { upserted, removed, slot } = await indexSnapshot(src, COLLECTION_KEY);
  console.log(`✅ DONE — ${COLLECTION_KEY}: ${upserted} holders upserted, ${removed} stale removed @ slot ${slot}`);
}

// run only when invoked directly (so indexSnapshot/toRows stay importable/testable)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
