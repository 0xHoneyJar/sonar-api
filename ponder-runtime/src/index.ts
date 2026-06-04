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
