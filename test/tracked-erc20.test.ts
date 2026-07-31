/*
 * tracked-erc20.test.ts — the ERC-20 lane.
 *
 * Same delete-at-zero rule as the other lanes, and the same preload discipline.
 * The lane is deliberately plain — balances plus an Action stream — so these
 * tests are mostly about the boundaries: zero-value transfers, burns, and the
 * fact that a fully-drained wallet leaves no row behind.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { captured } = vi.hoisted(() => ({ captured: { handler: null as any } }));

vi.mock("envio", () => ({
  indexer: {
    onEvent: (id: { contract?: string; event?: string }, cb: any) => {
      if (id?.contract === "TrackedErc20" && id?.event === "Transfer") captured.handler = cb;
    },
    contractRegister: () => {},
    onBlock: () => {},
    onSlot: () => {},
  },
}));

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const TOKEN = "0x0000000000000000000000000000000000erc020";
const ALICE = "0x000000000000000000000000000000000000a11ce";
const BOB = "0x0000000000000000000000000000000000000b0b0";

function makeContext(isPreload = false) {
  const store = new Map<string, any>();
  const actions: any[] = [];
  const deleted: string[] = [];
  return {
    store,
    actions,
    deleted,
    isPreload,
    TrackedTokenBalance: {
      get: async (id: string) => store.get(id),
      set: (r: any) => store.set(r.id, r),
      deleteUnsafe: (id: string) => {
        store.delete(id);
        deleted.push(id);
      },
    },
    Action: { set: (a: any) => actions.push(a) },
  };
}

const ev = (from: string, to: string, value: bigint, logIndex = 0) => ({
  srcAddress: TOKEN,
  chainId: 1,
  logIndex,
  params: { from, to, value },
  block: { timestamp: 1_750_000_000, number: 2_000_000 },
  transaction: { hash: `0xtx${logIndex}`, transactionIndex: 9 },
});

const balances = (ctx: any) =>
  Object.fromEntries([...ctx.store.values()].map((r: any) => [r.address, r.balance]));

describe("ERC-20 lane", () => {
  beforeEach(async () => {
    captured.handler = null;
    vi.resetModules();
    await import("../src/handlers/tracked-erc20");
    expect(captured.handler, "handler did not self-register").not.toBeNull();
  });

  it("credits the recipient on a mint", async () => {
    const ctx = makeContext();
    await captured.handler({ event: ev(ZERO, ALICE, 1000n), context: ctx });
    expect(balances(ctx)).toEqual({ [ALICE]: 1000n });
    expect(ctx.actions.some((a) => a.actionType === "mint20")).toBe(true);
  });

  it("moves balance from sender to recipient", async () => {
    const ctx = makeContext();
    await captured.handler({ event: ev(ZERO, ALICE, 1000n, 0), context: ctx });
    await captured.handler({ event: ev(ALICE, BOB, 400n, 1), context: ctx });
    expect(balances(ctx)).toEqual({ [ALICE]: 600n, [BOB]: 400n });
  });

  it("DELETES the row when a wallet is fully drained", async () => {
    const ctx = makeContext();
    await captured.handler({ event: ev(ZERO, ALICE, 500n, 0), context: ctx });
    await captured.handler({ event: ev(ALICE, BOB, 500n, 1), context: ctx });
    const aliceId = `${ALICE}_${TOKEN}_1`;
    expect(ctx.store.has(aliceId), "zero-balance row must not persist").toBe(false);
    expect(ctx.deleted).toContain(aliceId);
    expect(balances(ctx)).toEqual({ [BOB]: 500n });
  });

  it("debits the burner on a burn to the dead address", async () => {
    const ctx = makeContext();
    await captured.handler({ event: ev(ZERO, ALICE, 100n, 0), context: ctx });
    await captured.handler({ event: ev(ALICE, DEAD, 40n, 1), context: ctx });
    expect(balances(ctx)).toEqual({ [ALICE]: 60n });
    expect(ctx.actions.some((a) => a.actionType === "burn20")).toBe(true);
  });

  it("ignores a zero-value transfer", async () => {
    const ctx = makeContext();
    await captured.handler({ event: ev(ALICE, BOB, 0n), context: ctx });
    expect(ctx.store.size).toBe(0);
    expect(ctx.actions.length).toBe(0);
  });

  it("writes nothing during the preload pass", async () => {
    const ctx = makeContext(true);
    await captured.handler({ event: ev(ZERO, ALICE, 1000n), context: ctx });
    expect(ctx.store.size).toBe(0);
    expect(ctx.actions.length).toBe(0);
  });

  it("stamps exact event identity on every Action", async () => {
    const ctx = makeContext();
    await captured.handler({ event: ev(ZERO, ALICE, 1000n), context: ctx });
    expect(ctx.actions.length).toBeGreaterThan(0);
    for (const a of ctx.actions) {
      expect(a.blockNumber).toBe(2_000_000n);
      expect(a.transactionIndex).toBe(9);
    }
  });

  it("never stores a negative balance", async () => {
    // A transfer out of a wallet the belt never saw funded (mid-history start)
    // must floor at zero and delete, not go negative.
    const ctx = makeContext();
    await captured.handler({ event: ev(ALICE, BOB, 50n), context: ctx });
    for (const r of ctx.store.values()) expect(r.balance).toBeGreaterThan(0n);
    expect(ctx.store.has(`${ALICE}_${TOKEN}_1`)).toBe(false);
  });
});
