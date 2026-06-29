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

import { createConfig } from "ponder";
import miberaConfig from "./ponder.config.mibera";
import { MirrorObservabilityAbi } from "./abis/MirrorObservabilityAbi";

// ─── Optimism (10) green-belt contract addresses ────────────────────────
// Mirror's WritingEditions observability contract (per envio config.yaml
// MirrorObservability + src/handlers/mirror-observability.ts).
const MIRROR_OBSERVABILITY_OP = "0x4c2393aae4f0ad55dfd4ddcfa192f817d1b28d1f";

// Optimism migration boundary (rollup → pin EXACTLY, no finality overlap).
// mirror_article_stats accumulates totalPurchases / totalRevenue, so any
// overlap with the frozen import would double-count. Boundary = 152132710.
const OP_MIRROR_START_BLOCK = 152132710;

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
  },

  // Block-tick outbox flush carried over VERBATIM from the blue-belt config.
  blocks: miberaConfig.blocks,
});
