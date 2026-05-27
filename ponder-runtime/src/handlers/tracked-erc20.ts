// ponder-runtime/src/handlers/tracked-erc20.ts
//
// PORTED FROM: src/handlers/tracked-erc20.ts (envio, source-of-truth)
// Contract: TrackedErc20 (Base 8453 — MiberaMaker333 + 5 HENLO/HENLOCKED tokens
// per envio config.yaml lines 1170+).
//
// F-6 re-dispatch: ACTIVE — balance-tracking + miberamaker activity branches.
//
// PARTIAL PORT — what's INCLUDED:
//   1. Balance tracking (ALL tokens via TOKEN_CONFIGS routing).
//      Writes to `tracked_token_balance` (already in A-1 ponder schema).
//   2. Activity tracking for `miberamaker` (mint/burn/transfer actions).
//      Writes to `action` (already in A-1 ponder schema).
//
// PARTIAL PORT — what's DEFERRED (with citation):
//   3. HENLO holder-stats (envio src/handlers/tracked-erc20/holder-stats.ts).
//      Requires entities: HenloHolder + HenloHolderStats.
//   4. HENLO burn-tracking (envio src/handlers/tracked-erc20/burn-tracking.ts).
//      Requires entities: HenloBurn + HenloBurnStats + HenloGlobalBurnStats +
//      HenloBurner + HenloSourceBurner + HenloChainBurner.
//
// Why deferred: A-1's ponder.schema.ts does NOT include any HENLO substrate
// entities (verified 2026-05-27: no `henlo*` exports). Adding 8+ HENLO tables
// in this PR would materially expand A-1's blue-belt schema beyond its declared
// MiberaMaker333 scope. ENVIO's schema.graphql has the full set (HenloBurn etc),
// but only the MiberaMaker333 token is wired in A-1's ponder config.
//
// Operator decision required for G-5 of the original A-2 gap inventory: either
// (a) add HENLO substrate schema in a follow-up sprint, or (b) accept that
// HENLO-specific aggregates live in envio-only and ponder serves only
// balance + activity for these tokens. The handler logic IS structurally
// complete for the supported subset.

import { ponder } from "ponder:registry";
import { trackedTokenBalance } from "../../ponder.schema";
import { recordAction } from "../lib/record-action";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

interface TokenConfig {
  key: string;
  burnTracking: boolean;
  holderStats: boolean;
}

// Verbatim from envio src/handlers/tracked-erc20/constants.ts:21-58.
// Keep all 6 tokens so balance-tracking covers the full footprint;
// burnTracking/holderStats flags are read but currently no-op'd
// (the HENLO substrate isn't in A-1's ponder schema — see file header).
const TOKEN_CONFIGS: Record<string, TokenConfig> = {
  "0xb2f776e9c1c926c4b2e54182fac058da9af0b6a5": {
    key: "henlo",
    burnTracking: true,
    holderStats: true,
  },
  "0x120756ccc6f0cefb43a753e1f2534377c2694bb4": {
    key: "miberamaker",
    burnTracking: false,
    holderStats: false,
  },
  "0xf0edfc3e122db34773293e0e5b2c3a58492e7338": {
    key: "hlkd1b",
    burnTracking: false,
    holderStats: false,
  },
  "0x8ab854dc0672d7a13a85399a56cb628fb22102d6": {
    key: "hlkd690m",
    burnTracking: false,
    holderStats: false,
  },
  "0xf07fa3ece9741d408d643748ff85710bedef25ba": {
    key: "hlkd420m",
    burnTracking: false,
    holderStats: false,
  },
  "0x37dd8850919ebdca911c383211a70839a94b0539": {
    key: "hlkd330m",
    burnTracking: false,
    holderStats: false,
  },
  "0x7bdf98ddeed209cfa26bd2352b470ac8b5485ec5": {
    key: "hlkd100m",
    burnTracking: false,
    holderStats: false,
  },
};

const ACTIVITY_TRACKED_TOKENS = new Set<string>(["miberamaker"]);

function isBurnTransfer(to: string): boolean {
  const l = to.toLowerCase();
  return l === ZERO_ADDRESS || l === DEAD_ADDRESS;
}

ponder.on("TrackedErc20:Transfer", async ({ event, context }) => {
  const { from, to, value } = event.args;
  const timestamp = event.block.timestamp;
  const chainId = context.chain.id;
  const tokenAddress = event.log.address.toLowerCase();
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  const config = TOKEN_CONFIGS[tokenAddress];
  if (!config) return; // Token not in our tracked list.

  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();

  // ── 1. Balance tracking — all tokens ─────────────────────────────────────
  await updateBalance(
    context,
    tokenAddress,
    config.key,
    chainId,
    fromLower,
    toLower,
    value,
    timestamp
  );

  // ── 2/3. HENLO holder-stats + burn-tracking — DEFERRED (see file header).
  // The flags are read but no-op'd. When the operator approves expanding the
  // ponder schema with HENLO substrate, the branches below activate.
  if (config.holderStats) {
    // TODO(F-6 follow-up): port envio src/handlers/tracked-erc20/holder-stats.ts
    // once HenloHolder + HenloHolderStats tables land in ponder.schema.ts.
  }
  if (config.burnTracking && isBurnTransfer(toLower)) {
    // TODO(F-6 follow-up): port envio src/handlers/tracked-erc20/burn-tracking.ts
    // once HenloBurn + HenloBurnStats + HenloGlobalBurnStats land in ponder.schema.ts.
  }

  // ── 4. Activity tracking for miberamaker ─────────────────────────────────
  if (ACTIVITY_TRACKED_TOKENS.has(config.key)) {
    const isMint = fromLower === ZERO_ADDRESS;
    const isBurn = isBurnTransfer(toLower);

    let actionType: string;
    let actor: string;
    if (isMint) {
      actionType = `${config.key}_mint`;
      actor = toLower;
    } else if (isBurn) {
      actionType = `${config.key}_burn`;
      actor = fromLower;
    } else {
      // Regular transfer — record as the receiver (DEX trade buyer).
      actionType = `${config.key}_transfer`;
      actor = toLower;
    }

    await recordAction(context, {
      id: `${txHash}_${logIndex}`,
      actionType,
      actor,
      primaryCollection: config.key,
      timestamp,
      chainId,
      txHash,
      logIndex,
      numeric1: value,
      context: {
        from: fromLower,
        to: toLower,
        tokenAddress,
        isMint,
        isBurn,
      },
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// updateBalance — verbatim port of envio's updateBalance (lines 139-206).
// Handles sender (decrease) and receiver (increase) balance rows, with
// first-time-holder row creation. Burns leave receiver at zero (which the
// envio source notes is intentional — burn destinations are tracked for
// completeness via the same row).
// ────────────────────────────────────────────────────────────────────────────
async function updateBalance(
  context: any,
  tokenAddress: string,
  tokenKey: string,
  chainId: number,
  fromLower: string,
  toLower: string,
  value: bigint,
  timestamp: bigint
): Promise<void> {
  // Sender (decrease balance) — skip if mint.
  if (fromLower !== ZERO_ADDRESS) {
    const fromId = `${fromLower}_${tokenAddress}_${chainId}`;
    const fromBalance = await context.db.find(trackedTokenBalance, { id: fromId });

    if (fromBalance) {
      await context.db
        .update(trackedTokenBalance, { id: fromId })
        .set({
          balance: fromBalance.balance - value,
          lastUpdated: timestamp,
        });
    } else {
      // Negative-balance row — shouldn't happen in practice but envio creates
      // it for audit-trail purposes (handler ran out of order from indexed-block).
      await context.db
        .insert(trackedTokenBalance)
        .values({
          id: fromId,
          address: fromLower as `0x${string}`,
          tokenAddress: tokenAddress as `0x${string}`,
          tokenKey,
          chainId,
          balance: -value,
          lastUpdated: timestamp,
        })
        .onConflictDoNothing();
    }
  }

  // Receiver (increase balance) — skip if burn.
  if (toLower !== ZERO_ADDRESS) {
    const toId = `${toLower}_${tokenAddress}_${chainId}`;
    const toBalance = await context.db.find(trackedTokenBalance, { id: toId });

    if (toBalance) {
      await context.db
        .update(trackedTokenBalance, { id: toId })
        .set({
          balance: toBalance.balance + value,
          lastUpdated: timestamp,
        });
    } else {
      await context.db
        .insert(trackedTokenBalance)
        .values({
          id: toId,
          address: toLower as `0x${string}`,
          tokenAddress: tokenAddress as `0x${string}`,
          tokenKey,
          chainId,
          balance: value,
          lastUpdated: timestamp,
        })
        .onConflictDoNothing();
    }
  }
}
