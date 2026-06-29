// ponder-runtime/src/handlers/tracked-erc721-bera-collections.test.ts
//
// Unit tests for the NET-NEW pure logic introduced by bd-1jg (S1b): the
// contract→collectionKey resolution + multi-collection burn classification for
// the 12 TrackedErc721Bera contracts. Tested WITHOUT the Ponder runtime
// (mirrors token-projection/shared.test.ts). The (blockNumber,logIndex) ordering
// + UPSERT + last-write-wins are already covered by shared.test.ts (this handler
// REUSES that helper verbatim) — these tests cover only what bd-1jg adds.

import { describe, expect, it } from "vitest";
import {
  ZERO_ADDRESS,
  DEAD_ADDRESS,
  BURN_ADDRESSES,
  isMintFromZero,
  isBurnAddress,
  isBurnTransfer,
  resolveTrackedCollectionKey,
  TRACKED_ERC721_BERA_COLLECTION_KEYS,
} from "./tracked-erc721-bera-collections";

// The 12 addresses registered for TrackedErc721Bera in ponder.config.mibera.ts:75-87,
// lowercased + paired with their expected human key. Inlined (NOT imported from
// the config, which calls createConfig) so this test is a drift-guard: if the
// config registers a 13th address or renames one, the registered-set test fails
// loudly instead of the handler silently using the raw address as collectionKey.
const REGISTERED: ReadonlyArray<readonly [string, string]> = [
  ["0x4b08a069381efbb9f08c73d6b2e975c9be3c4684", "mibera_tarot"],
  ["0x86db98cf1b81e833447b12a077ac28c36b75c8e1", "miparcels"],
  ["0x8d4972bd5d2df474e71da6676a365fb549853991", "miladies"],
  ["0x144b27b1a267ee71989664b3907030da84cc4754", "mireveal_1_1"],
  ["0x72db992e18a1bf38111b1936dd723e82d0d96313", "mireveal_2_2"],
  ["0x3a00301b713be83ec54b7b4fb0f86397d087e6d3", "mireveal_3_3"],
  ["0x419f25c4f9a9c730aacf58b8401b5b3e566fe886", "mireveal_4_20"],
  ["0x81a27117bd894942ba6737402fb9e57e942c6058", "mireveal_5_5"],
  ["0xaab7b4502251ae393d0590bab3e208e2d58f4813", "mireveal_6_6"],
  ["0xc64126ea8dc7626c16daa2a29d375c33fcaa4c7c", "mireveal_7_7"],
  ["0x24f4047d372139de8dacbe79e2fc576291ec3ffc", "mireveal_8_8"],
  ["0xfc2d7ebfeb2714fce13caf234a95db129ecc43da", "apdao_seat"],
] as const;

describe("TRACKED_ERC721_BERA_COLLECTION_KEYS (registered-subset drift guard)", () => {
  it("maps exactly the 12 registered Berachain addresses (no more, no fewer)", () => {
    expect(Object.keys(TRACKED_ERC721_BERA_COLLECTION_KEYS)).toHaveLength(12);
    expect(REGISTERED).toHaveLength(12);
  });

  it("resolves every registered address to its envio-parity human key", () => {
    for (const [addr, key] of REGISTERED) {
      expect(resolveTrackedCollectionKey(addr)).toBe(key);
    }
  });

  it("stores keys lowercased so lookup is checksum-stable", () => {
    // The handler lowercases event.log.address before lookup; resolving the
    // checksum form here exercises that the stored keys are themselves lowercased.
    expect(resolveTrackedCollectionKey("0x4B08a069381EfbB9f08C73D6B2e975C9BE3c4684".toLowerCase()))
      .toBe("mibera_tarot");
  });

  it("apdao_seat is one of the 12 (explicit per bd-1jg)", () => {
    expect(resolveTrackedCollectionKey("0xfc2d7ebfeb2714fce13caf234a95db129ecc43da"))
      .toBe("apdao_seat");
  });
});

describe("resolveTrackedCollectionKey fallback", () => {
  it("falls back to the lowercased contract address for an UNregistered emitter", () => {
    const unknown = "0x1111111111111111111111111111111111111111";
    expect(resolveTrackedCollectionKey(unknown)).toBe(unknown);
  });
});

describe("burn classification (B1 — real sink, not hardcoded 0x0)", () => {
  const HOLDER = "0x000000000000000000000000000000000000aaaa";

  it("burn sink set is exactly {0x0, 0x…dead}", () => {
    expect([...BURN_ADDRESSES].sort()).toEqual([ZERO_ADDRESS, DEAD_ADDRESS].sort());
  });

  it("isBurnAddress covers the zero address AND the dead address", () => {
    expect(isBurnAddress(ZERO_ADDRESS)).toBe(true);
    expect(isBurnAddress(DEAD_ADDRESS)).toBe(true);
    expect(isBurnAddress(DEAD_ADDRESS.toUpperCase())).toBe(true); // case-insensitive
    expect(isBurnAddress(HOLDER)).toBe(false);
  });

  it("isMintFromZero is true only for the zero address", () => {
    expect(isMintFromZero(ZERO_ADDRESS)).toBe(true);
    expect(isMintFromZero(HOLDER)).toBe(false);
    expect(isMintFromZero(DEAD_ADDRESS)).toBe(false); // dead is a burn, not a mint
  });

  it("isBurnTransfer: NON-mint → dead sink is a burn", () => {
    expect(isBurnTransfer(HOLDER, DEAD_ADDRESS)).toBe(true);
    expect(isBurnTransfer(HOLDER, ZERO_ADDRESS)).toBe(true);
  });

  it("isBurnTransfer: a mint (from 0x0) into a sink is NOT a burn", () => {
    // Excludes the unusual mint-to-burn case (matches envio isBurnTransfer).
    expect(isBurnTransfer(ZERO_ADDRESS, DEAD_ADDRESS)).toBe(false);
  });

  it("isBurnTransfer: an ordinary holder→holder transfer is NOT a burn", () => {
    expect(isBurnTransfer(HOLDER, "0x000000000000000000000000000000000000bbbb")).toBe(false);
  });
});
