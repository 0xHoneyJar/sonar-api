// HenloVault ABI (sonar-ponder-migration-v1 · sprint B-1 green belt · Group E)
//
// Event signatures extracted VERBATIM from the envio config.yaml
// (HenloVault contract, config.yaml:476-513 in the contracts header +
// address config.yaml:918-921). The HenloVault contract (Berachain 80094,
// 0x42069E3BF367C403b632CF9cD5a8d61e2c0c44fC) is the HENLOCKER vault system:
// HENLOCKED-token mint deposits, per-strike rounds, epochs, and rollup stats.
//
// Follows the abis/MiberaAbis.ts + abis/MirrorObservabilityAbi.ts +
// abis/ApdaoAuctionHouseAbi.ts + abis/MoneycombVaultAbi.ts pattern — parseAbi
// keeps the surface compact; Ponder uses the ABI for filter inference +
// decoding only (functions / non-event items omitted).
//
// TRACKED-TOKEN SCOPE NOTE (grounded — see b-1-handler-gap.md §"Group E"):
// the envio src/handlers/henlo-vault.ts ALSO writes `tracked_token_balance`
// (the 40-Mibera / Group-D `TrackedErc20` path). That path is ALREADY ported
// (ponder-runtime/src/handlers/tracked-erc20.ts) and is NOT re-handled here.
// This ABI + the ported handler cover the `henlo_vault_*` entities ONLY. The
// `TrackedErc20` contract is registered separately in ponder.config.mibera.ts
// and MUST NOT be re-registered for Group E.
//
// uint48 (epochId) / uint64 (strike) / uint256 (amount, depositLimit) all
// decode to JS `bigint` in viem — matching the envio handler's bigint usage.
import { parseAbi } from "viem";

// HenloVault — HENLOCKER round/epoch/deposit system (Berachain 80094)
export const HenloVaultAbi = parseAbi([
  "event Mint(address indexed user, uint256 indexed strike, uint256 amount)",
  "event RoundOpened(uint48 indexed epochId, uint64 indexed strike, uint256 depositLimit)",
  "event RoundClosed(uint48 indexed epochId, uint64 indexed strike)",
  "event DepositsPaused(uint48 indexed epochId, uint64 indexed strike)",
  "event DepositsUnpaused(uint48 indexed epochId, uint64 indexed strike)",
  "event MintFromReservoir(address indexed reservoir, uint64 indexed strike, uint256 amount)",
  "event Redeem(address indexed user, uint64 indexed strike, uint256 amount)",
  "event ReservoirSet(uint48 indexed epochId, uint64 indexed strike, address indexed reservoir)",
] as const);
