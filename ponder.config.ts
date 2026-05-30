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

import { createConfig } from "ponder";
import miberaConfig from "./ponder.config.mibera";
import { MirrorObservabilityAbi } from "./abis/MirrorObservabilityAbi";
import { ApdaoAuctionHouseAbi } from "./abis/ApdaoAuctionHouseAbi";
import { MoneycombVaultAbi } from "./abis/MoneycombVaultAbi";

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
  },

  // Block-tick outbox flush carried over VERBATIM from the blue-belt config.
  blocks: miberaConfig.blocks,
});
