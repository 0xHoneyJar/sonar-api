/**
 * collection-event-indexer.ts — Sprint 2 backfill runner for the generic SVM collection-event pipe.
 *
 * Enumerates a collection's member NFTs (DAS), walks each NFT's full parsed tx history (Helius Enhanced
 * address-history) into mint/transfer/burn/sale events, and upserts them into svm.collection_event. Then
 * RECONCILES (§4.5 go/no-go gate): derives latest-owner-per-NFT from the event stream and compares to the
 * DAS current-ownership snapshot — proving the event history is complete before "full history" is claimed.
 *
 * Sprint-2 MVP indexes Pythians (the hard-coded CONFIG); Sprint 4 lifts the collection to a registry.
 *
 * Run (dry, no writes — validate + reconcile):
 *   HELIUS_API_KEY=<key> npx tsx src/svm/collection-event-indexer.ts --dry [--limit N]
 * Run (backfill into Hasura):
 *   HELIUS_API_KEY=<key> HASURA_GRAPHQL_ADMIN_SECRET=<secret> \
 *   SVM_HASURA_ENDPOINT=https://belt-hasura-selfhost-production.up.railway.app \
 *   npx tsx src/svm/collection-event-indexer.ts
 */
import { fileURLToPath } from "node:url";
import { DasNftCollectionSource } from "./nft-collection-source";
import { HeliusCollectionEventSource, type CollectionEvent } from "./collection-event-source";
import { upsertCollectionEvents } from "./collection-event-writer";
import { PYTHIANS_COLLECTION, COLLECTION_KEY } from "./pythians-collection-indexer";

const API_KEY = process.env.HELIUS_API_KEY ?? "";
const RPC = process.env.SOLANA_RPC_URL ?? (API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${API_KEY}` : "");

const RECONCILE_MIN_PCT = 99; // §4.5 go/no-go gate: refuse to write a likely-incomplete history below this

function parseArgs(): { dry: boolean; limit?: number; force: boolean } {
  const dry = process.argv.includes("--dry");
  const force = process.argv.includes("--force");
  const li = process.argv.indexOf("--limit");
  const limit = li >= 0 ? Number(process.argv[li + 1]) : undefined;
  return { dry, limit, force };
}

/**
 * Latest-owner-per-mint from the event stream (chronological by slot then per-mint leg). `null` =
 * burned / no current owner. Exported for tests + the reconciliation gate.
 */
export function deriveLatestOwners(events: readonly CollectionEvent[]): Map<string, string | null> {
  const sorted = [...events].sort((a, b) => a.slot - b.slot || a.instructionIndex - b.instructionIndex);
  const owner = new Map<string, string | null>();
  for (const e of sorted) owner.set(e.nftMint, e.kind === "burn" ? null : e.to);
  return owner;
}

async function main(): Promise<void> {
  const { dry, limit, force } = parseArgs();
  if (!API_KEY) throw new Error("HELIUS_API_KEY required");
  if (!RPC) throw new Error("SOLANA_RPC_URL or HELIUS_API_KEY required");
  if (!dry) {
    if (!process.env.HASURA_GRAPHQL_ADMIN_SECRET) throw new Error("HASURA_GRAPHQL_ADMIN_SECRET required (or pass --dry)");
    if (!process.env.SVM_HASURA_ENDPOINT) throw new Error("SVM_HASURA_ENDPOINT required (or pass --dry)");
  }

  const snap = await new DasNftCollectionSource(RPC, PYTHIANS_COLLECTION).snapshot();
  let members = snap.members;
  if (limit && limit > 0) members = members.slice(0, limit);
  console.log(`${COLLECTION_KEY}: ${members.length} member NFTs to backfill (snapshot slot ${snap.slot})${dry ? " [DRY]" : ""}`);

  const source = new HeliusCollectionEventSource(API_KEY, PYTHIANS_COLLECTION, { rpcUrl: RPC });
  const events: CollectionEvent[] = [];
  let done = 0;
  for (const m of members) {
    for await (const ev of source.mintHistory(m.nftMint)) events.push(ev);
    if (++done % 250 === 0) console.log(`  …${done}/${members.length} NFTs walked, ${events.length} events so far`);
  }
  console.log(`collected ${events.length} events across ${members.length} NFTs`);

  // Reconciliation gate (§4.5): latest-owner-from-events vs the DAS current owner.
  const latest = deriveLatestOwners(events);
  let match = 0;
  const mismatches: string[] = [];
  for (const m of members) {
    if (latest.get(m.nftMint) === m.owner) match++;
    else mismatches.push(m.nftMint);
  }
  const pct = members.length ? (match / members.length) * 100 : 0;
  console.log(`RECONCILE: ${match}/${members.length} (${pct.toFixed(2)}%) latest-owner-from-events == DAS owner`);
  if (mismatches.length) console.log(`  ${mismatches.length} mismatch(es); first 5: ${mismatches.slice(0, 5).join(", ")}`);

  if (dry) {
    console.log("DRY — no writes performed.");
    return;
  }
  // §4.5 reconciliation gate — refuse to surface a likely-incomplete history (unless explicitly forced).
  if (pct < RECONCILE_MIN_PCT && !force) {
    throw new Error(
      `reconciliation ${pct.toFixed(2)}% < ${RECONCILE_MIN_PCT}% gate — refusing to write a likely-incomplete history. ` +
        `Investigate the mismatches (escrow/finality vs a real coverage gap) or re-run with --force.`,
    );
  }
  const affected = await upsertCollectionEvents(events, COLLECTION_KEY, PYTHIANS_COLLECTION, "helius-backfill");
  console.log(`✅ DONE — upserted ${affected} event rows into svm.collection_event for ${COLLECTION_KEY}`);
}

// run only when invoked directly (so deriveLatestOwners stays importable/testable)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
