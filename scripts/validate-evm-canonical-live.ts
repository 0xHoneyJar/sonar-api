/**
 * validate-evm-canonical-live.ts — exercise the merged EVM mapper (src/canonical/map-evm.ts) against
 * the LIVE `Transfer` data at the belt-gateway. READ-ONLY: maps every real Transfer row through
 * `mapEvmLegs` (NO sale rows — the gateway exposes no sale entity, so this validates the mint / burn /
 * transfer verbs only; the sale-join is S5/score-api territory). No emit, no write, no consumer dep.
 *
 * The sibling of validate-svm-canonical-live.ts — the EVM half of "validate both producers on
 * production". It also SURFACES the S4/S6 EVM-adapter contract (found by looking at real data):
 *   - `Transfer.collection` is a NAME ("HoneyJar2", "crayons_factory"), NOT a 0x address and NOT a
 *     valid topic-segment slug → the adapter MUST slugify it for `collection_key` AND map name →
 *     contract-address for `metadata.contract` (the read surface gives only the name; a placeholder
 *     0x is used here, since the contract value is not what verb-classification validates).
 *   - `timestamp` / `blockNumber` are Hasura `numeric` → STRINGS on the wire (the bigint lesson).
 *   - `id` = "{txHash}_{logIndex}" → logIndex is the suffix after the last "_".
 *   - data spans multiple chains (chainId per row).
 *
 * Usage: npx tsx scripts/validate-evm-canonical-live.ts [limit]
 */
import { Either } from "effect";
import { mapEvmLegs, type EvmTransferLeg, type EvmCollectionContext } from "../src/canonical/map-evm";

const ENDPOINT = process.env.SVM_CONTRACT_ENDPOINT ?? "https://belt-gateway-production.up.railway.app/v1/graphql";
const BATCH = 1000;
const TAG = "[validate-evm-canonical-live]";
// Placeholder contract (valid lowercase 0x40-hex). The real adapter supplies the actual address via a
// collection-name → contract map; the contract value is orthogonal to the verb classification we validate.
const PLACEHOLDER_CONTRACT = "0x" + "0".repeat(39) + "1";

interface Row {
  id: string;
  from: string;
  to: string;
  tokenId: string;
  timestamp: string; // numeric → string
  blockNumber: string; // numeric → string
  chainId: number;
  collection: string;
}

const QUERY = `query Q($limit: Int!, $offset: Int!) {
  Transfer(limit: $limit, offset: $offset, order_by: { id: asc }) {
    id from to tokenId timestamp blockNumber chainId collection
  }
}`;

async function fetchBatch(limit: number, offset: number): Promise<Row[]> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { limit, offset } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data?: { Transfer: Row[] }; errors?: unknown };
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data?.Transfer ?? [];
}

/** Collection NAME → topic-segment slug ("HoneyJar2" → "honeyjar2", "crayons_factory" → "crayons-factory"). */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function logIndexOf(id: string, fallback: number): number {
  const suffix = id.slice(id.lastIndexOf("_") + 1);
  const n = Number(suffix);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function toLeg(r: Row, idx: number): EvmTransferLeg {
  // id is "{txHash}_{logIndex}" — the prefix before the last "_" is the txHash.
  const cut = r.id.lastIndexOf("_");
  const txHash = cut > 0 ? r.id.slice(0, cut) : r.id;
  return {
    txHash,
    tokenId: r.tokenId,
    from: r.from,
    to: r.to,
    logIndex: logIndexOf(r.id, idx),
    blockNumber: Number(r.blockNumber),
    timestamp: new Date(Number(r.timestamp) * 1000).toISOString(),
  };
}

async function main() {
  const maxRows = Number(process.argv[2] ?? 30000);
  let offset = 0;
  let total = 0;
  let ok = 0;
  const verbCount: Record<string, number> = {};
  const failReasons: Record<string, number> = {};
  const collectionsNeedingSlugify = new Set<string>();
  const chains = new Set<number>();

  console.log(`${TAG} scanning Transfer at ${ENDPOINT} (max ${maxRows})...`);
  while (total < maxRows) {
    const rows = await fetchBatch(Math.min(BATCH, maxRows - total), offset);
    if (rows.length === 0) break;
    // group by (slugified collection, chainId) so mapEvmLegs runs per collection context
    for (const r of rows) {
      total++;
      chains.add(r.chainId);
      const slug = slugify(r.collection);
      if (slug !== r.collection) collectionsNeedingSlugify.add(`${r.collection}→${slug}`);
      const ctx: EvmCollectionContext = { collectionKey: slug, chainId: r.chainId, contract: PLACEHOLDER_CONTRACT };
      // tx must be present; the gateway omits transactionHash from this projection's required set but
      // it IS queryable — fall back to the id prefix if absent.
      const leg = toLeg(r, total);
      const [res] = mapEvmLegs([leg], [], ctx);
      if (Either.isRight(res)) {
        ok++;
        verbCount[res.right.verb] = (verbCount[res.right.verb] ?? 0) + 1;
      } else {
        const reason = res.left.reason.replace(/token \S+/g, "token <t>").slice(0, 90);
        failReasons[reason] = (failReasons[reason] ?? 0) + 1;
      }
    }
    offset += rows.length;
    if (rows.length < BATCH) break;
  }

  const pct = total > 0 ? ((ok / total) * 100).toFixed(2) : "0";
  console.log(`\n${TAG} ===== RESULT (mint/burn/transfer only; no sale entity on this surface) =====`);
  console.log(`${TAG} scanned ${total} live Transfer rows · mapped OK ${ok} (${pct}%) · failed ${total - ok}`);
  console.log(`${TAG} verb distribution: ${JSON.stringify(verbCount)}`);
  console.log(`${TAG} chains seen: ${[...chains].sort((a, b) => a - b).join(", ")}`);
  console.log(`${TAG} collection names that REQUIRED slugify (adapter must do this): ${collectionsNeedingSlugify.size}`);
  for (const c of [...collectionsNeedingSlugify].slice(0, 12)) console.log(`${TAG}   ${c}`);
  if (Object.keys(failReasons).length) {
    console.log(`${TAG} failure reasons:`);
    for (const [reason, n] of Object.entries(failReasons).sort((a, b) => b[1] - a[1])) console.log(`${TAG}   ${n}× ${reason}`);
  }
  process.exit(total - ok === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`${TAG} ERROR: ${(e as Error).message}`);
  process.exit(2);
});
