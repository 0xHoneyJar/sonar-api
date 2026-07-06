/**
 * T-3: §4.5 Gate Integration Test — loads the committed pythians fixture, verifies SHA256,
 * pre-seeds seenMints, streams SQD blocks for the fixture's slot_range, decodes events,
 * computes match_rate, and asserts ≥ 0.99 with ≤ 300 divergences.
 *
 * Skip condition: fixture is absent AND SQD_GATE_DB_URL is unset.
 * With the committed synthetic fixture (event_count=0, slot_range={from:0,to:0}):
 *   - SHA256 verified against "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
 *   - No SQD streaming (from >= to → empty range)
 *   - match_rate = 1.0 (vacuous: 0 reference events, 0 divergences)
 *   - Result: PASS
 *
 * Run: pnpm test:gate
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqdClient } from "../src/svm/sqd-client";
import { decodeSqdBlocks } from "../src/svm/sqd-collection-event-source";
import { eventId } from "../src/svm/collection-event-writer";
import { resolveCollection } from "../src/svm/collection-registry";

const FIXTURE_PATH = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/pythians-gate-snapshot.json");

interface GateFixture {
  collection_key: string;
  event_count: number;
  slot_range: { from: number; to: number };
  created_at: string;
  sha256: string;
  event_ids: string[];
}

/** SHA256 canonicalization (MUST match generate-pythians-fixture.ts):
 *   Sort event_ids lexicographically → JSON.stringify(sorted) → SHA256(UTF-8). */
function computeFixtureHash(eventIds: string[]): string {
  const sorted = [...eventIds].sort();
  const canonical = JSON.stringify(sorted);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * §4.5 gate floor (DISS-003): the pythians reference reconciliation is 30,006 events.
 * Any fixture below this floor cannot represent the real snapshot — the gate must
 * refuse to run against it rather than pass vacuously.
 */
const GATE_MIN_EVENTS = 30_000;

describe("§4.5 gate integration", () => {
  it("passes match_rate ≥ 0.99 against the committed pythians fixture", async (ctx) => {
    // ── Load fixture ──────────────────────────────────────────────────────────
    if (!existsSync(FIXTURE_PATH)) {
      if (!process.env.SQD_GATE_DB_URL) {
        ctx.skip();
        return;
      }
      throw new Error("[FIXTURE-MISSING] pythians-gate-snapshot.json absent and SQD_GATE_DB_URL set — run generate-pythians-fixture.ts first");
    }

    const fixture: GateFixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

    // ── SHA256 verification (runs before any SQD streaming) ──────────────────
    const computedHash = computeFixtureHash(fixture.event_ids);
    if (computedHash !== fixture.sha256) {
      throw new Error(`[FIXTURE-TAMPERED] SHA256 mismatch: expected ${fixture.sha256}, got ${computedHash}`);
    }

    // ── Vacuous-fixture guard (DISS-003, sprint-bug-173) ─────────────────────
    // A zero-event (or suspiciously small) fixture makes the reconciliation below
    // pass by definition — a fake-green §4.5 gate. The gate is only meaningful
    // against the real pythians snapshot (30,006 events per §4.5). In CI this
    // hard-fails; locally it skips with an explicit BLOCKED marker, never PASS.
    if (fixture.event_count < GATE_MIN_EVENTS) {
      const msg =
        `[GATE-BLOCKED] pythians fixture has event_count=${fixture.event_count} < ${GATE_MIN_EVENTS} — ` +
        `§4.5 requires the real 30,006-event snapshot. ` +
        `Regenerate via scripts/generate-pythians-fixture.ts against SQD_GATE_DB_URL.`;
      if (process.env.CI) throw new Error(msg);
      console.warn(msg);
      ctx.skip();
      return;
    }

    // ── Pre-seed seenMints from fixture event IDs ────────────────────────────
    // Mirrors production runSqdLoader initialization: pre-seeded from ALL sources
    // so post-resume first-appearances don't masquerade as mints.
    const seenMints = new Set<string>();
    for (const id of fixture.event_ids) {
      const mint = id.split(":")[1];
      if (mint) seenMints.add(mint);
    }

    // ── Stream SQD blocks for fixture.slot_range ─────────────────────────────
    const refIdSet = new Set(fixture.event_ids);
    const sqdDecodedIds = new Set<string>();
    let sqd_decoded_count = 0;

    const { from, to } = fixture.slot_range;
    if (from < to) {
      // Real fixture: stream blocks and decode
      const cfg = resolveCollection(fixture.collection_key);
      const client = new SqdClient(undefined, 5000);
      const stats = { requests: 0, blocks: 0, balanceRows: 0, stoppedAtCap: false, lastSlot: from };
      const memberSet = new Set<string>(); // populated from any event_id mints in the fixture

      // Reconstruct member set from fixture event IDs (all mints that appear in events)
      for (const id of fixture.event_ids) {
        const mint = id.split(":")[1];
        if (mint) memberSet.add(mint);
      }

      for await (const blocks of client.stream(Array.from(memberSet), from, to, stats)) {
        const { events } = decodeSqdBlocks(blocks, memberSet, seenMints);
        for (const e of events) {
          sqdDecodedIds.add(eventId(e));
        }
      }
      sqd_decoded_count = sqdDecodedIds.size;
    }
    // from >= to: empty slot range → no streaming, no decoded events

    // ── Compute reconciliation metrics ────────────────────────────────────────
    let matched = 0;
    for (const id of refIdSet) {
      if (sqdDecodedIds.has(id)) matched++;
    }
    // denominator > 0 guaranteed by the GATE_MIN_EVENTS guard above — the old
    // `denominator === 0 ? 1.0` vacuous branch was the DISS-003 fake-green path.
    const denominator = fixture.event_count;
    const match_rate = matched / denominator;
    const divergences = denominator - matched;

    // ── Emit structured JSON result ───────────────────────────────────────────
    const result = {
      fixture_count: fixture.event_count,
      sqd_decoded_count,
      matched,
      divergences: Math.max(0, divergences),
      match_rate,
      slot_range: fixture.slot_range,
      status: match_rate >= 0.99 && Math.max(0, divergences) <= 300 ? "PASS" : "FAIL",
    };
    console.log(JSON.stringify(result));

    // ── Assertions ────────────────────────────────────────────────────────────
    expect(match_rate, `match_rate=${match_rate} < 0.99`).toBeGreaterThanOrEqual(0.99);
    expect(Math.max(0, divergences), `divergences=${divergences} > 300`).toBeLessThanOrEqual(300);
  });
});
