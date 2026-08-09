/*
 * tracked-erc721-balances-only.test.ts — the per-collection balances-only lever
 * (2026-08-09).
 *
 * A registry entry with `balancesOnly: true` keeps TrackedHolder + Token exact
 * and writes NO Action rows — the erc20 lane's storage lever (4632be59), scoped
 * to one collection instead of the whole lane. Snapshot-served communities have
 * no consumer for per-event rows, and those rows are the storage cost driver.
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

const FLAGGED = "0xed5af388653567af2f388e6224dc7c4b3241c544"; // azuki-shaped
const UNFLAGGED = "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d";

vi.mock("../src/registry/contracts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/registry/contracts")>();
  return {
    ...actual,
    isBalancesOnlyContract: (chain: number, address: string) =>
      chain === 1 && address.toLowerCase() === FLAGGED,
  };
});

import { handleTrackedErc721Transfer } from "../src/handlers/tracked-erc721";

const ZERO = "0x0000000000000000000000000000000000000000";
const HOLDER_A = "0x1111111111111111111111111111111111111111";
const HOLDER_B = "0x2222222222222222222222222222222222222222";

function mockContext() {
  const holders = new Map<string, unknown>();
  return {
    isPreload: false,
    Action: { set: vi.fn() },
    TrackedHolder: {
      get: vi.fn(async (id: string) => holders.get(id)),
      set: vi.fn((h: { id: string }) => holders.set(h.id, h)),
      deleteUnsafe: vi.fn((id: string) => holders.delete(id)),
    },
    Token: { get: vi.fn(async () => undefined), set: vi.fn() },
    MintActivity: { set: vi.fn() },
  };
}

function transferEvent(
  contract: string,
  from: string,
  to: string,
  tokenId: bigint,
  logIndex = 0,
) {
  return {
    srcAddress: contract,
    chainId: 1,
    logIndex,
    params: { from, to, tokenId },
    transaction: { hash: "0xcafebabe" },
    block: { timestamp: 1_750_000_000, number: 21_000_000 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("balancesOnly — no Action rows, exact balances", () => {
  it("emits NO Action rows for a flagged collection on transfer, mint, and burn", async () => {
    const ctx = mockContext();
    await handleTrackedErc721Transfer(
      transferEvent(FLAGGED, ZERO, HOLDER_A, 1n, 0) as never, // mint
      ctx as never,
    );
    await handleTrackedErc721Transfer(
      transferEvent(FLAGGED, HOLDER_A, HOLDER_B, 1n, 1) as never, // transfer
      ctx as never,
    );
    await handleTrackedErc721Transfer(
      transferEvent(FLAGGED, HOLDER_B, ZERO, 1n, 2) as never, // burn
      ctx as never,
    );

    expect(ctx.Action.set).not.toHaveBeenCalled();
  });

  it("still maintains TrackedHolder and Token for a flagged collection", async () => {
    const ctx = mockContext();
    await handleTrackedErc721Transfer(
      transferEvent(FLAGGED, ZERO, HOLDER_A, 1n, 0) as never,
      ctx as never,
    );

    const holderId = `${FLAGGED}_1_${HOLDER_A}`;
    const holderWrites = ctx.TrackedHolder.set.mock.calls.map(
      (c) => c[0] as { id: string; tokenCount: number },
    );
    expect(holderWrites.some((h) => h.id === holderId && h.tokenCount === 1)).toBe(
      true,
    );
    expect(ctx.Token.set).toHaveBeenCalled();
  });

  it("an unflagged collection on the same chain still emits Action rows", async () => {
    const ctx = mockContext();
    await handleTrackedErc721Transfer(
      transferEvent(UNFLAGGED, HOLDER_A, HOLDER_B, 7n) as never,
      ctx as never,
    );

    const types = ctx.Action.set.mock.calls.map(
      (c) => (c[0] as { actionType: string }).actionType,
    );
    expect(types).toContain("transfer");
    expect(types).toContain("hold721");
  });
});
