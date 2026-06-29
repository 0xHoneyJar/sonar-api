/**
 * validate-svm-canonical-live.ts — exercise the merged SVM mapper (src/canonical/map-svm.ts) against
 * the LIVE svm.collection_event data at the belt-gateway. READ-ONLY: queries the public read surface,
 * maps every real row through `mapSvm`, and reports how many produce a valid canonical NftActivity vs
 * a typed SchemaInvalid — the producer-side of the S5 dry-run, run on PRODUCTION data. No emit, no
 * write, no consumer dependency.
 *
 * Also writes a small `canonical-sample.json` (the producer half of the S5 parity gate) so the
 * score-mibera handshake has a real-data sample to diff against.
 *
 * Usage: npx tsx scripts/validate-svm-canonical-live.ts [limit] [outPath]
 *   limit   = max rows to scan (default 30000; paginated in batches)
 *   outPath = where to write the canonical sample (default ./canonical-sample.json)
 */
import { writeFileSync } from "node:fs";
import { Either } from "effect";
import { mapSvm, isCanonicalOwnershipKind, type SvmCollectionContext } from "../src/canonical/map-svm";
import type { CollectionEvent } from "../src/svm/collection-event-source";

const ENDPOINT = process.env.SVM_CONTRACT_ENDPOINT ?? "https://belt-gateway-production.up.railway.app/v1/graphql";
const BATCH = 1000;
const TAG = "[validate-svm-canonical-live]";

interface Row {
  nft_mint: string;
  kind: string;
  from: string | null;
  to: string | null;
  instruction_index: number;
  price: number | null;
  marketplace: string | null;
  slot: number;
  block_time: string; // timestamptz (ISO) on the wire
  tx_signature: string;
  collection_key: string;
  collection_mint: string;
}

const QUERY = `query Q($limit: Int!, $offset: Int!) {
  svm_collection_event(limit: $limit, offset: $offset, order_by: { slot: asc }) {
    nft_mint kind from to instruction_index price marketplace slot block_time tx_signature collection_key collection_mint
  }
}`;

async function fetchBatch(limit: number, offset: number): Promise<Row[]> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { limit, offset } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data?: { svm_collection_event: Row[] }; errors?: unknown };
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data?.svm_collection_event ?? [];
}

/** DB row → the map-svm input CollectionEvent. Hasura serializes `bigint` (price, slot) as STRINGS
 *  and `timestamptz` (block_time) as an ISO string — the real Helius source gives numbers, so this
 *  conversion is the contract a future Hasura-sourced adapter (the S6 backfill) MUST also apply.
 *  Lamport prices (~1e9) and slots (~3e8) are well under 2^53, so Number() is lossless here. */
function toCollectionEvent(r: Row): CollectionEvent {
  return {
    nftMint: r.nft_mint,
    kind: r.kind as CollectionEvent["kind"],
    from: r.from,
    to: r.to,
    instructionIndex: Number(r.instruction_index),
    price: r.price === null ? null : Number(r.price),
    marketplace: r.marketplace,
    slot: Number(r.slot),
    blockTime: Math.floor(new Date(r.block_time).getTime() / 1000),
    txSignature: r.tx_signature,
  };
}

async function main() {
  const maxRows = Number(process.argv[2] ?? 30000);
  const outPath = process.argv[3] ?? "./canonical-sample.json";

  let offset = 0;
  let total = 0;
  let ok = 0;
  let skippedNonOwnership = 0;
  const verbCount: Record<string, number> = {};
  const failReasons: Record<string, number> = {};
  const failures: Array<{ tx: string; mint: string; reason: string }> = [];
  const sample: unknown[] = [];

  console.log(`${TAG} scanning svm_collection_event at ${ENDPOINT} (max ${maxRows}, batch ${BATCH})...`);
  while (total < maxRows) {
    const rows = await fetchBatch(Math.min(BATCH, maxRows - total), offset);
    if (rows.length === 0) break;
    for (const r of rows) {
      total++;
      // list/delist (#85) are marketplace-STATE events, not canonical ownership activities — excluded
      // from the canonical stream (the consumer reads them off svm_collection_event directly).
      if (!isCanonicalOwnershipKind(r.kind as never)) {
        skippedNonOwnership++;
        continue;
      }
      const ctx: SvmCollectionContext = { collectionKey: r.collection_key, collectionMint: r.collection_mint };
      const res = mapSvm(toCollectionEvent(r), ctx);
      if (Either.isRight(res)) {
        ok++;
        verbCount[res.right.verb] = (verbCount[res.right.verb] ?? 0) + 1;
        if (sample.length < 100) sample.push(res.right);
      } else {
        const reason = res.left.reason.replace(/mint \S+/g, "mint <m>").replace(/tx \S+/g, "tx <t>").slice(0, 80);
        failReasons[reason] = (failReasons[reason] ?? 0) + 1;
        if (failures.length < 20) failures.push({ tx: r.tx_signature, mint: r.nft_mint, reason: res.left.reason.slice(0, 120) });
      }
    }
    offset += rows.length;
    if (rows.length < BATCH) break;
  }

  const ownership = total - skippedNonOwnership;
  const pct = ownership > 0 ? ((ok / ownership) * 100).toFixed(2) : "0";
  console.log(`\n${TAG} ===== RESULT =====`);
  console.log(`${TAG} scanned ${total} live rows · ${skippedNonOwnership} non-ownership (list/delist #85) excluded · ${ownership} ownership events`);
  console.log(`${TAG} ownership mapped OK ${ok} (${pct}%) · failed ${ownership - ok}`);
  console.log(`${TAG} verb distribution: ${JSON.stringify(verbCount)}`);
  if (Object.keys(failReasons).length) {
    console.log(`${TAG} failure reasons (templated):`);
    for (const [reason, n] of Object.entries(failReasons).sort((a, b) => b[1] - a[1])) console.log(`${TAG}   ${n}× ${reason}`);
    console.log(`${TAG} first failures:`);
    for (const f of failures.slice(0, 5)) console.log(`${TAG}   ${f.mint} (tx ${f.tx.slice(0, 16)}…): ${f.reason}`);
  }
  writeFileSync(outPath, JSON.stringify(sample, null, 2));
  console.log(`${TAG} wrote ${sample.length}-record canonical sample → ${outPath}`);
  process.exit(ownership - ok === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`${TAG} ERROR: ${(e as Error).message}`);
  process.exit(2);
});
