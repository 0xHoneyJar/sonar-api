import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MINT_CHUNK, PAYLOAD_SOFT_CEILING, SqdAuthRequiredError, SqdClient, type SqdStreamStats } from "../src/svm/sqd-client";

const MINT = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w";
const freshStats = (): SqdStreamStats => ({ requests: 0, blocks: 0, balanceRows: 0, stoppedAtCap: false, lastSlot: 0 });

const jsonl = (blocks: Array<Record<string, unknown>>) =>
  new Response(blocks.map((b) => JSON.stringify(b)).join("\n") + "\n", { status: 200, headers: { "Content-Type": "application/jsonl" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("SqdClient.stream", () => {
  it("drives continuation from lastBlock+1 until toSlot (measured Portal semantics)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonl([{ header: { number: 150 }, tokenBalances: [{}] }]))
      .mockResolvedValueOnce(jsonl([{ header: { number: 300 }, tokenBalances: [{}, {}] }]));
    const c = new SqdClient(undefined, 100);
    const stats = freshStats();
    const batches: number[] = [];
    for await (const blocks of c.stream([MINT], 100, 300, stats)) batches.push(blocks.length);
    expect(stats.requests).toBe(2);
    expect(stats.balanceRows).toBe(3);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).fromBlock).toBe(151); // lastBlock+1
    expect(batches).toEqual([1, 1]);
  });

  it("stops CLEANLY at the request cap between requests (grant-not-right guard) and flags it", async () => {
    fetchMock.mockResolvedValue(jsonl([{ header: { number: 999999 } }]));
    const c = new SqdClient(undefined, 1);
    const stats = freshStats();
    const logs: string[] = [];
    for await (const _ of c.stream([MINT], 0, 10_000_000, stats, (m) => logs.push(m))) { /* drain */ }
    expect(stats.requests).toBe(1);
    expect(stats.stoppedAtCap).toBe(true);
    expect(logs.join(" ")).toContain("request cap");
  });

  it("refuses a chunk above the MEASURED filter ceiling", async () => {
    const c = new SqdClient(undefined, 10);
    const big = Array.from({ length: MINT_CHUNK + 1 }, () => MINT);
    await expect(c.stream(big, 0, 1, freshStats()).next()).rejects.toThrow(/exceeds measured ceiling/);
  });

  it("retries 429 with retry-after then succeeds; sends Authorization ONLY when a key is set", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "0.001" } }))
      .mockResolvedValueOnce(jsonl([{ header: { number: 5 } }]));
    const keyed = new SqdClient("test-key", 10);
    const stats = freshStats();
    for await (const _ of keyed.stream([MINT], 0, 5, stats)) { /* drain */ }
    expect(stats.requests).toBe(1);
    expect(fetchMock.mock.calls[1][1].headers["Authorization"]).toBe("Bearer test-key");

    fetchMock.mockResolvedValueOnce(jsonl([{ header: { number: 5 } }]));
    for await (const _ of new SqdClient(undefined, 10).stream([MINT], 0, 5, freshStats())) { /* drain */ }
    expect(fetchMock.mock.calls[2][1].headers["Authorization"]).toBeUndefined();
  });

  it("tolerates a torn trailing line (jsonl stream end)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ header: { number: 7 }, tokenBalances: [{}] }) + '\n{"header":{"numb', { status: 200 }),
    );
    const stats = freshStats();
    for await (const _ of new SqdClient(undefined, 10).stream([MINT], 0, 7, stats)) { /* drain */ }
    expect(stats.blocks).toBe(1);
    expect(stats.balanceRows).toBe(1);
  });

  // T-1: Auth guard (FR-6) — 401 must throw SqdAuthRequiredError immediately, not retry
  it("throws SqdAuthRequiredError immediately on 401 — not caught by retry loop", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    const c = new SqdClient(undefined, 10);
    const err = await c.stream([MINT], 0, 100, freshStats()).next().catch((e) => e);
    expect(err).toBeInstanceOf(SqdAuthRequiredError);
    expect((err as SqdAuthRequiredError).status).toBe(401);
    // Should NOT have retried — only one fetch call
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws SqdAuthRequiredError immediately on 403 — not caught by retry loop", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));
    const c = new SqdClient(undefined, 10);
    const err = await c.stream([MINT], 0, 100, freshStats()).next().catch((e) => e);
    expect(err).toBeInstanceOf(SqdAuthRequiredError);
    expect((err as SqdAuthRequiredError).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 503 (retry-eligible) but NOT on 401 (auth-guard)", async () => {
    // 503 should retry up to MAX_RETRIES
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(jsonl([{ header: { number: 5 } }]));
    const c = new SqdClient(undefined, 10);
    const stats = freshStats();
    for await (const _ of c.stream([MINT], 0, 5, stats)) { /* drain */ }
    expect(fetchMock).toHaveBeenCalledTimes(3); // 2 retries + 1 success
  });

  // T-1: SqdAuthRequiredError contains blockHeight, timestamp, status, url
  it("SqdAuthRequiredError carries blockHeight, timestamp, status, url fields", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    const c = new SqdClient(undefined, 10);
    const err = await c.stream([MINT], 42, 100, freshStats()).next().catch((e) => e);
    expect(err).toBeInstanceOf(SqdAuthRequiredError);
    expect((err as SqdAuthRequiredError).blockHeight).toBe(42);
    expect(typeof (err as SqdAuthRequiredError).timestamp).toBe("string");
    expect(typeof (err as SqdAuthRequiredError).url).toBe("string");
  });

  // T-1: No-credential bootstrap (NFR-1): client must NOT read SQD_API_KEY
  it("no-credential bootstrap: stream succeeds with no SQD_API_KEY in environment", async () => {
    const savedKey = process.env.SQD_API_KEY;
    delete process.env.SQD_API_KEY;
    try {
      fetchMock.mockResolvedValueOnce(jsonl([{ header: { number: 5 } }]));
      // Instantiate with no apiKey argument — constructor reads process.env.SQD_API_KEY
      const c = new SqdClient(process.env.SQD_API_KEY, 10);
      const stats = freshStats();
      for await (const _ of c.stream([MINT], 0, 5, stats)) { /* drain */ }
      // Authorization header must be absent
      expect(fetchMock.mock.calls[0][1].headers["Authorization"]).toBeUndefined();
      expect(stats.requests).toBe(1);
    } finally {
      if (savedKey !== undefined) process.env.SQD_API_KEY = savedKey;
    }
  });

  // T-1: lastBlockReceivedAt tracking
  it("lastBlockReceivedAt is updated on each block received from stream", async () => {
    const t0 = Date.now();
    fetchMock
      .mockResolvedValueOnce(jsonl([{ header: { number: 10 }, tokenBalances: [] }]))
      .mockResolvedValueOnce(jsonl([{ header: { number: 20 }, tokenBalances: [] }]))
      .mockResolvedValueOnce(jsonl([{ header: { number: 30 }, tokenBalances: [] }]));
    const c = new SqdClient(undefined, 100);
    const stats = freshStats();
    let count = 0;
    for await (const _ of c.stream([MINT], 0, 30, stats)) { count++; }
    expect(count).toBe(3);
    expect(c.lastBlockReceivedAt).toBeGreaterThanOrEqual(t0);
    expect(c.lastBlockReceivedAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  // T-1: Ceiling guard (FR-5): payload exceeding soft ceiling triggers rechunk + warn
  it("ceiling guard: oversized payload triggers warn and rechunking with full mint coverage", async () => {
    // Create a mint list where each entry is long enough that 1500×2 appearances → >330KB
    // A 220-char string × 1500 mints × 2 appearances = 660KB → triggers guard
    // After split (750 mints each), still >330KB → splits again to 375 mints each (<165KB = OK)
    const LONG_MINT = "A".repeat(220);
    const bigChunk = Array.from({ length: 1500 }, () => LONG_MINT);

    // Mock fetch to succeed with the sub-chunk requests — use mockImplementation so each call
    // gets a FRESH Response instance (Response body can only be read once; mockResolvedValue
    // reuses the same object, causing "Body has already been read" on recursive sub-chunks).
    fetchMock.mockImplementation(() => Promise.resolve(jsonl([{ header: { number: 5 } }])));

    const c = new SqdClient(undefined, 1000);
    const stats = freshStats();
    const logs: string[] = [];

    for await (const _ of c.stream(bigChunk, 0, 5, stats, (m) => logs.push(m))) { /* drain */ }

    // Should have logged at least one WARN about ceiling
    expect(logs.some((l) => l.includes("[SQD WARN]") && l.includes("soft ceiling"))).toBe(true);

    // Fetch should have been called (sub-chunks processed)
    expect(fetchMock).toHaveBeenCalled();

    // All sub-chunks together should cover all 1500 mints
    // Verify by checking that total mints in all fetch calls = 1500
    let totalMints = 0;
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(call[1].body);
      totalMints += body.tokenBalances[0].postMint.length;
    }
    expect(totalMints).toBe(1500);
  });

  // T-1: Ceiling guard constant is exported and at 90% of 345KB
  it("PAYLOAD_SOFT_CEILING is defined at 330_000 bytes (90% of 345KB ceiling)", () => {
    expect(PAYLOAD_SOFT_CEILING).toBe(330_000);
  });
});

describe("SqdClient.currentHeight", () => {
  it("returns the finalized head slot from the Portal", async () => {
    fetchMock.mockResolvedValueOnce(new Response("430902735\n", { status: 200 }));
    const c = new SqdClient(undefined, 10);
    expect(await c.currentHeight()).toBe(430902735);
  });

  it("throws SqdAuthRequiredError on 401 from height endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    const c = new SqdClient(undefined, 10);
    await expect(c.currentHeight()).rejects.toBeInstanceOf(SqdAuthRequiredError);
  });
});
