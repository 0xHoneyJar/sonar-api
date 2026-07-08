/*
 * token-ownership-index.test.ts — EVM Onboarding Sprint 1 (FR-2, #153).
 *
 * Two things this file proves:
 *  1. Task 1.1 (schema @index): `type Token` carries @index on owner/collection/isBurned — the three
 *     fields inventory-api#27's getNftsForOwner query filters on (schema.graphql, matching indexed peers).
 *  2. Task 1.2 (FR-2c reconciliation invariant, SDD §3.3): the enumerable per-token ownership list and the
 *     aggregate holder balance move in lockstep. Concretely, for any owner:
 *         count(Token rows where owner==X AND !isBurned) === Holder(X).balance
 *     This is the invariant getNftsForOwner depends on — if a token silently drops from enumeration, the
 *     list and the count diverge. Exercised against the REAL writer (src/lib/erc721-holders.ts) with an
 *     in-memory mock context (no live RPC/Hasura), mirroring test/erc1155-holder.test.ts + incremental-reconcile.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { processErc721Transfer, type Erc721TransferEventLike } from "../src/lib/erc721-holders";
import { updateTokenOwnership as updateTrackedToken } from "../src/handlers/tracked-erc721";
import { updateTokenOwnership as updateMiberaToken } from "../src/handlers/mibera-collection";
import { ZERO_ADDRESS } from "../src/handlers/constants";

const COLLECTION = "0xCollEction00000000000000000000000000000001";
const CHAIN = 1;
const ZERO = ZERO_ADDRESS.toLowerCase();

// --- minimal in-memory entity store mimicking Envio's context.<Entity> surface ---
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
    Holder: makeStore<any>(),
    Transfer: makeStore<any>(),
    CollectionStat: makeStore<any>(),
  };
}
type Ctx = ReturnType<typeof makeContext>;

let logIx = 0;
function xfer(from: string, to: string, tokenId: bigint): Erc721TransferEventLike {
  const ix = logIx++;
  return {
    params: { from, to, tokenId },
    srcAddress: COLLECTION,
    transaction: { hash: `0xtx${ix}` },
    block: { timestamp: 1_700_000_000 + ix, number: 100 + ix },
    logIndex: ix,
    chainId: CHAIN,
  };
}

async function apply(ctx: Ctx, from: string, to: string, tokenId: bigint) {
  await processErc721Transfer({ event: xfer(from, to, tokenId), context: ctx as any });
}

/** the "getNftsForOwner" side: enumerable, non-burned Token rows for an owner */
function enumeratedTokenCount(ctx: Ctx, owner: string): number {
  const o = owner.toLowerCase();
  return [...ctx.Token.map.values()].filter((t) => t.owner === o && !t.isBurned).length;
}
/** the aggregate side: Holder.balance */
function holderBalance(ctx: Ctx, owner: string): number {
  const h = ctx.Holder.map.get(`${COLLECTION.toLowerCase()}_${CHAIN}_${owner.toLowerCase()}`);
  return h?.balance ?? 0;
}

const A = "0xAAAA000000000000000000000000000000000001";
const B = "0xBBBB000000000000000000000000000000000002";

describe("Token ownership index — FR-2c reconciliation invariant (enumeration === holder balance)", () => {
  it("mint N → N enumerable tokens AND Holder.balance === N", async () => {
    const ctx = makeContext();
    await apply(ctx, ZERO, A, 1n);
    await apply(ctx, ZERO, A, 2n);
    await apply(ctx, ZERO, A, 3n);

    expect(enumeratedTokenCount(ctx, A)).toBe(3);
    expect(holderBalance(ctx, A)).toBe(3);
    expect(enumeratedTokenCount(ctx, A)).toBe(holderBalance(ctx, A)); // the invariant
  });

  it("secondary transfer preserves the invariant for BOTH parties", async () => {
    const ctx = makeContext();
    await apply(ctx, ZERO, A, 1n);
    await apply(ctx, ZERO, A, 2n);
    await apply(ctx, A, B, 2n); // A sends token 2 to B

    expect(enumeratedTokenCount(ctx, A)).toBe(holderBalance(ctx, A));
    expect(enumeratedTokenCount(ctx, B)).toBe(holderBalance(ctx, B));
    expect(holderBalance(ctx, A)).toBe(1);
    expect(holderBalance(ctx, B)).toBe(1);
  });

  it("burn drops the token from enumeration AND balance in lockstep", async () => {
    const ctx = makeContext();
    await apply(ctx, ZERO, A, 1n);
    await apply(ctx, ZERO, A, 2n);
    await apply(ctx, A, ZERO, 1n); // burn token 1

    // token 1 is marked burned (still a row, but excluded from enumeration)
    const t1 = ctx.Token.map.get(`${COLLECTION.toLowerCase()}_${CHAIN}_1`);
    expect(t1.isBurned).toBe(true);
    expect(enumeratedTokenCount(ctx, A)).toBe(1);
    expect(enumeratedTokenCount(ctx, A)).toBe(holderBalance(ctx, A));
  });

  it("has teeth: silently dropping a Token row breaks the invariant (negative control)", async () => {
    const ctx = makeContext();
    await apply(ctx, ZERO, A, 1n);
    await apply(ctx, ZERO, A, 2n);
    expect(enumeratedTokenCount(ctx, A)).toBe(holderBalance(ctx, A)); // holds first

    // simulate the #153 failure: a token missing from the enumerable index
    ctx.Token.map.delete(`${COLLECTION.toLowerCase()}_${CHAIN}_1`);
    expect(enumeratedTokenCount(ctx, A)).not.toBe(holderBalance(ctx, A)); // detected
  });
});

describe("Token ownership index — ported population wiring (#153, the actual fix)", () => {
  const MIBERA = "0x6666397dfe9a8c469bf65dc744cb1c733416c420";
  const BERA = 80094;

  it("tracked-erc721 path: writes Token{owner=to}, keyed collection_chainId_tokenId (Tarot/Fractures)", async () => {
    const ctx = makeContext();
    const c = "0xtarot0000000000000000000000000000000099";
    await updateTrackedToken({ context: ctx as any, contractAddress: c, chainId: 1, tokenId: 7n, from: ZERO, to: A, timestamp: 1n });
    const t = ctx.Token.map.get(`${c}_1_7`);
    expect(t).toBeDefined();
    expect(t.owner).toBe(A);
    expect(t.isBurned).toBe(false);
    expect(t.mintedAt).toBe(1n); // from ZERO ⇒ mint
  });

  it("tracked-erc721 path: burn (to burn address) sets owner=ZERO + isBurned=true (excluded from enumeration)", async () => {
    const ctx = makeContext();
    const c = "0xtarot0000000000000000000000000000000099";
    await updateTrackedToken({ context: ctx as any, contractAddress: c, chainId: 1, tokenId: 7n, from: ZERO, to: A, timestamp: 1n });
    await updateTrackedToken({ context: ctx as any, contractAddress: c, chainId: 1, tokenId: 7n, from: A, to: ZERO, timestamp: 2n });
    const t = ctx.Token.map.get(`${c}_1_7`);
    expect(t.isBurned).toBe(true);
    expect(t.owner).toBe(ZERO);
  });

  it("mibera path: writes Token for 0x6666… on BERACHAIN with effectiveOwner (staking keeps user as owner)", async () => {
    const ctx = makeContext();
    // normal transfer: effectiveOwner = to
    await updateMiberaToken({ context: ctx as any, tokenId: 66n, from: ZERO, effectiveOwner: A, timestamp: 1n });
    const t = ctx.Token.map.get(`${MIBERA}_${BERA}_66`);
    expect(t).toBeDefined();
    expect(t.collection).toBe(MIBERA);
    expect(t.chainId).toBe(BERA);
    expect(t.owner).toBe(A);
    expect(t.isBurned).toBe(false);
  });

  it("mibera path: this is what #153/inventory-api#27 needed — Token rows now enumerable for an owner", async () => {
    const ctx = makeContext();
    await updateMiberaToken({ context: ctx as any, tokenId: 1n, from: ZERO, effectiveOwner: A, timestamp: 1n });
    await updateMiberaToken({ context: ctx as any, tokenId: 2n, from: ZERO, effectiveOwner: A, timestamp: 1n });
    const owned = [...ctx.Token.map.values()].filter((t) => t.owner === A && !t.isBurned);
    expect(owned.map((t) => t.tokenId).sort()).toEqual([1n, 2n]); // getNftsForOwner(A) would return [1,2], not []
  });
});

describe("Token ownership index — Task 1.1 schema @index (inventory-api#27 query fields)", () => {
  const schema = readFileSync("schema.graphql", "utf8");
  const tokenBlock = schema.slice(schema.indexOf("type Token {"), schema.indexOf("}", schema.indexOf("type Token {")) + 1);

  it("indexes the three fields getNftsForOwner filters on", () => {
    expect(tokenBlock).toMatch(/owner:\s*String!\s*@index/);
    expect(tokenBlock).toMatch(/collection:\s*String!\s*@index/);
    expect(tokenBlock).toMatch(/isBurned:\s*Boolean!\s*@index/);
  });
});
