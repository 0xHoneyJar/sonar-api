/**
 * set-token-owner.test.ts — unit harness for the Mibera Token-entity writer.
 *
 * Covers the four load-bearing behaviours the runbook requires (Verify Layer 1):
 *   (a) normal transfer writes Token with the new owner
 *   (b) staking-destination transfer SKIPS Token write (preserves prior owner)
 *   (c) burn-address transfer flips `isBurned: true`
 *   (d) idempotency on re-index — re-emitted transfer with the same fields is
 *       a Token.set upsert no-op (last call wins, same value)
 *
 * The handler context is mocked with the minimal Token store surface the helper
 * touches (`get`, `set`). The shape matches `generated/src/Types.ts:2594-2625`
 * verbatim; Envio's full handlerContext is a much larger generated interface
 * but the helper only depends on `context.Token.{get,set}` — keep the mock
 * surface tight so the test fails fast if the helper grows incidental coupling.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Token } from "generated";

import { setTokenOwner } from "../set-token-owner";
import { PADDLEFI_VAULT, JIKO_STAKING } from "../../handlers/mibera-staking/constants";
import { DEAD_ADDRESS } from "../mint-detection";
import { ZERO_ADDRESS } from "../../handlers/constants";

const MIBERA = "0x6666397dfe9a8c469bf65dc744cb1c733416c420";
const BERACHAIN = 80094;

const ALICE = "0xaaaa000000000000000000000000000000000001";
const BOB = "0xbbbb000000000000000000000000000000000002";

interface TokenStoreCalls {
  get: Array<string>;
  set: Array<Token>;
}

function createMockContext(seed?: Token) {
  const store = new Map<string, Token>();
  if (seed) store.set(seed.id, seed);

  const calls: TokenStoreCalls = { get: [], set: [] };

  const context = {
    Token: {
      get: vi.fn(async (id: string) => {
        calls.get.push(id);
        return store.get(id);
      }),
      set: vi.fn((entity: Token) => {
        calls.set.push(entity);
        store.set(entity.id, entity);
      }),
    },
  } as unknown as Parameters<typeof setTokenOwner>[0]["context"];

  return { context, store, calls };
}

describe("setTokenOwner — normal transfer (a)", () => {
  let mocks: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    mocks = createMockContext();
  });

  it("writes a Token with the new owner on first-sight transfer", async () => {
    const outcome = await setTokenOwner({
      context: mocks.context,
      collection: MIBERA,
      chainId: BERACHAIN,
      tokenId: 42n,
      from: ZERO_ADDRESS, // mint
      to: ALICE,
      timestamp: 1_700_000_000n,
    });

    expect(outcome).toBe("written");
    expect(mocks.calls.set).toHaveLength(1);
    const written = mocks.calls.set[0];
    expect(written.id).toBe(`${MIBERA}_${BERACHAIN}_42`);
    expect(written.owner).toBe(ALICE);
    expect(written.isBurned).toBe(false);
    expect(written.collection).toBe(MIBERA);
    expect(written.chainId).toBe(BERACHAIN);
    expect(written.tokenId).toBe(42n);
    expect(written.lastTransferTime).toBe(1_700_000_000n);
  });

  it("updates the owner on subsequent transfer (alice → bob)", async () => {
    // Seed the store as if alice already owns the token from a prior mint.
    const seed: Token = {
      id: `${MIBERA}_${BERACHAIN}_42`,
      collection: MIBERA,
      chainId: BERACHAIN,
      tokenId: 42n,
      owner: ALICE,
      isBurned: false,
      mintedAt: 1_700_000_000n,
      lastTransferTime: 1_700_000_000n,
    };
    mocks = createMockContext(seed);

    const outcome = await setTokenOwner({
      context: mocks.context,
      collection: MIBERA,
      chainId: BERACHAIN,
      tokenId: 42n,
      from: ALICE,
      to: BOB,
      timestamp: 1_700_000_500n,
    });

    expect(outcome).toBe("written");
    expect(mocks.calls.set).toHaveLength(1);
    const written = mocks.calls.set[0];
    expect(written.owner).toBe(BOB);
    expect(written.mintedAt).toBe(1_700_000_000n); // preserved from seed
    expect(written.lastTransferTime).toBe(1_700_000_500n);
  });
});

describe("setTokenOwner — staking-skip gate (b) — load-bearing invariant", () => {
  it("SKIPS write when destination is the paddlefi staking vault", async () => {
    const { context, calls } = createMockContext();

    const outcome = await setTokenOwner({
      context,
      collection: MIBERA,
      chainId: BERACHAIN,
      tokenId: 42n,
      from: ALICE,
      to: PADDLEFI_VAULT,
      timestamp: 1_700_000_500n,
    });

    expect(outcome).toBe("skipped-staking");
    // The gate must fire BEFORE we touch the store — no get, no set.
    expect(calls.get).toHaveLength(0);
    expect(calls.set).toHaveLength(0);
  });

  it("SKIPS write when destination is the jiko staking contract", async () => {
    const { context, calls } = createMockContext();

    const outcome = await setTokenOwner({
      context,
      collection: MIBERA,
      chainId: BERACHAIN,
      tokenId: 7n,
      from: ALICE,
      to: JIKO_STAKING,
      timestamp: 1_700_000_500n,
    });

    expect(outcome).toBe("skipped-staking");
    expect(calls.set).toHaveLength(0);
  });

  it("PRESERVES prior owner when a staking deposit transfer arrives", async () => {
    // Seed: alice owns the token. A re-index emits the deposit transfer
    // (alice → paddlefi). The helper must NOT overwrite alice's ownership.
    const seed: Token = {
      id: `${MIBERA}_${BERACHAIN}_42`,
      collection: MIBERA,
      chainId: BERACHAIN,
      tokenId: 42n,
      owner: ALICE,
      isBurned: false,
      mintedAt: 1_700_000_000n,
      lastTransferTime: 1_700_000_000n,
    };
    const { context, store, calls } = createMockContext(seed);

    await setTokenOwner({
      context,
      collection: MIBERA,
      chainId: BERACHAIN,
      tokenId: 42n,
      from: ALICE,
      to: PADDLEFI_VAULT,
      timestamp: 1_700_000_500n,
    });

    expect(calls.set).toHaveLength(0);
    // The persisted owner is still alice — the gate is the invariant that
    // keeps staked Miberas visible to inventory-api's getNftsForOwner(alice).
    expect(store.get(`${MIBERA}_${BERACHAIN}_42`)?.owner).toBe(ALICE);
  });
});

describe("setTokenOwner — burn-flag (c)", () => {
  it("flips isBurned: true on transfer to ZERO_ADDRESS", async () => {
    const { context, calls } = createMockContext();

    await setTokenOwner({
      context,
      collection: MIBERA,
      chainId: BERACHAIN,
      tokenId: 99n,
      from: ALICE,
      to: ZERO_ADDRESS,
      timestamp: 1_700_001_000n,
    });

    expect(calls.set).toHaveLength(1);
    expect(calls.set[0].isBurned).toBe(true);
    expect(calls.set[0].owner).toBe(ZERO_ADDRESS);
  });

  it("flips isBurned: true on transfer to DEAD_ADDRESS (0x…dead)", async () => {
    const { context, calls } = createMockContext();

    await setTokenOwner({
      context,
      collection: MIBERA,
      chainId: BERACHAIN,
      tokenId: 99n,
      from: ALICE,
      to: DEAD_ADDRESS,
      timestamp: 1_700_001_000n,
    });

    expect(calls.set).toHaveLength(1);
    expect(calls.set[0].isBurned).toBe(true);
  });
});

describe("setTokenOwner — idempotency on re-index (d)", () => {
  it("second call with same (collection, chainId, tokenId, to) yields identical Token", async () => {
    const args = {
      collection: MIBERA,
      chainId: BERACHAIN,
      tokenId: 42n,
      from: ZERO_ADDRESS,
      to: ALICE,
      timestamp: 1_700_000_000n,
    } as const;

    const { context, store } = createMockContext();

    await setTokenOwner({ context, ...args });
    const afterFirst = { ...store.get(`${MIBERA}_${BERACHAIN}_42`)! };

    // Simulate Envio re-replaying the same transfer (genesis re-index).
    await setTokenOwner({ context, ...args });
    const afterSecond = store.get(`${MIBERA}_${BERACHAIN}_42`)!;

    // Same id, same owner, same isBurned, same lastTransferTime.
    // The second set is a no-op from the consumer's perspective.
    expect(afterSecond.id).toBe(afterFirst.id);
    expect(afterSecond.owner).toBe(afterFirst.owner);
    expect(afterSecond.isBurned).toBe(afterFirst.isBurned);
    expect(afterSecond.lastTransferTime).toBe(afterFirst.lastTransferTime);
    expect(afterSecond.collection).toBe(afterFirst.collection);
    expect(afterSecond.chainId).toBe(afterFirst.chainId);
    expect(afterSecond.tokenId).toBe(afterFirst.tokenId);
  });

  it("normalizes collection address to lowercase in the entity id", async () => {
    // Defensive: callers should already lowercase, but the helper guards.
    const UPPER = "0x6666397DFE9A8C469BF65DC744CB1C733416C420";
    const lower = UPPER.toLowerCase();

    const { context, store } = createMockContext();

    await setTokenOwner({
      context,
      collection: UPPER,
      chainId: BERACHAIN,
      tokenId: 1n,
      from: ZERO_ADDRESS,
      to: ALICE,
      timestamp: 1_700_000_000n,
    });

    expect(store.get(`${lower}_${BERACHAIN}_1`)?.owner).toBe(ALICE);
    // No entity at the upper-cased id — the lowercased one is canonical.
    expect(store.get(`${UPPER}_${BERACHAIN}_1`)).toBeUndefined();
  });
});
