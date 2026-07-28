/*
 * tracked-nft-contracts.ts — the set of NFT contracts eligible for sale attribution,
 * read from THE registry (src/registry/contracts.ts).
 *
 * Why not a hand-maintained list here: Kitchen patches config.yaml when a community
 * is onboarded (src/kitchen/config-patcher.ts) but never touched seaport.ts's
 * TRACKED_COLLECTIONS, so onboarded collections could never produce a sale row
 * (bug-20260725-224d57 F2). Why not a second config parse either (bd-dwq5.1): the
 * registry is now the single declaration site, and the config is held to it by
 * test/contract-registry.test.ts — so reading the registry and reading the config
 * cannot disagree, and the registry needs no filesystem access at event time.
 *
 * Every registered address is eligible, with no per-handler name list to maintain.
 * The trade-off: a name allowlist silently drops a collection the moment a new
 * handler class is added, which is the failure mode this module exists to kill.
 *
 * Bounded caveat (BB SEA-008): including non-NFT entries is very nearly inert, but
 * not provably so. Seaport does not validate item token types, and ERC-20's
 * `transferFrom(address,address,uint256)` shares a selector with ERC-721's, so a
 * crafted order can declare a registered ERC-20 or vault as an itemType-2 item and
 * fill successfully — emitting a sale row for a non-collection contract. Impact is
 * bounded (two-wallet wash trades against real collections are already possible),
 * but consumers should filter to known collections rather than trust every address.
 *
 * Addresses are keyed by chainId so the same address on two chains cannot cross-match.
 */
import { addressesByChain, isTrackedContract } from "../../registry/contracts";

/** chainId → set of lowercased contract addresses tracked on that chain. */
export type BoundContracts = ReadonlyMap<number, ReadonlySet<string>>;

let override: BoundContracts | null = null;

/** Tracked contracts by chain, from the registry. */
export function boundContracts(): BoundContracts {
  return override ?? addressesByChain();
}

/** True when `address` is tracked on `chainId`. */
export function isTrackedNftContract(chainId: number, address: string): boolean {
  if (override) return override.get(chainId)?.has(address.toLowerCase()) ?? false;
  return isTrackedContract(chainId, address);
}

/** Test seam: replace the tracked set. Pass null to restore the registry. */
export function __setBoundContractsForTest(v: BoundContracts | null): void {
  override = v;
}
