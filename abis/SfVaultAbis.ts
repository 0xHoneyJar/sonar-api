// Set & Forgetti vault ABIs (sonar-ponder-migration-v1 · sprint B-1 green belt · Group F)
//
// Event signatures extracted VERBATIM from the envio config.yaml
// (config.yaml:433-475, the 3 Set & Forgetti contracts) + addresses
// config.yaml:891-916. Group F is the LARGEST handler in the repo
// (src/handlers/sf-vaults.ts, ~40KB): ERC4626 vault deposits/withdrawals +
// MultiRewards staking/claiming, with stateful per-MultiRewards position
// tracking across strategy migrations.
//
// Follows the abis/MiberaAbis.ts + abis/FatBeraAbis.ts + abis/HenloVaultAbi.ts
// + abis/ApdaoAuctionHouseAbi.ts + abis/MoneycombVaultAbi.ts pattern — parseAbi
// keeps the surface compact; Ponder uses the ABI for filter inference +
// decoding only (functions / non-event items omitted).
//
// ── RPC READ ABIs (kept here for grounding traceability) ────────────────────
// The handler also reads two view functions off-chain via context.client:
//   SFVaultStrategyWrapper.multiRewardsAddress() view returns (address)
//   SFMultiRewards.stakingToken()             view returns (address)
// Those are parsed inline in the handler (parseAbi at the call site) — same as
// the envio source did (createEffect bodies). They are NOT part of the
// event-decoding ABIs below (Ponder only needs the events to infer log filters).
//
// uint256 args (assets, shares, amount, reward) decode to JS `bigint` in viem —
// matching the envio handler's bigint usage. address args (sender, owner,
// receiver, user, rewardsToken, oldStrategy, newStrategy, oldMultiRewards,
// newMultiRewards) decode to 0x hex strings (lowercased at the handler boundary).
import { parseAbi } from "viem";

// SFVaultERC4626 — ERC4626 deposit/withdraw + strategy-migration announce
// (Berachain 80094; 5 vault addresses, config.yaml:891-898).
export const SFVaultERC4626Abi = parseAbi([
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event StrategyUpdated(address indexed oldStrategy, address indexed newStrategy)",
] as const);

// SFMultiRewards — staking + reward distribution (Berachain 80094; 5
// MultiRewards addresses, config.yaml:909-916).
export const SFMultiRewardsAbi = parseAbi([
  "event Staked(address indexed user, uint256 amount)",
  "event Withdrawn(address indexed user, uint256 amount)",
  "event RewardPaid(address indexed user, address indexed rewardsToken, uint256 reward)",
  "event RebatePaid(address indexed user, uint256 amount)",
] as const);

// SFVaultStrategyWrapper — emits when vault admin updates the MultiRewards
// contract (Berachain 80094; 5 strategy addresses, config.yaml:899-907).
export const SFVaultStrategyWrapperAbi = parseAbi([
  "event MultiRewardsUpdated(address indexed oldMultiRewards, address indexed newMultiRewards)",
] as const);
