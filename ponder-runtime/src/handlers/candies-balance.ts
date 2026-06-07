// ponder-runtime/src/handlers/candies-balance.ts
//
// Per-holder ERC-1155 balance maintenance for Candies (mibera_drugs),
// extracted as a pure-arithmetic helper + a thin upsert wrapper so the
// balance logic is unit-testable WITHOUT the Ponder runtime (the repo's
// established test posture — see ponder-runtime/tests/*: test the shared
// helpers, exercise the `ponder.on` registration via byte-parity / live).
//
// Consumer contract (inventory-api src/live-sonar.ts):
//   CandiesHolderBalance(where: { holder_id: {_eq: <addrLower>}, amount: {_gt: "0"} })
//     { contract tokenId amount }
// The table + its `holder_id` field are defined in ponder.schema.ts
// (candiesHolderBalance). This module only WRITES it.
//
// Correctness invariants:
//   - CREDIT to `to`  on every transfer where to   != ZERO_ADDRESS (incl. mint).
//   - DEBIT  from `from` on every transfer where from != ZERO_ADDRESS (incl. burn).
//   - amount clamps at 0 — a debit never drives a balance negative (defends
//     against out-of-order / partial-history reindex windows).
//   - mint (from == 0x0): only the credit fires.
//   - burn (to   == 0x0): only the debit fires.

import { candiesHolderBalance } from "../../ponder.schema";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type BalanceDirection = "credit" | "debit";

/**
 * Pure balance arithmetic. Given the current stored amount and a positive
 * `quantity` moving in the given `direction`, return the next amount.
 *
 * - credit: current + quantity
 * - debit:  max(0, current - quantity)   (clamp — never negative)
 */
export function computeNextBalance(
  current: bigint,
  quantity: bigint,
  direction: BalanceDirection,
): bigint {
  if (quantity < 0n) {
    // Quantities are ERC-1155 `value` fields (uint256) — never negative on-chain.
    // Treat a negative input defensively as a no-op delta.
    quantity = 0n;
  }
  if (direction === "credit") {
    return current + quantity;
  }
  const next = current - quantity;
  return next < 0n ? 0n : next;
}

/**
 * Deterministic primary key for a holder-balance cell.
 * `${contract}-${chainId}-${tokenId}-${holder}` (addresses lowercased).
 */
export function makeCandiesBalanceId(
  contract: string,
  chainId: number,
  tokenId: bigint,
  holder: string,
): string {
  return `${contract.toLowerCase()}-${chainId}-${tokenId.toString()}-${holder.toLowerCase()}`;
}

export interface ApplyCandiesBalanceArgs {
  context: any;
  holder: string;
  contract: string;
  tokenId: bigint;
  chainId: number;
  quantity: bigint;
  direction: BalanceDirection;
  timestamp: bigint;
}

/**
 * Upsert a single holder-balance cell for one (contract, chainId, tokenId,
 * holder) tuple. Skips the ZERO_ADDRESS leg (mint has no `from` holder;
 * burn has no `to` holder) and zero-quantity transfers.
 *
 * Upsert shape mirrors the existing balance handlers (find → update | insert
 * .onConflictDoNothing) for reorg-replay idempotency.
 */
export async function applyCandiesBalance({
  context,
  holder,
  contract,
  tokenId,
  chainId,
  quantity,
  direction,
  timestamp,
}: ApplyCandiesBalanceArgs): Promise<void> {
  const holderLower = holder.toLowerCase();
  if (holderLower === ZERO_ADDRESS) {
    return; // mint has no source holder; burn has no destination holder
  }
  if (quantity === 0n) {
    return;
  }

  const contractLower = contract.toLowerCase();
  const balanceId = makeCandiesBalanceId(contractLower, chainId, tokenId, holderLower);

  const existing = await context.db.find(candiesHolderBalance, { id: balanceId });
  // mode:"bigint" numeric columns can infer through as number under this
  // ponder/drizzle version (see puru-apiculture1155.ts) — coerce to bigint.
  const current = BigInt(existing?.amount ?? 0n);
  const next = computeNextBalance(current, quantity, direction);

  if (existing) {
    await context.db.update(candiesHolderBalance, { id: balanceId }).set({
      holder_id: holderLower as `0x${string}`,
      contract: contractLower as `0x${string}`,
      tokenId,
      chainId,
      amount: next,
      updatedAt: timestamp,
    });
  } else {
    await context.db
      .insert(candiesHolderBalance)
      .values({
        id: balanceId,
        holder_id: holderLower as `0x${string}`,
        contract: contractLower as `0x${string}`,
        tokenId,
        chainId,
        amount: next,
        updatedAt: timestamp,
      })
      .onConflictDoNothing();
  }
}
