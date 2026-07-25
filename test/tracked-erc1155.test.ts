/*
 * tracked-erc1155.test.ts — generic ERC-1155 preparation (sonar-api#185/#186/#200).
 *
 * Exercises the REAL handler (src/handlers/tracked-erc1155.ts) against an
 * in-memory context, mirroring test/token-ownership-index.test.ts.
 *
 * The property under test is the one an ERC-721-shaped model gets wrong:
 * ERC-1155 balances are per-id and NON-EXCLUSIVE, so two wallets hold the same
 * tokenId at the same time and neither is "the owner".
 */
import { describe, expect, it } from "vitest";

import {
  handleTrackedErc1155TransferBatch,
  handleTrackedErc1155TransferSingle,
} from "../src/handlers/tracked-erc1155";
import { erc1155HolderId } from "../src/lib/erc1155-holder";
import { ZERO_ADDRESS } from "../src/handlers/constants";

const CONTRACT = "0xecA03517c5195F1edD634DA6D690D6c72407c40c";
const CONTRACT_LOWER = CONTRACT.toLowerCase();
const CHAIN = 80094;
const ZERO = ZERO_ADDRESS.toLowerCase();
const DEAD = "0x000000000000000000000000000000000000dEaD".toLowerCase();
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";

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
  return { TrackedHolder: makeStore<any>(), TrackedHolder1155: makeStore<any>() };
}
type Ctx = ReturnType<typeof makeContext>;

let ts = 1_700_000_000;

const single = (ctx: Ctx, from: string, to: string, id: bigint, value: bigint) =>
  handleTrackedErc1155TransferSingle(
    {
      srcAddress: CONTRACT,
      chainId: CHAIN,
      params: { from, to, id, value },
      block: { timestamp: ts++ },
    },
    ctx as any,
  );

const batch = (
  ctx: Ctx,
  from: string,
  to: string,
  ids: bigint[],
  values: bigint[],
) =>
  handleTrackedErc1155TransferBatch(
    {
      srcAddress: CONTRACT,
      chainId: CHAIN,
      params: { from, to, ids, values },
      block: { timestamp: ts++ },
    },
    ctx as any,
  );

const balance = (ctx: Ctx, tokenId: bigint, holder: string): bigint | undefined =>
  ctx.TrackedHolder1155.map.get(
    erc1155HolderId(CONTRACT_LOWER, CHAIN, tokenId, holder),
  )?.balance;

const aggregate = (ctx: Ctx, holder: string): number | undefined =>
  ctx.TrackedHolder.map.get(`${CONTRACT_LOWER}_${CHAIN}_${holder.toLowerCase()}`)
    ?.tokenCount;

describe("generic tracked ERC-1155 handler", () => {
  it("credits a mint and debits a transfer per tokenId", async () => {
    const ctx = makeContext();
    await single(ctx, ZERO, ALICE, 7n, 10n);
    expect(balance(ctx, 7n, ALICE)).toBe(10n);
    expect(aggregate(ctx, ALICE)).toBe(10);

    await single(ctx, ALICE, BOB, 7n, 4n);
    expect(balance(ctx, 7n, ALICE)).toBe(6n);
    expect(balance(ctx, 7n, BOB)).toBe(4n);
    expect(aggregate(ctx, ALICE)).toBe(6);
    expect(aggregate(ctx, BOB)).toBe(4);
  });

  it("lets two wallets hold the same tokenId at once (non-exclusive)", async () => {
    const ctx = makeContext();
    await single(ctx, ZERO, ALICE, 1n, 3n);
    await single(ctx, ZERO, BOB, 1n, 5n);
    expect(balance(ctx, 1n, ALICE)).toBe(3n);
    expect(balance(ctx, 1n, BOB)).toBe(5n);
  });

  it("deletes the row when a balance burns to zero", async () => {
    const ctx = makeContext();
    await single(ctx, ZERO, ALICE, 2n, 5n);
    await single(ctx, ALICE, DEAD, 2n, 5n);

    expect(balance(ctx, 2n, ALICE)).toBeUndefined();
    // Burn address is not a holder.
    expect(balance(ctx, 2n, DEAD)).toBeUndefined();
    expect(aggregate(ctx, ALICE)).toBeUndefined();
    expect(aggregate(ctx, DEAD)).toBeUndefined();
  });

  it("clamps at zero rather than storing a negative balance", async () => {
    const ctx = makeContext();
    await single(ctx, ZERO, ALICE, 3n, 2n);
    // More than held — nextBalance floors at zero and deletes.
    await single(ctx, ALICE, BOB, 3n, 5n);
    expect(balance(ctx, 3n, ALICE)).toBeUndefined();
    expect(balance(ctx, 3n, BOB)).toBe(5n);
  });

  it("applies TransferBatch per tokenId and folds a repeated id", async () => {
    const ctx = makeContext();
    await batch(ctx, ZERO, ALICE, [10n, 11n, 10n], [1n, 2n, 4n]);
    expect(balance(ctx, 10n, ALICE)).toBe(5n);
    expect(balance(ctx, 11n, ALICE)).toBe(2n);
    // Aggregate is total units, not distinct ids.
    expect(aggregate(ctx, ALICE)).toBe(7);

    await batch(ctx, ALICE, BOB, [10n, 11n], [5n, 1n]);
    expect(balance(ctx, 10n, ALICE)).toBeUndefined();
    expect(balance(ctx, 11n, ALICE)).toBe(1n);
    expect(balance(ctx, 10n, BOB)).toBe(5n);
    expect(balance(ctx, 11n, BOB)).toBe(1n);
    expect(aggregate(ctx, ALICE)).toBe(1);
    expect(aggregate(ctx, BOB)).toBe(6);
  });

  it("ignores zero-value moves", async () => {
    const ctx = makeContext();
    await single(ctx, ZERO, ALICE, 4n, 0n);
    await batch(ctx, ZERO, ALICE, [4n], [0n]);
    expect(ctx.TrackedHolder1155.map.size).toBe(0);
    expect(ctx.TrackedHolder.map.size).toBe(0);
  });

  it("treats a self-transfer as a no-op", async () => {
    const ctx = makeContext();
    await single(ctx, ZERO, ALICE, 5n, 3n);
    await single(ctx, ALICE, ALICE, 5n, 3n);
    expect(balance(ctx, 5n, ALICE)).toBe(3n);
    expect(aggregate(ctx, ALICE)).toBe(3);
  });

  it("never writes a one-owner-per-token entity", async () => {
    const ctx = makeContext();
    await single(ctx, ZERO, ALICE, 6n, 1n);
    // Token is the ERC-721 shape; a 1155 row landing there would be the bug.
    expect((ctx as Record<string, unknown>).Token).toBeUndefined();
  });
});
