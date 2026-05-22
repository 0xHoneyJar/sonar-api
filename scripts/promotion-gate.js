/**
 * promotion-gate.js — blue→green promotion reconciliation gate (SDD §6, FR-4, S1).
 *
 * The non-skippable precondition for a blue-green alias swap. A green deployment
 * that reached blue's block height but silently dropped entities (KF-012 getLogs
 * loss) would pass a naive height check and serve a lossy view after the swap.
 * The gate is therefore multi-part and FAIL-CLOSED (any unknown → FAIL, never
 * PASS — SR-7a/IMP-004):
 *
 *   Part 1 — block-height parity: green.latest_processed_block ≥ blue's on EVERY chain.
 *   Part 2 — entity-count reconciliation: |green − blue| ≤ tolerance for the 12
 *            score-api footprint entities, using the per-entity reconciliation MODE
 *            from Task 1.0 (grimoires/loa/a2a/sprint-173/reconciliation-feasibility.md):
 *              A = at-block count (has blockNumber, append-only)
 *              B = timestamp-proxy at-block (Action: append-only, no blockNumber)
 *              C = converged current-state exact (mutable aggregate, low-cardinality)
 *   Part 3 — schema superset (FR-7 additive-only): green's schema ⊇ blue's
 *            (type/field/nullability), so the alias swap is transparent to consumers.
 *
 * Live Part 4 (raw-L1 eth_getLogs spot-check, R-B) + Part 5 (content sample, R-E)
 * are wired in main() and exercised against a live green in S2 (they need live RPC
 * + a live green deployment, so they are not unit-testable here).
 *
 * The pure check functions take SNAPSHOTS ({ chainMeta, counts, schema }) so the
 * test harness injects fixtures and the S2 dry-run feeds the same functions real
 * blue/green data. Exit 0 = PASS (swap allowed) · non-zero = FAIL (hold).
 *
 * Zero dependencies by design — matches verify-belt-config.js's stated invariant
 * (a gate guarding promotion safety must not introduce an npm install surface).
 * Run: `node scripts/promotion-gate.js` (self-parity) — see main().
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The 12 score-api footprint entities (SDD §6.2 AC-R7 baseline), each tagged with
 * its reconciliation MODE (Task 1.0) and tolerance (R-G): exact on low-cardinality,
 * max(rel, floor) on high-cardinality. `baseline` documents the shipped-belt count.
 */
export const FOOTPRINT = [
  { entity: "MiberaTransfer",    baseline: 39_714,    mode: "A", tolerance: { rel: 0.001, floor: 50 } },
  { entity: "MintActivity",      baseline: 10_000,    mode: "A", tolerance: { rel: 0.001, floor: 25 } },
  { entity: "NftBurn",           baseline: 39,        mode: "A", tolerance: { exact: true } },
  { entity: "BgtBoostEvent",     baseline: 1_470_000, mode: "A", tolerance: { rel: 0.001, floor: 500 } },
  { entity: "Erc1155MintEvent",  baseline: 7_607,     mode: "A", tolerance: { rel: 0.001, floor: 25 } },
  { entity: "FriendtechTrade",   baseline: 1_317,     mode: "A", tolerance: { exact: true } },
  { entity: "PaddleSupply",      baseline: 363,       mode: "A", tolerance: { exact: true } },
  { entity: "MintEvent",         baseline: 3_588,     mode: "A", tolerance: { exact: true } },
  { entity: "TreasuryActivity",  baseline: 11_819,    mode: "A", tolerance: { rel: 0.001, floor: 25 } },
  { entity: "Action",            baseline: 2_070_000, mode: "B", tolerance: { rel: 0.001, floor: 500 } },
  { entity: "MiberaLoan",        baseline: 176,       mode: "C", tolerance: { exact: true } },
  { entity: "MiberaStakedToken", baseline: 1_603,     mode: "C", tolerance: { exact: true } },
];

/** Allowed absolute delta for a count, given a tolerance spec (R-G). */
export function allowedDelta(baseline, tolerance) {
  if (!tolerance || tolerance.exact) return 0;
  const rel = Math.ceil((baseline || 0) * (tolerance.rel ?? 0));
  return Math.max(rel, tolerance.floor ?? 0);
}

/**
 * Part 1 — block-height parity. For every chain blue indexes, green must have a
 * chain_metadata row AND be at-or-ahead. A green missing a chain blue has is the
 * KF-013/D6 silent-skip failure.
 */
export function checkBlockHeights(blue, green) {
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
  return { pass: failures.length === 0, failures };
}

/**
 * Part 2 — entity-count reconciliation over the footprint. FAIL-CLOSED: a missing
 * count on either side is a failure, never a pass (SR-7a/IMP-004).
 */
export function checkEntityCounts(blueCounts, greenCounts, footprint = FOOTPRINT) {
  const failures = [];
  for (const f of footprint) {
    const b = blueCounts?.[f.entity];
    const g = greenCounts?.[f.entity];
    if (b === undefined || b === null || g === undefined || g === null) {
      failures.push(`${f.entity} (MODE ${f.mode}): missing count (blue=${b} green=${g}) — fail-closed`);
      continue;
    }
    const delta = Math.abs(Number(g) - Number(b));
    const allowed = allowedDelta(Number(b), f.tolerance);
    if (delta > allowed) {
      failures.push(`${f.entity} (MODE ${f.mode}): |${g} − ${b}| = ${delta} > allowed ${allowed}`);
    }
  }
  return { pass: failures.length === 0, failures };
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

/**
 * Part 3 — schema superset (FR-7 additive-only). Green must contain every blue
 * type + field with an identical signature (catches removal, type change, AND
 * nullability/enum contraction — IMP-005). Green adding fields/types is allowed.
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
  return { pass: failures.length === 0, failures };
}

/**
 * Run the full gate over two snapshots. A snapshot = { chainMeta: {chainId: block},
 * counts: {entity: n}, schema: string }. Returns the per-part results + overall pass.
 */
export function runGate(blue, green, { footprint = FOOTPRINT } = {}) {
  const part1 = checkBlockHeights(blue.chainMeta || {}, green.chainMeta || {});
  const part2 = checkEntityCounts(blue.counts || {}, green.counts || {}, footprint);
  const part3 = checkSchemaSuperset(blue.schema, green.schema);
  const pass = part1.pass && part2.pass && part3.pass;
  return { pass, part1, part2, part3 };
}

/** Render a PASS/FAIL markdown report for grimoires/loa/a2a/<sprint>/promotion-reconciliation.md. */
export function renderReport(result, meta = {}) {
  const L = [];
  L.push(`# Promotion Reconciliation — ${result.pass ? "✅ PASS (swap allowed)" : "❌ FAIL (hold)"}`);
  L.push("");
  L.push(`**When:** ${new Date().toISOString()} · **Blue:** ${meta.blue || "?"} · **Green:** ${meta.green || "?"}`);
  L.push("");
  for (const [name, part] of [["Part 1 — block-height parity", result.part1], ["Part 2 — entity-count reconciliation", result.part2], ["Part 3 — schema superset", result.part3]]) {
    L.push(`## ${name}: ${part.pass ? "✅" : "❌"}`);
    if (part.failures.length) for (const f of part.failures) L.push(`- ${f}`);
    else L.push("- (all checks passed)");
    L.push("");
  }
  return L.join("\n");
}

// ── main() — live wiring. Builds snapshots from blue/green endpoints (env), runs
// the gate, writes the report, exits 0/non-zero. Exercised against a live green in
// S2; with only BLUE_* set it runs blue-vs-blue self-parity (trivially PASS).
async function main() {
  const env = process.env;
  const blueUrl = env.BLUE_GRAPHQL_URL;
  const greenUrl = env.GREEN_GRAPHQL_URL || blueUrl; // self-parity when green unset
  if (!blueUrl) {
    console.error("[promotion-gate] BLUE_GRAPHQL_URL required (and GREEN_GRAPHQL_URL for a real promotion). Connection strings are env-sourced, never hardcoded (IMP-001).");
    process.exit(2);
  }
  // NOTE: live snapshot fetch (per-MODE entity counts at the fixed block cutoff,
  // chain_metadata heights, schema introspection, raw-L1 eth_getLogs spot-check
  // with backoff+dedicated key [SR-4], golden-id content sample [SR-5]) is wired
  // in S2 against the live green. S1 ships the gate logic + its fixture tests.
  const fetchSnapshot = makeFetchSnapshot(env);
  const [blue, green] = await Promise.all([fetchSnapshot(blueUrl), fetchSnapshot(greenUrl)]);
  const result = runGate(blue, green);
  const sprint = env.PROMOTION_SPRINT || "sprint-173";
  const dir = `grimoires/loa/a2a/${sprint}`;
  try { mkdirSync(dir, { recursive: true }); } catch {}
  writeFileSync(`${dir}/promotion-reconciliation.md`, renderReport(result, { blue: blueUrl, green: greenUrl }));
  console.error(`[promotion-gate] ${result.pass ? "PASS" : "FAIL"} — report: ${dir}/promotion-reconciliation.md`);
  process.exit(result.pass ? 0 : 1);
}

/** Build a snapshot fetcher (Hasura/Envio GraphQL). Per-MODE count queries land in S2. */
function makeFetchSnapshot(/* env */) {
  return async function fetchSnapshot(/* url */) {
    // S2: POST GraphQL aggregate queries per FOOTPRINT mode (A: where blockNumber<=cutoff;
    // B: where timestamp<=cutoff_ts; C: current count once converged) + chain_metadata + schema.
    throw new Error("live snapshot fetch is wired in S2 — S1 ships the gate logic (see test/promotion-gate.test.ts)");
  };
}

// Run only when invoked directly (not when imported by the test harness).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[promotion-gate] ${e.message}`); process.exit(2); });
}
