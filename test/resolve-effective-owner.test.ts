/*
 * resolve-effective-owner.test.ts — EVM Sprint 1.6 hardening (SHANNON F2).
 *
 * Pins `resolveEffectiveOwner(from, to)`, the mibera staking-owner resolution
 * that was previously INLINE in the mibera-collection onEvent closure and
 * therefore untestable (the existing reconciliation tests passed a pre-resolved
 * `effectiveOwner`, so the staking-deposit branch — the whole point of the
 * function — had ZERO direct coverage). SHANNON F2/F3 + AUD-001 flagged this.
 *
 * The load-bearing case is the staking DEPOSIT: when a user sends an NFT to a
 * known staking contract the TrackedHolder count is NOT decremented (staked
 * NFTs still count as held), so Token{owner} must stay the USER (`from`), not
 * the staking contract — otherwise Token↔Holder reconciliation diverges.
 *
 * Asserted against the REAL STAKING_CONTRACT_KEYS (paddlefi + jiko), not a mock.
 */
import { describe, it, expect } from "vitest";

import { resolveEffectiveOwner } from "../src/handlers/mibera-collection";
import {
  PADDLEFI_VAULT,
  JIKO_STAKING,
} from "../src/handlers/mibera-staking/constants";
import { ZERO_ADDRESS } from "../src/handlers/constants";

const ZERO = ZERO_ADDRESS.toLowerCase();
const USER_A = "0xaaaa000000000000000000000000000000000001";
const USER_B = "0xbbbb000000000000000000000000000000000002";

describe("resolveEffectiveOwner — mibera staking-aware owner resolution (SHANNON F2)", () => {
  it("(a) normal transfer (to is a user) → returns `to`", () => {
    expect(resolveEffectiveOwner(USER_A, USER_B)).toBe(USER_B);
  });

  it("(b) staking DEPOSIT (to is a staking contract, from is a user) → returns `from` (the user keeps ownership)", () => {
    // The key case with zero direct coverage before this test. Both configured
    // staking contracts must resolve the same way.
    expect(resolveEffectiveOwner(USER_A, PADDLEFI_VAULT)).toBe(USER_A);
    expect(resolveEffectiveOwner(USER_B, JIKO_STAKING)).toBe(USER_B);
  });

  it("(c) staking WITHDRAWAL (from is a staking contract, to is a user) → returns `to`", () => {
    // `to` is not a staking key, so the deposit branch is not taken → owner = to.
    expect(resolveEffectiveOwner(PADDLEFI_VAULT, USER_A)).toBe(USER_A);
    expect(resolveEffectiveOwner(JIKO_STAKING, USER_B)).toBe(USER_B);
  });

  it("(d) MINT (from === ZERO) directly to a staking contract → returns `to` (documents the F5 edge)", () => {
    // from === ZERO short-circuits isStakingDeposit, so a direct mint into a
    // staking contract records the staking contract as owner (not a real mint
    // path today, but the resolution is defined + pinned rather than accidental).
    expect(resolveEffectiveOwner(ZERO, PADDLEFI_VAULT)).toBe(PADDLEFI_VAULT);
  });

  it("is case-insensitive on the staking lookup (SHANNON F1 boundary) — a checksummed staking address still resolves to the user", () => {
    const checksummedStaking = PADDLEFI_VAULT.toUpperCase().replace("0X", "0x");
    expect(resolveEffectiveOwner(USER_A, checksummedStaking)).toBe(USER_A);
  });
});
