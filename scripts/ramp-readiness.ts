/**
 * ramp-readiness.ts — the data-truth oracle for the community-onboarding ramp (#121).
 *
 * The recurring disease this kills: completion signals decoupled from data truth. An order
 * reads `fulfilled`, a community reads `active`, a collection sits in `config.yaml` — yet the
 * belt has 0 holders for it (the Azuki #120 / Base-batch #124 class). A consumer that trusts
 * config intent or order state advertises collections that can't be rendered (#413).
 *
 * This oracle answers ONE question per collection — "is it truly ready for score-api to pull?"
 * — by reading the SAME source-of-truth the indexer uses and cross-checking it against LIVE
 * gateway state:
 *   - EVM keys  ← src/handlers/tracked-erc721/constants.ts   (address → collectionKey)
 *   - EVM chain ← config.yaml                                 (chain + start_block per address)
 *   - SVM keys  ← src/svm/collection-registry.ts             (collectionKey → mint/displayName)
 *   - live data ← the belt-gateway GraphQL (TrackedHolder / CollectionStat / svm_collection_event
 *                 / svm_sync_status / chain_metadata)
 *
 * READ-ONLY. No emit, no write, no consumer dependency. Same production-probe posture as
 * validate-evm-canonical-live.ts / validate-svm-canonical-live.ts (its siblings).
 *
 * Verdicts (per collection):
 *   READY            holders/events > 0 AND the chain is caught up to head       → score-api can pull
 *   READY·backfill   holders > 0 but the chain is still backfilling               → partial, growing
 *   INDEXING         backfill hasn't reached the collection's deploy block yet    → wait, not broken
 *   MISSING ⚠        deploy block scanned but 0 holders/events                    → real defect (Azuki #120 class)
 *   NOT·BACKFILLED   SVM collection with no events (needs the deep-history lane)  → BOEHM PRD territory
 *   DRIFT ⚠          key in constants.ts but no address in config.yaml            → config/handler drift
 * A KEY·REVIEW flag rides alongside any key that looks like a test fixture (_e2e/_kitchen/_test):
 * score-api joins on the EXACT string (category_key === collectionKey), so a fixture-shaped key
 * must get a naming decision before a real community binds to it (the #382 landmine).
 *
 * Usage: npx tsx scripts/ramp-readiness.ts [--json] [--all]
 *   --json  emit machine-readable JSON (CI / score-api handoff) instead of the table
 *   --all   include non-ramp tracked collections (mibera/lore/honeyjar), not just the onboarding ramp
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { TRACKED_ERC721_COLLECTION_KEYS } from "../src/handlers/tracked-erc721/constants";
import { COLLECTIONS } from "../src/svm/collection-registry";

const ENDPOINT =
  process.env.SONAR_GATEWAY ??
  process.env.SVM_CONTRACT_ENDPOINT ??
  "https://sonar.0xhoneyjar.xyz/v1/graphql";
const TAG = "[ramp-readiness]";
const HEAD_LAG_TOLERANCE = 500; // blocks; within this of block_height ⇒ "caught up"
const RAMP_CHAINS: Record<number, true> = { 1: true, 8453: true }; // community-onboarding EVM ramp lives on ETH + Base
const FIXTURE_KEY = /(_e2e|_kitchen|_test)\b|_e2e$|_kitchen$|_test$/;

interface EvmCol {
  key: string;
  contract: string;
  chainId: number;
  startBlock: number;
  ramp: boolean;
}
interface EvmResult extends EvmCol {
  holders: number | null;
  totalMinted: number | null;
  totalSupply: number | null;
  chainLpb: number | null;
  chainHead: number | null;
  deployScanned: boolean;
  caughtUp: boolean;
  verdict: string;
  keyReview: boolean;
}
interface SvmResult {
  key: string;
  mint: string;
  displayName: string;
  ownership: string;
  events: number | null;
  lastEventAt: string | null;
  lastReconcile: string | null;
  verdict: string;
  keyReview: boolean;
}

async function gql<T = any>(query: string): Promise<T> {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await r.json();
  if (body.errors)
    throw new Error(
      `${TAG} gql errors: ${JSON.stringify(body.errors).slice(0, 400)}`,
    );
  return body.data;
}

/** Parse config.yaml → address(lowercased) → { chainId, startBlock }, from every chain's TrackedErc721 block. */
function buildAddressChainMap(): Map<
  string,
  { chainId: number; startBlock: number }
> {
  // failsafe schema = every scalar stays a string. Critical: unquoted `0x…` addresses in config.yaml
  // would otherwise be coerced to (imprecise) hex NUMBERS, mangling the join key. id/start_block are
  // then coerced back with Number().
  const raw = parseYaml(readFileSync("config.yaml", "utf8"), {
    schema: "failsafe",
  }) as {
    chains: {
      id: string;
      start_block: string;
      contracts: { name: string; address: string[]; start_block?: string }[];
    }[];
  };
  const map = new Map<string, { chainId: number; startBlock: number }>();
  for (const chain of raw.chains) {
    const chainId = Number(chain.id);
    for (const c of chain.contracts ?? []) {
      if (c.name !== "TrackedErc721") continue;
      const startBlock = Number(c.start_block ?? chain.start_block);
      for (const addr of c.address ?? []) {
        map.set(addr.toLowerCase(), { chainId, startBlock });
      }
    }
  }
  return map;
}

function collectEvm(
  addrChain: Map<string, { chainId: number; startBlock: number }>,
): EvmCol[] {
  return Object.entries(TRACKED_ERC721_COLLECTION_KEYS).map(([addr, key]) => {
    const loc = addrChain.get(addr.toLowerCase());
    return {
      key,
      contract: addr.toLowerCase(),
      chainId: loc?.chainId ?? -1, // -1 = in constants but not in config (drift)
      startBlock: loc?.startBlock ?? -1,
      ramp: loc ? loc.chainId in RAMP_CHAINS : false,
    };
  });
}

async function fetchChainMeta(): Promise<
  Map<number, { lpb: number; head: number }>
> {
  const d = await gql<{
    chain_metadata: {
      chain_id: number;
      latest_processed_block: number;
      block_height: number;
    }[];
  }>(
    `query { chain_metadata { chain_id latest_processed_block block_height } }`,
  );
  return new Map(
    d.chain_metadata.map((r) => [
      r.chain_id,
      { lpb: r.latest_processed_block, head: r.block_height },
    ]),
  );
}

async function fetchEvm(
  cols: EvmCol[],
  chainMeta: Map<number, { lpb: number; head: number }>,
): Promise<EvmResult[]> {
  // Batch: one aliased query for holder counts + CollectionStat enrichment.
  const inConfig = cols.filter((c) => c.chainId !== -1);
  const holderAliases = inConfig
    .map(
      (c, i) =>
        `h${i}: TrackedHolder_aggregate(where:{chainId:{_eq:${c.chainId}}, contract:{_eq:"${c.contract}"}}){aggregate{count}}`,
    )
    .join("\n");
  const statAliases = inConfig
    .map(
      (c, i) =>
        `s${i}: CollectionStat_by_pk(id:"${c.key}_${c.chainId}"){ totalMinted totalSupply }`,
    )
    .join("\n");
  const data = inConfig.length
    ? await gql<Record<string, any>>(
        `query { ${holderAliases}\n${statAliases} }`,
      )
    : {};
  const byKey = new Map<
    string,
    { holders: number; totalMinted: number | null; totalSupply: number | null }
  >();
  inConfig.forEach((c, i) => {
    byKey.set(c.contract, {
      holders: data[`h${i}`]?.aggregate?.count ?? 0,
      totalMinted: data[`s${i}`]?.totalMinted ?? null,
      totalSupply: data[`s${i}`]?.totalSupply ?? null,
    });
  });

  return cols.map((c) => {
    if (c.chainId === -1) {
      return {
        ...c,
        holders: null,
        totalMinted: null,
        totalSupply: null,
        chainLpb: null,
        chainHead: null,
        deployScanned: false,
        caughtUp: false,
        verdict: "DRIFT ⚠",
        keyReview: FIXTURE_KEY.test(c.key),
      };
    }
    const cm = chainMeta.get(c.chainId);
    const stat = byKey.get(c.contract)!;
    const chainLpb = cm?.lpb ?? null;
    const chainHead = cm?.head ?? null;
    const deployScanned = chainLpb != null && chainLpb >= c.startBlock;
    const caughtUp =
      chainLpb != null &&
      chainHead != null &&
      chainHead - chainLpb <= HEAD_LAG_TOLERANCE;
    // Verdict gate = chain CAUGHT UP (not the shared config start_block): a multi-address TrackedErc721
    // block carries ONE start_block (the batch minimum), so per-collection deployScanned is unreliable.
    // Only once the chain reaches head do we KNOW a collection's full history was scanned → 0 ⇒ MISSING.
    let verdict: string;
    if (stat.holders > 0) verdict = caughtUp ? "READY" : "READY·backfill";
    else verdict = caughtUp ? "MISSING ⚠" : "INDEXING";
    return {
      ...c,
      holders: stat.holders,
      totalMinted: stat.totalMinted,
      totalSupply: stat.totalSupply,
      chainLpb,
      chainHead,
      deployScanned,
      caughtUp,
      verdict,
      keyReview: FIXTURE_KEY.test(c.key),
    };
  });
}

async function fetchSvm(): Promise<SvmResult[]> {
  const cols = Object.values(COLLECTIONS);
  const evtAliases = cols
    .map(
      (c, i) =>
        `e${i}: svm_collection_event_aggregate(where:{collection_key:{_eq:"${c.collectionKey}"}}){aggregate{count}}`,
    )
    .join("\n");
  const syncAliases = cols
    .map(
      (c, i) =>
        `y${i}: svm_sync_status_by_pk(collection_key:"${c.collectionKey}"){ last_event_at last_reconcile_result }`,
    )
    .join("\n");
  const data = await gql<Record<string, any>>(
    `query { ${evtAliases}\n${syncAliases} }`,
  );
  return cols.map((c, i) => {
    const events = data[`e${i}`]?.aggregate?.count ?? 0;
    const sync = data[`y${i}`] ?? null;
    return {
      key: c.collectionKey,
      mint: c.collectionMint,
      displayName: c.displayName,
      ownership: c.ownership,
      events,
      lastEventAt: sync?.last_event_at ?? null,
      lastReconcile: sync?.last_reconcile_result ?? null,
      verdict: events > 0 ? "READY" : "NOT·BACKFILLED",
      keyReview: FIXTURE_KEY.test(c.collectionKey),
    };
  });
}

function pad(s: string, n: number): string {
  const clean = s.replace(/[⚠·]/g, "x"); // width-approx for emoji/middot
  return s + " ".repeat(Math.max(0, n - clean.length));
}

function renderEvm(rows: EvmResult[]): string {
  const lines: string[] = [];
  lines.push(
    pad("COLLECTION", 26) +
      pad("CHAIN", 8) +
      pad("HOLDERS", 9) +
      pad("MINTED", 9) +
      pad("BACKFILL", 12) +
      "VERDICT",
  );
  for (const r of rows) {
    const chain = r.chainId === -1 ? "—" : String(r.chainId);
    const holders = r.holders == null ? "—" : String(r.holders);
    const minted = r.totalMinted == null ? "—" : String(r.totalMinted);
    const backfill =
      r.chainLpb == null
        ? "—"
        : r.deployScanned
          ? r.caughtUp
            ? "head ✓"
            : `${((r.chainLpb / (r.chainHead || 1)) * 100).toFixed(0)}%`
          : `<deploy`;
    const flag = r.keyReview ? "  ⟵ KEY·REVIEW" : "";
    lines.push(
      pad(r.key, 26) +
        pad(chain, 8) +
        pad(holders, 9) +
        pad(minted, 9) +
        pad(backfill, 12) +
        r.verdict +
        flag,
    );
  }
  return lines.join("\n");
}

function renderSvm(rows: SvmResult[]): string {
  const lines: string[] = [];
  lines.push(
    pad("COLLECTION", 20) +
      pad("EVENTS", 9) +
      pad("LAST EVENT", 22) +
      pad("RECONCILE", 12) +
      "VERDICT",
  );
  for (const r of rows) {
    const events = r.events == null ? "—" : String(r.events);
    const last = r.lastEventAt ? r.lastEventAt.slice(0, 19) : "—";
    const rec = r.lastReconcile ? r.lastReconcile.slice(0, 10) : "—";
    const flag = r.keyReview ? "  ⟵ KEY·REVIEW" : "";
    lines.push(
      pad(r.key, 20) +
        pad(events, 9) +
        pad(last, 22) +
        pad(rec, 12) +
        r.verdict +
        flag,
    );
  }
  return lines.join("\n");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const jsonOut = args.has("--json");
  const includeAll = args.has("--all");

  const addrChain = buildAddressChainMap();
  const chainMeta = await fetchChainMeta();
  const allEvm = await fetchEvm(collectEvm(addrChain), chainMeta);
  const svm = await fetchSvm();

  const evm = includeAll
    ? allEvm
    : allEvm.filter((c) => c.ramp || c.verdict === "DRIFT ⚠");

  const summarize = (verdicts: string[]) => {
    const c: Record<string, number> = {};
    for (const v of verdicts) c[v] = (c[v] ?? 0) + 1;
    return c;
  };

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          endpoint: ENDPOINT,
          at: new Date().toISOString(),
          evm,
          svm,
          summary: {
            evm: summarize(evm.map((r) => r.verdict)),
            svm: summarize(svm.map((r) => r.verdict)),
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `\n${TAG} ramp readiness @ ${new Date().toISOString()}\n  gateway: ${ENDPOINT}\n`,
  );
  console.log(
    `━━ EVM ${includeAll ? "(all tracked)" : "(community-onboarding ramp — ETH + Base)"} ━━`,
  );
  console.log(renderEvm(evm));
  console.log(`\n━━ SVM (registry) ━━`);
  console.log(renderSvm(svm));

  const evmSum = summarize(evm.map((r) => r.verdict));
  const svmSum = summarize(svm.map((r) => r.verdict));
  const keyReviews = [
    ...evm.filter((r) => r.keyReview).map((r) => `evm:${r.key}`),
    ...svm.filter((r) => r.keyReview).map((r) => `svm:${r.key}`),
  ];
  console.log(`\n━━ SUMMARY ━━`);
  console.log(`  EVM: ${JSON.stringify(evmSum)}`);
  console.log(`  SVM: ${JSON.stringify(svmSum)}`);
  if (keyReviews.length)
    console.log(
      `  ⚠ KEY·REVIEW (score-api binds on exact collectionKey — decide before a real community pulls): ${keyReviews.join(", ")}`,
    );
  const broken = evm.filter(
    (r) => r.verdict === "MISSING ⚠" || r.verdict === "DRIFT ⚠",
  );
  if (broken.length)
    console.log(
      `  ⚠ NEEDS ATTENTION: ${broken.map((r) => `${r.key}(${r.verdict.trim()})`).join(", ")}`,
    );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
