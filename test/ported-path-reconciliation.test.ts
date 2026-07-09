/*
 * ported-path-reconciliation.test.ts — EVM Sprint 1.6 hardening (SHANNON F3 + AUD-001).
 *
 * The now-LIVE ported Token↔Holder logic (Mibera Token index + reconciliation)
 * was flagged UNTESTED: the existing reconciliation tests (token-ownership-index.test.ts)
 * route through src/lib/erc721-holders.ts — a DIFFERENT writer + a DIFFERENT
 * holder entity (Holder). Production traffic runs through the tracked-erc721 and
 * mibera-collection handlers, which write the Token entity via writeTokenOwnership
 * and maintain the TrackedHolder count via their own `adjustHolder`. THIS file
 * exercises those real production paths and pins two things:
 *
 *  F3  — reconciliation invariant on the ported writers:
 *          count(Token where owner==X AND !isBurned) === TrackedHolder(X).tokenCount
 *        at every step of mint → transfer → burn (tracked) and mint → transfer →
 *        stake → burn (mibera). The staking step is the subtle one: a deposit keeps
 *        the user as Token owner AND does not decrement the holder count, so the
 *        invariant must still hold across a stake.
 *
 *  AUD-001 — wiring: a transfer through each handler actually INVOKES the Token
 *        writer (a Token row appears). A future edit that drops the
 *        updateTokenOwnership call fails these tests.
 *
 * Tracked path: handleTrackedErc721Transfer is exported → called directly.
 * Mibera path: the handler self-registers via indexer.onEvent (no export) → we
 *   capture the registered closure with an `envio` spy (mirrors
 *   test/seaport-mainnet-sale.test.ts) and drive it with synthetic Transfer events.
 *   This exercises the FULL closure: resolveEffectiveOwner + updateTokenOwnership +
 *   adjustHolder + the staking helpers, wired exactly as production runs them.
 *
 * In-memory mock context (no live RPC/Hasura), mirroring the store pattern in
 * test/token-ownership-index.test.ts.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

import { handleTrackedErc721Transfer } from "../src/handlers/tracked-erc721";
import { ZERO_ADDRESS } from "../src/handlers/constants";
import { PADDLEFI_VAULT } from "../src/handlers/mibera-staking/constants";

// Capture the MiberaCollection Transfer closure registered at module load.
const { captured } = vi.hoisted(() => ({
  captured: { mibera: null as null | ((arg: any) => Promise<void>) },
}));

vi.mock("envio", () => ({
  indexer: {
    onEvent: (
      id: { contract?: string; event?: string },
      cb: (arg: any) => Promise<void>,
    ) => {
      if (id?.contract === "MiberaCollection" && id?.event === "Transfer") {
        captured.mibera = cb;
      }
    },
    contractRegister: () => {},
    onBlock: () => {},
    onSlot: () => {},
  },
  // Type-only exports are erased at compile time — no runtime binding needed.
}));

const ZERO = ZERO_ADDRESS.toLowerCase();
const A = "0xaaaa000000000000000000000000000000000001";
const B = "0xbbbb000000000000000000000000000000000002";

const MIBERA = "0x6666397dfe9a8c469bf65dc744cb1c733416c420";
const BERA = 80094;

// --- in-memory entity store (mirrors token-ownership-index.test.ts) ---
function makeStore<T extends { id: string }>() {
  const map = new Map<string, T>();
  return {
    map,
    get: async (id: string): Promise<T | undefined> => map.get(id),
    set: (e: T) => void map.set(e.id, e),
    deleteUnsafe: (id: string) => void map.delete(id),
  };
}

function makeContext() {
  return {
    Token: makeStore<any>(),
    TrackedHolder: makeStore<any>(),
    Action: makeStore<any>(),
    MiberaTransfer: makeStore<any>(),
    MintActivity: makeStore<any>(),
    NftBurn: makeStore<any>(),
    NftBurnStats: makeStore<any>(),
    MiberaStakedToken: makeStore<any>(),
    MiberaStaker: makeStore<any>(),
    // publishMintEvent (mibera mint path) is fail-soft with no NATS env — it
    // logs once via warn and returns; provide the minimal logger surface.
    log: { warn: () => {}, info: () => {} },
  };
}
type Ctx = ReturnType<typeof makeContext>;

// enumeration side: non-burned Token rows for an owner within a collection/chain
function enumeratedTokenCount(ctx: Ctx, collection: string, owner: string): number {
  const o = owner.toLowerCase();
  return [...ctx.Token.map.values()].filter(
    (t) => t.collection === collection && t.owner === o && !t.isBurned,
  ).length;
}
// aggregate side: TrackedHolder.tokenCount (0 when the holder row is absent/deleted)
function holderCount(ctx: Ctx, collection: string, chainId: number, owner: string): number {
  const h = ctx.TrackedHolder.map.get(`${collection}_${chainId}_${owner.toLowerCase()}`);
  return h?.tokenCount ?? 0;
}

let logIx = 0;
function trackedEvent(collection: string, chainId: number, from: string, to: string, tokenId: bigint) {
  const ix = logIx++;
  return {
    srcAddress: collection,
    chainId,
    logIndex: ix,
    params: { from, to, tokenId },
    transaction: { hash: `0xtx${ix}` },
    block: { timestamp: 1_700_000_000 + ix, number: 100 + ix },
  };
}
function miberaEvent(from: string, to: string, tokenId: bigint) {
  const ix = logIx++;
  return {
    params: { from, to, tokenId },
    logIndex: ix,
    transaction: { hash: `0xmb${ix}` }, // no `value` → amountPaid = 0n
    block: { timestamp: 1_700_000_000 + ix, number: 100 + ix },
  };
}

// ---------------------------------------------------------------------------
// Tracked ERC-721 path (Tarot/Fractures-class collection — no staking)
// ---------------------------------------------------------------------------
describe("tracked-erc721 ported path — Token↔TrackedHolder reconciliation (F3) + writer wiring (AUD-001)", () => {
  const TAROT = "0xtarot0000000000000000000000000000000099";
  const CHAIN = 1;

  async function apply(ctx: Ctx, from: string, to: string, tokenId: bigint) {
    await handleTrackedErc721Transfer(trackedEvent(TAROT, CHAIN, from, to, tokenId) as any, ctx as any);
  }

  it("AUD-001: a transfer INVOKES the Token writer (a Token row appears)", async () => {
    const ctx = makeContext();
    await apply(ctx, ZERO, A, 1n); // mint
    const t = ctx.Token.map.get(`${TAROT}_${CHAIN}_1`);
    expect(t, "handler did not write a Token row on transfer").toBeDefined();
    expect(t.owner).toBe(A);
  });

  it("F3: invariant holds across mint → transfer → burn for BOTH parties at every step", async () => {
    const ctx = makeContext();

    // mint token 1 and 2 to A
    await apply(ctx, ZERO, A, 1n);
    await apply(ctx, ZERO, A, 2n);
    expect(enumeratedTokenCount(ctx, TAROT, A)).toBe(2);
    expect(enumeratedTokenCount(ctx, TAROT, A)).toBe(holderCount(ctx, TAROT, CHAIN, A));

    // secondary transfer: A → B (token 2)
    await apply(ctx, A, B, 2n);
    expect(enumeratedTokenCount(ctx, TAROT, A)).toBe(holderCount(ctx, TAROT, CHAIN, A));
    expect(enumeratedTokenCount(ctx, TAROT, B)).toBe(holderCount(ctx, TAROT, CHAIN, B));
    expect(holderCount(ctx, TAROT, CHAIN, A)).toBe(1);
    expect(holderCount(ctx, TAROT, CHAIN, B)).toBe(1);

    // burn: A burns token 1 (to ZERO)
    await apply(ctx, A, ZERO, 1n);
    const t1 = ctx.Token.map.get(`${TAROT}_${CHAIN}_1`);
    expect(t1.isBurned).toBe(true); // excluded from enumeration
    expect(enumeratedTokenCount(ctx, TAROT, A)).toBe(0);
    expect(holderCount(ctx, TAROT, CHAIN, A)).toBe(0);
    expect(enumeratedTokenCount(ctx, TAROT, A)).toBe(holderCount(ctx, TAROT, CHAIN, A));
  });
});

// ---------------------------------------------------------------------------
// Mibera collection path (staking-aware) — driven through the REAL onEvent closure
// ---------------------------------------------------------------------------
describe("mibera-collection ported path — Token↔TrackedHolder reconciliation incl. staking (F3) + writer wiring (AUD-001)", () => {
  beforeAll(async () => {
    // Importing registers the onEvent handler → captures the closure.
    await import("../src/handlers/mibera-collection");
    expect(captured.mibera, "mibera-collection did not register a MiberaCollection.Transfer handler").not.toBeNull();
  });

  async function apply(ctx: Ctx, from: string, to: string, tokenId: bigint) {
    await captured.mibera!({ event: miberaEvent(from, to, tokenId), context: ctx });
  }

  it("AUD-001: a transfer INVOKES the Token writer (a Token row appears for 0x6666… on Berachain)", async () => {
    const ctx = makeContext();
    await apply(ctx, ZERO, A, 10n); // mint
    const t = ctx.Token.map.get(`${MIBERA}_${BERA}_10`);
    expect(t, "mibera handler did not write a Token row on transfer").toBeDefined();
    expect(t.collection).toBe(MIBERA);
    expect(t.chainId).toBe(BERA);
    expect(t.owner).toBe(A);
  });

  it("F3: invariant holds across mint → transfer → STAKE → burn (staking keeps the user as owner + does not decrement)", async () => {
    const ctx = makeContext();

    // mint token 1 and 2 to A
    await apply(ctx, ZERO, A, 1n);
    await apply(ctx, ZERO, A, 2n);
    expect(enumeratedTokenCount(ctx, MIBERA, A)).toBe(2);
    expect(enumeratedTokenCount(ctx, MIBERA, A)).toBe(holderCount(ctx, MIBERA, BERA, A));

    // secondary transfer: A → B (token 2)
    await apply(ctx, A, B, 2n);
    expect(enumeratedTokenCount(ctx, MIBERA, A)).toBe(holderCount(ctx, MIBERA, BERA, A));
    expect(enumeratedTokenCount(ctx, MIBERA, B)).toBe(holderCount(ctx, MIBERA, BERA, B));
    expect(holderCount(ctx, MIBERA, BERA, A)).toBe(1);
    expect(holderCount(ctx, MIBERA, BERA, B)).toBe(1);

    // STAKE: A deposits token 1 into the paddlefi vault.
    // Effective owner stays A (staked NFTs still count as held); holder NOT decremented.
    await apply(ctx, A, PADDLEFI_VAULT, 1n);
    const staked = ctx.Token.map.get(`${MIBERA}_${BERA}_1`);
    expect(staked.owner).toBe(A); // NOT the staking contract
    expect(staked.isBurned).toBe(false);
    expect(holderCount(ctx, MIBERA, BERA, A)).toBe(1); // unchanged by the stake
    expect(enumeratedTokenCount(ctx, MIBERA, A)).toBe(1);
    expect(enumeratedTokenCount(ctx, MIBERA, A)).toBe(holderCount(ctx, MIBERA, BERA, A)); // invariant across a stake
    // staking side-effects recorded
    expect(ctx.MiberaStakedToken.map.size).toBe(1);

    // BURN: B burns token 2 (to ZERO)
    await apply(ctx, B, ZERO, 2n);
    const t2 = ctx.Token.map.get(`${MIBERA}_${BERA}_2`);
    expect(t2.isBurned).toBe(true);
    expect(enumeratedTokenCount(ctx, MIBERA, B)).toBe(0);
    expect(holderCount(ctx, MIBERA, BERA, B)).toBe(0);
    expect(enumeratedTokenCount(ctx, MIBERA, B)).toBe(holderCount(ctx, MIBERA, BERA, B));
  });
});
