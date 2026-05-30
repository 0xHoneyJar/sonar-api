// ApdaoAuctionHouse ABI (sonar-ponder-migration-v1 · sprint B-1 green belt · Group G)
//
// Event signatures extracted VERBATIM from the envio config.yaml
// (ApdaoAuctionHouse contract, config.yaml:524-551). The ApdaoAuctionHouse
// proxy (Berachain 80094, 0xE840929cd47c6a1cf0f5D9b6d0C6277075680A0b) emits the
// ApiologyDAO seat auction lifecycle + the exit-auction queue events.
//
// Follows the abis/MiberaAbis.ts + abis/MirrorObservabilityAbi.ts pattern —
// parseAbi keeps the surface compact; Ponder uses the ABI for filter inference
// + decoding only (functions / non-event items omitted).
import { parseAbi } from "viem";

// ApdaoAuctionHouse — seat auction lifecycle + queue management (Berachain 80094)
export const ApdaoAuctionHouseAbi = parseAbi([
  "event AuctionCreated(uint256 indexed apdaoId, uint256 startTime, uint256 endTime)",
  "event AuctionBid(uint256 indexed apdaoId, address sender, uint256 value, bool extended)",
  "event AuctionExtended(uint256 indexed apdaoId, uint256 endTime)",
  "event AuctionSettled(uint256 indexed apdaoId, address winner, uint256 amount)",
  "event TokensAddedToAuctionQueue(uint256[] tokenIds, address indexed owner)",
  "event TokensRemovedFromAuctionQueue(uint256[] tokenIds, address indexed owner)",
] as const);
