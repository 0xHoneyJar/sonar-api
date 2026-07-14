/**
 * sqd-parallel-loader.test.ts — colocated unit tests for the range-partitioned PARALLEL backfill.
 *
 * The load-bearing property is DECODE PARITY: runSqdParallelLoader parallelizes only the FETCH,
 * then decodes SEQUENTIALLY in ascending slot order — so it MUST produce byte-identical decode
 * output to the proven sequential runSqdLoader for the same input. decodeSqdBlocks is the REAL
 * decoder (never mocked here); only the network client is faked.
 *
 * Covers: partitionSlotRange invariants + edges, decode parity across partition boundaries
 * (early gaining-only mint stays `mint`, not `transfer`/ambiguous), concurrency=1 delegation,
 * conservative cursor (head on full coverage / held at `from` on cap), fetch-stats aggregation,
 * and the two entry guards.
 */
import { describe, expect, it, vi } from "vitest";
import { partitionSlotRange, runSqdParallelLoader } from "./sqd-parallel-loader.js";
import { runSqdLoader, type SqdLoaderDeps, type SqdLoaderResult } from "./sqd-loader.js";
import type { SqdClient, SqdStreamStats } from "./sqd-client.js";
import type { SqdBlock } from "./sqd-collection-event-source.js";
import type { CollectionEvent } from "./collection-event-source.js";

// ── base58 fixtures ──────────────────────────────────────────────────────────────
// Every mint/account/owner in a tokenBalance row is BASE58-validated by decodeSqdBlocks, so
// fixture addresses must be real base58 (alphabet below, no 0/O/I/l), length in [32,88].
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function addr(seed: string): string {
  let h = 2166136261 >>> 0; // FNV-1a seed → deterministic, distinct-per-seed, collision-free at 44 chars
  for (let i = 0; i < seed.length; i++) {
    h = (h ^ seed.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 44; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    out += B58[h % B58.length];
  }
  return out;
}

const NFT_A = addr("nft-a");
const NFT_B = addr("nft-b");
const OWNER1 = addr("owner-1");
const OWNER2 = addr("owner-2");
const OWNER3 = addr("owner-3");
const ATA_A1 = addr("ata-a1");
const ATA_A2 = addr("ata-a2");
const ATA_B1 = addr("ata-b1");
const SIG_MINT_A = addr("sig-mint-a");
const SIG_MINT_B = addr("sig-mint-b");
const SIG_XFER_A = addr("sig-xfer-a");

const BASE_TS = 1_700_000_000; // unix seconds; header.timestamp → CollectionEvent.blockTime
const FROM = 0;
const HEAD = 100;

// ── SqdBlock fixture builders ─────────────────────────────────────────────────────
// MINT = single gaining leg (pre=0→post=1), no losing leg → first-appearance rule classifies it
// `mint` ONLY if the NFT is unseen when decoded. TRANSFER = losing (pre=1→post=0) + gaining leg in
// the same tx. Owners are non-null on every leg so the null-owner ambiguity gate never fires.
function mintBlock(slot: number, mint: string, owner: string, ata: string, sig: string): SqdBlock {
  return {
    header: { number: slot, timestamp: BASE_TS + slot },
    transactions: [{ transactionIndex: 0, signatures: [sig] }],
    tokenBalances: [
      { transactionIndex: 0, account: ata, postMint: mint, postOwner: owner, preAmount: "0", postAmount: "1" },
    ],
  };
}

function transferBlock(
  slot: number,
  mint: string,
  fromOwner: string,
  toOwner: string,
  fromAta: string,
  toAta: string,
  sig: string,
): SqdBlock {
  return {
    header: { number: slot, timestamp: BASE_TS + slot },
    transactions: [{ transactionIndex: 0, signatures: [sig] }],
    tokenBalances: [
      { transactionIndex: 0, account: fromAta, preMint: mint, postMint: mint, preOwner: fromOwner, postOwner: fromOwner, preAmount: "1", postAmount: "0" },
      { transactionIndex: 0, account: toAta, preMint: mint, postMint: mint, preOwner: toOwner, postOwner: toOwner, preAmount: "0", postAmount: "1" },
    ],
  };
}

// Straddle test: with concurrency 4 over [0,100) the ranges are [0,25) [25,50) [50,75) [75,100).
// NFT_A mint lands in range 0, NFT_B mint in range 1, and NFT_A's TRANSFER in range 2 — so the
// early mint and its later transfer are decoded from DIFFERENT partitions. Correct ordered decode
// sees the mint first (→ `mint`); an out-of-order decode would see the transfer first, mark NFT_A
// seen, and misclassify the gaining-only mint as ambiguous — parity would break loudly.
const FIXTURE: readonly SqdBlock[] = [
  mintBlock(10, NFT_A, OWNER1, ATA_A1, SIG_MINT_A),
  mintBlock(30, NFT_B, OWNER3, ATA_B1, SIG_MINT_B),
  transferBlock(60, NFT_A, OWNER1, OWNER2, ATA_A1, ATA_A2, SIG_XFER_A),
];

type StreamFn = SqdClient["stream"];

/** Faithful client.stream mock: yields fixture blocks whose slot is in [from,to), ascending, one
 *  batch per block, incrementing stats.requests/blocks per yield. Optionally tallies into `served`. */
function makeStreamMock(blocks: readonly SqdBlock[], served?: { requests: number; blocks: number }) {
  return vi.fn(async function* (
    _mintChunk: readonly string[],
    fromSlot: number,
    toSlot: number,
    stats: SqdStreamStats,
  ) {
    const inRange = blocks
      .filter((b) => {
        const s = Number(b.header?.number);
        return s >= fromSlot && s < toSlot;
      })
      .sort((a, b) => Number(a.header?.number) - Number(b.header?.number));
    for (const b of inRange) {
      stats.requests++;
      stats.blocks++;
      stats.lastSlot = Number(b.header?.number);
      if (served) {
        served.requests++;
        served.blocks++;
      }
      yield [b];
    }
  });
}

/** Like makeStreamMock, but fires stoppedAtCap for the single range whose start === capFromSlot. */
function makeCapStreamMock(blocks: readonly SqdBlock[], capFromSlot: number) {
  return vi.fn(async function* (
    _mintChunk: readonly string[],
    fromSlot: number,
    toSlot: number,
    stats: SqdStreamStats,
  ) {
    const inRange = blocks
      .filter((b) => {
        const s = Number(b.header?.number);
        return s >= fromSlot && s < toSlot;
      })
      .sort((a, b) => Number(a.header?.number) - Number(b.header?.number));
    for (const b of inRange) {
      stats.requests++;
      stats.blocks++;
      stats.lastSlot = Number(b.header?.number);
      yield [b];
    }
    if (fromSlot === capFromSlot) stats.stoppedAtCap = true;
  });
}

/** Upsert mock that captures every event flattened across all upsert calls (arg[0] = events). */
function makeUpsertCapture() {
  const captured: CollectionEvent[] = [];
  const upsert = vi.fn(async (events: CollectionEvent[]) => {
    captured.push(...events);
  });
  return { captured, upsert: upsert as unknown as SqdLoaderDeps["upsert"] };
}

function buildDeps(args: {
  stream: StreamFn;
  upsert: SqdLoaderDeps["upsert"];
  members?: string[];
  head?: number;
  cursorSlot?: number;
  knownMints?: string[];
  syncStatus?: SqdLoaderDeps["syncStatus"];
}): SqdLoaderDeps {
  const head = args.head ?? HEAD;
  const client = {
    head: vi.fn().mockResolvedValue(head),
    currentHeight: vi.fn().mockResolvedValue(head),
    stream: args.stream,
    lastBlockReceivedAt: 0,
  } as unknown as SqdClient;
  return {
    client,
    members: vi.fn().mockResolvedValue(args.members ?? [NFT_A, NFT_B]),
    cursorSlot: vi.fn().mockResolvedValue(args.cursorSlot ?? 0),
    knownMints: vi.fn().mockResolvedValue(args.knownMints ?? []),
    upsert: args.upsert,
    syncStatus: args.syncStatus ?? (vi.fn().mockResolvedValue(true) as unknown as SqdLoaderDeps["syncStatus"]),
    log: () => {},
  };
}

const eventKey = (e: CollectionEvent): string => `${e.txSignature}:${e.nftMint}:${e.instructionIndex}`;
const sortEvents = (events: readonly CollectionEvent[]): CollectionEvent[] =>
  [...events].sort((a, b) => eventKey(a).localeCompare(eventKey(b)));

// ── partitionSlotRange ─────────────────────────────────────────────────────────────

describe("partitionSlotRange", () => {
  /** Asserts the ranges exactly reconstruct [from,to): ascending, contiguous, gap-free, disjoint,
   *  each non-empty half-open, count <= n and <= (to-from), union === every slot in [from,to). */
  function assertCoversExactly(ranges: Array<[number, number]>, from: number, to: number, n: number): void {
    expect(ranges.length).toBeLessThanOrEqual(n);
    expect(ranges.length).toBeLessThanOrEqual(to - from);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges[0][0]).toBe(from);
    expect(ranges[ranges.length - 1][1]).toBe(to);
    for (let i = 0; i < ranges.length; i++) {
      const [start, end] = ranges[i];
      expect(start).toBeLessThan(end); // non-empty half-open
      if (i > 0) expect(start).toBe(ranges[i - 1][1]); // contiguous + gap-free + disjoint + ascending
    }
    const covered: number[] = [];
    for (const [start, end] of ranges) for (let x = start; x < end; x++) covered.push(x);
    expect(covered).toEqual(Array.from({ length: to - from }, (_, i) => from + i));
  }

  it("splits [from,to) into disjoint, contiguous, gap-free ascending ranges covering the whole span", () => {
    const cases: Array<{ from: number; to: number; n: number }> = [
      { from: 0, to: 100, n: 4 }, // even split, size 25
      { from: 0, to: 10, n: 3 }, // uneven: sizes 4,4,2
      { from: 5, to: 17, n: 5 }, // ceil rounding yields fewer ranges (4) than n — still <= n
      { from: 1000, to: 1001, n: 4 }, // single-slot span
      { from: 42, to: 4242, n: 7 },
    ];
    for (const { from, to, n } of cases) {
      assertCoversExactly(partitionSlotRange(from, to, n), from, to, n);
    }
  });

  it("returns [] for an empty (to === from) or inverted (to < from) span", () => {
    expect(partitionSlotRange(100, 100, 4)).toEqual([]);
    expect(partitionSlotRange(100, 50, 4)).toEqual([]);
    expect(partitionSlotRange(0, 0, 1)).toEqual([]);
  });

  it("returns a single [from,to) range when n === 1", () => {
    expect(partitionSlotRange(0, 100, 1)).toEqual([[0, 100]]);
    expect(partitionSlotRange(5, 9, 1)).toEqual([[5, 9]]);
  });

  it("caps at exactly (to-from) single-slot ranges when n exceeds the span", () => {
    expect(partitionSlotRange(0, 3, 10)).toEqual([[0, 1], [1, 2], [2, 3]]);
    expect(partitionSlotRange(7, 9, 100)).toEqual([[7, 8], [8, 9]]);
  });

  it("throws when from or to is not an integer", () => {
    expect(() => partitionSlotRange(0.5, 10, 4)).toThrow(/integer/i);
    expect(() => partitionSlotRange(0, 10.25, 4)).toThrow(/integer/i);
    expect(() => partitionSlotRange(Number.NaN, 10, 4)).toThrow(/integer/i);
  });

  it("throws when n < 1", () => {
    expect(() => partitionSlotRange(0, 10, 0)).toThrow(/n must be/i);
    expect(() => partitionSlotRange(0, 10, -3)).toThrow(/n must be/i);
  });
});

// ── decode parity (the critical property) ──────────────────────────────────────────

describe("runSqdParallelLoader — decode parity with runSqdLoader", () => {
  it("produces byte-identical decode output to the sequential loader across partition boundaries", async () => {
    const seq = makeUpsertCapture();
    const seqResult: SqdLoaderResult = await runSqdLoader(
      { collectionKey: "pythians", fromSlot: FROM },
      buildDeps({ stream: makeStreamMock(FIXTURE), upsert: seq.upsert }),
    );

    const par = makeUpsertCapture();
    const parResult: SqdLoaderResult = await runSqdParallelLoader(
      { collectionKey: "pythians", fromSlot: FROM, concurrency: 4 },
      buildDeps({ stream: makeStreamMock(FIXTURE), upsert: par.upsert }),
    );

    // Decode counters match exactly.
    expect(parResult.eventsUpserted).toBe(seqResult.eventsUpserted);
    expect(parResult.rejectedRows).toBe(seqResult.rejectedRows);
    expect(parResult.ambiguousGroups).toBe(seqResult.ambiguousGroups);

    // The full upserted-event set (PK {sig}:{mint}:{ordinal} + kind + from/to + slot + blockTime)
    // is identical — byte-for-byte decode parity, order-independent.
    expect(sortEvents(par.captured)).toEqual(sortEvents(seq.captured));

    // The straddling early mint is classified `mint` (first-appearance preserved), not transfer.
    const parMintA = par.captured.find((e) => e.nftMint === NFT_A && e.kind === "mint");
    expect(parMintA).toBeDefined();
    expect(parMintA?.from).toBeNull();
    expect(par.captured.filter((e) => e.nftMint === NFT_A && e.kind === "transfer")).toHaveLength(1);
    expect(parResult.ambiguousGroups).toBe(0);
    expect(parResult.eventsUpserted).toBe(3);
  });
});

// ── concurrency=1 delegation ────────────────────────────────────────────────────────

describe("runSqdParallelLoader — concurrency=1 delegates to runSqdLoader", () => {
  it("returns the sequential loader's result and cursor semantics, not the parallel head advance", async () => {
    const seq = makeUpsertCapture();
    const seqResult = await runSqdLoader(
      { collectionKey: "pythians", fromSlot: FROM },
      buildDeps({ stream: makeStreamMock(FIXTURE), upsert: seq.upsert }),
    );

    const del = makeUpsertCapture();
    const delResult = await runSqdParallelLoader(
      { collectionKey: "pythians", fromSlot: FROM, concurrency: 1 },
      buildDeps({ stream: makeStreamMock(FIXTURE), upsert: del.upsert }),
    );

    expect(delResult).toEqual(seqResult);
    expect(sortEvents(del.captured)).toEqual(sortEvents(seq.captured));
    // Delegation discriminator: sequential cursor = min completed-chunk data-slot (60), whereas the
    // parallel (concurrency>=2) path would advance the cursor to head (100). Proves it took the
    // delegated path, not the parallel code path.
    expect(delResult.lastSlot).toBe(60);
    expect(delResult.lastSlot).not.toBe(HEAD);
  });
});

// ── conservative cursor ─────────────────────────────────────────────────────────────

describe("runSqdParallelLoader — conservative cursor", () => {
  it("advances sqdCursorSlot to head when no range hit the cap", async () => {
    const { upsert } = makeUpsertCapture();
    const syncStatus = vi.fn().mockResolvedValue(true);
    const result = await runSqdParallelLoader(
      { collectionKey: "pythians", fromSlot: FROM, concurrency: 4 },
      buildDeps({ stream: makeStreamMock(FIXTURE), upsert, syncStatus: syncStatus as unknown as SqdLoaderDeps["syncStatus"] }),
    );

    expect(result.stoppedAtCap).toBe(false);
    expect(result.lastSlot).toBe(HEAD);
    expect(syncStatus).toHaveBeenCalledWith(expect.objectContaining({ collectionKey: "pythians", sqdCursorSlot: HEAD }));
  });

  it("holds sqdCursorSlot at `from` when any single range stopped at cap", async () => {
    const START = 5;
    const ranges = partitionSlotRange(START, HEAD, 4);
    const capFromSlot = ranges[2][0]; // cap ONLY the 3rd range → proves the OR-reduce over ranges
    const { upsert } = makeUpsertCapture();
    const syncStatus = vi.fn().mockResolvedValue(true);
    const result = await runSqdParallelLoader(
      { collectionKey: "pythians", fromSlot: START, concurrency: 4 },
      buildDeps({ stream: makeCapStreamMock(FIXTURE, capFromSlot), upsert, syncStatus: syncStatus as unknown as SqdLoaderDeps["syncStatus"] }),
    );

    expect(result.stoppedAtCap).toBe(true);
    expect(result.lastSlot).toBe(START);
    expect(result.lastSlot).not.toBe(HEAD);
    expect(syncStatus).toHaveBeenCalledWith(expect.objectContaining({ collectionKey: "pythians", sqdCursorSlot: START }));
  });
});

// ── fetch-stats aggregation ─────────────────────────────────────────────────────────

describe("runSqdParallelLoader — fetch stats aggregation", () => {
  it("sums requests and blocks across every (chunk, range) fetch task to equal the total served", async () => {
    const served = { requests: 0, blocks: 0 };
    const { upsert } = makeUpsertCapture();
    const result = await runSqdParallelLoader(
      { collectionKey: "pythians", fromSlot: FROM, concurrency: 4 },
      buildDeps({ stream: makeStreamMock(FIXTURE, served), upsert }),
    );

    expect(result.requests).toBe(served.requests);
    expect(result.blocks).toBe(served.blocks);
    // sanity: all 3 in-range fixture blocks were served exactly once (partition covered the span).
    expect(served.requests).toBe(3);
    expect(served.blocks).toBe(3);
  });
});

// ── entry guards ────────────────────────────────────────────────────────────────────

describe("runSqdParallelLoader — guards", () => {
  it("rejects when members() is empty (refuse to walk nothing)", async () => {
    const stream = makeStreamMock(FIXTURE);
    const { upsert } = makeUpsertCapture();
    await expect(
      runSqdParallelLoader(
        { collectionKey: "pythians", fromSlot: FROM, concurrency: 4 },
        buildDeps({ stream, upsert, members: [] }),
      ),
    ).rejects.toThrow(/refuse to walk nothing/);
    expect(stream).not.toHaveBeenCalled();
  });

  it("returns an empty result and never streams when fromSlot >= head", async () => {
    const stream = makeStreamMock(FIXTURE);
    const { captured, upsert } = makeUpsertCapture();
    const syncStatus = vi.fn().mockResolvedValue(true);
    const result = await runSqdParallelLoader(
      { collectionKey: "pythians", fromSlot: HEAD, concurrency: 4 },
      buildDeps({ stream, upsert, syncStatus: syncStatus as unknown as SqdLoaderDeps["syncStatus"] }),
    );

    const expected: SqdLoaderResult = {
      requests: 0,
      blocks: 0,
      balanceRows: 0,
      stoppedAtCap: false,
      lastSlot: HEAD,
      eventsUpserted: 0,
      rejectedRows: 0,
      ambiguousGroups: 0,
      chunks: 0,
    };
    expect(result).toEqual(expected);
    expect(stream).not.toHaveBeenCalled();
    expect(captured).toEqual([]);
    expect(syncStatus).not.toHaveBeenCalled();
  });
});
