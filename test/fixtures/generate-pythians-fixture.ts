#!/usr/bin/env tsx
/**
 * generate-pythians-fixture.ts — one-time generator for the §4.5 gate frozen reference set.
 *
 * Reads pythians collection events from the live DB and writes a committed fixture file.
 * NOT a test — excluded from the vitest suite (not *.test.ts).
 *
 * Usage:
 *   SQD_GATE_DB_URL=postgres://... tsx test/fixtures/generate-pythians-fixture.ts
 *
 * SHA256 canonicalization algorithm (MUST match T-3 gate verification):
 *   1. Sort event_ids lexicographically: JS .sort() — Unicode code point order.
 *   2. Serialize as compact JSON array: JSON.stringify(sorted_ids) — no trailing newline,
 *      no extra whitespace.
 *   3. SHA256 of the UTF-8 bytes of that string.
 */
import { Client } from "pg";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const COLLECTION_KEY = "pythians";

const DB_URL = process.env.SQD_GATE_DB_URL;
if (!DB_URL) {
  console.error("[generate-pythians-fixture] SQD_GATE_DB_URL is not set. Exiting.");
  process.exit(1);
}

const client = new Client({ connectionString: DB_URL });

try {
  await client.connect();

  // Query DISTINCT event IDs and slots, excluding sqd-stream source to match production
  // seenMints initialization (see T-2 seenMints rule).
  const res = await client.query<{ id: string; slot: number }>(
    `SELECT DISTINCT id, slot
     FROM svm.collection_event
     WHERE collection_key = $1
       AND source != 'sqd-stream'
     ORDER BY id`,
    [COLLECTION_KEY],
  );

  const rows = res.rows;
  const eventIds = rows.map((r) => r.id);
  const slots = rows.map((r) => Number(r.slot));
  const fromSlot = Math.min(...slots);
  const toSlot = Math.max(...slots);

  // SHA256 canonicalization: sort lexicographically → compact JSON → SHA256(UTF-8)
  const sorted = [...eventIds].sort();
  const canonical = JSON.stringify(sorted);
  const sha256 = createHash("sha256").update(canonical, "utf8").digest("hex");

  const fixture = {
    collection_key: COLLECTION_KEY,
    event_count: eventIds.length,
    slot_range: { from: fromSlot, to: toSlot },
    created_at: new Date().toISOString(),
    sha256,
    event_ids: sorted,
  };

  const outPath = join(fileURLToPath(new URL(".", import.meta.url)), "pythians-gate-snapshot.json");
  writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n", "utf8");

  console.log(`[generate-pythians-fixture] wrote ${eventIds.length} events → ${outPath}`);
  console.log(`[generate-pythians-fixture] sha256=${sha256}`);
  console.log(`[generate-pythians-fixture] slot_range=${fromSlot}..${toSlot}`);
} finally {
  await client.end();
}
