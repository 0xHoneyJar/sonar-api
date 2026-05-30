// CrayonsFactory ABI (sonar-ponder-migration-v1 · sprint B-1 green belt · Group B)
//
// Event signature extracted VERBATIM from the envio config.yaml (CrayonsFactory
// contract, config.yaml:104-111 in the contracts header + address
// config.yaml:775-779). The CrayonsFactory (Berachain 80094,
// 0xF1c7d49B39a5aCa29ead398ad9A7024ed6837F87) emits one event when a new ERC721
// Base collection is deployed: Factory__NewERC721Base(owner, erc721Base).
//
// This is NOT a standard ERC721 event (the existing abis/MiberaAbis.ts
// Erc721TransferAbi only covers Transfer) — so per the dispatch brief's
// "author a minimal ABI only if a specific event isn't covered" rule, the one
// factory event gets its own parseAbi surface here. HoneyJar / HoneyJar*Eth /
// Honeycomb (Transfer) REUSE Erc721TransferAbi — no new ABI for those.
//
// Follows the abis/MiberaAbis.ts + abis/MoneycombVaultAbi.ts pattern: parseAbi
// keeps the surface compact; Ponder uses the ABI for filter inference +
// decoding only (functions / non-event items omitted).

import { parseAbi } from "viem";

export const CrayonsFactoryAbi = parseAbi([
  "event Factory__NewERC721Base(address indexed owner, address erc721Base)",
] as const);
