// Per-tokenId ERC-1155 holder-balance helpers (sonar-api#62).
// Pure core ported from ponder-runtime; DB glue lives in puru-apiculture1155.ts.

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

export function nextBalance(current: bigint, delta: bigint): NextBalance {
  const raw = current + delta;
  if (raw <= 0n) {
    return { stored: 0n, shouldDelete: true };
  }
  return { stored: raw, shouldDelete: false };
}

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
