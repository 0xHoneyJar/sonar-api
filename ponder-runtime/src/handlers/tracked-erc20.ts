// ponder-runtime/src/handlers/tracked-erc20.ts
//
// PORTED FROM: src/handlers/tracked-erc20.ts (envio, source-of-truth)
// Contract: TrackedErc20 (Base 8453 — MiberaMaker333 + 5 HENLO/HENLOCKED tokens
// per envio config.yaml lines 1170+).
//
// F-6 re-dispatch: ACTIVE — balance-tracking + miberamaker activity branches.
//
// B-1 green-belt (Group D): ACTIVATED — HENLO holder-stats + burn-tracking.
//
// FULL PORT — what's INCLUDED:
//   1. Balance tracking (ALL tokens via TOKEN_CONFIGS routing).
//      Writes to `tracked_token_balance` (blue-belt ponder schema).
//   2. HENLO holder-stats (envio src/handlers/tracked-erc20/holder-stats.ts).
//      Writes to `henlo_holder` + `henlo_holder_stats`.
//   3. HENLO burn-tracking (envio src/handlers/tracked-erc20/burn-tracking.ts).
//      Writes to `henlo_burn` + `henlo_burn_stats` + `henlo_global_burn_stats` +
//      `henlo_burner` + `henlo_chain_burner` + `henlo_source_burner`, and calls
//      recordAction(...).
//   4. Activity tracking for `miberamaker` (mint/burn/transfer actions).
//      Writes to `action` (blue-belt ponder schema).
//
// The 8 henlo green-belt tables landed in ponder.schema.ts ("green-belt: henlo
// (B-1 Group D)" section), ported column-by-column from
// grimoires/loa/migration/b-1-green-belt-map.yaml. The holder-stats +
// burn-tracking branches below are a verbatim envio→ponder API-pivot of the
// envio modules (event.params→event.args, context.<Entity>.get→context.db.find,
// context.<Entity>.set→insert/update). Envio's optional-chaining guards for
// HenloChainBurner/HenloSourceBurner (a schema-version hack) are dropped here —
// all 8 tables exist in ponder, so those writes are direct.

import { ponder } from "ponder:registry";
import {
  trackedTokenBalance,
  henloHolder,
  henloHolderStats,
  henloBurn,
  henloBurnStats,
  henloGlobalBurnStats,
  henloBurner,
  henloChainBurner,
  henloSourceBurner,
} from "../../ponder.schema";
import { recordAction } from "../lib/record-action";

// INVARIANT: ZERO_ADDRESS and DEAD_ADDRESS MUST remain lowercase literals.
// isBurnTransfer() and updateHolderBalances() compare a lowercased arg against
// these constants directly (envio's isBurnTransfer lowercases BOTH sides — this
// port relies on the literals already being lowercase). A future edit that
// pastes a checksummed address here would silently break burn/holder detection.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

interface TokenConfig {
  key: string;
  burnTracking: boolean;
  holderStats: boolean;
  burnSources?: Record<string, string>; // contract address -> source name
}

// Henlo burn source addresses (Berachain mainnet).
// Verbatim from envio src/handlers/tracked-erc20/constants.ts:14-18.
const HENLO_BURN_SOURCES: Record<string, string> = {
  "0xde81b20b6801d99efeaeced48a11ba025180b8cc": "incinerator",
  // TODO: Add actual OverUnder contract address when available
  // TODO: Add actual BeraTrackr contract address when available
};

// Verbatim from envio src/handlers/tracked-erc20/constants.ts:20-60.
// Keep all 7 tokens so balance-tracking covers the full footprint;
// only the HENLO token has burnTracking + holderStats = true (B-1 Group D).
const TOKEN_CONFIGS: Record<string, TokenConfig> = {
  "0xb2f776e9c1c926c4b2e54182fac058da9af0b6a5": {
    key: "henlo",
    burnTracking: true,
    holderStats: true,
    burnSources: HENLO_BURN_SOURCES,
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

  // ── 2. HENLO holder-stats (B-1 Group D) ──────────────────────────────────
  // Port of envio src/handlers/tracked-erc20/holder-stats.ts. Entry semantics
  // match envio tracked-erc20.ts:70-81 — only update stats when something
  // actually changed, and swallow errors so a stats write can't break indexing.
  if (config.holderStats) {
    try {
      const { holderDelta, supplyDelta } = await updateHolderBalances(
        context,
        chainId,
        fromLower,
        toLower,
        value,
        timestamp
      );
      if (holderDelta !== 0 || supplyDelta !== BigInt(0)) {
        await updateHolderStats(
          context,
          chainId,
          holderDelta,
          supplyDelta,
          timestamp
        );
      }
    } catch (error) {
      console.error(
        `[TrackedErc20] Holder stats error for token ${tokenAddress} on chain ${chainId}: ${error}`
      );
    }
  }

  // ── 3. HENLO burn-tracking (B-1 Group D) ─────────────────────────────────
  // Port of envio src/handlers/tracked-erc20/burn-tracking.ts (trackBurn).
  if (config.burnTracking && isBurnTransfer(toLower)) {
    try {
      await trackBurn(event, context, config, fromLower, toLower);
    } catch (error) {
      console.error(
        `[TrackedErc20] Burn tracking error for token ${tokenAddress} on chain ${chainId}: ${error}`
      );
    }
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

// ════════════════════════════════════════════════════════════════════════════
// HENLO holder-stats — verbatim port of envio src/handlers/tracked-erc20/
// holder-stats.ts (updateHolderBalances + updateHolderStats).
//
// API-pivot from envio:
//   - event.params/event.chainId resolved at the call site; helper takes
//     fromLower/toLower/value/chainId/timestamp directly.
//   - getOrCreateHolder: context.HenloHolder.get(id) → context.db.find(henloHolder,{id}).
//   - context.HenloHolder.set(obj): find→update OR insert().onConflictDoNothing()
//     (rollup-lww — exactly like updateBalance).
//   - id = holder address (envio getOrCreateHolder uses `holderId = address`).
// ════════════════════════════════════════════════════════════════════════════
async function updateHolderBalances(
  context: any,
  chainId: number,
  fromLower: string,
  toLower: string,
  value: bigint,
  timestamp: bigint
): Promise<{ holderDelta: number; supplyDelta: bigint }> {
  const zeroAddress = ZERO_ADDRESS;
  const deadAddress = DEAD_ADDRESS;

  let holderDelta = 0;
  let supplyDelta = BigInt(0);

  // Handle 'from' address (decrease balance).
  if (fromLower !== zeroAddress) {
    const fromHolder = await context.db.find(henloHolder, { id: fromLower });
    const prevBalance = fromHolder ? fromHolder.balance : BigInt(0);
    const newFromBalance = prevBalance - value;

    if (fromHolder) {
      await context.db
        .update(henloHolder, { id: fromLower })
        .set({
          balance: newFromBalance,
          lastActivityTime: timestamp,
        });
    } else {
      await context.db
        .insert(henloHolder)
        .values({
          id: fromLower,
          address: fromLower,
          balance: newFromBalance,
          firstTransferTime: null,
          lastActivityTime: timestamp,
          chainId,
        })
        .onConflictDoNothing();
    }

    // If balance went to zero, decrease holder count.
    if (prevBalance > BigInt(0) && newFromBalance === BigInt(0)) {
      holderDelta--;
    }

    // Supply decreases when tokens are burned.
    if (toLower === zeroAddress || toLower === deadAddress) {
      supplyDelta -= value;
    }
  } else {
    // Mint: supply increases.
    supplyDelta += value;
  }

  // Handle 'to' address (increase balance) — skip burns.
  if (toLower !== zeroAddress && toLower !== deadAddress) {
    const toHolder = await context.db.find(henloHolder, { id: toLower });
    const prevBalance = toHolder ? toHolder.balance : BigInt(0);
    const newToBalance = prevBalance + value;
    const firstTransferTime =
      (toHolder && toHolder.firstTransferTime) || timestamp;

    if (toHolder) {
      await context.db
        .update(henloHolder, { id: toLower })
        .set({
          balance: newToBalance,
          lastActivityTime: timestamp,
          firstTransferTime,
        });
    } else {
      await context.db
        .insert(henloHolder)
        .values({
          id: toLower,
          address: toLower,
          balance: newToBalance,
          firstTransferTime,
          lastActivityTime: timestamp,
          chainId,
        })
        .onConflictDoNothing();
    }

    // If balance went from zero to positive, increase holder count.
    if (prevBalance === BigInt(0) && newToBalance > BigInt(0)) {
      holderDelta++;
    }
  }

  return { holderDelta, supplyDelta };
}

async function updateHolderStats(
  context: any,
  chainId: number,
  holderDelta: number,
  supplyDelta: bigint,
  timestamp: bigint
): Promise<void> {
  const statsId = chainId.toString();
  const stats = await context.db.find(henloHolderStats, { id: statsId });

  const prevUnique = stats ? stats.uniqueHolders : 0;
  const prevSupply = stats ? stats.totalSupply : BigInt(0);

  const updated = {
    uniqueHolders: Math.max(0, prevUnique + holderDelta),
    totalSupply: prevSupply + supplyDelta,
    lastUpdateTime: timestamp,
  };

  if (stats) {
    await context.db.update(henloHolderStats, { id: statsId }).set(updated);
  } else {
    await context.db
      .insert(henloHolderStats)
      .values({
        id: statsId,
        chainId,
        ...updated,
      })
      .onConflictDoNothing();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// HENLO burn-tracking — verbatim port of envio src/handlers/tracked-erc20/
// burn-tracking.ts (trackBurn + updateChainBurnStats + updateGlobalBurnStats).
//
// API-pivot from envio:
//   - event.params.value → event.args.value
//   - event.chainId → context.chain.id
//   - event.srcAddress → event.log.address
//   - event.logIndex → event.log.logIndex
//   - event.block.number → event.block.number (already bigint; no BigInt() wrap)
//   - event.transaction.from/.to/.hash → same in ponder
//   - context.<Entity>.get(id) → context.db.find(<table>, { id })
//   - append entity (henlo_burn): insert().onConflictDoNothing()
//   - rollup / lww entities: find → update OR insert().onConflictDoNothing()
//   - envio guarded HenloChainBurner/HenloSourceBurner behind optional-chaining
//     (a schema-version hack); all 8 tables exist in ponder so they are written
//     directly here.
// ════════════════════════════════════════════════════════════════════════════
const BERACHAIN_MAINNET_ID = 80094;

async function trackBurn(
  event: any,
  context: any,
  config: TokenConfig,
  fromLower: string,
  toLower: string
): Promise<void> {
  const { value } = event.args;
  const timestamp = event.block.timestamp as bigint;
  const chainId = context.chain.id;
  const transactionFromLower = event.transaction.from?.toLowerCase();
  const transactionToLower = event.transaction.to?.toLowerCase();
  const burnSources = config.burnSources || {};
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  // Determine burn source by checking both token holder and calling contract.
  const sourceMatchAddress =
    (fromLower && burnSources[fromLower] ? fromLower : undefined) ??
    (transactionToLower && burnSources[transactionToLower]
      ? transactionToLower
      : undefined);
  const source = sourceMatchAddress ? burnSources[sourceMatchAddress] : "user";

  // Identify the unique wallet that initiated the burn.
  const burnerAddress =
    source !== "user" ? transactionFromLower ?? fromLower : fromLower;
  const burnerId = burnerAddress;

  // Create burn record (append; deterministic id).
  const burnId = `${txHash}_${logIndex}`;
  await context.db
    .insert(henloBurn)
    .values({
      id: burnId,
      amount: value,
      timestamp,
      blockNumber: event.block.number,
      transactionHash: txHash,
      from: burnerAddress,
      source,
      chainId,
    })
    .onConflictDoNothing();

  await recordAction(context, {
    id: burnId,
    actionType: "burn",
    actor: burnerAddress ?? fromLower,
    primaryCollection: "henlo_incinerator",
    timestamp,
    chainId,
    txHash,
    logIndex,
    numeric1: value,
    context: {
      from: fromLower,
      transactionFrom: transactionFromLower,
      transactionTo: transactionToLower,
      source,
      rawTo: toLower,
      token: event.log.address.toLowerCase(),
    },
  });

  // Track unique burners at global, chain, and source scope.
  const chainBurnerId = `${chainId}_${burnerId}`;
  const sourceBurnerId = `${chainId}_${source}_${burnerId}`;

  const [existingBurner, existingChainBurner, existingSourceBurner] =
    await Promise.all([
      context.db.find(henloBurner, { id: burnerId }),
      context.db.find(henloChainBurner, { id: chainBurnerId }),
      context.db.find(henloSourceBurner, { id: sourceBurnerId }),
    ]);

  const isNewGlobalBurner = !existingBurner;
  if (isNewGlobalBurner) {
    await context.db
      .insert(henloBurner)
      .values({
        id: burnerId,
        address: burnerAddress,
        firstBurnTime: timestamp,
        chainId,
      })
      .onConflictDoNothing();
  }

  const isNewChainBurner = !existingChainBurner;
  if (isNewChainBurner) {
    await context.db
      .insert(henloChainBurner)
      .values({
        id: chainBurnerId,
        chainId,
        address: burnerAddress,
        firstBurnTime: timestamp,
      })
      .onConflictDoNothing();
  }

  const isNewSourceBurner = !existingSourceBurner;
  if (isNewSourceBurner) {
    await context.db
      .insert(henloSourceBurner)
      .values({
        id: sourceBurnerId,
        chainId,
        source,
        address: burnerAddress,
        firstBurnTime: timestamp,
      })
      .onConflictDoNothing();
  }

  // Update global unique-burner counters (only when a new global burner OR a
  // new incinerator source-burner is seen — envio burn-tracking.ts:154-187).
  if (isNewGlobalBurner || (isNewSourceBurner && source === "incinerator")) {
    const globalStats = await context.db.find(henloGlobalBurnStats, {
      id: "global",
    });
    const prevUnique = globalStats ? globalStats.uniqueBurners : 0;
    const prevIncineratorUnique = globalStats
      ? globalStats.incineratorUniqueBurners
      : 0;

    const uniqueBurners = prevUnique + (isNewGlobalBurner ? 1 : 0);
    const incineratorUniqueBurners =
      prevIncineratorUnique +
      (source === "incinerator" && isNewSourceBurner ? 1 : 0);

    if (globalStats) {
      await context.db
        .update(henloGlobalBurnStats, { id: "global" })
        .set({
          uniqueBurners,
          incineratorUniqueBurners,
          lastUpdateTime: timestamp,
        });
    } else {
      await context.db
        .insert(henloGlobalBurnStats)
        .values({
          id: "global",
          totalBurnedAllChains: BigInt(0),
          totalBurnedMainnet: BigInt(0),
          totalBurnedTestnet: BigInt(0),
          burnCountAllChains: 0,
          incineratorBurns: BigInt(0),
          overunderBurns: BigInt(0),
          beratrackrBurns: BigInt(0),
          userBurns: BigInt(0),
          uniqueBurners,
          incineratorUniqueBurners,
          lastUpdateTime: timestamp,
        })
        .onConflictDoNothing();
    }
  }

  // Update chain-specific burn stats with unique-burner increments.
  const sourceUniqueIncrement = isNewSourceBurner ? 1 : 0;
  const totalUniqueIncrement = isNewChainBurner ? 1 : 0;
  await updateChainBurnStats(
    context,
    chainId,
    source,
    value,
    timestamp,
    sourceUniqueIncrement,
    totalUniqueIncrement
  );

  // Update global burn stats (amounts/counts).
  await updateGlobalBurnStats(context, chainId, source, value, timestamp);
}

// Updates burn statistics for a specific chain and source.
// Port of envio burn-tracking.ts:209-269. Writes BOTH the `${chainId}_${source}`
// row and the `${chainId}_total` row each invocation.
async function updateChainBurnStats(
  context: any,
  chainId: number,
  source: string,
  amount: bigint,
  timestamp: bigint,
  sourceUniqueIncrement: number,
  totalUniqueIncrement: number
): Promise<void> {
  const statsId = `${chainId}_${source}`;
  const totalStatsId = `${chainId}_total`;

  const [stats, totalStats] = await Promise.all([
    context.db.find(henloBurnStats, { id: statsId }),
    context.db.find(henloBurnStats, { id: totalStatsId }),
  ]);

  // Source-specific stats.
  if (stats) {
    await context.db
      .update(henloBurnStats, { id: statsId })
      .set({
        totalBurned: stats.totalBurned + amount,
        burnCount: stats.burnCount + 1,
        uniqueBurners: stats.uniqueBurners + sourceUniqueIncrement,
        lastBurnTime: timestamp,
      });
  } else {
    await context.db
      .insert(henloBurnStats)
      .values({
        id: statsId,
        chainId,
        source,
        totalBurned: amount,
        burnCount: 1,
        uniqueBurners: sourceUniqueIncrement,
        lastBurnTime: timestamp,
        firstBurnTime: timestamp,
      })
      .onConflictDoNothing();
  }

  // Total stats (source = "total").
  if (totalStats) {
    await context.db
      .update(henloBurnStats, { id: totalStatsId })
      .set({
        totalBurned: totalStats.totalBurned + amount,
        burnCount: totalStats.burnCount + 1,
        uniqueBurners: totalStats.uniqueBurners + totalUniqueIncrement,
        lastBurnTime: timestamp,
      });
  } else {
    await context.db
      .insert(henloBurnStats)
      .values({
        id: totalStatsId,
        chainId,
        source: "total",
        totalBurned: amount,
        burnCount: 1,
        uniqueBurners: totalUniqueIncrement,
        lastBurnTime: timestamp,
        firstBurnTime: timestamp,
      })
      .onConflictDoNothing();
  }
}

// Updates global burn statistics across all chains.
// Port of envio burn-tracking.ts:274-337. mainnet (80094) vs testnet split +
// per-source bucket (incinerator/overunder/beratrackr/user). uniqueBurners +
// incineratorUniqueBurners are owned by the trackBurn unique-counter block
// above; this path preserves them.
async function updateGlobalBurnStats(
  context: any,
  chainId: number,
  source: string,
  amount: bigint,
  timestamp: bigint
): Promise<void> {
  const globalStats = await context.db.find(henloGlobalBurnStats, {
    id: "global",
  });

  const base = globalStats || {
    totalBurnedAllChains: BigInt(0),
    totalBurnedMainnet: BigInt(0),
    totalBurnedTestnet: BigInt(0),
    burnCountAllChains: 0,
    incineratorBurns: BigInt(0),
    overunderBurns: BigInt(0),
    beratrackrBurns: BigInt(0),
    userBurns: BigInt(0),
    uniqueBurners: 0,
    incineratorUniqueBurners: 0,
  };

  const updated = {
    totalBurnedAllChains: base.totalBurnedAllChains + amount,
    totalBurnedMainnet:
      chainId === BERACHAIN_MAINNET_ID
        ? base.totalBurnedMainnet + amount
        : base.totalBurnedMainnet,
    totalBurnedTestnet:
      chainId !== BERACHAIN_MAINNET_ID
        ? base.totalBurnedTestnet + amount
        : base.totalBurnedTestnet,
    incineratorBurns:
      source === "incinerator"
        ? base.incineratorBurns + amount
        : base.incineratorBurns,
    overunderBurns:
      source === "overunder"
        ? base.overunderBurns + amount
        : base.overunderBurns,
    beratrackrBurns:
      source === "beratrackr"
        ? base.beratrackrBurns + amount
        : base.beratrackrBurns,
    userBurns:
      source !== "incinerator" &&
      source !== "overunder" &&
      source !== "beratrackr"
        ? base.userBurns + amount
        : base.userBurns,
    burnCountAllChains: base.burnCountAllChains + 1,
    lastUpdateTime: timestamp,
  };

  if (globalStats) {
    await context.db.update(henloGlobalBurnStats, { id: "global" }).set(updated);
  } else {
    // Defensive insert fallback mirroring envio burn-tracking.ts:285-300. In
    // practice this is dead on the primary path: the first-ever burn always has
    // isNewGlobalBurner=true, so the unique-counter block in trackBurn() creates
    // the 'global' row BEFORE this function reads it (same-handler write-then-read
    // visibility, matching envio's in-memory store). The 'global' row is normally
    // created there, NOT here. Kept for parity / true-create-if-missing safety.
    await context.db
      .insert(henloGlobalBurnStats)
      .values({
        id: "global",
        uniqueBurners: base.uniqueBurners,
        incineratorUniqueBurners: base.incineratorUniqueBurners,
        ...updated,
      })
      .onConflictDoNothing();
  }
}
