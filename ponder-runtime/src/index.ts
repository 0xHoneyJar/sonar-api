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
import "./handlers/address-resolve"; // sonar-api#63 — address-type resolver block-tick
import "./handlers/mibera-collection";
// GeneralMints:Transfer + GeneralMints:Minted — frees Ruggy (registered in
// ponder.config.mibera.ts:218 but previously had no handler → mints silently
// discarded). Ports envio src/handlers/mints.ts + vm-minted.ts.
import "./handlers/general-mints";
// TrackedErc721Bera:Transfer (bd-1jg / S1b) — the 12 Berachain ERC-721 contracts
// (Tarot + 10 Fractures + apdao_seat, ponder.config.mibera.ts:75-87) were
// registered with NO handler → their transfers VANISHED. Restores the per-token
// `token` current-owner projection (token-only scope — the only consumer,
// inventory-api's Stash, reads the `token` index by contract address).
import "./handlers/tracked-erc721-bera";
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
