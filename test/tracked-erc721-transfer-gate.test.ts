/*
 * tracked-erc721-transfer-gate.test.ts — sprint-bug-190 RED suite (F1).
 *
 * `handleTrackedErc721Transfer` records a transfer Action only when the resolved
 * collectionKey is present in the hardcoded TRANSFER_TRACKED_COLLECTIONS set
 * (tracked-erc721.ts:130). Kitchen patches config.yaml when a community is
 * onboarded but never touches that set, so a newly onboarded collection indexes
 * holders and emits no transfer history at all.
 *
 * Measured 2026-07-25: chain 1 has 9 ERC-721 collections bound in config.yaml
 * (config.yaml:611-631) but `Action(distinct_on:primaryCollection)` on chain 1
 * returns exactly one row — "azuki". BAYC, Pudgy, Doodles, moonbirds, nouns,
 * mfers, remilia and just_t00ns are silent.
 *
 * The gate is redundant: `indexer.onEvent` only delivers events for addresses
 * bound in config.yaml, so arrival already proves the collection is tracked.
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

const ZERO = "0x0000000000000000000000000000000000000000";
const HOLDER_A = "0x1111111111111111111111111111111111111111";
const HOLDER_B = "0x2222222222222222222222222222222222222222";

/**
 * A collection bound in config.yaml chain 1 (EthTrackedErc721) that is absent
 * from TRANSFER_TRACKED_COLLECTIONS: Bored Ape Yacht Club (config.yaml:620).
 */
const BAYC = "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d";

/** A hypothetical freshly Kitchen-onboarded contract — in no TS constant at all. */
const NEWLY_ONBOARDED = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

function mockContext() {
  const holders = new Map<string, unknown>();
  return {
    isPreload: false,
    Action: { set: vi.fn() },
    TrackedHolder: {
      get: vi.fn(async (id: string) => holders.get(id)),
      set: vi.fn((h: { id: string }) => holders.set(h.id, h)),
    },
    Token: { get: vi.fn(async () => undefined), set: vi.fn() },
    MiberaTransfer: { set: vi.fn() },
    NftBurn: { set: vi.fn() },
    MintActivity: { set: vi.fn() },
  };
}

function transferEvent(contract: string, tokenId: bigint, logIndex = 0) {
  return {
    srcAddress: contract,
    chainId: 1,
    logIndex,
    params: { from: HOLDER_A, to: HOLDER_B, tokenId },
    transaction: { hash: "0xcafebabe" },
    block: { timestamp: 1_750_000_000, number: 21_000_000 },
  };
}

const transferActions = (ctx: ReturnType<typeof mockContext>) =>
  ctx.Action.set.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((a) => a.actionType === "transfer");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("F1 — transfer Actions are gated on a hardcoded collection set", () => {
  it("records a transfer for a config-bound collection missing from TRANSFER_TRACKED_COLLECTIONS", async () => {
    const ctx = mockContext();
    await handleTrackedErc721Transfer(transferEvent(BAYC, 1234n) as never, ctx as never);

    // RED: BAYC is bound in config.yaml but absent from the hardcoded set, so no
    // transfer Action is recorded — the collection is invisible to scoring.
    const actions = transferActions(ctx);
    expect(actions).toHaveLength(1);
    expect(actions[0].actor).toBe(HOLDER_B);
    expect(actions[0].chainId).toBe(1);
  });

  it("records a transfer for a freshly onboarded contract with no TS constant entry", async () => {
    const ctx = mockContext();
    await handleTrackedErc721Transfer(
      transferEvent(NEWLY_ONBOARDED, 7n) as never,
      ctx as never,
    );

    // The onboarding promise: patch config.yaml, get data. No code edit required.
    expect(transferActions(ctx)).toHaveLength(1);
  });

  it("still does not record a transfer for a mint (from the zero address)", async () => {
    const ctx = mockContext();
    await handleTrackedErc721Transfer(
      {
        ...transferEvent(BAYC, 5n),
        params: { from: ZERO, to: HOLDER_B, tokenId: 5n },
      } as never,
      ctx as never,
    );

    // Guard against over-correction: removing the gate must not turn mints into
    // secondary transfers.
    expect(transferActions(ctx)).toHaveLength(0);
  });
});
