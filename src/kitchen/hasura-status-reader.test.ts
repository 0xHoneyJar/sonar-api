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
      indexedAtMs: null,
      readiness: { state: "ready", kind: "indexed_rows" },
    });
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

    expect(snapshot).toEqual({ holderCount: 0, indexedAtMs: null });
  });
});
