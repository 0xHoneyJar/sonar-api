// Ponder config — GREEN BELT (sonar-ponder-migration-v1 · sprint B-1)
//
// This is the FULL green-belt config: it is the blue-belt Mibera config
// (ponder.config.mibera.ts — the LIVE green's config, 40 Mibera contracts +
// 4 chains + database block) PLUS the green-belt contracts that B-1 ports.
//
// ARCHITECTURE (Dockerfile.belt-ponder):
//   BELT_CONFIG = ponder.config.mibera.ts  → LIVE green (blue-belt Mibera)
//   BELT_CONFIG = ponder.config.ts         → green-belt deployment (THIS file)
//
// The LIVE green keeps booting on ponder.config.mibera.ts (untouched —
// changing it would rotate build_id + break live Mibera serving). The
// green-belt deployment boots on this file. The handler glob
// (ponder-runtime/src/**/*.ts) registers ponder.on("MirrorObservability:...")
// which REQUIRES MirrorObservability to be in the ACTIVE config — so the
// green-belt build/typecheck MUST use BELT_CONFIG=ponder.config.ts (this file).
//
// Composition: import the blue-belt config's default export and spread its
// chains / database / contracts VERBATIM (so the Mibera surface stays a
// single source of truth in ponder.config.mibera.ts), then ADD the green-belt
// contracts. The repo-root ponder.config.mibera.ts is NOT modified.
//
// ─── Group H (Mirror) ──────────────────────────────────────────────────
//   MirrorObservability (Optimism 10) — WritingEditionPurchased.
//   Address 0x4c2393aae4f0ad55dfd4ddcfa192f817d1b28d1f.
//   startBlock = the Optimism migration boundary 152132710 EXACTLY (no
//   overlap): the handler touches mirror_article_stats, a ROLLUP (additive
//   counters), so forward-index from the boundary; pre-boundary history comes
//   from the frozen import — NOT envio's deploy block.
//
// ─── Group G (ApDAO auction-house) ───────────────────────────────────────
//   ApdaoAuctionHouse proxy (Berachain 80094) — ApiologyDAO seat auctions.
//   Address 0xE840929cd47c6a1cf0f5D9b6d0C6277075680A0b.
//   startBlock = the Berachain migration boundary 21424739 EXACTLY (no
//   overlap, per b-1-plan §2.3): apdao touches rollup entities
//   (apdao_auction bidCount/settled mutate per bid/settle; apdao_auction_stats
//   accumulates totalAuctions/totalBids/totalVolume; apdao_queued_token flips
//   isQueued), so any overlap with the frozen import would double-count or
//   re-flip state. Forward-index from the boundary; pre-boundary history comes
//   from the frozen import — NOT envio's deploy block (5206807).
//
// ─── Group E (HenloVault · HENLOCKER vault) ──────────────────────────────
//   HenloVault (Berachain 80094) — HENLOCKER round/epoch/deposit system.
//   Address 0x42069E3BF367C403b632CF9cD5a8d61e2c0c44fC.
//   startBlock = the Berachain migration boundary 21424739 EXACTLY (no
//   overlap): henlo_vault_round/_balance/_epoch/_stats/_user are rollups
//   (deposit totals + counters accumulate; closed/paused/canRedeem flip), so
//   any overlap with the frozen import would double-count / re-flip state.
//   Forward-index from the boundary; pre-boundary history comes from the
//   frozen import — NOT envio's deploy block (2041392). The envio handler also
//   writes tracked_token_balance (Group D / TrackedErc20, already live) — that
//   path is NOT ported here; only the henlo_vault_* writes.

import { createConfig } from "ponder";
import miberaConfig from "./ponder.config.mibera";
import { MirrorObservabilityAbi } from "./abis/MirrorObservabilityAbi";
import { ApdaoAuctionHouseAbi } from "./abis/ApdaoAuctionHouseAbi";
import { MoneycombVaultAbi } from "./abis/MoneycombVaultAbi";
import { HenloVaultAbi } from "./abis/HenloVaultAbi";
import {
  FatBeraDepositsAbi,
  FatBeraAccountingAbi,
  BeaconDepositAbi,
  BlockRewardControllerAbi,
  AutomatedStakeAbi,
  ValidatorWithdrawalModuleAbi,
  ValidatorDepositRouterAbi,
} from "./abis/FatBeraAbis";

// ─── Optimism (10) green-belt contract addresses ────────────────────────
// Mirror's WritingEditions observability contract (per envio config.yaml
// MirrorObservability + src/handlers/mirror-observability.ts).
const MIRROR_OBSERVABILITY_OP = "0x4c2393aae4f0ad55dfd4ddcfa192f817d1b28d1f";

// Optimism migration boundary (rollup → pin EXACTLY, no finality overlap).
// mirror_article_stats accumulates totalPurchases / totalRevenue, so any
// overlap with the frozen import would double-count. Boundary = 152132710.
const OP_MIRROR_START_BLOCK = 152132710;

// ─── Berachain (80094) green-belt contract addresses ────────────────────
// ApdaoAuctionHouse proxy — events emit from here (per envio config.yaml
// ApdaoAuctionHouse + src/handlers/apdao-auction.ts; address config.yaml:954).
const APDAO_AUCTION_HOUSE_BERA = "0xE840929cd47c6a1cf0f5D9b6d0C6277075680A0b";

// Berachain migration boundary (rollup → pin EXACTLY, no finality overlap).
// apdao_auction / apdao_auction_stats / apdao_queued_token mutate or accumulate
// per event, so any overlap with the frozen import would double-count / re-flip
// state. Boundary = 21424739 (identical to the blue-belt BERA_START_BLOCK).
const BERA_APDAO_START_BLOCK = 21424739;

// ─── Group C (MoneycombVault · Berachain 80094) ──────────────────────────
// MoneycombVault — events emit from here (per envio config.yaml MoneycombVault
// + src/handlers/moneycomb-vault.ts; address config.yaml:772). HJ-burn vault.
const MONEYCOMB_VAULT_BERA = "0x9279b2227b57f349a0ce552b25af341e735f6309";

// Berachain migration boundary (rollup → pin EXACTLY, no finality overlap).
// vault (isActive/shares/burnedGenN/totalBurned mutate) + user_vault_summary
// (totalVaults/activeVaults/totalShares accumulate) are rollups, so any overlap
// with the frozen import would re-flip state / double-count. Forward-index from
// the boundary; pre-boundary history comes from the frozen import — NOT envio's
// deploy block (6954915, per config.yaml:773). Boundary = 21424739 (identical
// to the blue-belt BERA_START_BLOCK / the Group-G apdao boundary).
const BERA_MONEYCOMB_START_BLOCK = 21424739;

// ─── Group E (HenloVault · Berachain 80094) ──────────────────────────────
// HenloVault — events emit from here (per envio config.yaml HenloVault +
// src/handlers/henlo-vault.ts; address config.yaml:920). HENLOCKER round/epoch
// /deposit system. NOTE: the envio handler ALSO writes tracked_token_balance
// (the Group-D / 40-Mibera TrackedErc20 path, already ported in
// tracked-erc20.ts + registered as TrackedErc20 in ponder.config.mibera.ts).
// This registration covers HenloVault events ONLY; TrackedErc20 is NOT
// re-registered for Group E.
const HENLO_VAULT_BERA = "0x42069E3BF367C403b632CF9cD5a8d61e2c0c44fC";

// Berachain migration boundary (rollup → pin EXACTLY, no finality overlap).
// henlo_vault_round / _balance / _epoch / _stats / _user are rollups
// (totalDeposits/userDeposits/whaleDeposits/balance/totalUsers/totalRounds/
// totalEpochs accumulate; closed/depositsPaused/canRedeem mutate), so any
// overlap with the frozen import would double-count / re-flip state.
// Forward-index from the boundary; pre-boundary history comes from the frozen
// import — NOT envio's deploy block (2041392, per config.yaml:921). Boundary =
// 21424739 (identical to the blue-belt BERA_START_BLOCK / the Group-G apdao /
// Group-C moneycomb boundaries).
const BERA_HENLO_VAULT_START_BLOCK = 21424739;

// ─── Group A (validator-rewards / FatBera · Berachain 80094) ──────────────
// The 7 validator-rewards contracts (config.yaml:856-885). All Berachain-only.
// Addresses VERBATIM from config.yaml. ValidatorWithdrawalModule has THREE
// addresses (config.yaml:877-880) — passed as an address array (same shape
// ponder.config.mibera.ts uses for multi-address contracts).
const FATBERA_DEPOSITS_BERA = "0xBAE11292a3E693AF73651BDa350d752AE4A391d4";
const FATBERA_ACCOUNTING_BERA = "0xBAE11292a3E693AF73651BDa350d752AE4A391d4";
const BEACON_DEPOSIT_BERA = "0x4242424242424242424242424242424242424242";
const BLOCK_REWARD_CONTROLLER_BERA = "0x1ae7dd7ae06f6c58b4524d9c1f816094b1bccd8e";
const AUTOMATED_STAKE_BERA = "0x8ba92925c156ea522Cd80b4633bd0a9824c3bcdf";
const VALIDATOR_WITHDRAWAL_MODULE_BERA = [
  "0x81Da3e3E0C0C541038646AcE201EA17c4274bbcb",
  "0xE9f68A1cFe403f84C7bD37a590CfE390A3250324",
  "0x56c70E5eFbA5f18B04d17bBC580b6d37B3AFE5Ed",
] as const;
const VALIDATOR_DEPOSIT_ROUTER_BERA = "0x989212D8227a8957b9247e1966046B47a7a63D64";

// Berachain migration boundary — pin EXACTLY (no finality overlap), 21424739.
// Per the B-1 dispatch brief: ALL 7 Group-A contracts forward-index from the
// boundary, NOT envio's deploy blocks (1066385 / 1966971). The validator family
// mixes append-running (validator_block_rewards / validator_deposits carry
// cumulative running totals copied from the prior latest row), rollup-lww
// (latest_validator_deposit / latest_validator_reward / withdrawal_batch), and
// rollup (validator_withdrawal_totals additive counters). Append-running rows
// are only correct if the prior latest row is present, and the rollups
// double-count / re-flip on overlap — so any overlap with the frozen import
// would corrupt the running totals + the latest-snapshot singletons. Boundary =
// 21424739 (identical to the blue-belt BERA_START_BLOCK / the Group-G apdao /
// Group-C moneycomb / Group-E henlo-vault boundaries). Pre-boundary history
// (incl. the 906,771-row validator_block_rewards table) comes from the frozen
// import. ** Live correctness of the forward append-running totals + the
// Latest* singletons must be RLAI-graded at green-v3 boot (see report). **
const BERA_FATBERA_START_BLOCK = 21424739;

export default createConfig({
  // Chains + database carried over VERBATIM from the blue-belt config.
  // Optimism (10) is already a chain in ponder.config.mibera.ts.
  chains: miberaConfig.chains,
  database: miberaConfig.database,

  contracts: {
    // ─── All 40 blue-belt Mibera contracts (4 chains) — VERBATIM ────────
    ...miberaConfig.contracts,

    // ─── Green-belt: Group H (Mirror · Optimism 10) ─────────────────────
    // MirrorObservability — WritingEditionPurchased. Required for the
    // ponder.on("MirrorObservability:WritingEditionPurchased") registration
    // in ponder-runtime/src/handlers/mirror-observability.ts.
    MirrorObservability: {
      chain: "optimism",
      abi: MirrorObservabilityAbi,
      address: MIRROR_OBSERVABILITY_OP,
      startBlock: OP_MIRROR_START_BLOCK,
    },

    // ─── Green-belt: Group G (ApDAO · Berachain 80094) ──────────────────
    // ApdaoAuctionHouse — AuctionCreated / AuctionBid / AuctionExtended /
    // AuctionSettled + TokensAddedToAuctionQueue / TokensRemovedFromAuctionQueue.
    // Required for the ponder.on("ApdaoAuctionHouse:<Event>") registrations in
    // ponder-runtime/src/handlers/apdao-auction.ts. Berachain (80094) is
    // already a chain in ponder.config.mibera.ts.
    ApdaoAuctionHouse: {
      chain: "berachain",
      abi: ApdaoAuctionHouseAbi,
      address: APDAO_AUCTION_HOUSE_BERA,
      startBlock: BERA_APDAO_START_BLOCK,
    },

    // ─── Green-belt: Group C (MoneycombVault · Berachain 80094) ─────────
    // MoneycombVault — AccountOpened / AccountClosed / HJBurned / SharesMinted /
    // RewardClaimed. Required for the ponder.on("MoneycombVault:<Event>")
    // registrations in ponder-runtime/src/handlers/moneycomb-vault.ts.
    // Berachain (80094) is already a chain in ponder.config.mibera.ts.
    MoneycombVault: {
      chain: "berachain",
      abi: MoneycombVaultAbi,
      address: MONEYCOMB_VAULT_BERA,
      startBlock: BERA_MONEYCOMB_START_BLOCK,
    },

    // ─── Green-belt: Group E (HenloVault · Berachain 80094) ─────────────
    // HenloVault — Mint / RoundOpened / RoundClosed / DepositsPaused /
    // DepositsUnpaused / MintFromReservoir / Redeem / ReservoirSet. Required
    // for the ponder.on("HenloVault:<Event>") registrations in
    // ponder-runtime/src/handlers/henlo-vault.ts → henlo_vault_round /
    // henlo_vault_deposit / henlo_vault_balance / henlo_vault_epoch /
    // henlo_vault_stats / henlo_vault_user. The tracked_token_balance path the
    // envio handler also writes is NOT ported here (Group D / TrackedErc20,
    // already live). No NATS. Berachain (80094) is already a chain in
    // ponder.config.mibera.ts. Registration requires the green-belt config to
    // be ACTIVE — build/typecheck with BELT_CONFIG=ponder.config.ts.
    HenloVault: {
      chain: "berachain",
      abi: HenloVaultAbi,
      address: HENLO_VAULT_BERA,
      startBlock: BERA_HENLO_VAULT_START_BLOCK,
    },

    // ─── Green-belt: Group A (validator-rewards / FatBera · Berachain 80094) ─
    // The 7 validator-rewards contracts. Required for the ponder.on(...)
    // registrations in ponder-runtime/src/handlers/fatbera.ts:
    //   FatBeraDeposits:Deposit                              → fatbera_deposit + validator_deposits / latest_validator_deposit
    //   FatBeraAccounting:RewardAdded                        → validator_block_rewards / latest_validator_reward (proportional redistribution)
    //   FatBeraAccounting:WithdrawalRequested                → withdrawal_request / withdrawal_batch
    //   FatBeraAccounting:BatchStarted                       → withdrawal_batch (status → pending; opens next)
    //   FatBeraAccounting:WithdrawalFulfilled                → withdrawal_fulfillment / withdrawal_batch (status → fulfilled)
    //   BeaconDeposit:Deposit                                → validator_deposits / latest_validator_deposit
    //   BlockRewardController:BlockRewardProcessed           → validator_block_rewards / latest_validator_reward (THE 906k-row producer)
    //   AutomatedStake:WithdrawUnwrapAndStakeExecuted        → validator_deposits / latest_validator_deposit (outstandingFatBERA decrement)
    //   ValidatorWithdrawalModule:ValidatorWithdrawalRequested → validator_withdrawal_totals + validator_deposits / latest_validator_deposit
    //   ValidatorDepositRouter:ValidatorDepositRequested     → validator_deposits / latest_validator_deposit (capacity + redistribution)
    // No NATS. Registration requires the green-belt config to be ACTIVE —
    // build/typecheck with BELT_CONFIG=ponder.config.ts. Berachain (80094) is
    // already a chain in ponder.config.mibera.ts.
    FatBeraDeposits: {
      chain: "berachain",
      abi: FatBeraDepositsAbi,
      address: FATBERA_DEPOSITS_BERA,
      startBlock: BERA_FATBERA_START_BLOCK,
    },
    FatBeraAccounting: {
      chain: "berachain",
      abi: FatBeraAccountingAbi,
      address: FATBERA_ACCOUNTING_BERA,
      startBlock: BERA_FATBERA_START_BLOCK,
    },
    BeaconDeposit: {
      chain: "berachain",
      abi: BeaconDepositAbi,
      address: BEACON_DEPOSIT_BERA,
      startBlock: BERA_FATBERA_START_BLOCK,
    },
    BlockRewardController: {
      chain: "berachain",
      abi: BlockRewardControllerAbi,
      address: BLOCK_REWARD_CONTROLLER_BERA,
      startBlock: BERA_FATBERA_START_BLOCK,
    },
    AutomatedStake: {
      chain: "berachain",
      abi: AutomatedStakeAbi,
      address: AUTOMATED_STAKE_BERA,
      startBlock: BERA_FATBERA_START_BLOCK,
    },
    ValidatorWithdrawalModule: {
      chain: "berachain",
      abi: ValidatorWithdrawalModuleAbi,
      address: [...VALIDATOR_WITHDRAWAL_MODULE_BERA],
      startBlock: BERA_FATBERA_START_BLOCK,
    },
    ValidatorDepositRouter: {
      chain: "berachain",
      abi: ValidatorDepositRouterAbi,
      address: VALIDATOR_DEPOSIT_ROUTER_BERA,
      startBlock: BERA_FATBERA_START_BLOCK,
    },
  },

  // Block-tick outbox flush carried over VERBATIM from the blue-belt config.
  blocks: miberaConfig.blocks,
});
