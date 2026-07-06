/**
 * DISS-001 Regression Test — cursor-skip defect in runSqdLoader.
 *
 * Bug: `stats.lastSlot` is shared and accumulates across all chunks.  When chunk 0
 * completes at slot 1000 and chunk 1 subsequently advances `stats.lastSlot` to 2000
 * before the cap fires, `Object.assign(result, stats)` produces `result.lastSlot=2000`.
 * On the next resume, `fetchCursorSlot` (DB MAX) returns 2000, so chunk 0's mints skip
 * slots 1001-2000 entirely.
 *
 * Fix (T2): accumulate per-chunk `lastSlot` snapshots in `completedChunkSlots[]`,
 * then compute `safeSlot = Math.min(...completedChunkSlots)` as the return value.
 *
 * PRE-FIX: tests marked "pre-fix: red" FAIL because `result.lastSlot` is the MAX
 * across all chunks (2000), not the MIN (1000).
 * POST-FIX: all tests in this file pass green.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSqdLoader, type SqdLoaderDeps, type SqdLoaderResult } from "../src/svm/sqd-loader";
import { type SqdClient, MINT_CHUNK } from "../src/svm/sqd-client";
import type { SqdBlock } from "../src/svm/sqd-collection-event-source";

const MINT_A = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w";

/** Build an array of N distinct fake mint addresses */
function makeMints(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `Mint${String(i).padStart(40, "0")}`);
}

/** Minimal SqdBlock with a controllable slot */
function makeBlock(slot: number): SqdBlock {
  return { header: { number: slot, timestamp: 1_000_000 }, transactions: [], tokenBalances: [] };
}

/**
 * The DISS-001 bug scenario:
 *   - chunk 0 (callCount=1): completes normally at slot `slot0`, NO cap
 *   - chunk 1 (callCount=2): advances stats.lastSlot to `slot1` (> slot0), THEN fires cap
 *
 * Pre-fix: result.lastSlot = slot1  (stats.lastSlot overwritten by chunk 1 → bug)
 * Post-fix: result.lastSlot = slot0 (min of completedChunkSlots → correct)
 */
function makeMultiChunkCapClient(slot0: number, slot1: number): SqdClient {
  let callCount = 0;

  const streamMock = vi.fn(async function* (
    _mints: readonly string[],
    _from: number,
    _to: number,
    stats: { requests: number; blocks: number; balanceRows: number; stoppedAtCap: boolean; lastSlot: number },
  ) {
    callCount++;
    if (callCount === 1) {
      // chunk 0: runs fully, sets lastSlot=slot0, does NOT fire cap
      stats.requests++;
      stats.blocks++;
      stats.lastSlot = slot0;
      // stoppedAtCap intentionally left false so chunk 1 starts
      yield [makeBlock(slot0)];
    } else {
      // chunk 1: advances lastSlot past slot0 → THEN fires cap
      // This overwrites stats.lastSlot; pre-fix result.lastSlot = slot1 (wrong)
      stats.requests++;
      stats.blocks++;
      stats.lastSlot = slot1;
      stats.stoppedAtCap = true;
      yield [makeBlock(slot1)];
    }
  });

  return {
    head: vi.fn().mockResolvedValue(500_000),
    currentHeight: vi.fn().mockResolvedValue(500_000),
    stream: streamMock,
    lastBlockReceivedAt: 0,
  } as unknown as SqdClient;
}

// Need > MINT_CHUNK mints to produce exactly 2 chunks
const MINTS = makeMints(MINT_CHUNK + 1);
const CHUNK_0_LAST_SLOT = 1000;
const CHUNK_1_LAST_SLOT = 2000; // chunk 1 fires cap here; cursor must NOT advance to 2000

describe("DISS-001 — cursor-skip regression", () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * Pre-fix RED: result.lastSlot = 2000 (chunk 1 overwrote stats.lastSlot)
   * Post-fix GREEN: result.lastSlot = 1000 (safeSlot = min(completedChunkSlots))
   */
  it("safeSlot equals min(completedChunkSlots) when chunk 1 fires cap at a higher slot (pre-fix: red)", async () => {
    const client = makeMultiChunkCapClient(CHUNK_0_LAST_SLOT, CHUNK_1_LAST_SLOT);
    const deps: SqdLoaderDeps = {
      client,
      members: vi.fn().mockResolvedValue(MINTS),
      cursorSlot: vi.fn().mockResolvedValue(0),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["upsert"],
      syncStatus: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["syncStatus"],
      log: () => {},
    };

    const result: SqdLoaderResult = await runSqdLoader(
      { collectionKey: "pythians", fromSlot: 0 },
      deps,
    );

    // The safe cursor must reflect the MINIMUM across completed chunks
    expect(result.lastSlot).toBe(CHUNK_0_LAST_SLOT);
    // Strict inequality: cursor must NOT have advanced to chunk-1's higher slot
    expect(result.lastSlot).toBeLessThan(CHUNK_1_LAST_SLOT);
  });

  it("stoppedAtCap is true — chunk 2 would have run next but didn't", async () => {
    const client = makeMultiChunkCapClient(CHUNK_0_LAST_SLOT, CHUNK_1_LAST_SLOT);
    const deps: SqdLoaderDeps = {
      client,
      members: vi.fn().mockResolvedValue(MINTS),
      cursorSlot: vi.fn().mockResolvedValue(0),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["upsert"],
      syncStatus: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["syncStatus"],
      log: () => {},
    };

    const result = await runSqdLoader({ collectionKey: "pythians", fromSlot: 0 }, deps);

    expect(result.stoppedAtCap).toBe(true);
    // stream was called twice: chunk 0 completed, chunk 1 fired cap
    expect((client.stream as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it("single-chunk path: safeSlot equals the one chunk's lastSlot (no regression)", async () => {
    const SINGLE_SLOT = 500;
    const streamMock = vi.fn(async function* (
      _mints: readonly string[],
      _from: number,
      _to: number,
      stats: { requests: number; blocks: number; balanceRows: number; stoppedAtCap: boolean; lastSlot: number },
    ) {
      stats.requests++;
      stats.blocks++;
      stats.lastSlot = SINGLE_SLOT;
      yield [makeBlock(SINGLE_SLOT)];
    });

    const client: SqdClient = {
      head: vi.fn().mockResolvedValue(500_000),
      currentHeight: vi.fn().mockResolvedValue(500_000),
      stream: streamMock,
      lastBlockReceivedAt: 0,
    } as unknown as SqdClient;

    const deps: SqdLoaderDeps = {
      client,
      members: vi.fn().mockResolvedValue([MINT_A]),
      cursorSlot: vi.fn().mockResolvedValue(0),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["upsert"],
      syncStatus: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["syncStatus"],
      log: () => {},
    };

    const result = await runSqdLoader({ collectionKey: "pythians", fromSlot: 0 }, deps);
    expect(result.lastSlot).toBe(SINGLE_SLOT);
  });

  it("dry-run: no cursor write occurs regardless of safeSlot", async () => {
    const client = makeMultiChunkCapClient(CHUNK_0_LAST_SLOT, CHUNK_1_LAST_SLOT);
    const syncStatusMock = vi.fn().mockResolvedValue(undefined);
    const upsertMock = vi.fn().mockResolvedValue(undefined);

    const deps: SqdLoaderDeps = {
      client,
      members: vi.fn().mockResolvedValue(MINTS),
      cursorSlot: vi.fn().mockResolvedValue(0),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: upsertMock as unknown as SqdLoaderDeps["upsert"],
      syncStatus: syncStatusMock as unknown as SqdLoaderDeps["syncStatus"],
      log: () => {},
    };

    await runSqdLoader({ collectionKey: "pythians", fromSlot: 0, dry: true }, deps);

    // dry-run: upsert and syncStatus must NOT be called
    expect(upsertMock).not.toHaveBeenCalled();
    expect(syncStatusMock).not.toHaveBeenCalled();
  });

  it("invariant guard: zero completed chunks (stream yields nothing) throws with INVARIANT VIOLATION", async () => {
    // Stream yields zero blocks for the chunk — completedChunkSlots stays empty post-fix
    const streamMock = vi.fn(async function* () {
      // yields nothing — no lastSlot advance
    });

    const client: SqdClient = {
      head: vi.fn().mockResolvedValue(500_000),
      currentHeight: vi.fn().mockResolvedValue(500_000),
      stream: streamMock,
      lastBlockReceivedAt: 0,
    } as unknown as SqdClient;

    const logs: string[] = [];
    const deps: SqdLoaderDeps = {
      client,
      members: vi.fn().mockResolvedValue([MINT_A]),
      cursorSlot: vi.fn().mockResolvedValue(0),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["upsert"],
      syncStatus: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["syncStatus"],
      log: (m) => logs.push(m),
    };

    await expect(
      runSqdLoader({ collectionKey: "pythians", fromSlot: 0 }, deps),
    ).rejects.toThrow(/INVARIANT VIOLATION/i);

    expect(logs.some((l) => l.includes("INVARIANT VIOLATION"))).toBe(true);
  });
});

/**
 * DISS-001-residual (bug 20260706-da7f05, sprint-bug-173) — early-cap cursor skip.
 *
 * Residual defect: safeSlot = min(completedChunkSlots) only covers chunks that RAN.
 * If the request cap fires in chunk 0 of a multi-chunk run, chunk 1 never runs and is
 * absent from completedChunkSlots — safeSlot advances to chunk 0's slot, permanently
 * skipping chunk 1's events in [from, safeSlot] on resume.
 *
 * Fix: when stoppedAtCap fires before ALL chunks ran, hold result.lastSlot at the
 * pre-run cursor `from` (no advance) and log the hold-back.
 */
describe("DISS-001-residual — early-cap must not advance cursor past never-run chunks", () => {
  afterEach(() => vi.restoreAllMocks());

  const FROM_SLOT = 1_000;
  const CHUNK_0_CAP_SLOT = 5_000;

  /** Cap fires in chunk 0; chunk 1 never runs. */
  function makeEarlyCapClient(): SqdClient {
    const streamMock = vi.fn(async function* (
      _mints: readonly string[],
      _from: number,
      _to: number,
      stats: { requests: number; blocks: number; balanceRows: number; stoppedAtCap: boolean; lastSlot: number },
    ) {
      // chunk 0: advances, then fires cap — loop breaks before chunk 1
      stats.requests++;
      stats.blocks++;
      stats.lastSlot = CHUNK_0_CAP_SLOT;
      stats.stoppedAtCap = true;
      yield [makeBlock(CHUNK_0_CAP_SLOT)];
    });
    return {
      head: vi.fn().mockResolvedValue(500_000),
      currentHeight: vi.fn().mockResolvedValue(500_000),
      stream: streamMock,
      lastBlockReceivedAt: 0,
    } as unknown as SqdClient;
  }

  it("holds lastSlot at pre-run `from` when cap fires before all chunks ran (pre-fix: red)", async () => {
    const client = makeEarlyCapClient();
    const logs: string[] = [];
    const deps: SqdLoaderDeps = {
      client,
      members: vi.fn().mockResolvedValue(MINTS), // 2 chunks
      cursorSlot: vi.fn().mockResolvedValue(FROM_SLOT),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["upsert"],
      syncStatus: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["syncStatus"],
      log: (m) => logs.push(m),
    };

    const result = await runSqdLoader({ collectionKey: "pythians" }, deps);

    expect(result.stoppedAtCap).toBe(true);
    // chunk 1 never ran — exactly one stream call
    expect(client.stream as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    // THE assertion: cursor must NOT advance past the pre-run cursor
    expect(result.lastSlot).toBe(FROM_SLOT);
    // and the hold-back must be loud
    expect(logs.some((l) => /holding cursor|held.*cursor|no advance/i.test(l))).toBe(true);
  });

  it("full run through all chunks still advances to min(completedChunkSlots) (no regression)", async () => {
    // both chunks run to completion, no cap → min path unchanged
    let call = 0;
    const streamMock = vi.fn(async function* (
      _mints: readonly string[],
      _from: number,
      _to: number,
      stats: { requests: number; blocks: number; balanceRows: number; stoppedAtCap: boolean; lastSlot: number },
    ) {
      call++;
      stats.requests++;
      stats.blocks++;
      stats.lastSlot = call === 1 ? 3_000 : 4_000;
      yield [makeBlock(stats.lastSlot)];
    });
    const client = {
      head: vi.fn().mockResolvedValue(500_000),
      currentHeight: vi.fn().mockResolvedValue(500_000),
      stream: streamMock,
      lastBlockReceivedAt: 0,
    } as unknown as SqdClient;

    const deps: SqdLoaderDeps = {
      client,
      members: vi.fn().mockResolvedValue(MINTS),
      cursorSlot: vi.fn().mockResolvedValue(FROM_SLOT),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["upsert"],
      syncStatus: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["syncStatus"],
      log: () => {},
    };

    const result = await runSqdLoader({ collectionKey: "pythians" }, deps);
    expect(result.stoppedAtCap).toBe(false);
    expect(result.lastSlot).toBe(3_000); // min(3000, 4000)
  });
});

/**
 * Review iter-1 (sprint-bug-173) — the two dissent blockers, verified end-to-end.
 *
 * DISS-002: cap firing on the FINAL chunk before its first yield left chunksRun ==
 * chunks.length, so the loader advanced to min over EARLIER chunks — skipping the
 * final chunk's entire range.
 *
 * DISS-001: result.lastSlot was not the production resume authority — fetchCursorSlot
 * read MAX(slot) of upserted rows. The durable cursor (sync_status.sqd_cursor_slot,
 * migration 004) is now written every non-dry run and preferred on resume. The
 * two-consecutive-runs test reproduces the production wiring shape: cursorSlot reads
 * what syncStatus wrote (durable), falling back to MAX(upserted slots) (legacy).
 */
describe("review iter-1 — final-chunk cap-without-yield + durable-cursor resume", () => {
  afterEach(() => vi.restoreAllMocks());

  const FROM_SLOT = 1_000;

  it("holds cursor when cap fires on the FINAL chunk before its first yield (pre-fix: red)", async () => {
    let call = 0;
    const streamMock = vi.fn(async function* (
      _mints: readonly string[],
      _from: number,
      _to: number,
      stats: { requests: number; blocks: number; balanceRows: number; stoppedAtCap: boolean; lastSlot: number },
    ) {
      call++;
      if (call === 1) {
        // chunk 0: completes normally with coverage to 5000
        stats.requests++;
        stats.blocks++;
        stats.lastSlot = 5_000;
        yield [makeBlock(5_000)];
      } else {
        // chunk 1 (FINAL): cap already exhausted — fires before ANY yield
        stats.stoppedAtCap = true;
        // yields nothing
      }
    });
    const client = {
      head: vi.fn().mockResolvedValue(500_000),
      currentHeight: vi.fn().mockResolvedValue(500_000),
      stream: streamMock,
      lastBlockReceivedAt: 0,
    } as unknown as SqdClient;

    const deps: SqdLoaderDeps = {
      client,
      members: vi.fn().mockResolvedValue(MINTS), // 2 chunks
      cursorSlot: vi.fn().mockResolvedValue(FROM_SLOT),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["upsert"],
      syncStatus: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["syncStatus"],
      log: () => {},
    };

    const result = await runSqdLoader({ collectionKey: "pythians" }, deps);
    expect(result.stoppedAtCap).toBe(true);
    expect(client.stream as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2);
    // Final chunk produced ZERO coverage — cursor must hold, not advance to 5000
    expect(result.lastSlot).toBe(FROM_SLOT);
  });

  it("two consecutive runs: run 2 resumes from run 1's HELD durable cursor, not MAX(upserted slot)", async () => {
    // Production-shaped persistence: syncStatus writes the durable cursor; cursorSlot
    // prefers it, falling back to MAX(slot) of upserted rows (the legacy path that
    // caused DISS-001).
    let durableCursor: number | null = null;
    const upsertedSlots: number[] = [];
    const cursorSlotProd = async () =>
      durableCursor ?? (upsertedSlots.length ? Math.max(...upsertedSlots) : null);
    const syncStatusProd = vi.fn(async (patch: { sqdCursorSlot?: number }) => {
      if (patch.sqdCursorSlot !== undefined) durableCursor = patch.sqdCursorSlot;
      return true;
    });
    const upsertProd = vi.fn(async (events: Array<{ slot: number }>) => {
      for (const e of events) upsertedSlots.push(e.slot);
    });

    const fromSeen: number[] = [];
    let call = 0;
    const streamMock = vi.fn(async function* (
      _mints: readonly string[],
      from: number,
      _to: number,
      stats: { requests: number; blocks: number; balanceRows: number; stoppedAtCap: boolean; lastSlot: number },
    ) {
      call++;
      fromSeen.push(from);
      if (call === 1) {
        // RUN 1, chunk 0: upserts events at high slots, then cap fires → chunk 1 never runs
        stats.requests++;
        stats.blocks++;
        stats.lastSlot = 5_000;
        stats.stoppedAtCap = true;
        yield [makeBlock(5_000)];
      }
      // RUN 2 streams: yield nothing (we only care about the resume `from`)
      if (call === 2) stats.stoppedAtCap = true; // keep run 2 short: cap immediately, no yield
    });
    const client = {
      head: vi.fn().mockResolvedValue(500_000),
      currentHeight: vi.fn().mockResolvedValue(500_000),
      stream: streamMock,
      lastBlockReceivedAt: 0,
    } as unknown as SqdLoaderDeps["client"];

    const makeDeps = (): SqdLoaderDeps => ({
      client,
      members: vi.fn().mockResolvedValue(MINTS), // 2 chunks
      cursorSlot: cursorSlotProd,
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: upsertProd as unknown as SqdLoaderDeps["upsert"],
      syncStatus: syncStatusProd as unknown as SqdLoaderDeps["syncStatus"],
      log: () => {},
    });

    // RUN 1: starts at 0 (no cursor anywhere), caps early in chunk 0
    const run1 = await runSqdLoader({ collectionKey: "pythians" }, makeDeps());
    expect(run1.lastSlot).toBe(0); // held at pre-run from (0)
    expect(durableCursor).toBe(0); // durable cursor persisted despite cap
    // Seed the poison MAX directly: in production, run 1's chunk-0 events sit in the DB
    // at slot 5000 (synthetic blocks here decode to zero events, so emulate those rows).
    // Pre-fix, cursorSlotProd falls back to MAX(upserted)=5000 → the DISS-001 skip.
    upsertedSlots.push(5_000);

    // RUN 2: must resume from the durable cursor (0), NOT MAX(upserted)=5000
    await runSqdLoader({ collectionKey: "pythians" }, makeDeps());
    expect(fromSeen[1]).toBe(0); // ← THE DISS-001 assertion (pre-fix this was 5000)
  });
});

/**
 * Review iter-2 DISS-003: cursor persistence is a correctness write. writeSyncStatus is
 * fail-soft (returns false, never throws); a silently dropped cursor write makes the
 * next run resume from the poison MAX(slot). The loader must retry once, then fail LOUD.
 */
describe("review iter-2 — cursor write failure fails the run", () => {
  afterEach(() => vi.restoreAllMocks());

  function makeOkClient(): SqdClient {
    const streamMock = vi.fn(async function* (
      _m: readonly string[], _f: number, _t: number,
      stats: { requests: number; blocks: number; balanceRows: number; stoppedAtCap: boolean; lastSlot: number },
    ) {
      stats.requests++; stats.blocks++; stats.lastSlot = 700;
      yield [makeBlock(700)];
    });
    return { head: vi.fn().mockResolvedValue(500_000), currentHeight: vi.fn().mockResolvedValue(500_000), stream: streamMock, lastBlockReceivedAt: 0 } as unknown as SqdClient;
  }

  it("throws when the durable cursor write returns false twice", async () => {
    const syncStatus = vi.fn().mockResolvedValue(false);
    const deps: SqdLoaderDeps = {
      client: makeOkClient(),
      members: vi.fn().mockResolvedValue([MINT_A]),
      cursorSlot: vi.fn().mockResolvedValue(0),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["upsert"],
      syncStatus: syncStatus as unknown as SqdLoaderDeps["syncStatus"],
      log: () => {},
    };
    await expect(runSqdLoader({ collectionKey: "pythians", fromSlot: 0 }, deps)).rejects.toThrow(/CURSOR WRITE FAILED/);
    expect(syncStatus).toHaveBeenCalledTimes(2); // one retry
  });

  it("retry succeeding on attempt 2 completes the run", async () => {
    const syncStatus = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const deps: SqdLoaderDeps = {
      client: makeOkClient(),
      members: vi.fn().mockResolvedValue([MINT_A]),
      cursorSlot: vi.fn().mockResolvedValue(0),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["upsert"],
      syncStatus: syncStatus as unknown as SqdLoaderDeps["syncStatus"],
      log: () => {},
    };
    const result = await runSqdLoader({ collectionKey: "pythians", fromSlot: 0 }, deps);
    expect(result.lastSlot).toBe(700);
    expect(syncStatus).toHaveBeenCalledTimes(2);
  });
});
