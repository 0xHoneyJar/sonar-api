// ponder-runtime/src/index.ts
//
// Ponder discovers handler registrations by globbing `src/**/*.{js,mjs,ts,mts}`
// (per ponder/dist/esm/build/index.js indexingPattern). Each file's
// `ponder.on(...)` calls register with the runtime via `ponder:registry`.
//
// This file is the entry surface — it re-exports all handler modules to
// guarantee they're imported in a known order. (The glob alone would suffice;
// the explicit import order is a defense against Vite's lazy-evaluation
// ordering surprises during cold start.)
//
// ALL 12 target handlers ACTIVE post-F2/F3/F6 re-dispatch.
//
//   - outbox-flush.ts                 — block-tick drain for pending_emits
//   - mibera-collection.ts            — Mibera ERC-721 Transfer (Berachain)
//                                       (subsumes mibera-staking.ts — F-5)
//   - paddlefi.ts                     — PaddleFi Mint/Pawn/LiquidateBorrow
//   - friendtech.ts                   — FriendtechShares Trade (Base)
//   - mibera-liquid-backing/*.ts      — 9 handlers (loans/treasury/rfv) F-2
//   - mibera-zora.ts                  — TransferSingle/TransferBatch F-3
//   - mibera-sets.ts                  — TransferSingle/TransferBatch F-3
//   - mibera-premint.ts               — Participated/Refunded F-3
//   - tracked-erc20.ts                — Transfer (HENLO + miberamaker) F-6
//   - puru-apiculture1155.ts          — TransferSingle/TransferBatch F-6
//   - aquabera-vault-direct.ts        — Deposit/Withdraw F-6
//
// See docs/A-2-handler-port-summary.md for the full envio→ponder mapping
// table + the contract-gap inventory.

import "./handlers/outbox-flush";
import "./handlers/mibera-collection";
// GeneralMints:Transfer + GeneralMints:Minted — frees Ruggy (registered in
// ponder.config.mibera.ts:218 but previously had no handler → mints silently
// discarded). Ports envio src/handlers/mints.ts + vm-minted.ts.
import "./handlers/general-mints";
import "./handlers/paddlefi";
import "./handlers/friendtech";

// MiberaLiquidBacking — 9 handlers split across 3 files (F-2 re-dispatch).
// Contract IS in A-1's ponder.config.mibera.ts. All 9 handlers ACTIVE.
import "./handlers/mibera-liquid-backing/loans";
import "./handlers/mibera-liquid-backing/treasury";
import "./handlers/mibera-liquid-backing/rfv";

// ACTIVATED in F-3 re-dispatch (contracts added to ponder.config.mibera.ts).
import "./handlers/mibera-zora";
import "./handlers/mibera-sets";
import "./handlers/mibera-premint";

// F-6 re-dispatch (T-A2.6 handlers — contracts added to ponder.config.mibera.ts).
import "./handlers/tracked-erc20";
import "./handlers/puru-apiculture1155";
import "./handlers/aquabera-vault-direct";

// Mibera-gap handler-only port (registered-but-unsubscribed, RLAI-verified).
// BgtToken:QueueBoost — restores the deceptively-partial-frozen "delegate"
// action slice. Contract + bgt_boost_event table already in config/schema.
import "./handlers/bgt";

// CubBadges1155:TransferSingle/TransferBatch — restores badge holdings rollup.
// Contract + badge_holder/badge_amount/badge_balance tables already in
// config/schema; there was no handler so badge state was silently never
// written. No NATS — writes the three badge tables + parallel recordAction.
import "./handlers/badges1155";

// CandiesMarket1155:TransferSingle/TransferBatch — restores Mibera Candies
// (mibera_drugs) mint inventory/backing + SilkRoad order tracking. Contract +
// candies_inventory/candies_backing/mibera_order/erc1155_mint_event tables
// already in config/schema; there was no handler so these were silently never
// written. No NATS — writes the four tables + parallel recordAction.
import "./handlers/candies-market1155";

// B-1 green-belt (Group H) — Mirror article purchases (Optimism 10).
// MirrorObservability is in ponder.config.ts (the green-belt config), NOT in
// ponder.config.mibera.ts (the LIVE green). This handler's registration
// requires the green-belt config to be ACTIVE — build/typecheck with
// BELT_CONFIG=ponder.config.ts.
import "./handlers/mirror-observability";

// B-1 green-belt (Group G) — ApDAO seat auctions (Berachain 80094).
// ApdaoAuctionHouse is in ponder.config.ts (the green-belt config), NOT in
// ponder.config.mibera.ts (the LIVE green). Ports envio src/handlers/
// apdao-auction.ts: AuctionCreated/AuctionBid/AuctionExtended/AuctionSettled +
// TokensAddedToAuctionQueue/TokensRemovedFromAuctionQueue → apdao_auction /
// apdao_bid / apdao_queued_token / apdao_auction_stats. No NATS. Registration
// requires the green-belt config to be ACTIVE — build/typecheck with
// BELT_CONFIG=ponder.config.ts.
import "./handlers/apdao-auction";

// B-1 green-belt (Group C) — MoneycombVault HJ-burn vaults (Berachain 80094).
// MoneycombVault is in ponder.config.ts (the green-belt config), NOT in
// ponder.config.mibera.ts (the LIVE green). Ports envio src/handlers/
// moneycomb-vault.ts: AccountOpened/AccountClosed/HJBurned/SharesMinted/
// RewardClaimed → vault / vault_activity / user_vault_summary. No NATS.
// Registration requires the green-belt config to be ACTIVE — build/typecheck
// with BELT_CONFIG=ponder.config.ts.
import "./handlers/moneycomb-vault";

// B-1 green-belt (Group E) — HENLOCKER vault (Berachain 80094).
// HenloVault is in ponder.config.ts (the green-belt config), NOT in
// ponder.config.mibera.ts (the LIVE green). Ports envio src/handlers/
// henlo-vault.ts HenloVault* lifecycle: Mint / RoundOpened / RoundClosed /
// DepositsPaused / DepositsUnpaused / MintFromReservoir / Redeem / ReservoirSet
// → henlo_vault_round / henlo_vault_deposit / henlo_vault_balance /
// henlo_vault_epoch / henlo_vault_stats / henlo_vault_user. The envio handler
// ALSO writes tracked_token_balance (Group D / TrackedErc20, already live in
// tracked-erc20.ts) — that path is NOT ported here. No NATS. Registration
// requires the green-belt config to be ACTIVE — build/typecheck with
// BELT_CONFIG=ponder.config.ts.
import "./handlers/henlo-vault";

// B-1 green-belt (Group A — the LARGEST + most complex) — validator-rewards /
// FatBera (Berachain 80094). The 7 validator contracts (FatBeraDeposits,
// FatBeraAccounting, BeaconDeposit, BlockRewardController, AutomatedStake,
// ValidatorWithdrawalModule, ValidatorDepositRouter) are in ponder.config.ts
// (the green-belt config), NOT ponder.config.mibera.ts (the LIVE green). Ports
// envio src/handlers/fatbera.ts (10 handlers) + src/handlers/fatbera-core.ts
// (reward-split + capacity-redistribution math) → validator_block_rewards (the
// 906k-row table) / validator_deposits / latest_validator_deposit /
// latest_validator_reward / validator_withdrawal_totals / withdrawal_batch /
// withdrawal_request / withdrawal_fulfillment / fatbera_deposit (+ action via
// recordAction). The order-sensitive Latest* read-before-write lookups +
// reward-split arithmetic are preserved verbatim (the envio isPreload two-pass
// is dropped — ponder reads singletons inline, single-pass, in sequential event
// order). No NATS. Registration requires the green-belt config to be ACTIVE —
// build/typecheck with BELT_CONFIG=ponder.config.ts.
import "./handlers/fatbera";
