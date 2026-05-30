// MoneycombVault ABI (sonar-ponder-migration-v1 · sprint B-1 green belt · Group C)
//
// Event signatures extracted VERBATIM from the envio config.yaml
// (MoneycombVault contract, config.yaml:56-78 in the contracts header +
// addresses config.yaml:769-773). The MoneycombVault contract (Berachain 80094,
// 0x9279b2227b57f349a0ce552b25af341e735f6309) tracks per-account vaults backed
// by HoneyJar / Honeycomb NFT burns: account open/close, HJ burns, share mints,
// and reward claims.
//
// Follows the abis/MiberaAbis.ts + abis/MirrorObservabilityAbi.ts +
// abis/ApdaoAuctionHouseAbi.ts pattern — parseAbi keeps the surface compact;
// Ponder uses the ABI for filter inference + decoding only (functions /
// non-event items omitted).
//
// HONEYCOMB DEPENDENCY (grounded): the b-1-handler-gap.md §"Group C" note that
// MoneycombVault "depends on Honeycomb transfers" is a DOMAIN note, not a
// handler dependency. The envio handler (src/handlers/moneycomb-vault.ts) reads
// ONLY MoneycombVault events — `honeycombId` is a uint256 event PARAMETER on
// AccountOpened / AccountClosed, NOT a cross-contract read of the Honeycomb
// (HoneyComb721) contract. No Honeycomb event/ABI/registration is required for
// Group C; the Honeycomb contract belongs to Group B (honeyjar-genesis).
import { parseAbi } from "viem";

// MoneycombVault — HJ-burn vault lifecycle (Berachain 80094)
export const MoneycombVaultAbi = parseAbi([
  "event AccountOpened(address indexed user, uint256 indexed accountIndex, uint256 indexed honeycombId)",
  "event AccountClosed(address indexed user, uint256 indexed accountIndex, uint256 indexed honeycombId)",
  "event HJBurned(address indexed user, uint256 indexed accountIndex, uint256 indexed hjGen)",
  "event SharesMinted(address indexed user, uint256 accountIndex, uint256 shares)",
  "event RewardClaimed(address indexed user, uint256 reward)",
] as const);
