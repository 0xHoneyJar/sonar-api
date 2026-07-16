/**
 * probe-collection.ts — "can sonar eat this collection?"
 *
 * Read-only onboarding probe for an arbitrary Solana NFT collection. Answers the question the
 * collection-registry alone cannot: the registry entry is trivial, but whether the CURRENT event
 * substrate (Helius Enhanced mint-address-history) gives COMPLETE coverage depends on the collection's
 * token standard. This probe classifies the standard (via DAS) and EMPIRICALLY measures coverage on a
 * small sample (walk each sampled NFT's history → derive latest owner → compare to DAS current owner),
 * then prints a go/no-go verdict + the exact next step.
 *
 *   pNFT (ProgrammableNonFungible) → mint-history is complete → ✅ registry entry + backfill.
 *   classic V1 NFT               → raw SPL Transfers can omit the mint → coverage may be < 100% →
 *                                  ⚠ may need token-account tracing (the measure says how bad).
 *   compressed (cNFT)            → no mint/token accounts → ⛔ needs getSignaturesForAsset + Bubblegum
 *                                  (NOT built); the mint-history path returns nothing.
 *
 * Classification is shared with the CR-104 Solana DAS recognition adapter
 * (`classifyDasSampleItems`) so CLI + resolver stay in parity.
 *
 * Usage: HELIUS_API_KEY=<key> npx tsx src/svm/probe-collection.ts <collectionMint> [--sample N]
 * NO writes, NO registry mutation — pure diagnosis.
 */
import { HeliusCollectionEventSource, type CollectionEvent } from "./collection-event-source";
import { deriveLatestOwners } from "./collection-event-indexer";
import type { DasAsset } from "./nft-collection-source";
import {
  buildDasSampleRequestBody,
  classifyDasSampleItems,
  DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT,
  filterVerifiedDasSampleMembers,
  parseDasSampleLimitArgument,
  parseDasSampleRpcResponse,
} from "../collection-resolver/adapters/solana/sample-classifier.js";

const API_KEY = process.env.HELIUS_API_KEY ?? "";
const RPC = process.env.SOLANA_RPC_URL ?? (API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${API_KEY}` : "");

async function dasSample(mint: string, sample: number): Promise<DasAsset[]> {
  const res = await /* @non-metadata-fetch DAS probe */ fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      buildDasSampleRequestBody({ collection_mint: mint, limit: sample, id: "probe" }),
    ),
  });
  if (!res.ok) throw new Error(`DAS getAssetsByGroup: HTTP ${res.status}`);
  const raw: unknown = await res.json();
  const parsed = parseDasSampleRpcResponse(raw);
  if (parsed.kind === "rpc_error") throw new Error("DAS: rpc_error");
  if (parsed.kind === "malformed" || parsed.kind === "incomplete") {
    throw new Error(`DAS: ${parsed.safe_reason}`);
  }
  return [...parsed.page.items];
}

async function main(): Promise<void> {
  const mint = process.argv[2];
  if (!mint || mint.startsWith("--")) throw new Error("usage: npx tsx src/svm/probe-collection.ts <collectionMint> [--sample N]");
  if (!API_KEY) throw new Error("HELIUS_API_KEY required");
  const si = process.argv.indexOf("--sample");
  const sample =
    si >= 0
      ? parseDasSampleLimitArgument(process.argv[si + 1])
      : DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT;

  console.log(`\n  ◇ probing collection ${mint} (sample ${sample}) …`);
  const rawItems = await dasSample(mint, sample);
  const items = filterVerifiedDasSampleMembers(rawItems);
  if (items.length === 0) {
    console.log(`  ⛔ DAS returned 0 verified members — not a Metaplex certified collection mint, or empty. Nothing to index.`);
    process.exit(2);
  }
  const classification = classifyDasSampleItems(items);
  const { standard_label: standard, compressed_count: compressed, interfaces } = classification;
  console.log(
    `  ◇ standard: ${standard}   (interfaces: ${Object.entries(interfaces)
      .map(([k, v]) => `${k}×${v}`)
      .join(", ")}; compressed ${compressed}/${items.length})`,
  );

  // compressed → the mint-history substrate structurally can't see it; don't even measure.
  if (classification.coverage === "compressed" || compressed > 0) {
    console.log(`\n  ⛔ COMPRESSED (cNFT) — the current substrate (mint address-history) returns NOTHING for cNFTs.`);
    console.log(`     cNFTs have no mint/token accounts; their state lives in a Bubblegum Merkle tree (proofs via DAS).`);
    console.log(`     NEXT: build the getSignaturesForAsset + Bubblegum decode path before onboarding (NOT built).`);
    process.exit(1);
  }

  // measure coverage: walk each sampled NFT's history, derive latest owner, compare to DAS current owner.
  console.log(`  ◇ measuring substrate coverage on ${items.length} sampled NFTs …`);
  const src = new HeliusCollectionEventSource(API_KEY, mint, { rpcUrl: RPC });
  const events: CollectionEvent[] = [];
  for (const it of items) {
    for await (const ev of src.mintHistory(it.id!)) events.push(ev);
  }
  const latest = deriveLatestOwners(events);
  let match = 0;
  const misses: string[] = [];
  for (const it of items) {
    if (latest.get(it.id!) === it.ownership!.owner) match++;
    else misses.push(it.id!);
  }
  const pct = (match / items.length) * 100;
  console.log(`  ◇ coverage: ${match}/${items.length} (${pct.toFixed(1)}%) latest-event-owner == DAS owner · ${events.length} events decoded`);

  console.log("");
  const isPnft = classification.coverage === "programmable" || /programmable/i.test(standard);
  if (pct >= 99) {
    console.log(`  ✅ READY — the mint-history substrate covers this collection${isPnft ? " (pNFT — expected)" : ""}.`);
    console.log(`     NEXT (truly easy): add to src/svm/collection-registry.ts —`);
    console.log(`         "<key>": { collectionKey: "<key>", collectionMint: "${mint}" },`);
    console.log(`     then: HELIUS_API_KEY=… npx tsx src/svm/collection-event-indexer.ts --collection <key> --dry   (confirm 99%+) → drop --dry to go live.`);
  } else if (pct >= 80) {
    console.log(`  ⚠ PARTIAL (${pct.toFixed(1)}%) — some transfers the mint-history misses (likely classic-SPL raw Transfers that omit the mint).`);
    console.log(`     A registry entry "works" but the reconcile gate (99%) will BLOCK go-live. Decide: accept the tail (--force) or`);
    console.log(`     build token-account-chain tracing for this standard first. Re-probe with a larger --sample to firm up the number.`);
  } else {
    console.log(`  ⛔ POOR (${pct.toFixed(1)}%) — the mint-history substrate does NOT cover this collection's transfers.`);
    console.log(`     NEXT: build token-account ownership-chain tracing (SDD §4.4) before onboarding. Misses: ${misses.slice(0, 3).join(", ")}…`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`probe-collection: ${e.message}`);
  process.exit(2);
});
