/**
 * sqd-loader.test.ts — colocated unit tests for runSqdLoader and isLiveTailEnabled.
 *
 * Covers: kill switch (SQD_LIVE_TAIL_ENABLED), auth failures (SqdAuthRequiredError on
 * 401/403), dry-run invariants, and multi-chunk chunk-count tracking.
 *
 * Cursor-skip regression (DISS-001) lives in sqd-loader-cursor.test.ts.
 * Full §4.5 gate and decode tests live in test/.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLiveTailEnabled, runSqdLoader, type SqdLoaderDeps } from "./sqd-loader.js";
import { SqdAuthRequiredError, SqdClient } from "./sqd-client.js";

const MINT = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w";

// ── kill switch ────────────────────────────────────────────────────────────────

describe("isLiveTailEnabled", () => {
  afterEach(() => {
    delete process.env.SQD_LIVE_TAIL_ENABLED;
  });

  it("returns true when SQD_LIVE_TAIL_ENABLED is unset (default enabled)", () => {
    delete process.env.SQD_LIVE_TAIL_ENABLED;
    expect(isLiveTailEnabled()).toBe(true);
  });

  it("returns false and emits a [SQD] log when SQD_LIVE_TAIL_ENABLED=false", () => {
    process.env.SQD_LIVE_TAIL_ENABLED = "false";
    const logs: string[] = [];
    expect(isLiveTailEnabled((m) => logs.push(m))).toBe(false);
    expect(logs.some((l) => l.includes("[SQD]") && l.toLowerCase().includes("disabled"))).toBe(true);
  });

  it("returns true when SQD_LIVE_TAIL_ENABLED=true", () => {
    process.env.SQD_LIVE_TAIL_ENABLED = "true";
    expect(isLiveTailEnabled()).toBe(true);
  });

  it("only exact string 'false' triggers the kill — '0' and '1' leave it enabled", () => {
    process.env.SQD_LIVE_TAIL_ENABLED = "0";
    expect(isLiveTailEnabled()).toBe(true);
    process.env.SQD_LIVE_TAIL_ENABLED = "1";
    expect(isLiveTailEnabled()).toBe(true);
  });
});

describe("runSqdLoader — kill switch", () => {
  afterEach(() => {
    delete process.env.SQD_LIVE_TAIL_ENABLED;
    vi.restoreAllMocks();
  });

  it("returns empty zero result immediately when SQD_LIVE_TAIL_ENABLED=false", async () => {
    process.env.SQD_LIVE_TAIL_ENABLED = "false";

    const deps: SqdLoaderDeps = {
      client: {
        head: vi.fn(),
        stream: vi.fn(),
        currentHeight: vi.fn(),
        lastBlockReceivedAt: 0,
      } as unknown as SqdClient,
      members: vi.fn().mockResolvedValue([MINT]),
      cursorSlot: vi.fn().mockResolvedValue(null),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: vi.fn() as unknown as SqdLoaderDeps["upsert"],
      syncStatus: vi.fn() as unknown as SqdLoaderDeps["syncStatus"],
      log: vi.fn(),
    };

    const result = await runSqdLoader({ collectionKey: "pythians", fromSlot: 0 }, deps);

    expect(result.requests).toBe(0);
    expect(result.blocks).toBe(0);
    expect(result.eventsUpserted).toBe(0);
    expect(result.chunks).toBe(0);
    // network not touched
    expect((deps.client.head as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((deps.client.stream as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ── auth failure ───────────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeDeps(): { deps: SqdLoaderDeps; upsertMock: ReturnType<typeof vi.fn> } {
  const upsertMock = vi.fn().mockResolvedValue(undefined);
  const deps: SqdLoaderDeps = {
    client: new SqdClient(undefined, 10),
    members: vi.fn().mockResolvedValue([MINT]),
    cursorSlot: vi.fn().mockResolvedValue(0),
    knownMints: vi.fn().mockResolvedValue([]),
    upsert: upsertMock as unknown as SqdLoaderDeps["upsert"],
    syncStatus: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["syncStatus"],
    log: () => {},
  };
  return { deps, upsertMock };
}

describe("runSqdLoader — auth failure 401", () => {
  it("throws SqdAuthRequiredError instanceof on 401", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    const { deps } = makeDeps();
    await expect(runSqdLoader({ collectionKey: "mad_lads" }, deps)).rejects.toBeInstanceOf(SqdAuthRequiredError);
  });

  it("fetch is called exactly once — no retry on 401", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    const { deps } = makeDeps();
    await runSqdLoader({ collectionKey: "mad_lads" }, deps).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("zero upsert calls on 401", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    const { deps, upsertMock } = makeDeps();
    await runSqdLoader({ collectionKey: "mad_lads" }, deps).catch(() => {});
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("error carries status:401, url string, blockHeight number", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    const { deps } = makeDeps();
    const err = await runSqdLoader({ collectionKey: "mad_lads" }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(SqdAuthRequiredError);
    expect((err as SqdAuthRequiredError).status).toBe(401);
    expect(typeof (err as SqdAuthRequiredError).url).toBe("string");
    expect(typeof (err as SqdAuthRequiredError).blockHeight).toBe("number");
  });
});

describe("runSqdLoader — auth failure 403", () => {
  it("throws SqdAuthRequiredError instanceof on 403", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));
    const { deps } = makeDeps();
    await expect(runSqdLoader({ collectionKey: "mad_lads" }, deps)).rejects.toBeInstanceOf(SqdAuthRequiredError);
  });

  it("fetch is called exactly once — no retry on 403", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));
    const { deps } = makeDeps();
    await runSqdLoader({ collectionKey: "mad_lads" }, deps).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("error carries status:403", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));
    const { deps } = makeDeps();
    const err = await runSqdLoader({ collectionKey: "mad_lads" }, deps).catch((e) => e);
    expect((err as SqdAuthRequiredError).status).toBe(403);
  });
});

// ── chunk accounting ───────────────────────────────────────────────────────────

describe("runSqdLoader — chunk accounting", () => {
  afterEach(() => vi.restoreAllMocks());

  it("result.chunks equals the number of mint chunks derived from members()", async () => {
    // Two mints → one chunk (well below MINT_CHUNK=1500)
    const SLOT = 42;
    const streamMock = vi.fn(async function* (
      _mints: readonly string[],
      _from: number,
      _to: number,
      stats: { requests: number; blocks: number; balanceRows: number; stoppedAtCap: boolean; lastSlot: number },
    ) {
      stats.requests++;
      stats.blocks++;
      stats.lastSlot = SLOT;
      yield [{ header: { number: SLOT, timestamp: 1_000_000 }, transactions: [], tokenBalances: [] }];
    });

    const client: SqdClient = {
      head: vi.fn().mockResolvedValue(500_000),
      currentHeight: vi.fn().mockResolvedValue(500_000),
      stream: streamMock,
      lastBlockReceivedAt: 0,
    } as unknown as SqdClient;

    const deps: SqdLoaderDeps = {
      client,
      members: vi.fn().mockResolvedValue([MINT, "AnotherMint111111111111111111111111111111111"]),
      cursorSlot: vi.fn().mockResolvedValue(0),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["upsert"],
      syncStatus: vi.fn().mockResolvedValue(undefined) as unknown as SqdLoaderDeps["syncStatus"],
      log: () => {},
    };

    const result = await runSqdLoader({ collectionKey: "pythians", fromSlot: 0 }, deps);
    expect(result.chunks).toBe(1);
    expect(result.lastSlot).toBe(SLOT);
  });

  it("throws when members() returns empty array (refuse to walk nothing)", async () => {
    const client: SqdClient = {
      head: vi.fn().mockResolvedValue(500_000),
      currentHeight: vi.fn().mockResolvedValue(500_000),
      stream: vi.fn(),
      lastBlockReceivedAt: 0,
    } as unknown as SqdClient;

    const deps: SqdLoaderDeps = {
      client,
      members: vi.fn().mockResolvedValue([]),
      cursorSlot: vi.fn().mockResolvedValue(0),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: vi.fn() as unknown as SqdLoaderDeps["upsert"],
      syncStatus: vi.fn() as unknown as SqdLoaderDeps["syncStatus"],
      log: () => {},
    };

    await expect(runSqdLoader({ collectionKey: "pythians", fromSlot: 0 }, deps)).rejects.toThrow(/refuse to walk nothing/);
  });
});
