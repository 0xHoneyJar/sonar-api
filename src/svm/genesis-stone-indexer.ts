/**
 * genesis-stone-indexer.ts — the SVM v1 indexer (bd-w301.6 / .7).
 *
 * Reads StoneClaimed from a `StoneSource` (RPC v1; HyperSync later — same seam) and upserts into
 * `svm.genesis_stone` via Hasura (idempotent on `mint`). Bounded dataset (genesis stones), so the
 * Hasura write path is fine for v1; swap to direct `pg` if volume ever demands it.
 *
 * Run (backfill): SOLANA_RPC_URL=<helius-or-public> HASURA_GRAPHQL_ADMIN_SECRET=<secret> \
 *                 npx tsx src/svm/genesis-stone-indexer.ts
 */

import { Connection } from "@solana/web3.js";
import { RpcStoneSource, type StoneClaimed, type StoneSource } from "./stone-source";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const HASURA = (process.env.SVM_HASURA_ENDPOINT ?? "https://belt-hasura-selfhost-production.up.railway.app").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";

const UPSERT = `mutation Up($o: svm_genesis_stone_insert_input!) {
  insert_svm_genesis_stone_one(object: $o,
    on_conflict: { constraint: genesis_stone_pkey,
      update_columns: [wallet, element, element_name, weather, slot, sig, claimed_at, source] }
  ) { mint }
}`;

async function upsert(s: StoneClaimed): Promise<void> {
  const o = {
    mint: s.mint, wallet: s.wallet, element: s.element, element_name: s.elementName,
    weather: s.weather, slot: s.slot, sig: s.sig, claimed_at: s.claimedAt.toISOString(), source: s.source,
  };
  const res = await /* @non-metadata-fetch Genesis index */ fetch(`${HASURA}/v1/graphql`, {
    method: "POST",
    headers: { "x-hasura-admin-secret": SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ query: UPSERT, variables: { o } }),
  });
  const d = (await res.json()) as { errors?: unknown };
  if (d.errors) throw new Error(`upsert ${s.mint}: ${JSON.stringify(d.errors)}`);
}

/** Drain a StoneSource iterable into Hasura. Returns the count. */
export async function drain(it: AsyncIterable<StoneClaimed>): Promise<number> {
  let n = 0;
  for await (const stone of it) {
    await upsert(stone);
    n++;
    if (n % 10 === 0) console.log(`  …${n} stones`);
  }
  return n;
}

async function main(): Promise<void> {
  if (!SECRET) throw new Error("HASURA_GRAPHQL_ADMIN_SECRET required");
  const src: StoneSource = new RpcStoneSource(new Connection(RPC, "confirmed"));
  const h = await src.health();
  console.log(`source health: ${h.ok ? "ok" : "DEGRADED"} (${h.detail}) · rpc=${RPC.replace(/\?.*/, "")}`);
  console.log("backfilling genesis stones…");
  const n = await drain(src.backfill());
  console.log(`✅ DONE — indexed ${n} genesis stones into svm.genesis_stone`);
  // bd-w301.7 (realtime tail): once backfilled, `for await (const s of src.stream()) await upsert(s)`.
}

// run only when invoked directly (so drain() stays importable/testable)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
