/**
 * T-3: §4.5 Gate Integration Test — bounded-range reconciliation (sprint-bug-190).
 *
 * Loads the committed pythians fixture (BOUNDED slot range from the densest event
 * window — full history is 128M slots ≈ 160k-380k Portal requests, infeasible per-PR),
 * verifies SHA256, pre-seeds seenMints from `pre_range_mints` (mints seen BEFORE the
 * range start — seeding from in-range mints would make every in-range mint-kind event
 * a guaranteed false divergence), streams SQD blocks for the fixture's slot_range,
 * decodes, and reconciles.
 *
 * §4.5 semantics here are RANGE-COMPLETE decode reconciliation: every reference-lane
 * event in [from, to] must be reproduced by the SQD lane's decode over that range.
 * This is NOT an ownership-completeness claim (KF-018 doctrine: never derive
 * ownership completeness from windowed events).
 *
 * Vacuous-pass doctrine (DISS-003, sprint-bug-173) preserved: below-floor or
 * over-span fixtures hard-fail in CI and skip-as-BLOCKED locally — never PASS.
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
  source_mode?: string;
  pre_range_mints?: string[];
  sha256: string;
  event_ids: string[];
}

/** SHA256 canonicalization (MUST match both generators):
 *   Sort event_ids lexicographically → JSON.stringify(sorted) → SHA256(UTF-8). */
function computeFixtureHash(eventIds: string[]): string {
  const sorted = [...eventIds].sort();
  const canonical = JSON.stringify(sorted);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Bounded-gate floors (sprint-bug-190, evolving DISS-003):
 * - GATE_MIN_EVENTS: a fixture below this cannot be a meaningful reconciliation set —
 *   the committed densest-window fixture carries 1,767 events; anything under 1,500 is
 *   either the old zero-event stub or a degenerate regeneration. Hard-block.
 * - GATE_MAX_SPAN_SLOTS: CI feasibility ceiling (~200 Portal requests at measured
 *   2024-26 density). A fixture wider than this cannot finish in per-PR CI — block it
 *   loudly instead of timing out ambiguously.
 */
const GATE_MIN_EVENTS = 1_500;
const GATE_MAX_SPAN_SLOTS = 100_000;
/** Streaming ~60k slots ≈ 120 Portal requests — allow up to 5 minutes. */
const GATE_TIMEOUT_MS = 300_000;

describe("§4.5 gate integration (bounded range)", () => {
  it("reconciles SQD decode against the committed pythians reference window", { timeout: GATE_TIMEOUT_MS }, async (ctx) => {
    // ── Load fixture ──────────────────────────────────────────────────────────
    if (!existsSync(FIXTURE_PATH)) {
      if (!process.env.SQD_GATE_DB_URL) {
        ctx.skip();
        return;
      }
      throw new Error("[FIXTURE-MISSING] pythians-gate-snapshot.json absent — run test/fixtures/generate-pythians-fixture-gateway.ts");
    }

    const fixture: GateFixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

    // ── SHA256 verification (runs before any SQD streaming) ──────────────────
    const computedHash = computeFixtureHash(fixture.event_ids);
    if (computedHash !== fixture.sha256) {
      throw new Error(`[FIXTURE-TAMPERED] SHA256 mismatch: expected ${fixture.sha256}, got ${computedHash}`);
    }

    // ── Vacuous/degenerate-fixture guards (DISS-003 doctrine, bounded form) ──
    const span = fixture.slot_range.to - fixture.slot_range.from;
    let blocked: string | null = null;
    if (fixture.event_count < GATE_MIN_EVENTS) {
      blocked = `event_count=${fixture.event_count} < ${GATE_MIN_EVENTS} — degenerate or stub fixture`;
    } else if (span > GATE_MAX_SPAN_SLOTS) {
      blocked = `slot span ${span} > ${GATE_MAX_SPAN_SLOTS} — infeasible for per-PR CI streaming`;
    } else if (!Array.isArray(fixture.pre_range_mints)) {
      blocked = `fixture lacks pre_range_mints — bounded reconciliation requires the pre-range seenMints seed`;
    }
    if (blocked) {
      const msg = `[GATE-BLOCKED] ${blocked}. Regenerate via test/fixtures/generate-pythians-fixture-gateway.ts (densest window).`;
      if (process.env.CI) throw new Error(msg);
      console.warn(msg);
      ctx.skip();
      return;
    }

    // ── Pre-seed seenMints from PRE-RANGE mints only (sprint-bug-190 fix) ─────
    // Mirrors production resume: seenMints = mints known BEFORE the stream start.
    // Mints first appearing IN range must be free to decode as mint-kind — seeding
    // them here was the latent bug that guaranteed divergences on real fixtures.
    const seenMints = new Set<string>(fixture.pre_range_mints);

    // ── Stream SQD blocks for fixture.slot_range ─────────────────────────────
    const refIdSet = new Set(fixture.event_ids);
    const sqdDecodedIds = new Set<string>();

    const { from, to } = fixture.slot_range;
    const cfg = resolveCollection(fixture.collection_key);
    void cfg; // registry resolution validates the collection key exists
    const client = new SqdClient(undefined, 5000);
    const stats = { requests: 0, blocks: 0, balanceRows: 0, stoppedAtCap: false, lastSlot: from };

    // Member set = every mint that appears in the reference window (the stream filter);
    // pre-range mints are included so cross-window transfers of older tokens decode too.
    const memberSet = new Set<string>(fixture.pre_range_mints);
    for (const id of fixture.event_ids) {
      const mint = id.split(":")[1];
      if (mint) memberSet.add(mint);
    }

    let overshoot = 0; // decoded events past `to` — the client's final page overshoots the bound
    for await (const blocks of client.stream(Array.from(memberSet), from, to, stats)) {
      const { events } = decodeSqdBlocks(blocks, memberSet, seenMints);
      for (const e of events) {
        // Range-filter BEFORE comparison: the stream's last page can overshoot `to`
        // (observed live: an event 106 slots past the bound). Out-of-range events are
        // not part of the reference window — neither matches nor divergences.
        if (e.slot < from || e.slot > to) {
          overshoot++;
          continue;
        }
        sqdDecodedIds.add(eventId(e));
      }
    }
    const sqd_decoded_count = sqdDecodedIds.size;

    // ── Compute reconciliation metrics (TWO-SIDED, dissent iter-1) ────────────
    let matched = 0;
    for (const id of refIdSet) {
      if (sqdDecodedIds.has(id)) matched++;
    }
    // Unexpected: SQD-decoded IN-RANGE events absent from the reference set. A
    // reconciliation gate must fail on surplus too — a decoder inventing events is
    // as broken as one missing them.
    const unexpected = [...sqdDecodedIds].filter((id) => !refIdSet.has(id));
    // denominator > 0 guaranteed by GATE_MIN_EVENTS — the vacuous branch stays dead.
    const denominator = fixture.event_count;
    const match_rate = matched / denominator;
    const divergences = Math.max(0, denominator - matched);
    // Bounded threshold: 1% of the reference set (the old absolute 300 was calibrated
    // to a 30k-event history set — it would be 17% of a bounded window, far too loose).
    const maxDivergences = Math.ceil(0.01 * denominator);

    // ── Emit structured JSON result ───────────────────────────────────────────
    const result = {
      fixture_count: fixture.event_count,
      sqd_decoded_count,
      matched,
      divergences,
      unexpected_count: unexpected.length,
      overshoot_excluded: overshoot,
      match_rate,
      max_divergences: maxDivergences,
      slot_range: fixture.slot_range,
      requests: stats.requests,
      status: match_rate >= 0.99 && divergences <= maxDivergences && unexpected.length === 0 ? "PASS" : "FAIL",
    };
    console.log(JSON.stringify(result));
    if (unexpected.length > 0) console.log(JSON.stringify({ unexpected_sample: unexpected.slice(0, 5) }));

    // ── Assertions ────────────────────────────────────────────────────────────
    expect(match_rate, `match_rate=${match_rate} < 0.99`).toBeGreaterThanOrEqual(0.99);
    expect(divergences, `divergences=${divergences} > ${maxDivergences} (1% of ${denominator})`).toBeLessThanOrEqual(maxDivergences);
    expect(unexpected.length, `SQD decoded ${unexpected.length} in-range events absent from reference (sample logged)`).toBe(0);
  });
});
