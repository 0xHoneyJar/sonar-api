import type { CollectionKey } from "./types.js";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function parseChainId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const chainId = Number(raw);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  return chainId;
}

export function normalizeContractAddress(raw: string): `0x${string}` | null {
  const trimmed = raw.trim();
  if (!EVM_ADDRESS_RE.test(trimmed)) return null;
  return trimmed.toLowerCase() as `0x${string}`;
}

export function collectionKeyFromParams(
  chainIdRaw: string,
  contractRaw: string,
): CollectionKey | null {
  const chainId = parseChainId(chainIdRaw);
  const contract = normalizeContractAddress(contractRaw);
  if (chainId === null || contract === null) return null;
  return { chainId, contract };
}

export function collectionKeyId(key: CollectionKey): string {
  return `${key.chainId}:${key.contract}`;
}

export function makeIngestJobId(key: CollectionKey): string {
  return `ingest_${key.chainId}_${key.contract.slice(2)}`;
}
