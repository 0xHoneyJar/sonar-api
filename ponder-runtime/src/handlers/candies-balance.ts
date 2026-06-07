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

// ────────────────────────────────────────────────────────────────────────────
// Candies-collection identity + the canonical contract value the CONSUMER
// filters on.
//
// CandiesMarket1155 subscribes to TWO addresses (ponder.config.mibera.ts:65),
// BOTH labelled mibera_drugs / mibera_candies:
//   - 0x80283fbf2b8e50f6ddf9bfc4a90a8336bc90e38f  (primary / SilkRoad market)
//   - 0xeca03517c5195f1edd634da6d690d6c72407c40c  (secondary)
//
// inventory-api (src/inventory.ts:31 CANDIES_CONTRACT) recognises exactly ONE
// candies contract: 0xecA03517c5195F1edD634DA6D690D6c72407c40c. Its
// liveCandiesBalances reads `CandiesHolderBalance(where:{holder_id…})` and the
// caller treats every returned row as Candy holdings under that single contract.
//
// THEREFORE: the per-holder balance row MUST carry the canonical contract value
// (0xeca03517…), regardless of which of the two market addresses emitted the
// event. Writing the raw event-log address (e.g. 0x80283fbf…) would land
// primary-market candies activity under a contract the consumer never queries —
// a silent-empty result. We collapse both addresses onto the canonical value.
//
// CANDIES_COLLECTION_KEY mirrors getCollectionKey("mibera_drugs") in the
// handler — the single signal used to gate writes to candies events only.
export const CANDIES_COLLECTION_KEY = "mibera_drugs";

// The canonical candies contract the consumer (inventory-api) filters on,
// lowercased. MUST equal inventory-api src/inventory.ts CANDIES_CONTRACT
// (0xecA03517c5195F1edD634DA6D690D6c72407c40c) lowercased.
export const CANONICAL_CANDIES_CONTRACT =
  "0xeca03517c5195f1edd634da6d690d6c72407c40c";

// The CandiesMarket1155 addresses that map to the candies collection. Mirrors
// CANDIES_MARKET_1155 in ponder.config.mibera.ts and MINT_COLLECTION_KEYS in
// candies-market1155.ts. Used to gate balance writes to candies events only.
const CANDIES_MARKET_ADDRESSES = new Set<string>([
  "0x80283fbf2b8e50f6ddf9bfc4a90a8336bc90e38f",
  "0xeca03517c5195f1edd634da6d690d6c72407c40c",
]);

/**
 * Is this event-log address one of the candies (mibera_drugs) market contracts?
 * The gate that keeps non-candy collections out of candies_holder_balance.
 */
export function isCandiesContract(contractAddress: string): boolean {
  return CANDIES_MARKET_ADDRESSES.has(contractAddress.toLowerCase());
}

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

export interface ApplyTransferBalancesArgs {
  context: any;
  /** raw `from` address from the transfer (ZERO for mints). */
  from: string;
  /** raw `to` address from the transfer (ZERO for burns). */
  to: string;
  /** event-log address — the gate signal AND the source of the canonical map. */
  contractAddress: string;
  tokenId: bigint;
  chainId: number;
  /** positive transfer quantity (ERC-1155 `value`). */
  quantity: bigint;
  timestamp: bigint;
}

/**
 * Apply per-holder balance maintenance for ONE ERC-1155 transfer leg.
 *
 * This is the handler-wiring unit — it encodes the two FAGAN-convergence
 * decisions in one testable place (vs. inlining inside the un-invokable
 * `ponder.on` closures):
 *
 *   1. RUN-FOR-ALL-TRANSFERS (Finding 1): DEBIT `from` AND CREDIT `to` are
 *      BOTH issued for every leg. `applyCandiesBalance` no-ops the ZERO leg,
 *      so a mint only credits, a burn only debits, and a TRADE both debits the
 *      sender and credits the receiver. The debit is NOT gated behind a
 *      mint-only branch — that was the bug.
 *
 *   2. GATE-TO-CANDIES + CANONICAL CONTRACT (Finding 2): writes happen ONLY for
 *      candies (mibera_drugs) market addresses, and the row's `contract` is the
 *      single canonical value inventory-api filters on (CANONICAL_CANDIES_-
 *      CONTRACT) — NOT the raw event-log address — so primary- and
 *      secondary-market candies activity both land where the consumer looks.
 *
 * Returns true if the transfer was a candies transfer (balance writes issued),
 * false if it was gated out (non-candies — no write).
 */
export async function applyTransferBalances({
  context,
  from,
  to,
  contractAddress,
  tokenId,
  chainId,
  quantity,
  timestamp,
}: ApplyTransferBalancesArgs): Promise<boolean> {
  // Finding 2 — gate: skip every non-candies event entirely.
  if (!isCandiesContract(contractAddress)) {
    return false;
  }

  // Finding 2 — canonical contract: collapse both market addresses onto the
  // one value the consumer filters on.
  const contract = CANONICAL_CANDIES_CONTRACT;

  // Finding 1 — debit `from` (no-op for mints) + credit `to` (no-op for burns).
  // The debit runs for EVERY transfer, so trades correctly decrement the sender.
  await applyCandiesBalance({
    context,
    holder: from,
    contract,
    tokenId,
    chainId,
    quantity,
    direction: "debit",
    timestamp,
  });
  await applyCandiesBalance({
    context,
    holder: to,
    contract,
    tokenId,
    chainId,
    quantity,
    direction: "credit",
    timestamp,
  });

  return true;
}
