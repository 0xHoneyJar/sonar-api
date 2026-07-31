/*
 * tracked-erc1155.test.ts — the ERC-1155 lane.
 *
 * Two things here can only be got wrong silently, so both are asserted directly:
 *
 *  1. DELETE-AT-ZERO. A wallet at balance 0 must have its row deleted, not
 *     stored as 0 — an absent row and a zero row would both read as "holds none"
 *     and double-count in any holder aggregate.
 *  2. THE BATCH FOLD. A TransferBatch may name the same tokenId twice. The legs
 *     must be summed BEFORE any balance read, or the second leg reads a stale
 *     balance and overwrites the first.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { captured } = vi.hoisted(() => ({
  captured: { single: null as any, batch: null as any },
}));

vi.mock("envio", () => ({
  indexer: {
    onEvent: (id: { contract?: string; event?: string }, cb: any) => {
      if (id?.contract !== "TrackedErc1155") return;
      if (id.event === "TransferSingle") captured.single = cb;
      if (id.event === "TransferBatch") captured.batch = cb;
    },
    contractRegister: () => {},
    onBlock: () => {},
    onSlot: () => {},
  },
}));

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const CONTRACT = "0x00000000000000000000000000000000000c1155";
const ALICE = "0x000000000000000000000000000000000000a11ce";
const BOB = "0x0000000000000000000000000000000000000b0b0";

/** In-memory stand-in for the entity store, so balances persist across events. */
function makeContext(isPreload = false) {
  const holders = new Map<string, any>();
  const actions: any[] = [];
  const deleted: string[] = [];
  return {
    store: holders,
    actions,
    deleted,
    isPreload,
    TrackedHolder1155: {
      get: async (id: string) => holders.get(id),
      set: (r: any) => holders.set(r.id, r),
      deleteUnsafe: (id: string) => {
        holders.delete(id);
        deleted.push(id);
      },
    },
    Action: { set: (a: any) => actions.push(a) },
  };
}

function single(from: string, to: string, id: bigint, value: bigint, logIndex = 0) {
  return {
    srcAddress: CONTRACT,
    chainId: 8453,
    logIndex,
    params: { operator: from, from, to, id, value },
    block: { timestamp: 1_750_000_000, number: 1_000_000 },
    transaction: { hash: `0xtx${logIndex}`, transactionIndex: 3 },
  };
}

function batch(from: string, to: string, ids: bigint[], values: bigint[], logIndex = 0) {
  return {
    srcAddress: CONTRACT,
    chainId: 8453,
    logIndex,
    params: { operator: from, from, to, ids, values },
    block: { timestamp: 1_750_000_000, number: 1_000_000 },
    transaction: { hash: `0xtxb${logIndex}`, transactionIndex: 3 },
  };
}

const balances = (ctx: any) =>
  Object.fromEntries([...ctx.store.values()].map((r: any) => [`${r.address}:${r.tokenId}`, r.balance]));

describe("ERC-1155 lane", () => {
  beforeEach(async () => {
    captured.single = null;
    captured.batch = null;
    vi.resetModules();
    await import("../src/handlers/tracked-erc1155");
    expect(captured.single, "TransferSingle did not register").not.toBeNull();
    expect(captured.batch, "TransferBatch did not register").not.toBeNull();
  });

  it("credits the recipient on a mint", async () => {
    const ctx = makeContext();
    await captured.single({ event: single(ZERO, ALICE, 7n, 5n), context: ctx });
    expect(balances(ctx)).toEqual({ [`${ALICE}:7`]: 5n });
    expect(ctx.actions.some((a) => a.actionType === "mint1155")).toBe(true);
  });

  it("moves balance from sender to recipient on a transfer", async () => {
    const ctx = makeContext();
    await captured.single({ event: single(ZERO, ALICE, 7n, 5n, 0), context: ctx });
    await captured.single({ event: single(ALICE, BOB, 7n, 2n, 1), context: ctx });
    expect(balances(ctx)).toEqual({ [`${ALICE}:7`]: 3n, [`${BOB}:7`]: 2n });
  });

  it("DELETES the row at zero instead of storing a zero balance", async () => {
    const ctx = makeContext();
    await captured.single({ event: single(ZERO, ALICE, 7n, 2n, 0), context: ctx });
    await captured.single({ event: single(ALICE, BOB, 7n, 2n, 1), context: ctx });
    const aliceId = `${CONTRACT}_8453_7_${ALICE}`;
    expect(ctx.store.has(aliceId), "zero-balance row must not persist").toBe(false);
    expect(ctx.deleted).toContain(aliceId);
    expect(balances(ctx)).toEqual({ [`${BOB}:7`]: 2n });
  });

  it("debits the burner and credits nobody on a burn", async () => {
    const ctx = makeContext();
    await captured.single({ event: single(ZERO, ALICE, 7n, 3n, 0), context: ctx });
    await captured.single({ event: single(ALICE, DEAD, 7n, 1n, 1), context: ctx });
    expect(balances(ctx)).toEqual({ [`${ALICE}:7`]: 2n });
    expect(ctx.actions.some((a) => a.actionType === "burn1155")).toBe(true);
  });

  it("SUMS duplicate tokenIds within one TransferBatch", async () => {
    // The whole reason aggregateBatchDeltas exists: applying these legs
    // independently would make the second read a stale balance and overwrite
    // the first, landing 2 instead of 3.
    const ctx = makeContext();
    await captured.batch({ event: batch(ZERO, ALICE, [7n, 7n], [1n, 2n]), context: ctx });
    expect(balances(ctx)).toEqual({ [`${ALICE}:7`]: 3n });
  });

  it("handles a multi-token batch independently per tokenId", async () => {
    const ctx = makeContext();
    await captured.batch({ event: batch(ZERO, ALICE, [1n, 2n, 3n], [10n, 20n, 30n]), context: ctx });
    expect(balances(ctx)).toEqual({
      [`${ALICE}:1`]: 10n,
      [`${ALICE}:2`]: 20n,
      [`${ALICE}:3`]: 30n,
    });
  });

  it("ignores zero-quantity legs", async () => {
    const ctx = makeContext();
    await captured.single({ event: single(ZERO, ALICE, 7n, 0n), context: ctx });
    expect(ctx.store.size).toBe(0);
  });

  it("writes nothing during the preload pass", async () => {
    const ctx = makeContext(true);
    await captured.single({ event: single(ZERO, ALICE, 7n, 5n), context: ctx });
    expect(ctx.store.size).toBe(0);
    expect(ctx.actions.length).toBe(0);
  });

  it("stamps exact event identity on every Action", async () => {
    const ctx = makeContext();
    await captured.single({ event: single(ZERO, ALICE, 7n, 5n), context: ctx });
    expect(ctx.actions.length).toBeGreaterThan(0);
    for (const a of ctx.actions) {
      expect(a.blockNumber).toBe(1_000_000n);
      expect(a.transactionIndex).toBe(3);
    }
  });

  it("gives every Action in one batch a distinct id", async () => {
    const ctx = makeContext();
    await captured.batch({ event: batch(ZERO, ALICE, [1n, 2n, 3n], [1n, 1n, 1n]), context: ctx });
    const ids = ctx.actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
