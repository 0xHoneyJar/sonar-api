/*
 * Pure per-tokenId ERC-1155 balance arithmetic. No DB glue — the handler owns
 * the reads and writes, this owns the rules.
 */

/** Balance row key: one row per (contract, chain, tokenId, wallet). */
export function erc1155HolderId(
  contract: string,
  chainId: number,
  tokenId: bigint,
  address: string,
): string {
  return `${contract.toLowerCase()}_${chainId}_${tokenId.toString()}_${address.toLowerCase()}`;
}

export interface NextBalance {
  stored: bigint;
  shouldDelete: boolean;
}

/**
 * Apply `delta` to `current`. A balance at or below zero deletes the row rather
 * than storing 0 — an absent row and a zero row must not both mean "holds none",
 * or holder counts double-count.
 */
export function nextBalance(current: bigint, delta: bigint): NextBalance {
  const raw = current + delta;
  if (raw <= 0n) return { stored: 0n, shouldDelete: true };
  return { stored: raw, shouldDelete: false };
}

/**
 * Fold a TransferBatch into one delta per tokenId.
 *
 * A batch may legitimately name the same tokenId twice, so summing is required —
 * applying the legs independently would let the second read a stale balance and
 * overwrite the first. Zero-value legs are dropped (a no-op transfer is not a
 * holder event).
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
