// FatBera / validator-rewards ABIs (sonar-ponder-migration-v1 · sprint B-1 · Group A)
//
// Event signatures extracted VERBATIM from the envio config.yaml (config.yaml:360-422,
// the 7 validator-rewards contracts) + addresses config.yaml:856-885. Group A is the
// LARGEST + most complex green-belt group: validator deposit/reward state machine on
// Berachain (80094).
//
// Follows the abis/MiberaAbis.ts + abis/HenloVaultAbi.ts + abis/ApdaoAuctionHouseAbi.ts
// + abis/MoneycombVaultAbi.ts pattern — parseAbi keeps the surface compact; Ponder uses
// the ABI for filter inference + decoding only (functions / non-event items omitted).
//
// ── INDEXED-BYTES PUBKEY DECODING (load-bearing fidelity note) ──────────────────────
// Three events carry a `bytes indexed` pubkey/cometBFTPublicKey:
//   BlockRewardController.BlockRewardProcessed   — bytes indexed pubkey
//   AutomatedStake.WithdrawUnwrapAndStakeExecuted— bytes indexed pubkey
//   ValidatorWithdrawalModule.ValidatorWithdrawalRequested — bytes indexed cometBFTPublicKey
// For an `indexed` dynamic `bytes` param, the topic is keccak256(rawBytes), NOT the raw
// value — viem decodes `event.args.pubkey` as the 32-byte keccak HASH (a 0x hex string).
// This is EXACTLY what the fatbera handlers match against: `VALIDATORS.find(v => v.id ===
// pubkey.toLowerCase())` — `v.id` IS the keccak-hash (the envio VALIDATORS table carries
// BOTH `pubkey` (raw 48-byte) and `id` (the bytes32 hash)). So the indexed-bytes hash
// topic aligns with the `v.id` match by construction — NO transaction-calldata recovery
// is needed here (unlike bgt.ts QueueBoost, which matches the RAW pubkey and therefore
// must re-decode the calldata). See ponder-runtime/src/handlers/fatbera.ts header.
//
// BeaconDeposit.Deposit carries a NON-indexed `bytes pubkey` → viem decodes the RAW
// 48-byte value into event.args.pubkey; the handler matches `v.pubkey` (raw). ✓
//
// uint256/uint64/uint48 args (assets, shares, rewardAmount, amount, batchId, totalAmount,
// nextTimestamp, baseRate, rewardRate, withdrawAmount, fee, validatorIndex) all decode to
// JS `bigint` in viem — matching the envio handler's bigint usage (the envio BigInt(x.toString())
// wraps are dropped in the ponder port).
import { parseAbi } from "viem";

// FatBeraDeposits — ERC4626-style deposit (Berachain 80094, 0xBAE11292a3E693AF73651BDa350d752AE4A391d4)
export const FatBeraDepositsAbi = parseAbi([
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
] as const);

// FatBeraAccounting — reward accrual + withdrawal-batch lifecycle (Berachain 80094, same addr as deposits)
export const FatBeraAccountingAbi = parseAbi([
  "event RewardAdded(address indexed token, uint256 rewardAmount)",
  "event WithdrawalRequested(address indexed user, uint256 indexed batchId, uint256 amount)",
  "event BatchStarted(uint256 indexed batchId, uint256 totalAmount)",
  "event WithdrawalFulfilled(address indexed user, uint256 indexed batchId, uint256 amount)",
] as const);

// BeaconDeposit — canonical Berachain beacon deposit (Berachain 80094, 0x4242424242424242424242424242424242424242)
// NON-indexed bytes pubkey → raw value decoded.
export const BeaconDepositAbi = parseAbi([
  "event Deposit(bytes pubkey, bytes credentials, uint64 amount, bytes signature, uint64 index)",
] as const);

// BlockRewardController — per-block validator reward (Berachain 80094, 0x1ae7dd7ae06f6c58b4524d9c1f816094b1bccd8e)
// INDEXED bytes pubkey → keccak-hash topic (matches VALIDATORS[i].id).
export const BlockRewardControllerAbi = parseAbi([
  "event BlockRewardProcessed(bytes indexed pubkey, uint64 nextTimestamp, uint256 baseRate, uint256 rewardRate)",
] as const);

// AutomatedStake — automated withdraw→unwrap→stake (Berachain 80094, 0x8ba92925c156ea522Cd80b4633bd0a9824c3bcdf)
// INDEXED bytes pubkey → keccak-hash topic (matches VALIDATORS[i].id; falls back to validatorIndex).
export const AutomatedStakeAbi = parseAbi([
  "event WithdrawUnwrapAndStakeExecuted(uint256 indexed amount, uint256 indexed validatorIndex, bytes indexed pubkey)",
] as const);

// ValidatorWithdrawalModule — validator withdrawal via safe (Berachain 80094; 3 addresses)
// INDEXED bytes cometBFTPublicKey → keccak-hash topic (matches VALIDATORS[i].id).
export const ValidatorWithdrawalModuleAbi = parseAbi([
  "event ValidatorWithdrawalRequested(address indexed safe, address indexed initiator, bytes indexed cometBFTPublicKey, uint256 withdrawAmount, uint256 fee)",
] as const);

// ValidatorDepositRouter — routed deposit with capacity redistribution (Berachain 80094, 0x989212D8227a8957b9247e1966046B47a7a63D64)
// validatorIndex is uint256 (NOT bytes) → no hash concern.
export const ValidatorDepositRouterAbi = parseAbi([
  "event ValidatorDepositRequested(address indexed depositor, address indexed receiver, uint256 amount, uint256 indexed validatorIndex)",
] as const);
