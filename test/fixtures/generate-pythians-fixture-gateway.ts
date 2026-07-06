#!/usr/bin/env tsx
/**
 * generate-pythians-fixture-gateway.ts — bounded-range fixture generator, gateway mode
 * (sprint-bug-190 / bd-0vso / bd-3mvd).
 *
 * Why a v2: the DB-mode generator needs SQD_GATE_DB_URL (operator secret), and the full
 * pythians history spans 128M slots — infeasible for per-PR CI streaming (measured
 * ~340-800 slots/req on the SQD Portal → 160k-380k requests). This variant reads the
 * SAME rows through the public read-only belt gateway and emits a BOUNDED slot-range
 * fixture from the densest event window, plus `pre_range_mints` — the mints already
 * seen BEFORE the range start, which is the correct seenMints seed for range-bounded
 * reconciliation (seeding from in-range mints makes every in-range mint-kind event a
 * guaranteed false divergence).
 *
 * SHA256 canonicalization (MUST match generate-pythians-fixture.ts + the T-3 gate):
 *   sort event_ids lexicographically → JSON.stringify(sorted) → SHA256(UTF-8).
 *
 * Usage:
 *   tsx test/fixtures/generate-pythians-fixture-gateway.ts --from 303195983 --to 303255938
 *   [GATEWAY_URL=https://.../v1/graphql]  (defaults to the public belt gateway)
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const COLLECTION_KEY = "pythians";
const GATEWAY = (process.env.GATEWAY_URL ?? "https://belt-gateway-production.up.railway.app/v1/graphql").replace(/\/$/, "");

const argv = process.argv.slice(2);
const getArg = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fromSlot = Number(getArg("--from"));
const toSlot = Number(getArg("--to"));
if (!Number.isFinite(fromSlot) || !Number.isFinite(toSlot) || fromSlot >= toSlot) {
  console.error("[gateway-fixture] --from <slot> --to <slot> required (from < to)");
  process.exit(1);
}

async function gql<T>(query: string): Promise<T> {
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const d = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || d.errors) throw new Error(`gateway: ${JSON.stringify(d.errors ?? res.status).slice(0, 300)}`);
  return d.data as T;
}

// 1. In-range event ids (reference lanes only — exclude sqd-stream, matching the DB generator)
const eventIds: string[] = [];
let offset = 0;
for (;;) {
  const d = await gql<{ svm_collection_event: Array<{ id: string }> }>(
    `query { svm_collection_event(where: {collection_key: {_eq: "${COLLECTION_KEY}"}, source: {_neq: "sqd-stream"}, slot: {_gte: ${fromSlot}, _lte: ${toSlot}}}, order_by: {id: asc}, limit: 5000, offset: ${offset}) { id } }`,
  );
  const batch = d.svm_collection_event.map((r) => r.id);
  eventIds.push(...batch);
  if (batch.length < 5000) break;
  offset += 5000;
}

// 2. pre_range_mints: distinct mints with any reference-lane event BEFORE the range start.
//    This is the seenMints seed for the bounded gate — mints first appearing IN range
//    must be allowed to decode as mint-kind.
const preMints: string[] = [];
offset = 0;
for (;;) {
  const d = await gql<{ svm_collection_event: Array<{ nft_mint: string }> }>(
    `query { svm_collection_event(where: {collection_key: {_eq: "${COLLECTION_KEY}"}, source: {_neq: "sqd-stream"}, slot: {_lt: ${fromSlot}}}, distinct_on: nft_mint, order_by: {nft_mint: asc}, limit: 5000, offset: ${offset}) { nft_mint } }`,
  );
  const batch = d.svm_collection_event.map((r) => r.nft_mint);
  preMints.push(...batch);
  if (batch.length < 5000) break;
  offset += 5000;
}

const sorted = [...eventIds].sort();
const canonical = JSON.stringify(sorted);
const sha256 = createHash("sha256").update(canonical, "utf8").digest("hex");

const fixture = {
  collection_key: COLLECTION_KEY,
  event_count: sorted.length,
  slot_range: { from: fromSlot, to: toSlot },
  created_at: new Date().toISOString(),
  source_mode: "gateway-bounded",
  pre_range_mints: [...preMints].sort(),
  sha256,
  event_ids: sorted,
};

const outPath = join(fileURLToPath(new URL(".", import.meta.url)), "pythians-gate-snapshot.json");
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.log(`[gateway-fixture] wrote ${sorted.length} events, ${preMints.length} pre-range mints → ${outPath}`);
console.log(`[gateway-fixture] sha256=${sha256}`);
console.log(`[gateway-fixture] slot_range=${fromSlot}..${toSlot} (span ${toSlot - fromSlot})`);
