import { describe, expect, it, vi } from "vitest";

import { createHasuraOwnershipSnapshotReader } from "./ownership-snapshot-reader.js";

const CAIP10 = "eip155:1:0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9";

describe("createHasuraOwnershipSnapshotReader", () => {
  it("reads E2 holders from TrackedHolder and computes concentration", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { TrackedHolder_aggregate: { aggregate: { count: 3 } } },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            TrackedHolder: [
              { address: "0xAaa", tokenCount: 50 },
              { address: "0xBbb", tokenCount: 30 },
              { address: "0xCcc", tokenCount: 20 },
            ],
          },
        }),
      });

    const reader = createHasuraOwnershipSnapshotReader({
      url: "http://hasura.test/v1/graphql",
      fetchFn,
    });
    const snap = await reader.readOwnershipSnapshot({ caip10: CAIP10, nowMs: 1_700_000_000_000 });
    expect("error" in snap).toBe(false);
    if ("error" in snap) return;
    expect(snap.coverage.ownership).toBe("available");
    expect(snap.holder_count).toBe(3);
    expect(snap.concentration).toMatchObject({ top10_share: 1 });
    expect(snap.whale_candidate_count).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("refuses oversized E2 holder sets without silent truncation", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { TrackedHolder_aggregate: { aggregate: { count: 200_000 } } },
      }),
    });
    const reader = createHasuraOwnershipSnapshotReader({
      url: "http://hasura.test/v1/graphql",
      fetchFn,
      currentHolderLimit: 1000,
    });
    const snap = await reader.readOwnershipSnapshot({ caip10: CAIP10 });
    expect("error" in snap).toBe(false);
    if ("error" in snap) return;
    expect(snap.metrics).toMatchObject({
      status: "insufficient_data",
      reason: expect.stringContaining("too large"),
    });
  });

  it("replays hold721 for as_of E1", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            Action_aggregate: {
              aggregate: { count: 3, min: { timestamp: "100" } },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            Action: [
              {
                id: "tx_0_in",
                actor: "0xaaa",
                timestamp: "100",
                numeric1: "2",
                context: JSON.stringify({ direction: "in" }),
              },
              {
                id: "tx_1_in",
                actor: "0xbbb",
                timestamp: "200",
                numeric1: "1",
                context: JSON.stringify({ direction: "in" }),
              },
            ],
          },
        }),
      });

    const reader = createHasuraOwnershipSnapshotReader({
      url: "http://hasura.test/v1/graphql",
      fetchFn,
    });
    const snap = await reader.readOwnershipSnapshot({
      caip10: CAIP10,
      asOfRaw: "2026-06-21",
      nowMs: 1_700_000_000_000,
    });
    expect("error" in snap).toBe(false);
    if ("error" in snap) return;
    expect(snap.as_of).toBe("2026-06-21");
    expect(snap.holder_count).toBe(2);
    expect(snap.coverage.ownership).toBe("available");
  });

  it("returns insufficient_data when history starts after as_of", async () => {
    const futureTs = Math.floor(Date.UTC(2026, 11, 1) / 1000);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          Action_aggregate: {
            aggregate: { count: 10, min: { timestamp: String(futureTs) } },
          },
        },
      }),
    });

    const reader = createHasuraOwnershipSnapshotReader({
      url: "http://hasura.test/v1/graphql",
      fetchFn,
    });
    const snap = await reader.readOwnershipSnapshot({
      caip10: CAIP10,
      asOfRaw: "2026-06-21",
    });
    expect("error" in snap).toBe(false);
    if ("error" in snap) return;
    expect(snap.coverage.ownership).toBe("unavailable");
    expect(snap.metrics).toMatchObject({
      status: "insufficient_data",
      reason: "indexed history starts after as_of",
    });
  });

  it("rejects invalid caip10", async () => {
    const reader = createHasuraOwnershipSnapshotReader({
      url: "http://hasura.test/v1/graphql",
      fetchFn: vi.fn(),
    });
    const snap = await reader.readOwnershipSnapshot({ caip10: "not-caip" });
    expect(snap).toMatchObject({ error: "invalid_caip10" });
  });
});
