/**
 * validate-evm-sales-live.ts — validate the EVM SALE path of map-evm against live data (the hardest,
 * FAGAN-flagged path). READ-ONLY. The discovery this rests on: the EVM buyer/seller resolution is
 * DATA-DERIVABLE, not score-api-only — `MintActivity` emits a `SALE` row (user = seller) AND a
 * `PURCHASE` row (user = buyer) for the same (tx, tokenId), both with `amountPaid` (price) + the real
 * `contract` 0x. So we derive `EvmSaleRow{seller, buyer, priceWei}` by pairing SALE.user/PURCHASE.user,
 * join with the live `Transfer` legs by (tx, tokenId), run `mapEvmLegs`, and check the matched legs
 * become verb=sale with valid resolved parties + wei value.
 *
 * What this VALIDATES (on real data): (a) the MintActivity↔Transfer (tx,tokenId) join actually matches
 * (the MINOR-1 silent-demotion risk), (b) map-evm classifies a matched leg as sale (not transfer) —
 * sale-exclusivity, (c) the derived sale activity is schema-valid (seller/buyer + decimals=18 + wei).
 * What it does NOT claim: that SALE.user/PURCHASE.user pairing is byte-identical to score-api's
 * fetchMiberaBuyers/Sellers — that exact parity is the S5 cross-building check (this is a strong
 * first-cut + a candidate resolution to hand the S5 handshake). No emit, so no F9 exposure.
 *
 * Usage: npx tsx scripts/validate-evm-sales-live.ts [maxSales]
 */
import { Either } from "effect";
import { mapEvmLeg, type EvmTransferLeg, type EvmSaleRow, type EvmCollectionContext } from "../src/canonical/map-evm";

const ENDPOINT = process.env.SVM_CONTRACT_ENDPOINT ?? "https://belt-gateway-production.up.railway.app/v1/graphql";
const TAG = "[validate-evm-sales-live]";

interface MaRow { activityType: string; user: string | null; amountPaid: string | null; tokenId: string; contract: string; transactionHash: string; chainId: number; }
interface TxRow { id: string; from: string; to: string; tokenId: string; timestamp: string; blockNumber: string; transactionHash: string; }

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { data?: T; errors?: unknown };
  if (j.errors) throw new Error(`GraphQL: ${JSON.stringify(j.errors)}`);
  return j.data as T;
}

const key = (tx: string, tokenId: string) => `${tx}|${tokenId}`;

async function main() {
  const maxSales = Number(process.argv[2] ?? 1500);

  // 1. Pull SALE + PURCHASE MintActivity rows and pair them by (tx, tokenId).
  const sales = new Map<string, { seller?: string; buyer?: string; price?: string; contract?: string; chainId?: number }>();
  let offset = 0;
  while (sales.size < maxSales) {
    const d = await gql<{ MintActivity: MaRow[] }>(
      `query Q($l:Int!,$o:Int!){ MintActivity(where:{activityType:{_in:["SALE","PURCHASE"]}}, limit:$l, offset:$o, order_by:{id:asc}){ activityType user amountPaid tokenId contract transactionHash chainId } }`,
      { l: 1000, o: offset },
    );
    if (d.MintActivity.length === 0) break;
    for (const r of d.MintActivity) {
      const k = key(r.transactionHash, r.tokenId);
      const e = sales.get(k) ?? {};
      if (r.activityType === "SALE") { e.seller = r.user ?? undefined; e.price = r.amountPaid ?? undefined; e.contract = r.contract; e.chainId = r.chainId; }
      else { e.buyer = r.user ?? undefined; e.price = e.price ?? r.amountPaid ?? undefined; e.contract = e.contract ?? r.contract; e.chainId = e.chainId ?? r.chainId; }
      sales.set(k, e);
    }
    offset += d.MintActivity.length;
    if (d.MintActivity.length < 1000) break;
  }

  const complete = [...sales.entries()].filter(([, v]) => v.seller && v.buyer && v.price);
  const txs = [...new Set(complete.map(([k]) => k.split("|")[0]))];

  // 2. Pull the MiberaTransfer legs for those txs (the mibera-specific transfer entity — the generic
  // `Transfer` table covers DIFFERENT collections (HoneyJar/Honeycomb) and does NOT contain mibera sales).
  const legs = new Map<string, TxRow>();
  for (let i = 0; i < txs.length; i += 200) {
    const chunk = txs.slice(i, i + 200);
    const d = await gql<{ MiberaTransfer: TxRow[] }>(
      `query Q($txs:[String!]){ MiberaTransfer(where:{transactionHash:{_in:$txs}}){ id from to tokenId timestamp blockNumber transactionHash } }`,
      { txs: chunk },
    );
    for (const t of d.MiberaTransfer) legs.set(key(t.transactionHash, t.tokenId), t);
  }

  // 3. For each complete sale, find its Transfer leg + map through map-evm with the derived sale row.
  let joined = 0, saleOk = 0, joinMiss = 0;
  const fails: Record<string, number> = {};
  for (const [k, v] of complete) {
    const leg = legs.get(k);
    if (!leg) { joinMiss++; continue; }
    joined++;
    const [tx, tokenId] = k.split("|");
    const evmLeg: EvmTransferLeg = {
      txHash: tx, tokenId, from: leg.from, to: leg.to,
      logIndex: Number(leg.id.slice(leg.id.lastIndexOf("_") + 1)) || 0,
      blockNumber: Number(leg.blockNumber), timestamp: new Date(Number(leg.timestamp) * 1000).toISOString(),
    };
    const saleRow: EvmSaleRow = { txHash: tx, tokenId, seller: v.seller!, buyer: v.buyer!, priceWei: v.price! };
    const ctx: EvmCollectionContext = { collectionKey: "mibera", chainId: v.chainId!, contract: v.contract! };
    const res = mapEvmLeg(evmLeg, ctx, saleRow);
    if (Either.isRight(res) && res.right.verb === "sale") saleOk++;
    else if (Either.isLeft(res)) { const r = res.left.reason.replace(/token \S+/g, "token <t>").slice(0, 80); fails[r] = (fails[r] ?? 0) + 1; }
    else fails["matched-but-not-verb=sale (exclusivity?)"] = (fails["matched-but-not-verb=sale (exclusivity?)"] ?? 0) + 1;
  }

  console.log(`\n${TAG} ===== EVM SALE-PATH RESULT =====`);
  console.log(`${TAG} MintActivity SALE/PURCHASE keys: ${sales.size} · complete pairs (seller+buyer+price): ${complete.length}`);
  console.log(`${TAG} of those, Transfer leg joined by (tx,tokenId): ${joined} · join MISSES: ${joinMiss}`);
  console.log(`${TAG} joined legs that map to a valid verb=sale: ${saleOk}/${joined}${joined ? ` (${((saleOk / joined) * 100).toFixed(2)}%)` : ""}`);
  if (Object.keys(fails).length) { console.log(`${TAG} failures:`); for (const [r, n] of Object.entries(fails).sort((a, b) => b[1] - a[1])) console.log(`${TAG}   ${n}× ${r}`); }
  console.log(`${TAG} NOTE: SALE.user/PURCHASE.user pairing is a data-derived candidate resolution; exact parity vs score-api fetchMiberaBuyers/Sellers is the S5 check.`);
  process.exit(joined > 0 && saleOk === joined ? 0 : 1);
}

main().catch((e) => { console.error(`${TAG} ERROR: ${(e as Error).message}`); process.exit(2); });
