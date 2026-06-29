/*
 * Burn Tracking Module
 * Handles HENLO burn record creation and statistics updates
 */

import {
  type HenloBurn,
  type HenloBurnStats,
  type HenloGlobalBurnStats,
} from "envio";

import { recordAction } from "../../lib/actions";
import { TokenConfig } from "./constants";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";
const BERACHAIN_MAINNET_ID = 80094;

type ExtendedHenloBurnStats = HenloBurnStats & { uniqueBurners?: number };
type ExtendedHenloGlobalBurnStats = HenloGlobalBurnStats & {
  incineratorUniqueBurners?: number;
};

/**
 * Checks if a transfer is a burn (to zero or dead address)
 */
export function isBurnTransfer(to: string): boolean {
  const toLower = to.toLowerCase();
  return (
    toLower === ZERO_ADDRESS.toLowerCase() ||
    toLower === DEAD_ADDRESS.toLowerCase()
  );
}

/**
 * Tracks a burn event and updates all statistics
 */
export async function trackBurn(
  event: any,
  context: any,
  config: TokenConfig,
  fromLower: string,
  toLower: string
) {
  const { value } = event.params;
  const timestamp = BigInt(event.block.timestamp);
  const chainId = event.chainId;
  const transactionFromLower = event.transaction.from?.toLowerCase();
  const transactionToLower = event.transaction.to?.toLowerCase();
  const burnSources = config.burnSources || {};

  // Determine burn source by checking both token holder and calling contract
  const sourceMatchAddress =
    (fromLower && burnSources[fromLower] ? fromLower : undefined) ??
    (transactionToLower && burnSources[transactionToLower]
      ? transactionToLower
      : undefined);
  const source = sourceMatchAddress
    ? burnSources[sourceMatchAddress]
    : "user";

  // Identify the unique wallet that initiated the burn
  const burnerAddress =
    source !== "user"
      ? transactionFromLower ?? fromLower
      : fromLower;
  const burnerId = burnerAddress;

  // Create burn record
  const burnId = `${event.transaction.hash}_${event.logIndex}`;
  const burn: HenloBurn = {
    id: burnId,
    amount: value,
    timestamp,
    blockNumber: BigInt(event.block.number),
    transactionHash: event.transaction.hash,
    from: burnerAddress,
    source,
    chainId,
  };

  context.HenloBurn.set(burn);

  recordAction(context, {
    id: burnId,
    actionType: "burn",
    actor: burnerAddress ?? fromLower,
    primaryCollection: "henlo_incinerator",
    timestamp,
    chainId,
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
    numeric1: value,
    context: {
      from: fromLower,
      transactionFrom: transactionFromLower,
      transactionTo: transactionToLower,
      source,
      rawTo: toLower,
      token: event.srcAddress.toLowerCase(),
    },
  });

  // Track unique burners at global, chain, and source scope
  // Cast to `any` required because HenloChainBurner and HenloSourceBurner
  // entities may not exist in all schema versions. Using optional chaining
  // with the cast allows graceful handling when these stores are unavailable.
  const extendedContext = context as any;
  const chainBurnerId = `${chainId}_${burnerId}`;
  const sourceBurnerId = `${chainId}_${source}_${burnerId}`;

  const [existingBurner, existingChainBurner, existingSourceBurner] = await Promise.all([
    context.HenloBurner.get(burnerId),
    extendedContext?.HenloChainBurner?.get(chainBurnerId),
    extendedContext?.HenloSourceBurner?.get(sourceBurnerId),
  ]);

  const isNewGlobalBurner = !existingBurner;
  if (isNewGlobalBurner) {
    const burner = {
      id: burnerId,
      address: burnerAddress,
      firstBurnTime: timestamp,
      chainId,
    };
    context.HenloBurner.set(burner);
  }

  const chainBurnerStore = extendedContext?.HenloChainBurner;
  const isNewChainBurner = !existingChainBurner;
  if (isNewChainBurner && chainBurnerStore) {
    const chainBurner = {
      id: chainBurnerId,
      chainId,
      address: burnerAddress,
      firstBurnTime: timestamp,
    };
    chainBurnerStore.set(chainBurner);
  }

  const sourceBurnerStore = extendedContext?.HenloSourceBurner;
  const isNewSourceBurner = !existingSourceBurner;
  if (isNewSourceBurner && sourceBurnerStore) {
    const sourceBurner = {
      id: sourceBurnerId,
      chainId,
      source,
      address: burnerAddress,
      firstBurnTime: timestamp,
    };
    sourceBurnerStore.set(sourceBurner);
  }

  if (isNewGlobalBurner || (isNewSourceBurner && source === "incinerator")) {
    let globalStats = (await context.HenloGlobalBurnStats.get(
      "global"
    )) as ExtendedHenloGlobalBurnStats | undefined;
    if (!globalStats) {
      globalStats = {
        id: "global",
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
        lastUpdateTime: timestamp,
      } as ExtendedHenloGlobalBurnStats;
    }

    const updatedGlobalUniqueStats: ExtendedHenloGlobalBurnStats = {
      ...globalStats,
      uniqueBurners:
        (globalStats.uniqueBurners ?? 0) + (isNewGlobalBurner ? 1 : 0),
      incineratorUniqueBurners:
        (globalStats.incineratorUniqueBurners ?? 0) +
        (source === "incinerator" && isNewSourceBurner ? 1 : 0),
      lastUpdateTime: timestamp,
    };
    context.HenloGlobalBurnStats.set(
      updatedGlobalUniqueStats as HenloGlobalBurnStats
    );
  }

  // Update chain-specific burn stats with unique burner increments
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

  // Update global burn stats
  await updateGlobalBurnStats(context, chainId, source, value, timestamp);
}

/**
 * Updates burn statistics for a specific chain and source
 */
async function updateChainBurnStats(
  context: any,
  chainId: number,
  source: string,
  amount: bigint,
  timestamp: bigint,
  sourceUniqueIncrement: number,
  totalUniqueIncrement: number
) {
  const statsId = `${chainId}_${source}`;
  const totalStatsId = `${chainId}_total`;

  const [stats, totalStats] = await Promise.all([
    context.HenloBurnStats.get(statsId) as Promise<ExtendedHenloBurnStats | undefined>,
    context.HenloBurnStats.get(totalStatsId) as Promise<ExtendedHenloBurnStats | undefined>,
  ]);

  // Create or update source-specific stats
  const statsToUpdate = stats || {
    id: statsId,
    chainId,
    source,
    totalBurned: BigInt(0),
    burnCount: 0,
    uniqueBurners: 0,
    lastBurnTime: timestamp,
    firstBurnTime: timestamp,
  } as ExtendedHenloBurnStats;

  const updatedStats: ExtendedHenloBurnStats = {
    ...statsToUpdate,
    totalBurned: statsToUpdate.totalBurned + amount,
    burnCount: statsToUpdate.burnCount + 1,
    uniqueBurners: (statsToUpdate.uniqueBurners ?? 0) + sourceUniqueIncrement,
    lastBurnTime: timestamp,
  };

  // Create or update total stats
  const totalStatsToUpdate = totalStats || {
    id: totalStatsId,
    chainId,
    source: "total",
    totalBurned: BigInt(0),
    burnCount: 0,
    uniqueBurners: 0,
    lastBurnTime: timestamp,
    firstBurnTime: timestamp,
  } as ExtendedHenloBurnStats;

  const updatedTotalStats: ExtendedHenloBurnStats = {
    ...totalStatsToUpdate,
    totalBurned: totalStatsToUpdate.totalBurned + amount,
    burnCount: totalStatsToUpdate.burnCount + 1,
    uniqueBurners: (totalStatsToUpdate.uniqueBurners ?? 0) + totalUniqueIncrement,
    lastBurnTime: timestamp,
  };

  // Set both stats
  context.HenloBurnStats.set(updatedStats as HenloBurnStats);
  context.HenloBurnStats.set(updatedTotalStats as HenloBurnStats);
}

/**
 * Updates global burn statistics across all chains
 */
async function updateGlobalBurnStats(
  context: any,
  chainId: number,
  source: string,
  amount: bigint,
  timestamp: bigint
) {
  let globalStats = (await context.HenloGlobalBurnStats.get(
    "global"
  )) as ExtendedHenloGlobalBurnStats | undefined;

  if (!globalStats) {
    globalStats = {
      id: "global",
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
      lastUpdateTime: timestamp,
    } as ExtendedHenloGlobalBurnStats;
  }

  // Create updated global stats object (immutable update)
  const updatedGlobalStats: ExtendedHenloGlobalBurnStats = {
    ...globalStats,
    totalBurnedAllChains: globalStats.totalBurnedAllChains + amount,
    totalBurnedMainnet:
      chainId === BERACHAIN_MAINNET_ID
        ? globalStats.totalBurnedMainnet + amount
        : globalStats.totalBurnedMainnet,
    totalBurnedTestnet:
      chainId !== BERACHAIN_MAINNET_ID
        ? globalStats.totalBurnedTestnet + amount
        : globalStats.totalBurnedTestnet,
    incineratorBurns:
      source === "incinerator"
        ? globalStats.incineratorBurns + amount
        : globalStats.incineratorBurns,
    overunderBurns:
      source === "overunder"
        ? globalStats.overunderBurns + amount
        : globalStats.overunderBurns,
    beratrackrBurns:
      source === "beratrackr"
        ? globalStats.beratrackrBurns + amount
        : globalStats.beratrackrBurns,
    userBurns:
      source !== "incinerator" && source !== "overunder" && source !== "beratrackr"
        ? globalStats.userBurns + amount
        : globalStats.userBurns,
    uniqueBurners: globalStats.uniqueBurners ?? 0,
    incineratorUniqueBurners: globalStats.incineratorUniqueBurners ?? 0,
    burnCountAllChains: globalStats.burnCountAllChains + 1,
    lastUpdateTime: timestamp,
  };

  context.HenloGlobalBurnStats.set(updatedGlobalStats as HenloGlobalBurnStats);
}
