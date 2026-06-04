// ponder-runtime/src/lib/erc1155-holder.ts
//
// Pure helpers for per-tokenId ERC-1155 holder-balance tracking (trackedHolder1155).
//
// The whole-contract trackedHolder (handler adjustHolder1155, lines 361-417) sums
// every edition of a multi-edition 1155 into one tokenCount. That conflates
// unrelated editions — e.g. puru apiculture (0x6cfb92…, Base 8453) holds 6 token
// ids but only id 4 is the Purupuru edition. This module is the testable core of
// the per-edition twin: id-keying, floor-at-zero balance math, and per-tokenId
// batch delta rollup. The DB read-modify-write glue stays in the handler.
//
// See sonar-api#62.

/**
 * Composite primary key for a per-(contract, chain, tokenId, holder) balance row —
 * one notch finer than trackedHolder's `{contract}_{chainId}_{address}`. Contract
 * and address are lowercased here so the key is stable regardless of caller hygiene
 * (the handler already lowercases at its boundary; this is defence in depth).
 */
export function erc1155HolderId(
  contract: string,
  chainId: number,
  tokenId: bigint,
  address: string,
): string {
  return `${contract.toLowerCase()}_${chainId}_${tokenId.toString()}_${address.toLowerCase()}`;
}

export interface NextBalance {
  /** Balance to persist — floored at zero, never negative. */
  stored: bigint;
  /** True when the running balance reached zero-or-below → the row should be deleted. */
  shouldDelete: boolean;
}

/**
 * Apply a signed delta to a running balance with floor-at-zero + delete-on-empty
 * semantics — identical to trackedHolder's whole-contract rule (handler lines
 * 369-398), just per tokenId. A raw result <= 0 means the holder no longer holds
 * this edition: persist nothing, delete the row. Over-decrement (raw < 0) can occur
 * if indexing starts mid-history; we floor rather than trust a negative.
 */
export function nextBalance(current: bigint, delta: bigint): NextBalance {
  const raw = current + delta;
  if (raw <= 0n) {
    return { stored: 0n, shouldDelete: true };
  }
  return { stored: raw, shouldDelete: false };
}

/**
 * Collapse a TransferBatch's parallel (ids, values) arrays into a per-tokenId
 * total quantity. A batch MAY repeat a tokenId; summing first means each edition's
 * balance row is touched exactly once per event — mirroring the whole-contract
 * handler's single totalQuantity adjustment, and avoiding intra-event
 * read-after-write ordering hazards. Zero-value entries are skipped.
 *
 * ERC-1155 TransferBatch REQUIRES ids and values to be equal-length parallel
 * arrays (EIP-1155). A mismatch is a malformed event we refuse — half-recording
 * a per-token balance that can't represent the emitted batch is worse than
 * surfacing the integrity violation. (In practice ponder's ABI decoder
 * guarantees parity, so this is a never-fires invariant assertion.)
 */
export function aggregateBatchDeltas(
  ids: readonly bigint[],
  values: readonly bigint[],
): Map<bigint, bigint> {
  if (ids.length !== values.length) {
    throw new Error(
      `TransferBatch ids/values length mismatch: ${ids.length} ids, ${values.length} values`,
    );
  }
  const out = new Map<bigint, bigint>();
  for (let i = 0; i < ids.length; i += 1) {
    const tokenId = ids[i];
    const value = values[i];
    if (tokenId === undefined || value === undefined) continue;
    if (value === 0n) continue;
    out.set(tokenId, (out.get(tokenId) ?? 0n) + value);
  }
  return out;
}
