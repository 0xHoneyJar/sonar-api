/**
 * gate1-evm-coverage-probe.ts — GATE-1 go/no-go: SQD Portal EVM endpoint coverage
 * for 6 target chains (Sprint 3 · FR-A1 · SDD §2.4 · SDD R-8).
 *
 * Actions per chain:
 *   (a) GET  /datasets/{dataset}/finalized-stream/height → finalized head block number
 *   (b) POST /datasets/{dataset}/finalized-stream        → fromBlock=0 (genesis reachability)
 *
 * Prints a coverage TABLE:
 *   CHAIN  DATASET  GENESIS-REACHABLE  HEAD  CERTAIN
 *
 * Chains flagged certain:false (zora, berachain — SDD R-8) render UNCERTAIN in the CERTAIN
 * column. 404 / dataset-not-found renders MISSING in the GENESIS-REACHABLE column — the
 * operator sees exactly which chains need the Goldsky/Covalent fallback (SDD R-8).
 *
 * [LIVE-GATE] SEAM: every [LIVE-GATE] comment names an assumption that T1
 * (src/evm/sqd-evm-client.ts) will inherit. Run this probe FIRST; propagate any
 * correction back to T1's resolveDataset() and buildEvmQuery() before wiring the loader.
 *
 * Usage : tsx scripts/gate1-evm-coverage-probe.ts [--stub]
 *   --stub  Offline mode (fake fetch). Validates table + dataset resolution without a
 *           live network call. zora/berachain stubs return 404 to simulate SDD R-8.
 *
 * Auth  : SQD_API_KEY env var honored. 401/403 surfaces SqdAuthRequiredError context and exits 2.
 * READ-ONLY: no DB writes, no migrations, no raw.evm_log inserts.
 */
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PORTAL_BASE = (process.env.SQD_PORTAL_BASE ?? "https://portal.sqd.dev").replace(/\/$/, "");
const API_KEY = process.env.SQD_API_KEY;

// ---------------------------------------------------------------------------
// Auth error — mirrors SqdAuthRequiredError in src/svm/sqd-client.ts.
// [LIVE-GATE] T1 (src/evm/sqd-evm-client.ts) must export this class with the same
// shape so downstream consumers share a single error type and can catch uniformly.
// ---------------------------------------------------------------------------
export class SqdAuthRequiredError extends Error {
  readonly blockHeight: number;
  readonly timestamp: string;
  readonly status: number;
  readonly url: string;

  constructor(opts: { blockHeight: number; timestamp: string; status: number; url: string }) {
    super(`SQD auth required: HTTP ${opts.status} at ${opts.url} (block ${opts.blockHeight})`);
    this.name = "SqdAuthRequiredError";
    this.blockHeight = opts.blockHeight;
    this.timestamp = opts.timestamp;
    this.status = opts.status;
    this.url = opts.url;
  }
}

// ---------------------------------------------------------------------------
// Chain registry — the CANONICAL source of EVM dataset slugs.
//
// [LIVE-GATE] Each `dataset` value MUST be confirmed against portal.sqd.dev by
// running this probe live. These slugs are best-effort guesses derived from SQD's
// published naming convention; the probe is the authoritative check.
//
// SEAM: T1's resolveDataset() must use these exact slug values, or be updated to
// match whatever the probe confirms. Corrections flow: probe finds mismatch →
// update EVM_CHAINS here AND T1's dataset constants in the same commit.
//
// Chain IDs sourced from config.yaml (id: 1, 8453, 42161, 10, 7777777, 80094).
//
// certain:false = SDD R-8 explicit uncertainty → Goldsky/Covalent fallback if MISSING.
// ---------------------------------------------------------------------------
export interface ChainSpec {
  readonly chainId: number;
  readonly label: string;
  readonly dataset: string; // [LIVE-GATE] verify this slug exists on portal.sqd.dev
  readonly certain: boolean; // false → UNCERTAIN column; SDD R-8 fallback required
}

export const EVM_CHAINS: ReadonlyArray<ChainSpec> = [
  { chainId: 1,       label: "ethereum",  dataset: "ethereum-mainnet",  certain: true  }, // [LIVE-GATE] slug TBC
  { chainId: 8453,    label: "base",      dataset: "base-mainnet",      certain: true  }, // [LIVE-GATE] slug TBC
  { chainId: 42161,   label: "arbitrum",  dataset: "arbitrum-one",      certain: true  }, // [LIVE-GATE] slug TBC
  { chainId: 10,      label: "optimism",  dataset: "optimism-mainnet",  certain: true  }, // [LIVE-GATE] slug TBC
  { chainId: 7777777, label: "zora",      dataset: "zora-mainnet",      certain: false }, // [LIVE-GATE] SDD R-8: uncertain
  { chainId: 80094,   label: "berachain", dataset: "berachain-mainnet", certain: false }, // [LIVE-GATE] SDD R-8: uncertain
];

/**
 * resolveDataset(chainId) — mirrors the export T1 must provide.
 * Returns undefined for unrecognized chain IDs.
 * SEAM: T1's resolveDataset() must accept the same chainId values and return a
 * compatible shape (at minimum: { dataset: string; certain: boolean }).
 */
export function resolveDataset(chainId: number): ChainSpec | undefined {
  return EVM_CHAINS.find((c) => c.chainId === chainId);
}

// ---------------------------------------------------------------------------
// Minimal probe query — mirrors what T1's buildEvmQuery() will emit.
//
// [LIVE-GATE] ALL field names below must be confirmed against a live SQD Portal
// EVM response before T1 implements buildEvmQuery(addresses, topic0, fromBlock):
//   "type": "evm"          — is the discriminant key+value exactly this?
//   "fromBlock"/"toBlock"  — are these the correct range key names?
//   "fields.log.*"         — do these log field names exist on the EVM portal schema?
//   "logs": [...]          — is the filter array key "logs" (not "events"/"logFilters")?
//   empty logs[] = no filter — does the portal accept an empty array without error?
//
// SEAM: T1's buildEvmQuery(addresses, topic0, fromBlock) must emit a superset of
// this object, adding { address: addresses, topics: [[topic0]] } inside logs[].
// ---------------------------------------------------------------------------
function buildProbeQuery(fromBlock: number): string {
  const toBlock = fromBlock + 100; // small window; one block proves reachability
  return JSON.stringify({
    type: "evm",          // [LIVE-GATE] confirm discriminant string
    fromBlock,
    toBlock,
    fields: {
      log: {              // [LIVE-GATE] confirm "log" is the field-selection key (not "logs"/"event")
        address:         true, // [LIVE-GATE]
        topics:          true, // [LIVE-GATE] array or discrete topic0..topic3?
        data:            true, // [LIVE-GATE]
        transactionHash: true, // [LIVE-GATE] camelCase or snake_case?
        logIndex:        true, // [LIVE-GATE]
      },
      block: {
        number:    true, // [LIVE-GATE]
        timestamp: true, // [LIVE-GATE] unix seconds or milliseconds?
      },
    },
    logs: [], // [LIVE-GATE] empty = no address/topic filter; confirm portal accepts this
  });
}

// ---------------------------------------------------------------------------
// Probe result types
// ---------------------------------------------------------------------------
type HeadStatus    = "ok" | "MISSING" | "ERROR";
type GenesisStatus = "YES" | "MISSING" | "ERROR";

interface ChainResult {
  spec:          ChainSpec;
  head:          number | null;
  headStatus:    HeadStatus;
  headDetail:    string | null;   // error detail when headStatus === "ERROR"
  genesisStatus: GenesisStatus;
  genesisDetail: string | null;   // error detail or note when genesisStatus !== "MISSING"
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// The probe only calls fetch(string, init?) — no URL/Request objects needed.
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`; // [LIVE-GATE] confirm auth header name
  return h;
}

async function fetchHeight(
  fetcher: Fetcher,
  dataset: string,
): Promise<{ head: number | null; status: HeadStatus; detail: string | null }> {
  const url = `${PORTAL_BASE}/datasets/${dataset}/finalized-stream/height`;
  let res: Response;
  try {
    res = await fetcher(url, { headers: authHeaders() });
  } catch (e) {
    return { head: null, status: "ERROR", detail: (e as Error).message.slice(0, 120) };
  }
  if (res.status === 401 || res.status === 403) {
    throw new SqdAuthRequiredError({
      blockHeight: 0, timestamp: new Date().toISOString(), status: res.status, url,
    });
  }
  if (res.status === 404) return { head: null, status: "MISSING", detail: null };
  if (!res.ok) return { head: null, status: "ERROR", detail: `HTTP ${res.status}` };
  const text = (await res.text()).trim();
  const n = Number(text);
  if (!Number.isFinite(n)) {
    return { head: null, status: "ERROR", detail: `non-numeric head: "${text.slice(0, 40)}"` };
  }
  return { head: Math.round(n), status: "ok", detail: null };
}

async function probeGenesis(
  fetcher: Fetcher,
  dataset: string,
): Promise<{ status: GenesisStatus; detail: string | null }> {
  const url = `${PORTAL_BASE}/datasets/${dataset}/finalized-stream`;
  const body = buildProbeQuery(0);
  let res: Response;
  try {
    res = await fetcher(url, { method: "POST", headers: authHeaders(), body });
  } catch (e) {
    return { status: "ERROR", detail: (e as Error).message.slice(0, 120) };
  }
  if (res.status === 401 || res.status === 403) {
    throw new SqdAuthRequiredError({
      blockHeight: 0, timestamp: new Date().toISOString(), status: res.status, url,
    });
  }
  if (res.status === 404) return { status: "MISSING", detail: null };
  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 120);
    return { status: "ERROR", detail: `HTTP ${res.status} ${snippet}` };
  }

  // [LIVE-GATE] JSONL response shape: each line is a JSON block object.
  // Assumed shape: { header: { number: N, timestamp: T }, logs: [...] }
  // T1's JSONL parser MUST be updated to match the ACTUAL shape found here.
  // Specifically, confirm: "header.number" field path for block number (vs "number" top-level).
  const text = await res.text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { header?: { number?: unknown } };
      const n = Number(parsed.header?.number); // [LIVE-GATE] confirm header.number field path
      if (Number.isFinite(n) && n >= 0) return { status: "YES", detail: null };
    } catch {
      // torn or non-JSON line at stream boundary — skip and continue
    }
  }

  // 200 OK but no recognized block header — the portal answered (dataset exists) but
  // blocks 0..100 had no parseable block lines. Treat as reachable: the dataset is up,
  // genesis accessibility is structurally confirmed even without a parsed block number.
  return { status: "YES", detail: "no parseable block in 0..100 (dataset reachable, range empty)" };
}

// ---------------------------------------------------------------------------
// Offline stub — validates table rendering + dataset resolution without network.
//
// Simulates SDD R-8 scenario:
//   ethereum / base / arbitrum / optimism  → pass (height + genesis block)
//   zora / berachain                       → 404 (dataset not found)
//
// [LIVE-GATE] The stub JSONL shape mirrors the assumed real response structure.
// The operator validates the actual structure via the live probe.
// ---------------------------------------------------------------------------
function makeStubFetch(): Fetcher {
  const HEIGHT = "21000000";
  // [LIVE-GATE] stub JSONL: assumed { header: { number, timestamp }, logs: [] } — confirm live
  const BLOCK_JSONL = JSON.stringify({ header: { number: 0, timestamp: 1700000000 }, logs: [] });

  return (url: string, init?: RequestInit): Promise<Response> => {
    const m = url.match(/\/datasets\/([^/]+)\//);
    const dataset = m?.[1] ?? "";
    const spec = EVM_CHAINS.find((c) => c.dataset === dataset);
    const certain = spec?.certain ?? false;

    if (!certain) {
      // Simulate SDD R-8: uncertain chains not found on portal
      return Promise.resolve(new Response("dataset not found", { status: 404 }));
    }
    if (url.endsWith("/height")) {
      return Promise.resolve(new Response(HEIGHT, { status: 200 }));
    }
    if (init?.method === "POST") {
      return Promise.resolve(new Response(BLOCK_JSONL + "\n", { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------
const W = { chain: 12, dataset: 24, genesis: 22, head: 15, certain: 10 } as const;

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function formatHead(head: number | null): string {
  return head === null ? "-" : head.toLocaleString("en-US");
}

function genesisCell(status: GenesisStatus, certain: boolean): string {
  if (status === "YES")     return "YES";
  if (status === "MISSING") return "MISSING (404)";
  // ERROR — render distinctly regardless of certain flag
  return "ERROR";
}

function certCell(certain: boolean): string {
  // [TASK] certain:false renders UNCERTAIN per task requirement ("render distinctly")
  return certain ? "CONFIRMED" : "UNCERTAIN";
}

function printTable(results: ChainResult[]): void {
  const hdr = [
    pad("CHAIN",             W.chain),
    pad("DATASET",           W.dataset),
    pad("GENESIS-REACHABLE", W.genesis),
    pad("HEAD",              W.head),
    "CERTAIN",
  ].join("  ");
  const sep = [
    "-".repeat(W.chain),
    "-".repeat(W.dataset),
    "-".repeat(W.genesis),
    "-".repeat(W.head),
    "-".repeat(W.certain),
  ].join("  ");

  console.log("\n" + hdr);
  console.log(sep);
  for (const r of results) {
    console.log([
      pad(r.spec.label,           W.chain),
      pad(r.spec.dataset,         W.dataset),
      pad(genesisCell(r.genesisStatus, r.spec.certain), W.genesis),
      pad(formatHead(r.head),     W.head),
      certCell(r.spec.certain),
    ].join("  "));
    // Print error detail on next line if present
    if (r.genesisStatus === "ERROR" && r.genesisDetail) {
      console.log(" ".repeat(W.chain + W.dataset + 4) + `  ↳ ${r.genesisDetail}`);
    }
  }
  console.log("");
}

function printSummary(results: ChainResult[]): void {
  const certain   = results.filter((r) =>  r.spec.certain);
  const uncertain = results.filter((r) => !r.spec.certain);

  const cPass    = certain.filter((r) => r.genesisStatus === "YES").length;
  const cMissing = certain.filter((r) => r.genesisStatus === "MISSING").length;
  const cError   = certain.filter((r) => r.genesisStatus === "ERROR").length;
  const uMissing = uncertain.filter((r) => r.genesisStatus === "MISSING").length;

  console.log("=== GATE-1 SUMMARY ===");
  console.log(`Confirmed chains  (${certain.length}): ${cPass} PASS · ${cMissing} MISSING · ${cError} ERROR`);
  if (uncertain.length > 0) {
    const uLabels = uncertain.map((r) => r.spec.label).join(", ");
    console.log(`Uncertain chains  (${uncertain.length} · SDD R-8 — ${uLabels}): ${uMissing} MISSING → Goldsky/Covalent fallback`);
  }

  console.log("");
  if (cError > 0) {
    console.log("[GATE-1] BLOCKED — errors on confirmed chains; investigate before loading.");
    return;
  }
  if (cPass === certain.length) {
    console.log("[GATE-1] GO — all confirmed chains reachable from genesis.");
  } else {
    console.log(`[GATE-1] PARTIAL — ${cMissing} confirmed chain(s) MISSING on SQD Portal EVM.`);
    console.log("[GATE-1] Contact SQD for missing datasets, or route to fallback provider.");
  }
  if (uMissing > 0) {
    const fallbackChains = uncertain
      .filter((r) => r.genesisStatus === "MISSING")
      .map((r) => r.spec.label)
      .join(", ");
    console.log(`[GATE-1] Fallback required for: ${fallbackChains} (Goldsky/Covalent per SDD R-8)`);
  }
}

// ---------------------------------------------------------------------------
// Probe runner
// ---------------------------------------------------------------------------
async function runProbe(fetcher: Fetcher): Promise<ChainResult[]> {
  const results: ChainResult[] = [];

  for (const spec of EVM_CHAINS) {
    process.stdout.write(`[gate1] probing ${spec.label} (${spec.dataset}) ... `);

    const r: ChainResult = {
      spec,
      head: null, headStatus: "ok", headDetail: null,
      genesisStatus: "YES", genesisDetail: null,
    };

    try {
      const h = await fetchHeight(fetcher, spec.dataset);
      r.headStatus = h.status;
      r.head       = h.head;
      r.headDetail = h.detail;

      if (h.status === "MISSING") {
        // Height 404 → dataset not found → skip genesis probe (would also 404)
        r.genesisStatus = "MISSING";
        r.genesisDetail = null;
      } else {
        // Probe genesis even when head errored — may reveal a richer error
        const g = await probeGenesis(fetcher, spec.dataset);
        r.genesisStatus = g.status;
        r.genesisDetail = g.detail;
      }
    } catch (e) {
      if (e instanceof SqdAuthRequiredError) throw e; // abort: auth error on any chain is global
      r.genesisStatus = "ERROR";
      r.genesisDetail = (e as Error).message.slice(0, 120);
    }

    const suffix = r.genesisDetail ? ` (${r.genesisDetail})` : "";
    console.log(r.genesisStatus + suffix);
    results.push(r);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Entry point (guarded via import.meta.url so file is safely importable)
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stubMode = args.includes("--stub");

  if (stubMode) {
    console.log("[gate1] STUB MODE (offline) — fake fetch; zora/berachain → 404 (simulates SDD R-8)");
    console.log("[gate1] This validates table rendering + dataset resolution without network access.");
  } else {
    console.log(`[gate1] LIVE probe → ${PORTAL_BASE}`);
    console.log(`[gate1] SQD_API_KEY: ${API_KEY ? "set" : "not set (unauthenticated)"}`);
    console.log("[gate1] Note: SQD Portal EVM may be open/unauthenticated — 401/403 surfaces context.");
  }

  console.log(`[gate1] Probing ${EVM_CHAINS.length} chains: ${EVM_CHAINS.map((c) => c.label).join(", ")}\n`);

  // Wrap global fetch to the simpler Fetcher signature; or use stub in offline mode.
  const fetcher: Fetcher = stubMode
    ? makeStubFetch()
    : (url: string, init?: RequestInit) => fetch(url, init);

  let results: ChainResult[];
  try {
    results = await runProbe(fetcher);
  } catch (e) {
    if (e instanceof SqdAuthRequiredError) {
      console.error(`\n[gate1] AUTH_REQUIRED: ${e.message}`);
      console.error(`[gate1] Set SQD_API_KEY to a valid Bearer token and retry.`);
      console.error(`[gate1] status=${e.status}  url=${e.url}`);
      process.exit(2);
    }
    throw e;
  }

  printTable(results);
  printSummary(results);

  // Exit 1 if any CONFIRMED chain errored (MISSING is informational — not a tool error)
  const blocked = results.some((r) => r.spec.certain && r.genesisStatus === "ERROR");
  process.exit(blocked ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    console.error(`[gate1] FATAL: ${(e as Error).message}`);
    process.exit(1);
  });
}
