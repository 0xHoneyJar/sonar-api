/*
 * pump-fun-indexer.test.ts — indexSnapshot flow + the empty-snapshot wipe guard.
 *
 * Mocks global fetch (Hasura) and feeds a fake SplHolderSource so the upsert→reconcile flow and the
 * "0 holders → don't wipe" safety are covered without a live RPC or Hasura.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { indexSnapshot } from "../src/svm/pump-fun-indexer";
import type { HolderSnapshot, SplHolderSource } from "../src/svm/spl-holder-source";

function sourceWith(holders: HolderSnapshot["holders"], slot = 200): SplHolderSource {
  return {
    snapshot: async () => ({
      mint: "7C9AvMCtsgbZoip9aMs8etFueo5YStXFnDtwrDg5pump",
      program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      decimals: 6,
      slot,
      source: "rpc",
      holders,
    }),
    health: async () => ({ ok: true, detail: "" }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("indexSnapshot", () => {
  it("skips upsert AND reconcile when the snapshot is empty (no wipe)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await indexSnapshot(sourceWith([], 222), "pythians", "2026-06-23T00:00:00.000Z");

    expect(fetchMock).not.toHaveBeenCalled(); // critical: no DELETE issued
    expect(res).toEqual({ upserted: 0, removed: 0, slot: 222 });
  });

  it("upserts holders then reconciles stale rows", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ data: { insert_svm_token_holder: { affected_rows: 2 } } }) })
      .mockResolvedValueOnce({ json: async () => ({ data: { delete_svm_token_holder: { affected_rows: 3 } } }) });
    vi.stubGlobal("fetch", fetchMock);

    const res = await indexSnapshot(
      sourceWith([
        { owner: "A", amountRaw: 10n },
        { owner: "B", amountRaw: 5n },
      ], 333),
      "pythians",
      "2026-06-23T00:00:00.000Z",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 upsert batch + 1 reconcile
    const reconcileBody = JSON.parse((fetchMock.mock.calls[1][1] as any).body);
    expect(reconcileBody.variables).toEqual({ ck: "pythians", slot: 333 });
    expect(res).toEqual({ upserted: 2, removed: 3, slot: 333 });
  });
});
