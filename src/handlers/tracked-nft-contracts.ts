/*
 * The set of NFT contracts eligible for sale attribution, read from THE registry
 * (src/registry/contracts.ts).
 *
 * Every registered address is eligible, with no per-handler name list. A name
 * allowlist silently drops a collection the moment a new one is registered,
 * which is the failure mode this module exists to kill.
 *
 * Bounded caveat (BB SEA-008): including non-NFT entries is very nearly inert,
 * but not provably so. Seaport does not validate item token types, and ERC-20's
 * `transferFrom(address,address,uint256)` shares a selector with ERC-721's, so a
 * crafted order can declare a registered ERC-20 as an itemType-2 item and fill
 * successfully, emitting a sale row for a non-collection contract. Consumers
 * should filter to known collections rather than trust every address.
 *
 * Keyed by chainId so the same address on two chains cannot cross-match.
 */
import { isTrackedContract } from "../registry/contracts";

/** True when `address` is tracked on `chainId`. */
export function isTrackedNftContract(chainId: number, address: string): boolean {
  return isTrackedContract(chainId, address);
}
