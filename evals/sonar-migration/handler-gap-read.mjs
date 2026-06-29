#!/usr/bin/env node
// evals/sonar-migration/handler-gap-read.mjs
//
// Reader for the RLAI claim ledger (handler-gap-ledger.jsonl). Plain node, no effect runtime
// dep (JSONL is self-describing — matches the repo's jq-reader discipline, evals/README.md ADR-001).
//
//   node evals/sonar-migration/handler-gap-read.mjs                 # all cohorts
//   node evals/sonar-migration/handler-gap-read.mjs <cohort>        # filter to one cohort
//
// Rollup: verdict distribution · needs-action ranked (severity ⨯ confidence) · frozen-but-fine
// · uncertain · the B-1 learnings. The "map vs territory" delta is the headline.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER = resolve(__dirname, "handler-gap-ledger.jsonl");
const cohortFilter = process.argv[2] || null;
const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

let rows = [];
try {
  rows = readFileSync(LEDGER, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try { return JSON.parse(l); } catch { console.error(`  ⚠ skipped malformed line ${i + 1}`); return null; }
    })
    .filter(Boolean);
} catch {
  console.error(`no ledger yet at ${LEDGER} — run the b1-rlai workflow to populate it.`);
  process.exit(0);
}
if (cohortFilter) rows = rows.filter((r) => r.cohort === cohortFilter);

if (!rows.length) { console.log("(no rows)"); process.exit(0); }

const by = (k) => rows.reduce((a, r) => ((a[r[k]] = (a[r[k]] || 0) + 1), a), {});
const cohorts = [...new Set(rows.map((r) => r.cohort))];

console.log(`\n═══ RLAI claim ledger ${cohortFilter ? `· cohort=${cohortFilter}` : ""} ═══`);
console.log(`rows: ${rows.length} · cohorts: ${cohorts.join(", ")}`);
console.log(`verdicts:`, JSON.stringify(by("verdict")));
console.log(`severity:`, JSON.stringify(by("severity")));

const real = rows.filter((r) => r.verdict === "real")
  .sort((a, b) => (SEV_RANK[b.severity] - SEV_RANK[a.severity]) || ((b.confidence || 0) - (a.confidence || 0)));
const refuted = rows.filter((r) => r.verdict === "refuted");
const uncertain = rows.filter((r) => r.verdict === "uncertain");

console.log(`\n🔴 NEEDS ACTION (real gaps, territory ≠ map) — ${real.length}:`);
for (const r of real)
  console.log(`  [${r.severity} · ${((r.confidence || 0) * 100).toFixed(0)}%] ${r.subject} — ${r.recommended_action}\n      ↳ ${r.ground_truth}`);

console.log(`\n🟢 FROZEN-BUT-FINE (refuted — Sprint-M's "accept-frozen-only" held) — ${refuted.length}:`);
console.log(`  ${refuted.map((r) => r.subject).join(", ") || "(none)"}`);

if (uncertain.length) {
  console.log(`\n🟡 UNCERTAIN (territory inconclusive) — ${uncertain.length}:`);
  for (const r of uncertain) console.log(`  ${r.subject} — ${r.ground_truth}`);
}

console.log(`\n📚 B-1 LEARNINGS:`);
for (const r of rows) if (r.learning) console.log(`  • (${r.subject}) ${r.learning}`);
console.log("");
