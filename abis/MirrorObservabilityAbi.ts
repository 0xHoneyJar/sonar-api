// MirrorObservability ABI (sonar-ponder-migration-v1 · sprint B-1 green belt · Group H)
//
// Event signature extracted VERBATIM from the envio contract surface
// (config.yaml MirrorObservability + src/handlers/mirror-observability.ts).
// WritingEditionPurchased is emitted by Mirror's WritingEditions observability
// contract on Optimism (10) for ALL clones; the handler filters to Mibera
// article clones (src/handlers/mirror-observability/constants.ts).
//
// Follows the abis/MiberaAbis.ts pattern — parseAbi keeps the surface compact;
// Ponder uses the ABI for filter inference + decoding only.
import { parseAbi } from "viem";

// MirrorObservability — WritingEditionPurchased (Optimism 10)
export const MirrorObservabilityAbi = parseAbi([
  "event WritingEditionPurchased(address indexed clone, uint256 tokenId, address indexed recipient, uint256 price, string message)",
] as const);
