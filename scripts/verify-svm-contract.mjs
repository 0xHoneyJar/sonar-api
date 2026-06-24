#!/usr/bin/env node
/**
 * verify-svm-contract.mjs — the SVM sibling of verify-belt-contract.mjs (same antibody, SVM seam).
 *
 * Introspects the LIVE GraphQL READ schema and asserts it still serves every SVM column that sonar's
 * consumers depend on (and that the SVM indexers' upserts must surface) — declared in scripts/svm-contract.json.
 * Producer-side: a column rename/removal or an untracked table fails CI here instead of returning empty
 * to a downstream reader.
 *
 * SCOPE (see svm-contract.json `_scope`): the gateway is read-only — no mutation_root / *_constraint
 * types are introspectable here. So this catches the COLUMN/type-drift sub-class (the loa-freeside#300
 * EVM class) but NOT the write-path on_conflict CONSTRAINT-NAME sub-class that bit PR #76 — that needs
 * a separate admin-endpoint introspection of <type>_constraint, or an offline DDL-bind. Don't over-read
 * a green here as "the indexer's upsert is safe"; it means "the read columns consumers select are intact".
 *
 * Two type statuses:
 *   - "live"             — hard contract. A drift (missing/typed-wrong/forbidden-present) FAILS (exit 1).
 *   - "pending-exposure" — declared by MERGED indexer code but not yet tracked/exposed on the live
 *                          schema. Surfaced as a LOUD warning (exit 0), so a merged-but-unreachable
 *                          pipe can't masquerade as "supported". When it appears + matches, the guard
 *                          nudges to promote it to "live".
 *
 * Origin: the SVM seam already hit this bug class — PR #76's last fix corrected an on_conflict
 * constraint name (svm_collection_nft_pkey → collection_nft_pkey) that would have failed the upsert.
 * That specific (constraint-name) instance is NOT caught here — see SCOPE. What IS caught: the read
 * column/type-drift class (a renamed/dropped column a consumer selects), and merged-but-unexposed types.
 *
 * Usage:  node scripts/verify-svm-contract.mjs [--endpoint URL] [--manifest PATH] [--json]
 * Exit:   0 = live contract holds (pending warnings allowed) · 1 = live drift · 2 = couldn't introspect
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const flagVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const endpointArg = flagVal('--endpoint');
const manifestPath = flagVal('--manifest');

const c = (code, s) => (asJson || !process.stdout.isTTY ? s : `\x1b[${code}m${s}\x1b[0m`);
const ok = (s) => c('32', s);
const bad = (s) => c('31', s);
const warn = (s) => c('33', s);
const dim = (s) => c('2', s);

const INTROSPECT_TIMEOUT_MS = 10_000;

async function introspectType(endpoint, typeName) {
  // 4 ofType hops: wrapping-complete to [scalar!]! depth (a triple-wrapped array column would
  // otherwise flatten to a null base name and false-positive a type-drift).
  const query = `query($n:String!){ __type(name:$n){ name fields{ name type{ name kind ofType{ name kind ofType{ name kind ofType{ name } } } } } } }`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTROSPECT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { n: typeName } }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`introspection HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const body = await res.json();
  if (body.errors) throw new Error(`introspection errors: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return body.data?.__type ?? null;
}

// flatten a GraphQL type ref down to its named scalar (NON_NULL/LIST unwrap)
const baseTypeName = (t) => (t?.name ?? baseTypeName(t?.ofType) ?? null);

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath ?? join(HERE, 'svm-contract.json'), 'utf8'));
  const endpoint = endpointArg || process.env[manifest.endpointEnv] || manifest.endpoint;

  const findings = []; // live-type, consumer-breaking -> exit 1
  const warnings = []; // pending-type observations -> exit 0, but loud
  const promotable = []; // pending types now exposed + matching -> nudge to promote

  for (const [typeName, spec] of Object.entries(manifest.types)) {
    const pending = (spec.status ?? 'live') !== 'live';
    let live;
    try {
      live = await introspectType(endpoint, typeName);
    } catch (e) {
      console.error(bad(`✗ could not introspect ${typeName} @ ${endpoint}: ${e.message}`));
      process.exit(2);
    }
    if (!live) {
      if (pending) {
        warnings.push({ type: typeName, kind: 'pending-absent', detail: spec.pendingNote ?? 'declared but not yet exposed on the live schema' });
      } else {
        findings.push({ type: typeName, kind: 'missing-type', field: '(type)', detail: `type ${typeName} not found on live schema (consumer: ${spec.consumer})` });
      }
      continue;
    }
    const liveFields = new Map(live.fields.map((f) => [f.name, baseTypeName(f.type)]));
    const bucket = pending ? warnings : findings;
    let gaps = 0;
    for (const [field, expectedType] of Object.entries(spec.requiredFields ?? {})) {
      if (!liveFields.has(field)) {
        bucket.push({ type: typeName, kind: 'missing', field, detail: `required field absent (consumer: ${spec.consumer})` });
        gaps++;
      } else if (expectedType && liveFields.get(field) !== expectedType) {
        bucket.push({ type: typeName, kind: 'type-drift', field, detail: `expected ${expectedType}, live serves ${liveFields.get(field)}` });
        gaps++;
      }
    }
    for (const field of spec.forbiddenFields ?? []) {
      if (liveFields.has(field)) bucket.push({ type: typeName, kind: 'forbidden-present', field, detail: 'a consumer might wrongly select this; assert it stays absent' });
    }
    if (pending && gaps === 0) promotable.push(typeName);
  }

  if (asJson) {
    console.log(JSON.stringify({ endpoint, ok: findings.length === 0, findings, warnings, promotable }, null, 2));
    process.exit(findings.length === 0 ? 0 : 1);
  }

  console.log(`\n  svm live-contract guard · ${dim(endpoint)}`);
  for (const w of warnings) {
    if (w.kind === 'pending-absent') {
      console.log(warn(`  ⚠ ${w.type} — DECLARED (merged indexer) but NOT exposed: data is not consumer-readable`));
      console.log(dim(`    ${w.detail}`));
    } else {
      console.log(warn(`  ⚠ ${w.type}.${w.field} [${w.kind}] — ${w.detail}`));
    }
  }
  for (const t of promotable) {
    console.log(warn(`  ⚠ ${t} is NOW exposed and matches its declared contract — promote it to status:"live" in svm-contract.json so future drift hard-fails CI.`));
  }
  const liveTypes = Object.entries(manifest.types).filter(([, s]) => (s.status ?? 'live') === 'live');
  const checked = liveTypes.flatMap(([t, s]) => [...Object.keys(s.requiredFields ?? {}), ...(s.forbiddenFields ?? [])].map((f) => `${t}.${f}`));
  if (findings.length === 0) {
    const tail = warnings.length ? `  ${warn(`(${warnings.length} pending warning(s) above)`)}` : '';
    console.log(ok(`  ✓ live contract holds — ${checked.length} field assertions across ${liveTypes.length} live type(s)`) + tail);
    console.log(dim(`    consumers can rely on the live SVM wire matching what the indexers were built against.`));
    process.exit(0);
  }
  console.log(bad(`  ✗ SVM CONTRACT DRIFT — ${findings.length} consumer-breaking change(s):`));
  for (const f of findings) console.log(bad(`    • ${f.type}.${f.field} [${f.kind}] — ${f.detail}`));
  console.log(dim(`\n    A downstream consumer (or the indexer's own upsert) built against the declared contract will break.\n    Fix the producer (sonar) or update scripts/svm-contract.json + every consumer in lockstep BEFORE this ships.`));
  process.exit(1);
}

main().catch((e) => {
  console.error(`verify-svm-contract: ${e.message}`);
  process.exit(2);
});
