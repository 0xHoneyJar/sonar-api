/*
 * tracked-erc721-custody.test.ts — staking custody is a registry field.
 *
 * A Mibera deposited into paddlefi or jiko is still held by the depositor. When
 * the ERC-721 handler treats the vault as a normal counterparty it decrements
 * the staker and credits the vault: measured 2026-07-28, paddlefi held 455
 * Mibera and jiko 7 (balanceOf against 0x6666397dfe9a8c469bf65dc744cb1c733416c420
 * on Berachain 80094), so the vault would index as the collection's #1 holder
 * ahead of the real top wallet at 395 and 462 stakers would lose their credit.
 *
 * The handler reads `custodial` off src/registry/contracts.ts — no address
 * literals and no per-community branch — so any community that stakes gets the
 * same behavior from one registry entry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("envio", () => ({
  indexer: {
    onEvent: () => {},
    contractRegister: () => {},
    onBlock: () => {},
    onSlot: () => {},
  },
}));

import { handleTrackedErc721Transfer } from "../src/handlers/tracked-erc721";

const BERACHAIN = 80094;
const MIBERA = "0x6666397dfe9a8c469bf65dc744cb1c733416c420";
const PADDLEFI = "0x242b7126f3c4e4f8cbd7f62571293e63e9b0a4e1";
const JIKO = "0x8778ca41cf0b5cd2f9967ae06b691daff11db246";
const STAKER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";

function mockContext(seed: Array<{ address: string; tokenCount: number }> = []) {
  const holders = new Map<string, { id: string; tokenCount: number }>();
  for (const h of seed) {
    const id = `${MIBERA}_${BERACHAIN}_${h.address}`;
    holders.set(id, { id, tokenCount: h.tokenCount });
  }
  const tokens = new Map<string, Record<string, unknown>>();
  return {
    isPreload: false,
    holders,
    tokens,
    Action: { set: vi.fn() },
    TrackedHolder: {
      get: vi.fn(async (id: string) => holders.get(id)),
      set: vi.fn((h: { id: string; tokenCount: number }) => holders.set(h.id, h)),
      deleteUnsafe: vi.fn((id: string) => holders.delete(id)),
    },
    Token: {
      get: vi.fn(async (id: string) => tokens.get(id)),
      set: vi.fn((t: { id: string }) => tokens.set(t.id, t)),
    },
    MiberaTransfer: { set: vi.fn() },
    NftBurn: { set: vi.fn() },
    MintActivity: { set: vi.fn() },
  };
}

function transfer(from: string, to: string, tokenId: bigint, logIndex = 0) {
  return {
    srcAddress: MIBERA,
    chainId: BERACHAIN,
    logIndex,
    params: { from, to, tokenId },
    transaction: { hash: "0xdeadbeef" },
    block: { timestamp: 1_750_000_000, number: 5_000_000 },
  };
}

const holderCount = (ctx: ReturnType<typeof mockContext>, address: string) =>
  ctx.holders.get(`${MIBERA}_${BERACHAIN}_${address}`)?.tokenCount;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("custodial counterparties leave holder credit with the user", () => {
  it("keeps the staker's credit and creates none for the vault on deposit", async () => {
    const ctx = mockContext([{ address: STAKER, tokenCount: 3 }]);
    await handleTrackedErc721Transfer(
      transfer(STAKER, PADDLEFI, 42n) as never,
      ctx as never,
    );

    expect(holderCount(ctx, STAKER)).toBe(3);
    expect(holderCount(ctx, PADDLEFI)).toBeUndefined();
    expect(ctx.TrackedHolder.deleteUnsafe).not.toHaveBeenCalled();
  });

  it("does not double-credit on withdrawal back out of custody", async () => {
    const ctx = mockContext([{ address: STAKER, tokenCount: 3 }]);
    await handleTrackedErc721Transfer(
      transfer(JIKO, STAKER, 42n) as never,
      ctx as never,
    );

    expect(holderCount(ctx, STAKER)).toBe(3);
    expect(holderCount(ctx, JIKO)).toBeUndefined();
  });

  it("leaves Token{owner} on the staker so it reconciles with the holder count", async () => {
    const ctx = mockContext([{ address: STAKER, tokenCount: 1 }]);
    await handleTrackedErc721Transfer(
      transfer(STAKER, PADDLEFI, 42n) as never,
      ctx as never,
    );

    expect(ctx.tokens.get(`${MIBERA}_${BERACHAIN}_42`)?.owner).toBe(STAKER);
  });

  it("still moves credit on an ordinary transfer between two wallets", async () => {
    // Guard against over-correction: only registered custody addresses pass through.
    const ctx = mockContext([{ address: STAKER, tokenCount: 2 }]);
    await handleTrackedErc721Transfer(
      transfer(STAKER, BUYER, 42n) as never,
      ctx as never,
    );

    expect(holderCount(ctx, STAKER)).toBe(1);
    expect(holderCount(ctx, BUYER)).toBe(1);
    expect(ctx.tokens.get(`${MIBERA}_${BERACHAIN}_42`)?.owner).toBe(BUYER);
  });
});
