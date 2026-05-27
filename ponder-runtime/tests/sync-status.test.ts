// ponder-runtime/tests/sync-status.test.ts — T-A2.1 AC unit tests
//
// AC: unit tests cover delayed blocks, clock skew, reorg windows.

import { describe, expect, it, beforeEach } from "vitest";
import {
  isLiveEvent,
  confirmationsFor,
  CONFIRMATIONS_BY_CHAIN,
  DEFAULT_CONFIRMATIONS,
  __resetHeadCacheForTests,
} from "../src/lib/sync-status";

function mockContext(chainId: number, head: bigint) {
  return {
    client: {
      getBlock: async (args: { blockTag: "latest" }) => {
        expect(args.blockTag).toBe("latest");
        return { number: head };
      },
    },
    chain: { id: chainId },
  };
}

describe("CONFIRMATIONS_BY_CHAIN", () => {
  it("matches SDD §4.2 + §5.3 REORG_DEPTH_BY_CHAIN table", () => {
    expect(CONFIRMATIONS_BY_CHAIN[1]).toBe(12n);
    expect(CONFIRMATIONS_BY_CHAIN[10]).toBe(0n);
    expect(CONFIRMATIONS_BY_CHAIN[8453]).toBe(0n);
    expect(CONFIRMATIONS_BY_CHAIN[42161]).toBe(0n);
    expect(CONFIRMATIONS_BY_CHAIN[7777777]).toBe(0n);
    expect(CONFIRMATIONS_BY_CHAIN[80094]).toBe(200n);
  });

  it("falls back to 12 for unknown chains", () => {
    expect(confirmationsFor(999999)).toBe(DEFAULT_CONFIRMATIONS);
    expect(DEFAULT_CONFIRMATIONS).toBe(12n);
  });
});

describe("isLiveEvent — Ethereum (12-block reorg window)", () => {
  beforeEach(() => __resetHeadCacheForTests());

  it("returns true when event is exactly at head", async () => {
    const event = { block: { number: 1000n } };
    const ctx = mockContext(1, 1000n);
    expect(await isLiveEvent(event, ctx)).toBe(true);
  });

  it("returns true when event is within 11 blocks of head", async () => {
    const event = { block: { number: 989n } };
    const ctx = mockContext(1, 1000n);
    expect(await isLiveEvent(event, ctx)).toBe(true);
  });

  it("returns false at exactly the reorg boundary (head - event = 12)", async () => {
    const event = { block: { number: 988n } };
    const ctx = mockContext(1, 1000n);
    expect(await isLiveEvent(event, ctx)).toBe(false);
  });

  it("returns false for events deep in cold-sync territory", async () => {
    const event = { block: { number: 100n } };
    const ctx = mockContext(1, 1_000_000n);
    expect(await isLiveEvent(event, ctx)).toBe(false);
  });
});

describe("isLiveEvent — Berachain (200-block reorg window)", () => {
  beforeEach(() => __resetHeadCacheForTests());

  it("returns true within the deep window (199 blocks)", async () => {
    const event = { block: { number: 9_801n } };
    const ctx = mockContext(80094, 10_000n);
    expect(await isLiveEvent(event, ctx)).toBe(true);
  });

  it("returns false at the 200-block boundary", async () => {
    const event = { block: { number: 9_800n } };
    const ctx = mockContext(80094, 10_000n);
    expect(await isLiveEvent(event, ctx)).toBe(false);
  });
});

describe("isLiveEvent — L2s (depth=0)", () => {
  beforeEach(() => __resetHeadCacheForTests());

  // At depth=0, no event satisfies (head - event < 0). isLiveEvent returns
  // false, which is CORRECT for L2s — the publish path is via the in-process
  // /ready gate (SDD §4.2 gate 2), not isLiveEvent. reorgSafeEmit's depth=0
  // branch inline-publishes regardless of isLiveEvent return.
  it.each([
    [10, "Optimism"],
    [8453, "Base"],
    [42161, "Arbitrum"],
    [7777777, "Zora"],
  ])("chain %d (%s) — head==event is NOT live (preserves L2 semantic)", async (chainId) => {
    const event = { block: { number: 1000n } };
    const ctx = mockContext(chainId, 1000n);
    expect(await isLiveEvent(event, ctx)).toBe(false);
  });
});

describe("isLiveEvent — clock skew + reorg edge cases", () => {
  beforeEach(() => __resetHeadCacheForTests());

  it("returns true when head < event (RPC lag / clock skew)", async () => {
    const event = { block: { number: 1000n } };
    const ctx = mockContext(1, 995n);
    expect(await isLiveEvent(event, ctx)).toBe(true);
  });

  it("delayed blocks: event 100 vs head 200 → not live", async () => {
    const event = { block: { number: 100n } };
    const ctx = mockContext(1, 200n);
    expect(await isLiveEvent(event, ctx)).toBe(false);
  });
});

describe("head cache", () => {
  beforeEach(() => __resetHeadCacheForTests());

  it("uses cached head within TTL window", async () => {
    let getBlockCalls = 0;
    const ctx = {
      client: {
        getBlock: async () => {
          getBlockCalls++;
          return { number: 1000n };
        },
      },
      chain: { id: 1 },
    };
    const event = { block: { number: 999n } };

    expect(await isLiveEvent(event, ctx)).toBe(true);
    expect(await isLiveEvent(event, ctx)).toBe(true);
    expect(await isLiveEvent(event, ctx)).toBe(true);

    expect(getBlockCalls).toBe(1);
  });
});
