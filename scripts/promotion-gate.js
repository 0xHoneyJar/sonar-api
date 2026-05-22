/**
 * promotion-gate.js — blue→green promotion reconciliation gate (SDD §6, FR-4, S1/S2).
 *
 * The non-skippable precondition for a blue-green alias swap. A green deployment
 * that reached blue's block height but silently dropped entities (KF-012 getLogs
 * loss) would pass a naive height check and serve a lossy view after the swap.
 * The gate is therefore multi-part and FAIL-CLOSED (any unknown → FAIL, never
 * PASS — SR-7a/IMP-004):
 *
 *   Part 1 — block-height parity: green.latest_processed_block ≥ blue's on EVERY
 *            chain blue indexes (shared chains).
 *   Part 2 — entity-count reconciliation: per-entity over the score-api footprint,
 *            using the per-entity reconciliation MODE from Task 1.0
 *            (grimoires/loa/a2a/sprint-173/reconciliation-feasibility.md):
 *              A = at-block count (has blockNumber, append-only)
 *              B = timestamp-proxy at-block (Action: append-only, no blockNumber)
 *              C = converged current-state exact (mutable aggregate, low-cardinality)
 *   Part 3 — schema superset (FR-7 additive-only): green's schema ⊇ blue's.
 *   Part 4 — raw-L1 eth_getLogs ground-truth (R-B, SR-4/SR-5): the ONLY correctness
 *            check for NEW chains (Arbitrum/Zora) with no blue baseline. Expansion-mode
 *            only. An empty-200 getLogs is a GAP, never a pass (KF-012).
 *
 * Two reconciliation MODES (S2 expansion reframe — NOTES.md Decision Log 2026-05-22,
 * "[SCOPE — S2 = consolidation EXPANSION, not a parity dry-run]"; SDD §6 to be
 * reconciled parity→expansion, drift_resolution: code):
 *   - `parity`    : |green − blue| ≤ tolerance on every shared entity/chain. The
 *                   degenerate dry-run case (green = a copy of blue). Default.
 *   - `expansion` : green ⊋ blue. SHARED entities/chains → green ≥ blue − floor
 *                   (NON-LOSSY non-regression; green MAY exceed). NEW entities/chains
 *                   → no blue compare; correctness deferred to Part-4 raw-L1.
 *
 * The pure check functions take SNAPSHOTS ({ chainMeta, counts, schema }) so the
 * test harness injects fixtures and the live run feeds the same functions real
 * blue/green data. Part-4 takes an injected `rpcFetch` so it is unit-testable
 * without live RPC. Exit 0 = PASS (swap allowed) · non-zero = FAIL (hold).
 *
 * Zero dependencies by design — matches verify-belt-config.js's stated invariant
 * (a gate guarding promotion safety must not introduce an npm install surface).
 * Run: `node scripts/promotion-gate.js` (self-parity) — see main().
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The 12 score-api footprint entities (SDD §6.2 AC-R7 baseline), each tagged with:
 *   - `mode`     : reconciliation MODE (Task 1.0)
 *   - `tolerance`: exact on low-cardinality, max(rel, floor) on high-cardinality (R-G)
 *   - `presence` : 'shared' (exists in blue's 4-chain belt) | 'new' (green-only data,
 *                  e.g. from an Arbitrum/Zora-only contract — verified via Part-4, not
 *                  the blue compare). All 12 score-api entities are shared today.
 * `baseline` documents the shipped blue-belt count.
 */
export const FOOTPRINT = [
  { entity: "MiberaTransfer",    baseline: 39_714,    mode: "A", presence: "shared", tolerance: { rel: 0.001, floor: 50 } },
  { entity: "MintActivity",      baseline: 10_000,    mode: "A", presence: "shared", tolerance: { rel: 0.001, floor: 25 } },
  { entity: "NftBurn",           baseline: 39,        mode: "A", presence: "shared", tolerance: { exact: true } },
  { entity: "BgtBoostEvent",     baseline: 1_470_000, mode: "A", presence: "shared", tolerance: { rel: 0.001, floor: 500 } },
  { entity: "Erc1155MintEvent",  baseline: 7_607,     mode: "A", presence: "shared", tolerance: { rel: 0.001, floor: 25 } },
  { entity: "FriendtechTrade",   baseline: 1_317,     mode: "A", presence: "shared", tolerance: { exact: true } },
  { entity: "PaddleSupply",      baseline: 363,       mode: "A", presence: "shared", tolerance: { exact: true } },
  { entity: "MintEvent",         baseline: 3_588,     mode: "A", presence: "shared", tolerance: { exact: true } },
  { entity: "TreasuryActivity",  baseline: 11_819,    mode: "A", presence: "shared", tolerance: { rel: 0.001, floor: 25 } },
  { entity: "Action",            baseline: 2_070_000, mode: "B", presence: "shared", tolerance: { rel: 0.001, floor: 500 } },
  { entity: "MiberaLoan",        baseline: 176,       mode: "C", presence: "shared", tolerance: { exact: true } },
  { entity: "MiberaStakedToken", baseline: 1_603,     mode: "C", presence: "shared", tolerance: { exact: true } },
];

/** Allowed absolute delta for a count, given a tolerance spec (R-G). In expansion
 * mode this same value is the DOWNWARD floor (how far green may dip below blue from
 * head-timing skew before it counts as a lossy regression). */
export function allowedDelta(baseline, tolerance) {
  if (!tolerance || tolerance.exact) return 0;
  const rel = Math.ceil((baseline || 0) * (tolerance.rel ?? 0));
  return Math.max(rel, tolerance.floor ?? 0);
}

/**
 * Part 1 — block-height parity + completeness. For every chain blue indexes, green
 * must have a chain_metadata row AND be at-or-ahead (KF-013/D6 silent-skip guard for
 * shared chains). For NEW chains (no blue baseline), the blue-derived loop can't see a
 * silent-drop — so `expectedChains` (an INDEPENDENT completeness list from config/env,
 * NOT derived from green) is asserted present in green: a new chain that failed to seed
 * has no green row and would otherwise be invisible. Present-but-not-behind new chains
 * are still deferred to Part-4 for at-head correctness.
 */
export function checkBlockHeights(blue, green, { mode = "parity", expectedChains = [] } = {}) {
  const failures = [];
  for (const chainId of Object.keys(blue)) {
    const b = blue[chainId];
    const g = green[chainId];
    if (g === undefined || g === null) {
      failures.push(`chain ${chainId}: green has no chain_metadata row (silent-skip — KF-013/D6)`);
      continue;
    }
    if (Number(g) < Number(b)) {
      failures.push(`chain ${chainId}: green ${g} < blue ${b} (still backfilling)`);
    }
  }
  // Independent completeness: green cannot self-attest. A NEW expected chain that silently
  // failed to seed has no green chain_metadata row and is invisible to the blue loop above.
  for (const chainId of expectedChains.map(String)) {
    if (chainId in blue) continue; // shared-chain presence already enforced above
    if (!(chainId in green)) {
      failures.push(`chain ${chainId}: EXPECTED (new) but absent from green chain_metadata (silent-drop — green cannot self-attest completeness, KF-013/D6)`);
    }
  }
  const deferred = [];
  if (mode === "expansion") {
    for (const chainId of Object.keys(green)) {
      if (!(chainId in blue)) {
        deferred.push(`chain ${chainId}: green-only (no blue baseline) — at-head verified via Part-4 raw-L1`);
      }
    }
  }
  return { pass: failures.length === 0, failures, deferred };
}

/**
 * Part 2 — entity-count reconciliation over the footprint. FAIL-CLOSED: a missing
 * count on either side (for an entity that needs comparing) is a failure, never a
 * pass (SR-7a/IMP-004).
 *   - parity   : |green − blue| ≤ tolerance (the original dry-run check).
 *   - expansion: SHARED entities → green ≥ blue − floor (non-lossy; green MAY exceed,
 *                which is the whole point — e.g. live MintActivity blue 10,000 vs
 *                green 29,514). NEW entities → no blue compare; deferred to Part-4.
 */
export function checkEntityCounts(blueCounts, greenCounts, footprint = FOOTPRINT, { mode = "parity" } = {}) {
  const failures = [];
  const deferred = [];
  for (const f of footprint) {
    const presence = f.presence || "shared";
    const b = blueCounts?.[f.entity];
    const g = greenCounts?.[f.entity];

    // expansion + new-entity: blue has no baseline → correctness is Part-4's job.
    if (mode === "expansion" && presence === "new") {
      deferred.push(
        g === undefined || g === null
          ? `${f.entity} (MODE ${f.mode}, NEW): no green count — verify via Part-4 raw-L1`
          : `${f.entity} (MODE ${f.mode}, NEW): green=${g} — verified via Part-4 raw-L1 (no blue baseline)`,
      );
      continue;
    }

    // shared (both modes) + every parity entity → need both counts (fail-closed).
    if (b === undefined || b === null || g === undefined || g === null) {
      failures.push(`${f.entity} (MODE ${f.mode}): missing count (blue=${b} green=${g}) — fail-closed`);
      continue;
    }

    const allowed = allowedDelta(Number(b), f.tolerance);
    if (mode === "expansion") {
      // NON-LOSSY: green may exceed blue freely; only a dip below blue−floor is lossy.
      if (Number(g) < Number(b) - allowed) {
        failures.push(`${f.entity} (MODE ${f.mode}, shared): green ${g} < blue ${b} − floor ${allowed} (LOSSY regression)`);
      }
    } else {
      const delta = Math.abs(Number(g) - Number(b));
      if (delta > allowed) {
        failures.push(`${f.entity} (MODE ${f.mode}): |${g} − ${b}| = ${delta} > allowed ${allowed}`);
      }
    }
  }
  return { pass: failures.length === 0, failures, deferred };
}

/** Parse a GraphQL schema string into { TypeName: { fieldName: typeSignature } }. */
function parseSchema(src) {
  const types = {};
  const noComments = String(src || "").replace(/#[^\n]*/g, "");
  const typeRe = /type\s+([A-Za-z0-9_]+)\s*(?:@\w+\s*)*\{([^}]*)\}/g;
  let m;
  while ((m = typeRe.exec(noComments)) !== null) {
    const [, name, body] = m;
    const fields = {};
    const fieldRe = /([A-Za-z0-9_]+)\s*:\s*(\[?[A-Za-z0-9_]+!?\]?!?)/g;
    let fm;
    while ((fm = fieldRe.exec(body)) !== null) fields[fm[1]] = fm[2];
    types[name] = fields;
  }
  return types;
}

/** Parse `enum Name { V1 V2 … }` declarations into { EnumName: [values] } (DISS-001). */
function parseEnums(src) {
  const enums = {};
  const noComments = String(src || "").replace(/#[^\n]*/g, "");
  const enumRe = /enum\s+([A-Za-z0-9_]+)\s*(?:@\w+\s*)*\{([^}]*)\}/g;
  let m;
  while ((m = enumRe.exec(noComments)) !== null) {
    const [, name, body] = m;
    // strip value directives (e.g. @deprecated) before extracting value identifiers
    const noDirectives = body.replace(/@\w+(?:\([^)]*\))?/g, " ");
    enums[name] = noDirectives.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  }
  return enums;
}

/**
 * Part 3 — schema superset (FR-7 additive-only). Green must contain every blue
 * type + field with an identical signature (catches removal, type/nullability
 * change) AND every blue enum's value-set must be ⊆ green's (catches enum
 * value-set contraction — IMP-005, DISS-001). Green adding fields/types/enum
 * values is allowed. Unchanged across both modes — expansion is additive by
 * definition, so green ⊇ blue must always hold.
 */
export function checkSchemaSuperset(blueSchema, greenSchema) {
  const blue = parseSchema(blueSchema);
  const green = parseSchema(greenSchema);
  const failures = [];
  for (const [type, fields] of Object.entries(blue)) {
    if (!green[type]) {
      failures.push(`green schema missing type ${type} (non-additive removal)`);
      continue;
    }
    for (const [fname, sig] of Object.entries(fields)) {
      const gsig = green[type][fname];
      if (!gsig) {
        failures.push(`green ${type}.${fname} missing (non-additive removal)`);
      } else if (gsig !== sig) {
        failures.push(`green ${type}.${fname}: '${gsig}' ≠ blue '${sig}' (type/nullability/enum drift)`);
      }
    }
  }
  // enum value-set superset (DISS-001): green must keep every blue enum value.
  const blueEnums = parseEnums(blueSchema);
  const greenEnums = parseEnums(greenSchema);
  for (const [enumName, values] of Object.entries(blueEnums)) {
    const g = greenEnums[enumName];
    if (!g) {
      failures.push(`green schema missing enum ${enumName} (non-additive removal)`);
      continue;
    }
    const gset = new Set(g);
    for (const v of values) {
      if (!gset.has(v)) failures.push(`green enum ${enumName} missing value '${v}' (non-additive value removal)`);
    }
  }
  return { pass: failures.length === 0, failures };
}

/**
 * Part 4 — raw-L1 eth_getLogs ground-truth (R-B, SR-4/SR-5). Expansion-mode only;
 * the ONLY correctness check for NEW chains (Arbitrum/Zora) with no blue baseline.
 * Each sample is a golden (chain, contract, block-range) tuple with a known-nonzero
 * expectation and — for true SR-5 identity grounding — an optional `expectTx` (the
 * transactionHash of a specific event green claims to have indexed) and `topics`
 * (e.g. the ERC-721 Transfer topic0, so the count reflects Transfers specifically).
 * FAIL-CLOSED on: no rpcFetch, RPC error, non-array response, empty-200 (= GAP,
 * KF-012), short count, a golden `expectTx` absent from the returned logs (green's
 * claimed event not on L1), or a required new-chain with no sample configured.
 * `rpcFetch` is injected — tests mock it; the live path uses makeRpcFetch (backoff +
 * jitter against a DEDICATED RPC, bypassing the eRPC pool it is checking).
 */
export async function checkRawL1(samples = [], { rpcFetch, requiredChains = [] } = {}) {
  const failures = [];
  const checks = [];
  if (typeof rpcFetch !== "function") {
    return {
      pass: false,
      failures: ["Part-4: no rpcFetch injected — cannot verify new-chain coverage (fail-closed)"],
      checks,
    };
  }
  for (const s of samples) {
    const label = s.label || `chain ${s.chain} ${s.address} [${s.fromBlock}-${s.toBlock}]`;
    const expected = s.minExpected ?? 1;
    let logs;
    try {
      logs = await rpcFetch(s.chain, {
        address: s.address,
        fromBlock: s.fromBlock,
        toBlock: s.toBlock,
        topics: s.topics,
      });
    } catch (e) {
      failures.push(`${label}: getLogs error '${e.message}' — fail-closed`);
      checks.push({ chain: String(s.chain), label, ok: false, count: null, expected, error: e.message });
      continue;
    }
    const count = Array.isArray(logs) ? logs.length : null;
    if (count === null) {
      failures.push(`${label}: non-array getLogs response — fail-closed`);
      checks.push({ chain: String(s.chain), label, ok: false, count, expected });
    } else if (count === 0) {
      failures.push(`${label}: empty getLogs-200 = GAP, not a pass (KF-012)`);
      checks.push({ chain: String(s.chain), label, ok: false, count, expected });
    } else if (count < expected) {
      failures.push(`${label}: ${count} logs < expected ${expected}`);
      checks.push({ chain: String(s.chain), label, ok: false, count, expected });
    } else if (s.expectTx && !logs.some((l) => String(l?.transactionHash || "").toLowerCase() === String(s.expectTx).toLowerCase())) {
      // SR-5 identity: a non-empty range isn't enough — the SPECIFIC log green claims must be on L1.
      failures.push(`${label}: golden tx ${s.expectTx} NOT among ${count} logs (green's claimed event absent on L1 — SR-5 identity)`);
      checks.push({ chain: String(s.chain), label, ok: false, count, expected, expectTx: s.expectTx });
    } else {
      checks.push({ chain: String(s.chain), label, ok: true, count, expected, ...(s.expectTx ? { expectTx: s.expectTx } : {}) });
    }
  }
  // Every new chain that needs verification MUST have at least one golden sample.
  const covered = new Set(samples.map((s) => String(s.chain)));
  for (const chain of requiredChains) {
    if (!covered.has(String(chain))) {
      failures.push(`new chain ${chain}: no golden sample configured — cannot verify coverage (fail-closed, KF-012)`);
    }
  }
  return { pass: failures.length === 0, failures, checks };
}

/**
 * Run Parts 1–3 over two snapshots (pure, sync). A snapshot = { chainMeta:
 * {chainId: block}, counts: {entity: n}, schema: string }. Part-4 (async, raw-L1)
 * is composed on top in main() for expansion runs. Returns the per-part results +
 * overall pass for Parts 1–3.
 */
export function runGate(blue, green, { footprint = FOOTPRINT, mode = "parity", expectedChains = [] } = {}) {
  const part1 = checkBlockHeights(blue.chainMeta || {}, green.chainMeta || {}, { mode, expectedChains });
  const part2 = checkEntityCounts(blue.counts || {}, green.counts || {}, footprint, { mode });
  const part3 = checkSchemaSuperset(blue.schema, green.schema);
  const pass = part1.pass && part2.pass && part3.pass;
  return { pass, mode, part1, part2, part3 };
}

/** Redact credentials from a URL before it is persisted to the (git-committed) report
 * or surfaced in an error message / CI log. Strips userinfo (user:pass@) and sensitive
 * query params (token/key/secret/admin/signature). Defense-in-depth: the gate queries the
 * anon public role today (no secret in-band), but an operator MAY configure a credentialed
 * endpoint or a keyed RPC, and the report is committed to the repo. */
export function redactUrl(u) {
  if (!u) return u;
  try {
    const url = new URL(u);
    if (url.username || url.password) { url.username = "***"; url.password = "***"; }
    for (const k of [...url.searchParams.keys()]) {
      if (/secret|token|key|password|admin|sig|signature|auth/i.test(k)) url.searchParams.set(k, "***");
    }
    return url.toString();
  } catch {
    return String(u).replace(/\/\/[^@/]*@/, "//***@"); // best-effort for non-parseable inputs
  }
}

/** Render a PASS/FAIL markdown report for grimoires/loa/a2a/<sprint>/promotion-reconciliation.md.
 * The report IS the operator's go/no-go UX (Design Rules): scannable PASS/FAIL with
 * per-entity/per-chain deltas, presence(shared/new) deferrals, and Part-4 evidence. */
export function renderReport(result, meta = {}) {
  const L = [];
  L.push(`# Promotion Reconciliation — ${result.pass ? "✅ PASS (swap allowed)" : "❌ FAIL (hold)"}`);
  L.push("");
  L.push(`**When:** ${new Date().toISOString()} · **Mode:** ${result.mode || "parity"} · **Blue:** ${redactUrl(meta.blue) || "?"} · **Green:** ${redactUrl(meta.green) || "?"}`);
  L.push("");
  const parts = [
    ["Part 1 — block-height parity", result.part1],
    ["Part 2 — entity-count reconciliation", result.part2],
    ["Part 3 — schema superset", result.part3],
  ];
  if (result.part4) parts.push(["Part 4 — raw-L1 ground-truth (new chains)", result.part4]);
  for (const [name, part] of parts) {
    if (!part) continue;
    L.push(`## ${name}: ${part.pass ? "✅" : "❌"}`);
    if (part.failures && part.failures.length) for (const f of part.failures) L.push(`- ❌ ${f}`);
    else L.push("- ✅ (all checks passed)");
    if (part.deferred && part.deferred.length) {
      L.push("");
      for (const d of part.deferred) L.push(`- ⏭️ ${d}`);
    }
    if (part.checks && part.checks.length) {
      L.push("");
      for (const c of part.checks) {
        L.push(`- ${c.ok ? "✅" : "❌"} ${c.label}: ${c.count == null ? "(error)" : c.count} logs (expected ≥ ${c.expected})`);
      }
    }
    L.push("");
  }
  return L.join("\n");
}

// ── Live snapshot fetch (Part 2/Part 1 data) ───────────────────────────────────

/** Build the per-MODE aggregate field (Task 1.0). With a cutoff configured, MODE A
 * caps on blockNumber and MODE B (Action — no blockNumber) caps on timestamp; MODE C
 * (converged current-state) and the no-cutoff case are a straight total count. */
export function buildCountField(alias, entity, mode, { cutoffBlock = null, cutoffTs = null } = {}) {
  if (mode === "A" && cutoffBlock != null) {
    return `${alias}: ${entity}_aggregate(where: {blockNumber: {_lte: "${cutoffBlock}"}}) { aggregate { count } }`;
  }
  if (mode === "B" && cutoffTs != null) {
    return `${alias}: ${entity}_aggregate(where: {timestamp: {_lte: "${cutoffTs}"}}) { aggregate { count } }`;
  }
  return `${alias}: ${entity}_aggregate { aggregate { count } }`;
}

/** Build the single batched snapshot query: chain_metadata heights + per-entity
 * aliased aggregate counts. One round-trip per deployment. */
export function buildSnapshotQuery(footprint = FOOTPRINT, cutoff = {}) {
  const fields = footprint.map((f, i) => buildCountField(`e${i}`, f.entity, f.mode, cutoff));
  return `query Snapshot { chain_metadata(order_by: {chain_id: asc}) { chain_id block_height latest_processed_block } ${fields.join(" ")} }`;
}

/** POST a GraphQL query; throw on non-200 or GraphQL errors (fail-closed). */
async function gqlFetch(url, query) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status} from ${redactUrl(url)}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors from ${redactUrl(url)}: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data;
}

/**
 * Build a snapshot fetcher against a deployment's Hasura GraphQL. Returns
 * { chainMeta, counts, schema }. HASURA runs with STRINGIFY_NUMERIC_TYPES=true so
 * numeric fields arrive as strings — every count/height is coerced via Number().
 *
 * The counts query doubles as the liveness/tracking check: if an entity table is
 * not tracked, its `_aggregate` field errors → gqlFetch throws → the gate
 * fails-closed (it never silently treats an untracked entity as zero).
 *
 * `schema` is read from the committed `schema.graphql` (env SCHEMA_PATH) — both belts
 * build from the same schema, so Part 3 compares the committed schema to itself and
 * passes by construction (verified: green and blue share an identical 93-entity table
 * set; the row counts differ, not the schema). The cutoff (env CUTOFF_BLOCK /
 * CUTOFF_TS) is the FR-4 at-block fixed-cutoff for the parity-dry-run-while-green-lags
 * case; for an at-head expansion certify it is left unset and total counts are used
 * (the expansion non-lossy floor absorbs head-timing skew).
 */
export function makeFetchSnapshot(env = process.env, footprint = FOOTPRINT) {
  const cutoffBlock = env.CUTOFF_BLOCK != null && env.CUTOFF_BLOCK !== "" ? String(env.CUTOFF_BLOCK) : null;
  const cutoffTs = env.CUTOFF_TS != null && env.CUTOFF_TS !== "" ? String(env.CUTOFF_TS) : null;
  const schemaPath = env.SCHEMA_PATH || "schema.graphql";
  return async function fetchSnapshot(url) {
    const data = await gqlFetch(url, buildSnapshotQuery(footprint, { cutoffBlock, cutoffTs }));
    const chainMeta = {};
    for (const row of data.chain_metadata || []) chainMeta[String(row.chain_id)] = Number(row.latest_processed_block);
    const counts = {};
    footprint.forEach((f, i) => {
      const c = data[`e${i}`]?.aggregate?.count;
      counts[f.entity] = c == null ? undefined : Number(c);
    });
    let schema = "";
    try { schema = readFileSync(schemaPath, "utf8"); } catch { schema = ""; }
    return { chainMeta, counts, schema };
  };
}

// ── Live raw-L1 fetch (Part 4) ─────────────────────────────────────────────────

/**
 * Build a raw eth_getLogs fetcher that BYPASSES the eRPC pool (it is the thing being
 * checked) — per-chain DEDICATED endpoints from env (RPC_<chainId>), with public
 * defaults for the new chains. Exponential backoff + full jitter on transient errors
 * (SR-4). Returns the `result` array verbatim (an empty array surfaces to the caller
 * as a GAP, never silently treated as a pass — KF-012).
 */
export function makeRpcFetch(env = process.env) {
  const DEFAULTS = { 42161: "https://arb1.arbitrum.io/rpc", 7777777: "https://rpc.zora.energy" };
  const urlFor = (chain) => env[`RPC_${chain}`] || DEFAULTS[chain];
  const maxRetries = Number(env.RPC_MAX_RETRIES ?? 5);
  const toHex = (n) => "0x" + BigInt(n).toString(16);
  return async function rpcFetch(chain, { address, fromBlock, toBlock, topics }) {
    const url = urlFor(chain);
    if (!url) throw new Error(`no RPC endpoint for chain ${chain} (set RPC_${chain})`);
    const filter = { address, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) };
    if (topics) filter.topics = topics;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [filter] });
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 15000) + Math.floor(Math.random() * 250);
        await new Promise((r) => setTimeout(r, backoff));
      }
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        const json = await res.json();
        if (json.error) { lastErr = new Error(`RPC error ${json.error.code}: ${json.error.message}`); continue; }
        return json.result || [];
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("rpcFetch exhausted retries");
  };
}

/** Load golden Part-4 samples from env.GOLDEN_SAMPLES (JSON array of
 * { chain, address, fromBlock, toBlock, topics?, expectTx?, minExpected?, label? }).
 * Empty when unset — main() then fails-closed for any required new chain (no sample = no proof). */
export function loadGoldenSamples(env = process.env) {
  if (!env.GOLDEN_SAMPLES) return [];
  try {
    const v = JSON.parse(env.GOLDEN_SAMPLES);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    throw new Error(`GOLDEN_SAMPLES is not valid JSON: ${e.message}`);
  }
}

/** Load the INDEPENDENT expected-chain completeness list from env.EXPECTED_CHAINS (JSON
 * array of chain ids). This is the source of truth for "which chains green MUST index" —
 * it must NOT be derived from green (green cannot self-attest completeness). Empty when
 * unset — main() then fails-closed in expansion mode (BLOCKING-1 closure). */
export function loadExpectedChains(env = process.env) {
  if (!env.EXPECTED_CHAINS) return [];
  try {
    const v = JSON.parse(env.EXPECTED_CHAINS);
    return Array.isArray(v) ? v.map(String) : [];
  } catch (e) {
    throw new Error(`EXPECTED_CHAINS is not valid JSON: ${e.message}`);
  }
}

// ── main() — live wiring. Builds snapshots from blue/green endpoints (env), runs the
// gate, writes the report, exits 0/non-zero. With only BLUE_* set it runs blue-vs-blue
// self-parity (trivially PASS). PROMOTION_MODE=expansion enables the non-lossy compare
// + Part-4 raw-L1 for new chains.
async function main() {
  const env = process.env;
  const blueUrl = env.BLUE_GRAPHQL_URL;
  const greenUrl = env.GREEN_GRAPHQL_URL || blueUrl; // self-parity when green unset
  const mode = env.PROMOTION_MODE === "expansion" ? "expansion" : "parity";
  if (!blueUrl) {
    console.error("[promotion-gate] BLUE_GRAPHQL_URL required (and GREEN_GRAPHQL_URL for a real promotion). Connection strings are env-sourced, never hardcoded (IMP-001).");
    process.exit(2);
  }
  const fetchSnapshot = makeFetchSnapshot(env);
  const [blue, green] = await Promise.all([fetchSnapshot(blueUrl), fetchSnapshot(greenUrl)]);
  const expectedChains = loadExpectedChains(env); // INDEPENDENT completeness list (not from green)
  const result = runGate(blue, green, { mode, expectedChains });

  // Part 4 (expansion only): raw-L1 ground-truth for the NEW chains. requiredChains is
  // derived from the INDEPENDENT expectedChains (NOT green's own chainMeta) so a silently
  // dropped chain still demands proof (BLOCKING-1). Without EXPECTED_CHAINS, fail-closed.
  if (mode === "expansion") {
    const blueChains = new Set(Object.keys(blue.chainMeta || {}));
    if (expectedChains.length === 0) {
      result.part4 = {
        pass: false,
        failures: ["EXPECTED_CHAINS not set — cannot verify green indexes all expected chains (fail-closed, BLOCKING-1)"],
        checks: [],
      };
    } else {
      const requiredChains = expectedChains.filter((c) => !blueChains.has(String(c)));
      const samples = loadGoldenSamples(env);
      result.part4 = await checkRawL1(samples, { rpcFetch: makeRpcFetch(env), requiredChains });
    }
    result.pass = result.pass && result.part4.pass;
  }

  const sprint = env.PROMOTION_SPRINT || "sprint-174";
  const dir = `grimoires/loa/a2a/${sprint}`;
  try { mkdirSync(dir, { recursive: true }); } catch {}
  writeFileSync(`${dir}/promotion-reconciliation.md`, renderReport(result, { blue: blueUrl, green: greenUrl }));
  console.error(`[promotion-gate] ${mode.toUpperCase()} ${result.pass ? "PASS" : "FAIL"} — report: ${dir}/promotion-reconciliation.md`);
  process.exit(result.pass ? 0 : 1);
}

// Run only when invoked directly (not when imported by the test harness).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[promotion-gate] ${e.message}`); process.exit(2); });
}
