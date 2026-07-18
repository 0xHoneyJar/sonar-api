import { describe, expect, it, vi } from "vitest";

import { createHasuraCollectionStatusReader } from "./hasura-status-reader.js";

describe("createHasuraCollectionStatusReader", () => {
  it("maps tracked holder count and last transfer time", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          tracked: { aggregate: { count: 5 } },
          tokens: { aggregate: { count: 10, max: { lastTransferTime: "1700000000" } } },
        },
      }),
    });

    const reader = createHasuraCollectionStatusReader({
      url: "http://hasura.test/v1/graphql",
      fetchFn,
    });

    const snapshot = await reader.readIndexedSnapshot({
      chainId: 80094,
      contract: "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684",
    });

    expect(snapshot).toEqual({
      holderCount: 5,
      tokenCount: 10,
      trackedHolderCount: 5,
      indexedAtMs: 1700000000 * 1000,
      readiness: {
        state: "ready",
        kind: "indexed_rows",
        observedAtMs: 1700000000 * 1000,
      },
    });
  });

  it("falls back to token aggregate count when tracked holders are empty", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          tracked: { aggregate: { count: 0 } },
          tokens: { aggregate: { count: 3, max: { lastTransferTime: null } } },
        },
      }),
    });

    const reader = createHasuraCollectionStatusReader({ url: "http://hasura.test/v1/graphql", fetchFn });
    const snapshot = await reader.readIndexedSnapshot({
      chainId: 8453,
      contract: "0x0000000000000000000000000000000000000001",
    });

    expect(snapshot).toMatchObject({
      holderCount: 3,
      tokenCount: 3,
      trackedHolderCount: 0,
      indexedAtMs: null,
    });
    expect(snapshot.readiness).toBeUndefined();
  });

  it("does not infer readiness from an empty aggregate", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          tracked: { aggregate: { count: 0 } },
          tokens: { aggregate: { count: 0, max: { lastTransferTime: null } } },
        },
      }),
    });

    const reader = createHasuraCollectionStatusReader({
      url: "http://hasura.test/v1/graphql",
      fetchFn,
    });
    const snapshot = await reader.readIndexedSnapshot({
      chainId: 8453,
      contract: "0x0000000000000000000000000000000000000001",
    });

    expect(snapshot).toEqual({
      holderCount: 0,
      tokenCount: 0,
      trackedHolderCount: 0,
      indexedAtMs: null,
    });
  });

  it.each([
    [100, 1],
    [500, 5],
  ])("reads %i collections in bounded batches", async (count, expectedCalls) => {
    const fetchFn = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      const aliases = [...body.query.matchAll(/tracked_(\d+):/g)].map(
        (match) => Number(match[1]),
      );
      return {
        ok: true,
        json: async () => ({
          data: Object.fromEntries(
            aliases.flatMap((index) => [
              [`tracked_${index}`, { aggregate: { count: 0 } }],
              [
                `tokens_${index}`,
                {
                  aggregate: {
                    count: index + 1,
                    max: { lastTransferTime: "1700000000" },
                  },
                },
              ],
            ]),
          ),
        }),
      };
    });
    const reader = createHasuraCollectionStatusReader({
      url: "http://hasura.test/v1/graphql",
      fetchFn,
      batchSize: 100,
    });
    const keys = Array.from({ length: count }, (_, index) => ({
      chainId: 1,
      contract: `0x${index.toString(16).padStart(40, "0")}` as `0x${string}`,
    }));

    const snapshots = await reader.readIndexedSnapshots!(keys);

    expect(fetchFn).toHaveBeenCalledTimes(expectedCalls);
    expect(snapshots).toHaveLength(count);
    expect(snapshots.get(`1:${keys.at(-1)!.contract}`)).toMatchObject({
      trackedHolderCount: 0,
    });
  });
});
