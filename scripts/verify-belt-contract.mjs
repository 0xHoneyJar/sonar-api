#!/usr/bin/env node
/**
 * verify-belt-contract.mjs — the antibody for the "built-against-an-assumed-schema" bug class.
 *
 * Introspects the LIVE belt-gateway GraphQL schema and asserts it still serves every field that
 * sonar's consumers depend on (declared in scripts/belt-contract.json) — and does NOT serve fields
 * a consumer might wrongly assume exist (forbiddenFields, e.g. logIndex/txHash/value). Producer-side:
 * sonar promises a contract; this proves the live wire still keeps it, so a field rename/removal
 * fails CI here instead of 400'ing a downstream consumer in production.
 *
 * Origin: loa-freeside shadow-audit (#296) shipped a query selecting logIndex/txHash/value that the
 * live Transfer type never exposed → HTTP 400 on the first page → no audit could run (fixed in
 * loa-freeside#300, 2026-06-23). This guard makes that class impossible to re-introduce silently.
 *
 * Usage:  node scripts/verify-belt-contract.mjs [--endpoint URL] [--json]
 * Exit:   0 = contract holds · 1 = drift (consumer-breaking) · 2 = couldn't reach/introspect
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
const dim = (s) => c('2', s);

async function introspectType(endpoint, typeName) {
  const query = `query($n:String!){ __type(name:$n){ name fields{ name type{ name kind ofType{ name kind ofType{ name } } } } } }`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { n: typeName } }),
  });
  if (!res.ok) throw new Error(`introspection HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const body = await res.json();
  if (body.errors) throw new Error(`introspection errors: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return body.data?.__type ?? null;
}

// flatten a GraphQL type ref down to its named scalar (NON_NULL/LIST unwrap)
const baseTypeName = (t) => (t?.name ?? baseTypeName(t?.ofType) ?? null);

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath ?? join(HERE, 'belt-contract.json'), 'utf8'));
  const endpoint = endpointArg || process.env[manifest.endpointEnv] || manifest.endpoint;

  const findings = []; // {type, kind: 'missing'|'type-drift'|'forbidden-present', field, detail}
  for (const [typeName, spec] of Object.entries(manifest.types)) {
    let live;
    try {
      live = await introspectType(endpoint, typeName);
    } catch (e) {
      console.error(bad(`✗ could not introspect ${typeName} @ ${endpoint}: ${e.message}`));
      process.exit(2);
    }
    if (!live) {
      findings.push({ type: typeName, kind: 'missing-type', field: '(type)', detail: `type ${typeName} not found on live schema` });
      continue;
    }
    const liveFields = new Map(live.fields.map((f) => [f.name, baseTypeName(f.type)]));
    for (const [field, expectedType] of Object.entries(spec.requiredFields ?? {})) {
      if (!liveFields.has(field)) {
        findings.push({ type: typeName, kind: 'missing', field, detail: `required field absent (consumer: ${spec.consumer})` });
      } else if (expectedType && liveFields.get(field) !== expectedType) {
        findings.push({ type: typeName, kind: 'type-drift', field, detail: `expected ${expectedType}, live serves ${liveFields.get(field)}` });
      }
    }
    for (const field of spec.forbiddenFields ?? []) {
      if (liveFields.has(field)) {
        findings.push({ type: typeName, kind: 'forbidden-present', field, detail: `a consumer might wrongly select this; assert it stays absent (it once didn't exist, and a consumer assumed it did)` });
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ endpoint, ok: findings.length === 0, findings }, null, 2));
    process.exit(findings.length === 0 ? 0 : 1);
  }

  console.log(`\n  belt-gateway live-contract guard · ${dim(endpoint)}`);
  const checked = Object.entries(manifest.types).flatMap(([t, s]) =>
    [...Object.keys(s.requiredFields ?? {}), ...(s.forbiddenFields ?? [])].map((f) => `${t}.${f}`),
  );
  if (findings.length === 0) {
    console.log(ok(`  ✓ contract holds — ${checked.length} field assertions across ${Object.keys(manifest.types).length} type(s)`));
    console.log(dim(`    consumers (e.g. loa-freeside shadow-audit) can rely on the live wire matching what they were built against.`));
    process.exit(0);
  }
  console.log(bad(`  ✗ CONTRACT DRIFT — ${findings.length} consumer-breaking change(s):`));
  for (const f of findings) console.log(bad(`    • ${f.type}.${f.field} [${f.kind}] — ${f.detail}`));
  console.log(dim(`\n    A downstream consumer built against the declared contract will break. Fix the producer (sonar)\n    or update scripts/belt-contract.json + every consumer in lockstep BEFORE this ships.`));
  process.exit(1);
}

main().catch((e) => {
  console.error(`verify-belt-contract: ${e.message}`);
  process.exit(2);
});
