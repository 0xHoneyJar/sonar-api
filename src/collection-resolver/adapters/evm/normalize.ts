/**
 * Single EVM address normalization at the adapter boundary.
 * Downstream code must use the returned normalized form only.
 */
import { normalizeEvmAddress } from "../../protocol.js";

export type NormalizedEvmAddress = `0x${string}`;

export interface AddressNormalizationResult {
  readonly normalized: NormalizedEvmAddress;
  /** Exactly 1 after a successful boundary normalize. */
  readonly normalization_count: 1;
}

/**
 * Normalize once. Throws only on structural failure — callers map to miss /
 * unsupported. Never re-normalize the result.
 */
export const normalizeAddressOnce = (raw: string): AddressNormalizationResult => {
  const normalized = normalizeEvmAddress(raw) as NormalizedEvmAddress;
  return { normalized, normalization_count: 1 };
};
