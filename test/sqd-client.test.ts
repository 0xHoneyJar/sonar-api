import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MINT_CHUNK, SqdClient, type SqdStreamStats } from "../src/svm/sqd-client";

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
});
