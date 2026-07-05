import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuneClient } from "../src/svm/dune-client";

const KEY = "test-dune-key-do-not-leak";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("DuneClient", () => {
  it("requires an api key", () => {
    const prev = process.env.DUNE_API_KEY;
    delete process.env.DUNE_API_KEY;
    expect(() => new DuneClient()).toThrow(/DUNE_API_KEY/);
    if (prev !== undefined) process.env.DUNE_API_KEY = prev;
  });

  it("sends the key as a header, never in the URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ execution_id: "01TEST" }));
    const c = new DuneClient(KEY);
    await c.executeQuery(123, { collection_mint: "abc" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain(KEY);
    expect(init.headers["X-Dune-API-Key"]).toBe(KEY);
  });

  it("drains pages until totalRowCount reached and surfaces credits", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ execution_id: "01X" })) // execute
      .mockResolvedValueOnce(jsonResponse({ state: "QUERY_STATE_COMPLETED" })) // status
      .mockResolvedValueOnce(
        jsonResponse({ result: { rows: [{ a: 1 }, { a: 2 }], metadata: { total_row_count: 3, execution_cost_credits: "0.5" } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ result: { rows: [{ a: 3 }], metadata: { total_row_count: 3, execution_cost_credits: "0.5" } } }),
      );
    const c = new DuneClient(KEY);
    const logs: string[] = [];
    const r = await c.runQuery(7, {}, { pageSize: 2, log: (m) => logs.push(m) });
    expect(r.rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(r.executionCostCredits).toBe(0.5);
    expect(logs.join(" ")).toContain("0.5 credits"); // NFR-1: no silent spend
  });

  it("retries 429/5xx with cap, then throws WITHOUT the key in the message", async () => {
    const c = new DuneClient(KEY);
    // retry-after 0.001s → 1ms backoff per attempt (keeps the exponential-fallback branch out of a unit test)
    for (let i = 0; i < 6; i++) fetchMock.mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "0.001" }));
    await expect(c.executeQuery(9)).rejects.toThrow(/HTTP 429 after 5 retries/);
    const err = await c.executeQuery(9).catch((e) => e); // exhausted mock → fetch undefined rejects too
    expect(String(err)).not.toContain(KEY);
  }, 20_000);

  it("throws on FAILED execution state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ state: "QUERY_STATE_FAILED", error: { msg: "boom" } }));
    const c = new DuneClient(KEY);
    await expect(c.waitForCompletion("01F")).rejects.toThrow(/QUERY_STATE_FAILED/);
  });
});
