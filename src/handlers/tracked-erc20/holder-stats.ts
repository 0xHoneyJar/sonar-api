/*
 * Holder Stats Module
 * Handles HENLO holder tracking and statistics updates
 */

import { type HenloHolder, type HenloHolderStats } from "envio";
import { TokenConfig } from "./constants";
import { ZERO_ADDRESS, DEAD_ADDRESS } from "./burn-tracking";

/**
 * Updates holder balances and statistics for a token transfer
 * Returns true if this is a burn transfer (to zero/dead address)
 */
export async function updateHolderBalances(
  event: any,
  context: any,
  config: TokenConfig
): Promise<{ holderDelta: number; supplyDelta: bigint }> {
  const { from, to, value } = event.params;
  const timestamp = BigInt(event.block.timestamp);
  const chainId = event.chainId;

  // Normalize addresses
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const zeroAddress = ZERO_ADDRESS.toLowerCase();
  const deadAddress = DEAD_ADDRESS.toLowerCase();

  // Track changes in holder counts and supply
  let holderDelta = 0;
  let supplyDelta = BigInt(0);

  // Handle 'from' address (decrease balance)
  if (fromLower !== zeroAddress) {
    const fromHolder = await getOrCreateHolder(context, fromLower, chainId, timestamp);
    const newFromBalance = fromHolder.balance - value;

    // Update holder record
    const updatedFromHolder = {
      ...fromHolder,
      balance: newFromBalance,
      lastActivityTime: timestamp,
    };
    context.HenloHolder.set(updatedFromHolder);

    // If balance went to zero, decrease holder count
    if (fromHolder.balance > BigInt(0) && newFromBalance === BigInt(0)) {
      holderDelta--;
    }

    // Supply decreases when tokens are burned
    if (toLower === zeroAddress || toLower === deadAddress) {
      supplyDelta -= value;
    }
  } else {
    // Mint: supply increases
    supplyDelta += value;
  }

  // Handle 'to' address (increase balance)
  if (toLower !== zeroAddress && toLower !== deadAddress) {
    const toHolder = await getOrCreateHolder(context, toLower, chainId, timestamp);
    const newToBalance = toHolder.balance + value;

    // Update holder record
    const updatedToHolder = {
      ...toHolder,
      balance: newToBalance,
      lastActivityTime: timestamp,
      // Set firstTransferTime if this is their first time receiving tokens
      firstTransferTime: toHolder.firstTransferTime || timestamp,
    };
    context.HenloHolder.set(updatedToHolder);

    // If balance went from zero to positive, increase holder count
    if (toHolder.balance === BigInt(0) && newToBalance > BigInt(0)) {
      holderDelta++;
    }
  }

  return { holderDelta, supplyDelta };
}

/**
 * Updates holder statistics for the chain
 */
export async function updateHolderStats(
  context: any,
  chainId: number,
  holderDelta: number,
  supplyDelta: bigint,
  timestamp: bigint
) {
  const statsId = chainId.toString();
  let stats = await context.HenloHolderStats.get(statsId);

  if (!stats) {
    stats = {
      id: statsId,
      chainId,
      uniqueHolders: 0,
      totalSupply: BigInt(0),
      lastUpdateTime: timestamp,
    };
  }

  // Create updated stats object (immutable update)
  const updatedStats = {
    ...stats,
    uniqueHolders: Math.max(0, stats.uniqueHolders + holderDelta),
    totalSupply: stats.totalSupply + supplyDelta,
    lastUpdateTime: timestamp,
  };

  context.HenloHolderStats.set(updatedStats);
}

/**
 * Gets an existing holder or creates a new one with zero balance
 */
async function getOrCreateHolder(
  context: any,
  address: string,
  chainId: number,
  timestamp: bigint
): Promise<HenloHolder> {
  const holderId = address; // Use address as ID
  let holder = await context.HenloHolder.get(holderId);

  if (!holder) {
    holder = {
      id: holderId,
      address: address,
      balance: BigInt(0),
      firstTransferTime: undefined,
      lastActivityTime: timestamp,
      chainId,
    };
  }

  return holder;
}
