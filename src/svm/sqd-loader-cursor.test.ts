/**
 * DISS-001 Regression Test — cursor-skip defect in runSqdLoader.
 *
 * Bug: `stats.lastSlot` is shared and accumulates across all chunks.  When chunk 0
 * completes at slot 1000 and chunk 1 subsequently advances `stats.lastSlot` to 2000
 * before the cap fires, `Object.assign(result, stats)` produces `result.lastSlot=2000`.
 * On the next resume, `fetchCursorSlot` (DB MAX) returns 2000, so chunk 0's mints skip
 * slots 1001–2000 entirely.
 *
 * Fix (T2): accumulate per-chunk `lastSlot` snapshots in `completedChunkSlots[]`,
 * then compute `safeSlot = Math.min(...completedChunkSlots)` as the return value.
 *
 * PRE-FIX: the "pre-fix: red" test FAILS because `result.lastSlot` would be the MAX
 * across all chunks (2000), not the MIN (1000).
 * POST-FIX: all tests in this file pass green.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSqdLoader, type SqdLoaderDeps, type SqdLoaderResult } from "./sqd-loader.js";
import { type SqdClient, MINT_CHUNK } from "./sqd-client.js";
import type { SqdBlock } from "./sqd-collection-event-source.js";

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
      yield [makeBlock(slot0)];
    } else {
      // chunk 1: advances lastSlot past slot0 → THEN fires cap
      // Pre-fix: result.lastSlot = slot1 (wrong, inflates cursor)
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

describe("DISS-001 — cursor-skip regression (src/svm colocated)", () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * Pre-fix RED: result.lastSlot = 2000 (chunk 1 overwrote stats.lastSlot via shared max)
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

  it("stoppedAtCap is true — chunk 2 would have run but didn't fire", async () => {
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
    // stream called twice: chunk 0 completed, chunk 1 fired cap
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

  it("dry-run: no cursor write occurs regardless of safeSlot value", async () => {
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

    // dry-run: neither upsert nor syncStatus should be called
    expect(upsertMock).not.toHaveBeenCalled();
    expect(syncStatusMock).not.toHaveBeenCalled();
  });

  it("invariant guard: zero completed chunks (stream yields nothing) throws INVARIANT VIOLATION", async () => {
    // Stream yields no blocks — chunkYielded stays false, completedChunkSlots stays empty
    const streamMock = vi.fn(async function* () {
      // intentionally yields nothing
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
