/**
 * s5-parity-dryrun.ts — run the S5 consumer-parity gate (src/canonical/parity.ts) against two JSON
 * snapshots. INERT operational tooling for the score-mibera handshake: feed a canonical sample +
 * the consumer's current (tx,asset_ref,verb) tuples, get the parity report + a go/no-go exit code.
 * No network, no emit, no live dependency.
 *
 * Usage:  npx tsx scripts/s5-parity-dryrun.ts <canonical.json> <legacy.json>
 *   canonical.json = NftActivity[]            (what the producer emits — from map-evm / map-svm)
 *   legacy.json    = {tx,asset_ref,verb}[]    (the consumer's current fetcher output)
 *
 * Exit: 0 = parity holds (with real overlap) · 1 = parity FAILED or vacuous · 2 = usage/IO error.
 * NOTE: presence parity only (value-parity over `matched` is a separate handshake step — see parity.ts).
 */
import { readFileSync } from "node:fs";
import { parityReport, type ParityKey } from "../src/canonical/parity";
import type { NftActivity } from "@0xhoneyjar/events";

const TAG = "[s5-parity-dryrun]";

function die(msg: string): never {
  console.error(`${TAG} ${msg}`);
  process.exit(2);
}

const [canonicalPath, legacyPath] = process.argv.slice(2);
if (!canonicalPath || !legacyPath) {
  die("usage: npx tsx scripts/s5-parity-dryrun.ts <canonical.json> <legacy.json>");
}

function readArray(path: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    die(`cannot read/parse ${label} (${path}): ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) die(`${label} (${path}) must be a JSON array`);
  return parsed;
}

const canonical = readArray(canonicalPath, "canonical") as NftActivity[];
const legacy = readArray(legacyPath, "legacy") as ParityKey[];

const r = parityReport(canonical, legacy);

console.log(`${TAG} canonical=${r.canonicalCount} keys · legacy=${r.legacyCount} keys · matched=${r.matched.length}`);
console.log(`${TAG} canonicalOnly (producer extras): ${r.canonicalOnly.length} ${JSON.stringify(r.canonicalOnlyByVerb)}`);
console.log(`${TAG} legacyOnly (LOSSES): ${r.legacyOnly.length} ${JSON.stringify(r.legacyOnlyByVerb)}`);

if (r.verbDisagreements.length > 0) {
  console.log(`${TAG} ⚠ ${r.verbDisagreements.length} VERB DISAGREEMENT(S) — misclassified, read FIRST (not tolerable over-emits):`);
  for (const d of r.verbDisagreements) {
    console.log(`${TAG}   ${d.tx} asset ${d.asset_ref}: canonical=[${d.canonicalVerbs.join(",")}] vs legacy=[${d.legacyVerbs.join(",")}]`);
  }
}
console.log(`${TAG} valueParityChecked=${r.valueParityChecked} (presence axis only; field-value parity is a separate step)`);

if (!r.parityHolds) {
  console.error(`${TAG} ✗ PARITY FAILED — canonical lost ${r.legacyOnly.length} activit(ies) the consumer relies on. NOT cleared for go-live.`);
  process.exit(1);
}
if (r.matched.length === 0) {
  // MINOR-2: parityHolds is vacuous when legacy was empty / non-overlapping — a trustworthy GREEN needs real overlap.
  console.error(`${TAG} ⚠ parity holds but matched=0 — the legacy sample was empty or non-overlapping. A real go/no-go needs overlap. NOT cleared.`);
  process.exit(1);
}
console.log(`${TAG} ✓ parity holds — canonical covers all ${r.legacyCount} consumer activities (${r.matched.length} matched). Cleared on the presence axis.`);
process.exit(0);
