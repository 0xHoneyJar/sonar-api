/**
 * Set & Forgetti Vault Handlers
 *
 * Tracks ERC4626 vault deposits/withdrawals and MultiRewards staking/claiming
 * Maintains stateful position tracking and vault-level statistics
 * Supports dynamic strategy migrations with historical tracking
 *
 * RPC: Uses ENVIO_RPC_URL env var for strategy lookups
 */

import {
  indexer,
  type SFPosition,
  type SFVaultStats,
  type SFVaultStrategy,
  type SFMultiRewardsPosition,
  type LatestVaultStrategy,
} from "envio";

import { createEffect, S } from "envio";
import { createPublicClient, http, parseAbi, defineChain } from "viem";

import { recordAction } from "../lib/actions";

// Define Berachain since it may not be in viem/chains yet
const berachain = defineChain({
  id: 80094,
  name: "Berachain",
  nativeCurrency: {
    decimals: 18,
    name: "BERA",
    symbol: "BERA",
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.berachain.com"],
    },
  },
  blockExplorers: {
    default: { name: "Berascan", url: "https://berascan.com" },
  },
});

const BERACHAIN_ID = 80094;

// Singleton RPC client — avoids re-creating per effect call
const rpcUrl = process.env.ENVIO_RPC_URL || "https://rpc.berachain.com";
const rpcClient = createPublicClient({
  chain: berachain,
  transport: http(rpcUrl),
});

/**
 * Vault Configuration Mapping
 * Maps vault addresses to their initial (first) strategy, MultiRewards contract, and metadata
 * These are the original deployments - subsequent strategies are tracked via StrategyUpdated events
 */
interface VaultConfig {
  vault: string;
  multiRewards: string;
  kitchenToken: string;
  kitchenTokenSymbol: string;
  strategy: string;
}

const VAULT_CONFIGS: Record<string, VaultConfig> = {
  // HLKD1B
  "0x3bec4140eda07911208d4fc06b2f5adb7b5237fb": {
    vault: "0x3bec4140eda07911208d4fc06b2f5adb7b5237fb",
    multiRewards: "0x34b3668e2ad47ccfe3c53e24a0606b911d1f6a8f",
    kitchenToken: "0xf0edfc3e122db34773293e0e5b2c3a58492e7338",
    kitchenTokenSymbol: "HLKD1B",
    strategy: "0x39748c56511c02eb7be22225c4699f59fbb55b8f",
  },
  // HLKD690M
  "0x335d150495f6c8483773abc0e4fa5780dd270e78": {
    vault: "0x335d150495f6c8483773abc0e4fa5780dd270e78",
    multiRewards: "0xd1cbf8f7f310947a7993abbd7fd6113794e353da",
    kitchenToken: "0x8ab854dc0672d7a13a85399a56cb628fb22102d6",
    kitchenTokenSymbol: "HLKD690M",
    strategy: "0x447d56af16a0cfaff96536c7fd54f46bf56e160e",
  },
  // HLKD420M
  "0x2e2bdfdd4b786703b374aeeaa44195698a699dd1": {
    vault: "0x2e2bdfdd4b786703b374aeeaa44195698a699dd1",
    multiRewards: "0x827b7ea9fdb4322dbc6f9bf72c04871be859f20c",
    kitchenToken: "0xf07fa3ece9741d408d643748ff85710bedef25ba",
    kitchenTokenSymbol: "HLKD420M",
    strategy: "0xffa9dbbff80f736cde9e41427c0335f866854a9a",
  },
  // HLKD330M
  "0x91f321a8791fb899c6b860b9f54940c68cb45aed": {
    vault: "0x91f321a8791fb899c6b860b9f54940c68cb45aed",
    multiRewards: "0xacd0177bfcbc3760b03c87808b5423945f6bfaec",
    kitchenToken: "0x37dd8850919ebdca911c383211a70839a94b0539",
    kitchenTokenSymbol: "HLKD330M",
    strategy: "0x3032a263c651d9237b74cd6d47baf1345bf0930e",
  },
  // HLKD100M
  "0xee1087ec5d6a0a673c046b9acb15c93b7adb95ca": {
    vault: "0xee1087ec5d6a0a673c046b9acb15c93b7adb95ca",
    multiRewards: "0xb5b312fbf7eb145485ece55b862db94d626efa0f",
    kitchenToken: "0x7bdf98ddeed209cfa26bd2352b470ac8b5485ec5",
    kitchenTokenSymbol: "HLKD100M",
    strategy: "0xaee9aea23783057cbc890684464570ad9723be01",
  },
};

/**
 * Lookup table mapping strategy addresses to their known multiRewards addresses
 * Used as fallback when RPC calls fail (e.g., contract doesn't exist at historical block)
 */
// --- Module-level reverse lookup Maps (derived from constants, safe across preload) ---
const MULTI_REWARDS_TO_VAULT = new Map<string, { vault: string; config: VaultConfig }>();
for (const [vaultAddr, config] of Object.entries(VAULT_CONFIGS)) {
  MULTI_REWARDS_TO_VAULT.set(config.multiRewards, { vault: vaultAddr, config });
}

const STRATEGY_TO_VAULT_MAP = new Map<string, { vault: string; config: VaultConfig }>();
for (const [vaultAddr, config] of Object.entries(VAULT_CONFIGS)) {
  STRATEGY_TO_VAULT_MAP.set(config.strategy, { vault: vaultAddr, config });
}

const STRATEGY_TO_MULTI_REWARDS: Record<string, string> = {
  "0x39748c56511c02eb7be22225c4699f59fbb55b8f": "0x34b3668e2ad47ccfe3c53e24a0606b911d1f6a8f", // HLKD1B
  "0x447d56af16a0cfaff96536c7fd54f46bf56e160e": "0xd1cbf8f7f310947a7993abbd7fd6113794e353da", // HLKD690M
  "0xffa9dbbff80f736cde9e41427c0335f866854a9a": "0x827b7ea9fdb4322dbc6f9bf72c04871be859f20c", // HLKD420M
  "0x3032a263c651d9237b74cd6d47baf1345bf0930e": "0xacd0177bfcbc3760b03c87808b5423945f6bfaec", // HLKD330M
  "0xaee9aea23783057cbc890684464570ad9723be01": "0xb5b312fbf7eb145485ece55b862db94d626efa0f", // HLKD100M
};

/**
 * Effect to query multiRewardsAddress from a strategy contract at a specific block
 * Used when handling StrategyUpdated events to get the new MultiRewards address
 * Falls back to hardcoded mapping if RPC call fails
 */
export const getMultiRewardsAddress = createEffect(
  {
    name: "getMultiRewardsAddress",
    input: {
      strategyAddress: S.string,
      blockNumber: S.bigint,
    },
    output: S.string,
    cache: true,
    rateLimit: { calls: 10, per: "second" },
  },
  async ({ input, context }) => {
    const strategyLower = input.strategyAddress.toLowerCase();
    // Cast to `any` required because Envio's createEffect context
    // has a narrower type than the full handler context. The effect context
    // doesn't include entity stores (like SFVaultStrategy) in its type definition,
    // but they're available at runtime for fallback queries.
    const anyContext = context as any;

    // First try RPC call
    try {
      const multiRewards = await rpcClient.readContract({
        address: input.strategyAddress as `0x${string}`,
        abi: parseAbi(["function multiRewardsAddress() view returns (address)"]),
        functionName: "multiRewardsAddress",
        blockNumber: input.blockNumber,
      });

      return (multiRewards as string).toLowerCase();
    } catch (error) {
      // Fallback to DB (tracks MultiRewardsUpdated changes)
      try {
        const existingByStrategy = await anyContext.SFVaultStrategy.getWhere({ strategy: { _eq: strategyLower } });
        if (existingByStrategy && existingByStrategy.length > 0) {
          const activeRecord = existingByStrategy.find((s: any) => s.isActive) ?? existingByStrategy[0];
          if (activeRecord?.multiRewards) {
            anyContext.log.warn(
              `RPC call failed for strategy ${strategyLower}, using DB multiRewards: ${activeRecord.multiRewards}`
            );
            return activeRecord.multiRewards;
          }
        }
      } catch (dbError) {
        anyContext.log.warn(`Failed to query SFVaultStrategy fallback for ${strategyLower}: ${dbError}`);
      }

      // Fallback to hardcoded mapping if RPC fails
      const fallback = STRATEGY_TO_MULTI_REWARDS[strategyLower];
      if (fallback) {
        anyContext.log.warn(`RPC call failed for strategy ${strategyLower}, using fallback multiRewards: ${fallback}`);
        return fallback;
      }

      anyContext.log.error(
        `Failed to get multiRewardsAddress for strategy ${input.strategyAddress} at block ${input.blockNumber}: ${error}`
      );
      throw error;
    }
  }
);

/**
 * Effect to query the vault (stakingToken) from a MultiRewards contract at a specific block.
 *
 * This lets us attribute staking/claim events even if MultiRewards contracts are upgraded,
 * without relying on hardcoded MultiRewards address lists.
 */
export const getVaultAddressFromMultiRewards = createEffect(
  {
    name: "getVaultAddressFromMultiRewards",
    input: {
      multiRewardsAddress: S.string,
      blockNumber: S.bigint,
    },
    output: S.string,
    cache: true,
    rateLimit: { calls: 10, per: "second" },
  },
  async ({ input }) => {
    const stakingToken = await rpcClient.readContract({
      address: input.multiRewardsAddress as `0x${string}`,
      abi: parseAbi(["function stakingToken() view returns (address)"]),
      functionName: "stakingToken",
      blockNumber: input.blockNumber,
    });

    return (stakingToken as string).toLowerCase();
  }
);

/**
 * Helper function to get vault info from a MultiRewards address
 * Searches through SFVaultStrategy records and falls back to hardcoded configs
 */
async function getVaultFromMultiRewards(
  context: any,
  multiRewardsAddress: string,
  blockNumber: bigint
): Promise<{ vault: string; config: VaultConfig } | null> {
  // 1. Module-level Map lookup (O(1), covers initial + runtime-updated configs)
  const cached = MULTI_REWARDS_TO_VAULT.get(multiRewardsAddress);
  if (cached) return cached;

  // 2. Search LatestVaultStrategy singleton by multiRewards (indexed, fast)
  const latestStrategies = await context.LatestVaultStrategy.getWhere({ multiRewards: { _eq: multiRewardsAddress } });
  if (latestStrategies && latestStrategies.length > 0) {
    const record = latestStrategies[0];
    const baseConfig = VAULT_CONFIGS[record.vault];
    if (baseConfig) {
      const result = {
        vault: record.vault,
        config: { ...baseConfig, strategy: record.strategy, multiRewards: record.multiRewards },
      };
      // Cache for future lookups in this batch
      MULTI_REWARDS_TO_VAULT.set(multiRewardsAddress, result);
      return result;
    }
  }

  // 3. Fallback: derive the vault from MultiRewards.stakingToken() via RPC (cached effect)
  try {
    const vaultAddress = await context.effect(getVaultAddressFromMultiRewards, {
      multiRewardsAddress,
      blockNumber,
    });

    const config = VAULT_CONFIGS[vaultAddress];
    if (config) {
      const result = { vault: vaultAddress, config };
      MULTI_REWARDS_TO_VAULT.set(multiRewardsAddress, result);
      return result;
    }
  } catch (error) {
    context.log.warn(
      `Failed to read stakingToken() for MultiRewards ${multiRewardsAddress} at block ${blockNumber}: ${error}`
    );
  }

  return null;
}

/**
 * Helper function to get vault info from a strategy wrapper address
 * Used when MultiRewardsUpdated is emitted from the strategy wrapper contract.
 */
async function getVaultFromStrategy(
  context: any,
  strategyAddress: string
): Promise<{ vault: string; config: VaultConfig } | null> {
  // 1. Module-level Map lookup (O(1))
  const cached = STRATEGY_TO_VAULT_MAP.get(strategyAddress);
  if (cached) return cached;

  // 2. Fallback: find via SFVaultStrategy records
  const strategies = await context.SFVaultStrategy.getWhere({ strategy: { _eq: strategyAddress } });
  if (strategies && strategies.length > 0) {
    const activeRecord = strategies.find((s: any) => s.isActive) ?? strategies[0];
    const baseConfig = VAULT_CONFIGS[activeRecord.vault];
    if (baseConfig) {
      return {
        vault: activeRecord.vault,
        config: {
          ...baseConfig,
          strategy: activeRecord.strategy,
          multiRewards: activeRecord.multiRewards,
        },
      };
    }
  }

  return null;
}

/**
 * Helper function to ensure initial strategy record exists for a vault
 * Called on first deposit to bootstrap the SFVaultStrategy table
 */
async function ensureInitialStrategy(
  context: any,
  vaultAddress: string,
  blockNumber: bigint,
): Promise<void> {
  const config = VAULT_CONFIGS[vaultAddress];
  if (!config) return;

  const strategyId = `${BERACHAIN_ID}_${vaultAddress}_${config.strategy}`;
  const existing = await context.SFVaultStrategy.get(strategyId);

  if (!existing) {
    const multiRewardsAtBlock = await context.effect(getMultiRewardsAddress, {
      strategyAddress: config.strategy,
      blockNumber,
    });

    context.SFVaultStrategy.set({
      id: strategyId,
      vault: vaultAddress,
      strategy: config.strategy,
      multiRewards: multiRewardsAtBlock,
      kitchenToken: config.kitchenToken,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
      activeFrom: BigInt(0),
      activeTo: undefined,
      isActive: true,
      chainId: BERACHAIN_ID,
    });

    // Also write LatestVaultStrategy singleton
    context.LatestVaultStrategy.set({
      id: vaultAddress,
      vault: vaultAddress,
      strategy: config.strategy,
      multiRewards: multiRewardsAtBlock,
      kitchenToken: config.kitchenToken,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
      chainId: BERACHAIN_ID,
    });

    // Update runtime Map
    MULTI_REWARDS_TO_VAULT.set(multiRewardsAtBlock, { vault: vaultAddress, config: { ...config, multiRewards: multiRewardsAtBlock } });
  }
}

/**
 * Register new MultiRewards contracts dynamically when strategy is updated
 */
indexer.contractRegister({ contract: "SFVaultERC4626", event: "StrategyUpdated" }, async ({ event, context }) => {
  const newStrategy = event.params.newStrategy.toLowerCase();

  // First check if we have a hardcoded mapping (faster and more reliable)
  const fallbackMultiRewards = STRATEGY_TO_MULTI_REWARDS[newStrategy];
  if (fallbackMultiRewards) {
    context.chain.SFMultiRewards.add(fallbackMultiRewards);
    return;
  }

  // Query the new strategy's multiRewardsAddress at this block
  // Note: contractRegister doesn't have access to context.effect, so we make direct RPC call
  try {
    const multiRewards = await rpcClient.readContract({
      address: newStrategy as `0x${string}`,
      abi: parseAbi(["function multiRewardsAddress() view returns (address)"]),
      functionName: "multiRewardsAddress",
      blockNumber: BigInt(event.block.number),
    });

    const newMultiRewards = (multiRewards as string).toLowerCase();

    // Register the new MultiRewards contract for indexing
    context.chain.SFMultiRewards.add(newMultiRewards);
  } catch (error) {
    context.log.error(`Failed to get multiRewardsAddress for strategy ${newStrategy}: ${error}`);
  }
});

/**
 * Register new MultiRewards contracts dynamically when vault admin updates MultiRewards
 *
 * NOTE: contractRegister runs before handler processing for the block, which helps ensure
 * any subsequent events from the new MultiRewards address are picked up without requiring
 * a redeploy or reindex.
 */
indexer.contractRegister({ contract: "SFVaultStrategyWrapper", event: "MultiRewardsUpdated" }, ({ event, context }) => {
  const newMultiRewards = event.params.newMultiRewards.toLowerCase();
  context.chain.SFMultiRewards.add(newMultiRewards);
});

/**
 * Handle StrategyUpdated events
 * Event: StrategyUpdated(address indexed oldStrategy, address indexed newStrategy)
 */
indexer.onEvent(
  { contract: "SFVaultERC4626", event: "StrategyUpdated" },
  async ({ event, context }) => {
    const vaultAddress = event.srcAddress.toLowerCase();
    const oldStrategy = event.params.oldStrategy.toLowerCase();
    const newStrategy = event.params.newStrategy.toLowerCase();
    const timestamp = BigInt(event.block.timestamp);

    const config = VAULT_CONFIGS[vaultAddress];
    if (!config) {
      context.log.warn(`Unknown vault address: ${vaultAddress}`);
      return;
    }

    // Query the new strategy's multiRewardsAddress at this block
    const newMultiRewards = await context.effect(getMultiRewardsAddress, {
      strategyAddress: newStrategy,
      blockNumber: BigInt(event.block.number),
    });

    // Mark old strategy as inactive
    const oldStrategyId = `${BERACHAIN_ID}_${vaultAddress}_${oldStrategy}`;
    const oldStrategyRecord = await context.SFVaultStrategy.get(oldStrategyId);
    if (oldStrategyRecord) {
      context.SFVaultStrategy.set({
        ...oldStrategyRecord,
        activeTo: timestamp,
        isActive: false,
      });
    }

    // Create new strategy record
    const newStrategyId = `${BERACHAIN_ID}_${vaultAddress}_${newStrategy}`;
    context.SFVaultStrategy.set({
      id: newStrategyId,
      vault: vaultAddress,
      strategy: newStrategy,
      multiRewards: newMultiRewards,
      kitchenToken: config.kitchenToken,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
      activeFrom: timestamp,
      activeTo: undefined,
      isActive: true,
      chainId: BERACHAIN_ID,
    });

    // Update vault stats with new strategy
    const statsId = `${BERACHAIN_ID}_${vaultAddress}`;
    const stats = await context.SFVaultStats.get(statsId);
    if (stats) {
      context.SFVaultStats.set({
        ...stats,
        strategy: newStrategy,
        lastActivityAt: timestamp,
      });
    }

    // Update LatestVaultStrategy singleton
    context.LatestVaultStrategy.set({
      id: vaultAddress,
      vault: vaultAddress,
      strategy: newStrategy,
      multiRewards: newMultiRewards,
      kitchenToken: config.kitchenToken,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
      chainId: BERACHAIN_ID,
    });

    // Update runtime Maps for subsequent events in same batch
    MULTI_REWARDS_TO_VAULT.delete(config.multiRewards);
    MULTI_REWARDS_TO_VAULT.set(newMultiRewards, { vault: vaultAddress, config: { ...config, strategy: newStrategy, multiRewards: newMultiRewards } });
    STRATEGY_TO_VAULT_MAP.set(newStrategy, { vault: vaultAddress, config: { ...config, strategy: newStrategy, multiRewards: newMultiRewards } });

    context.log.info(
      `Strategy updated for vault ${vaultAddress}: ${oldStrategy} -> ${newStrategy} (MultiRewards: ${newMultiRewards})`
    );

    // Record action for activity feed
    recordAction(context, {
      actionType: "sf_strategy_updated",
      actor: vaultAddress,
      primaryCollection: vaultAddress,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      context: {
        vault: vaultAddress,
        oldStrategy,
        newStrategy,
        newMultiRewards,
        kitchenTokenSymbol: config.kitchenTokenSymbol,
      },
    });
  }
);

/**
 * Handle MultiRewardsUpdated events on the strategy wrapper contract.
 * Event: MultiRewardsUpdated(address indexed oldMultiRewards, address indexed newMultiRewards)
 *
 * When vault admin calls `setMultiRewards`, the strategy wrapper updates the MultiRewards address
 * without changing the strategy itself. We must update our strategy->multiRewards mapping so that
 * new staking/claim events from the new MultiRewards address are correctly attributed to the vault.
 */
indexer.onEvent(
  { contract: "SFVaultStrategyWrapper", event: "MultiRewardsUpdated" },
  async ({ event, context }) => {
    const strategyAddress = event.srcAddress.toLowerCase();
    const oldMultiRewards = event.params.oldMultiRewards.toLowerCase();
    const newMultiRewards = event.params.newMultiRewards.toLowerCase();
    const timestamp = BigInt(event.block.timestamp);

    const vaultInfo = await getVaultFromStrategy(context, strategyAddress);
    if (!vaultInfo) {
      context.log.warn(
        `Unknown strategy wrapper address for MultiRewardsUpdated: ${strategyAddress} (old=${oldMultiRewards}, new=${newMultiRewards})`
      );
      return;
    }

    const { vault: vaultAddress, config } = vaultInfo;
    const strategyId = `${BERACHAIN_ID}_${vaultAddress}_${strategyAddress}`;
    const existing = await context.SFVaultStrategy.get(strategyId);

    if (existing) {
      context.SFVaultStrategy.set({
        ...existing,
        multiRewards: newMultiRewards,
      });
    } else {
      // If this is the first time we’ve ever seen this vault (no deposits yet),
      // bootstrap a minimal strategy record so MultiRewards events can be attributed.
      context.SFVaultStrategy.set({
        id: strategyId,
        vault: vaultAddress,
        strategy: strategyAddress,
        multiRewards: newMultiRewards,
        kitchenToken: config.kitchenToken,
        kitchenTokenSymbol: config.kitchenTokenSymbol,
        activeFrom: timestamp,
        activeTo: undefined,
        isActive: true,
        chainId: BERACHAIN_ID,
      });
    }

    // Update LatestVaultStrategy singleton with new multiRewards
    context.LatestVaultStrategy.set({
      id: vaultAddress,
      vault: vaultAddress,
      strategy: strategyAddress,
      multiRewards: newMultiRewards,
      kitchenToken: config.kitchenToken,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
      chainId: BERACHAIN_ID,
    });

    // Update runtime Maps
    MULTI_REWARDS_TO_VAULT.delete(oldMultiRewards);
    MULTI_REWARDS_TO_VAULT.set(newMultiRewards, { vault: vaultAddress, config: { ...config, multiRewards: newMultiRewards } });

    // Keep vault stats pointing at the currently active multiRewards (if stats exists)
    const statsId = `${BERACHAIN_ID}_${vaultAddress}`;
    const stats = await context.SFVaultStats.get(statsId);
    if (stats) {
      context.SFVaultStats.set({
        ...stats,
        lastActivityAt: timestamp,
      });
    }
  });

/**
 * Handle ERC4626 Deposit events
 * Event: Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)
 */
indexer.onEvent(
  { contract: "SFVaultERC4626", event: "Deposit" },
  async ({ event, context }) => {
    const vaultAddress = event.srcAddress.toLowerCase();
    const config = VAULT_CONFIGS[vaultAddress];

    if (!config) {
      context.log.warn(`Unknown vault address: ${vaultAddress}`);
      return;
    }

    const timestamp = BigInt(event.block.timestamp);
    const owner = event.params.owner.toLowerCase();
    const assets = event.params.assets; // Kitchen tokens deposited
    const shares = event.params.shares; // Vault shares received

    // Ensure initial strategy record exists (effect runs during preload to cache RPC)
    await ensureInitialStrategy(context, vaultAddress, BigInt(event.block.number));

    // Get the current active strategy via singleton (O(1) instead of getWhere+scan)
    const latestStrategy = await context.LatestVaultStrategy.get(vaultAddress);
    const strategyAddress = latestStrategy?.strategy || config.strategy;
    const multiRewardsAddress = latestStrategy?.multiRewards || config.multiRewards;

    // Create position ID
    const positionId = `${BERACHAIN_ID}_${owner}_${vaultAddress}`;
    const statsId = `${BERACHAIN_ID}_${vaultAddress}`;

    // Fetch existing position and stats in parallel
    const [position, stats] = await Promise.all([
      context.SFPosition.get(positionId),
      context.SFVaultStats.get(statsId),
    ]);

    // Skip writes during preload
    if ((context as any).isPreload) return;

    // Update or create position
    const isNewPosition = !position;
    const positionToUpdate: SFPosition = position || {
      id: positionId,
      user: owner,
      vault: vaultAddress,
      multiRewards: multiRewardsAddress,
      kitchenToken: config.kitchenToken,
      strategy: strategyAddress,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
      vaultShares: BigInt(0),
      stakedShares: BigInt(0),
      totalShares: BigInt(0),
      totalDeposited: BigInt(0),
      totalWithdrawn: BigInt(0),
      totalClaimed: BigInt(0),
      firstDepositAt: timestamp,
      lastActivityAt: timestamp,
      chainId: BERACHAIN_ID,
    };

    // When depositing, shares go to vault (not staked yet)
    const newVaultShares = positionToUpdate.vaultShares + shares;
    const newTotalShares = newVaultShares + positionToUpdate.stakedShares;

    const updatedPosition = {
      ...positionToUpdate,
      vaultShares: newVaultShares,
      totalShares: newTotalShares,
      totalDeposited: positionToUpdate.totalDeposited + assets,
      lastActivityAt: timestamp,
      // Update strategy/multiRewards to current active one
      strategy: strategyAddress,
      multiRewards: multiRewardsAddress,
      // Set firstDepositAt on first deposit, or backfill if null
      firstDepositAt: positionToUpdate.firstDepositAt || timestamp,
    };

    context.SFPosition.set(updatedPosition);

    // Update or create vault stats
    const statsToUpdate: SFVaultStats = stats || {
      id: statsId,
      vault: vaultAddress,
      kitchenToken: config.kitchenToken,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
      strategy: strategyAddress,
      totalDeposited: BigInt(0),
      totalWithdrawn: BigInt(0),
      totalStaked: BigInt(0),
      totalUnstaked: BigInt(0),
      totalClaimed: BigInt(0),
      uniqueDepositors: 0,
      activePositions: 0,
      depositCount: 0,
      withdrawalCount: 0,
      claimCount: 0,
      firstDepositAt: timestamp,
      lastActivityAt: timestamp,
      chainId: BERACHAIN_ID,
    };

    // Check if this deposit creates a new active position
    const previousTotalShares = position ? (position.vaultShares + position.stakedShares) : BigInt(0);
    const isNewActivePosition = previousTotalShares === BigInt(0) && newTotalShares > BigInt(0);

    const updatedStats = {
      ...statsToUpdate,
      totalDeposited: statsToUpdate.totalDeposited + assets,
      depositCount: statsToUpdate.depositCount + 1,
      lastActivityAt: timestamp,
      // Increment unique depositors if this is a new position
      uniqueDepositors: statsToUpdate.uniqueDepositors + (isNewPosition ? 1 : 0),
      // Increment active positions if totalShares went from 0 to non-zero
      activePositions: statsToUpdate.activePositions + (isNewActivePosition ? 1 : 0),
    };

    context.SFVaultStats.set(updatedStats);

    // Record action for activity feed
    recordAction(context, {
      actionType: "sf_vault_deposit",
      actor: owner,
      primaryCollection: vaultAddress,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      numeric1: assets,  // Kitchen token amount
      numeric2: shares,  // Vault shares received
      context: {
        vault: vaultAddress,
        kitchenToken: config.kitchenToken,
        kitchenTokenSymbol: config.kitchenTokenSymbol,
        sender: event.params.sender.toLowerCase(),
      },
    });
  }
);

/**
 * Handle ERC4626 Withdraw events
 * Event: Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)
 */
indexer.onEvent(
  { contract: "SFVaultERC4626", event: "Withdraw" },
  async ({ event, context }) => {
    const vaultAddress = event.srcAddress.toLowerCase();
    const config = VAULT_CONFIGS[vaultAddress];

    if (!config) {
      context.log.warn(`Unknown vault address: ${vaultAddress}`);
      return;
    }

    const timestamp = BigInt(event.block.timestamp);
    const owner = event.params.owner.toLowerCase();
    const assets = event.params.assets; // Kitchen tokens withdrawn
    const shares = event.params.shares; // Vault shares burned

    // Create position ID
    const positionId = `${BERACHAIN_ID}_${owner}_${vaultAddress}`;
    const statsId = `${BERACHAIN_ID}_${vaultAddress}`;

    // Fetch existing position and stats in parallel
    const [position, stats] = await Promise.all([
      context.SFPosition.get(positionId),
      context.SFVaultStats.get(statsId),
    ]);

    // Skip writes during preload
    if ((context as any).isPreload) return;

    // Update position if it exists
    if (position) {
      // When withdrawing, shares are burned from vault balance
      let newVaultShares = position.vaultShares - shares;

      // Ensure vaultShares doesn't go negative
      if (newVaultShares < BigInt(0)) {
        newVaultShares = BigInt(0);
      }

      const newTotalShares = newVaultShares + position.stakedShares;

      const updatedPosition = {
        ...position,
        vaultShares: newVaultShares,
        totalShares: newTotalShares,
        totalWithdrawn: position.totalWithdrawn + assets,
        lastActivityAt: timestamp,
      };
      context.SFPosition.set(updatedPosition);
    }

    // Update vault stats
    if (stats && position) {
      // Check if this withdrawal closes the position (totalShares -> 0)
      const previousTotalShares = position.totalShares;
      const newTotalShares = (position.vaultShares - shares) + position.stakedShares;
      const closedPosition = previousTotalShares > BigInt(0) && newTotalShares === BigInt(0);

      const updatedStats = {
        ...stats,
        totalWithdrawn: stats.totalWithdrawn + assets,
        withdrawalCount: stats.withdrawalCount + 1,
        // Decrement active positions if totalShares went to 0
        activePositions: stats.activePositions - (closedPosition ? 1 : 0),
        lastActivityAt: timestamp,
      };
      context.SFVaultStats.set(updatedStats);
    }

    // Record action for activity feed
    recordAction(context, {
      actionType: "sf_vault_withdraw",
      actor: owner,
      primaryCollection: vaultAddress,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      numeric1: assets,  // Kitchen token amount
      numeric2: shares,  // Vault shares burned
      context: {
        vault: vaultAddress,
        kitchenToken: config.kitchenToken,
        kitchenTokenSymbol: config.kitchenTokenSymbol,
        receiver: event.params.receiver.toLowerCase(),
      },
    });
  }
);

/**
 * Handle MultiRewards Staked events
 * Event: Staked(address indexed user, uint256 amount)
 */
indexer.onEvent(
  { contract: "SFMultiRewards", event: "Staked" },
  async ({ event, context }) => {
    const multiRewardsAddress = event.srcAddress.toLowerCase();

    // Look up vault from MultiRewards address
    const vaultInfo = await getVaultFromMultiRewards(
      context,
      multiRewardsAddress,
      BigInt(event.block.number)
    );

    if (!vaultInfo) {
      context.log.warn(`Unknown MultiRewards address: ${multiRewardsAddress}`);
      return;
    }

    const { vault: vaultAddress, config } = vaultInfo;
    const timestamp = BigInt(event.block.timestamp);
    const user = event.params.user.toLowerCase();
    const amount = event.params.amount; // Vault shares staked

    // Create position ID
    const positionId = `${BERACHAIN_ID}_${user}_${vaultAddress}`;
    const statsId = `${BERACHAIN_ID}_${vaultAddress}`;

    // Fetch existing position and stats in parallel
    const [position, stats] = await Promise.all([
      context.SFPosition.get(positionId),
      context.SFVaultStats.get(statsId),
    ]);

    // Track per-MultiRewards position (read for preload cache priming)
    const multiRewardsPositionId = `${BERACHAIN_ID}_${user}_${multiRewardsAddress}`;
    const multiRewardsPosition = await context.SFMultiRewardsPosition.get(multiRewardsPositionId);

    // Skip writes during preload
    if ((context as any).isPreload) return;

    // Update position
    if (position) {
      const newStakedShares = position.stakedShares + amount;

      // When staking, shares move from vault to staked
      let newVaultShares = position.vaultShares - amount;

      // Ensure vaultShares doesn't go negative
      if (newVaultShares < BigInt(0)) {
        newVaultShares = BigInt(0);
      }

      // totalShares remains the same (just moving between buckets)
      const newTotalShares = newVaultShares + newStakedShares;

      const updatedPosition = {
        ...position,
        vaultShares: newVaultShares,
        stakedShares: newStakedShares,
        totalShares: newTotalShares,
        multiRewards: multiRewardsAddress,
        lastActivityAt: timestamp,
      };
      context.SFPosition.set(updatedPosition);

      // Update stats
      if (stats) {
        const updatedStats = {
          ...stats,
          totalStaked: stats.totalStaked + amount,
          lastActivityAt: timestamp,
        };
        context.SFVaultStats.set(updatedStats);
      }
    }

    const updatedMultiRewardsPosition = multiRewardsPosition ? {
      ...multiRewardsPosition,
      stakedShares: multiRewardsPosition.stakedShares + amount,
      totalStaked: multiRewardsPosition.totalStaked + amount,
      lastActivityAt: timestamp,
    } : {
      id: multiRewardsPositionId,
      user,
      vault: vaultAddress,
      multiRewards: multiRewardsAddress,
      stakedShares: amount,
      totalStaked: amount,
      totalUnstaked: BigInt(0),
      totalClaimed: BigInt(0),
      firstStakeAt: timestamp,
      lastActivityAt: timestamp,
      chainId: BERACHAIN_ID,
    };

    context.SFMultiRewardsPosition.set(updatedMultiRewardsPosition);

    // Record action for activity feed
    recordAction(context, {
      actionType: "sf_rewards_stake",
      actor: user,
      primaryCollection: vaultAddress,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      numeric1: amount,  // Shares staked
      context: {
        vault: vaultAddress,
        multiRewards: multiRewardsAddress,
        kitchenTokenSymbol: config.kitchenTokenSymbol,
      },
    });
  }
);

/**
 * Handle MultiRewards Withdrawn events
 * Event: Withdrawn(address indexed user, uint256 amount)
 */
indexer.onEvent(
  { contract: "SFMultiRewards", event: "Withdrawn" },
  async ({ event, context }) => {
    const multiRewardsAddress = event.srcAddress.toLowerCase();

    // Look up vault from MultiRewards address
    const vaultInfo = await getVaultFromMultiRewards(
      context,
      multiRewardsAddress,
      BigInt(event.block.number)
    );

    if (!vaultInfo) {
      context.log.warn(`Unknown MultiRewards address: ${multiRewardsAddress}`);
      return;
    }

    const { vault: vaultAddress, config } = vaultInfo;
    const timestamp = BigInt(event.block.timestamp);
    const user = event.params.user.toLowerCase();
    const amount = event.params.amount; // Vault shares unstaked

    // Create position ID
    const positionId = `${BERACHAIN_ID}_${user}_${vaultAddress}`;
    const statsId = `${BERACHAIN_ID}_${vaultAddress}`;

    // Fetch existing position, stats, and multiRewards position in parallel
    const multiRewardsPositionId = `${BERACHAIN_ID}_${user}_${multiRewardsAddress}`;
    const [position, stats, multiRewardsPosition] = await Promise.all([
      context.SFPosition.get(positionId),
      context.SFVaultStats.get(statsId),
      context.SFMultiRewardsPosition.get(multiRewardsPositionId),
    ]);

    // Skip writes during preload
    if ((context as any).isPreload) return;

    // Update position
    if (position) {
      let newStakedShares = position.stakedShares - amount;

      // Ensure stakedShares doesn't go negative
      if (newStakedShares < BigInt(0)) {
        newStakedShares = BigInt(0);
      }

      // When unstaking, shares move from staked to vault
      const newVaultShares = position.vaultShares + amount;

      // totalShares remains the same (just moving between buckets)
      const newTotalShares = newVaultShares + newStakedShares;

      const updatedPosition = {
        ...position,
        vaultShares: newVaultShares,
        stakedShares: newStakedShares,
        totalShares: newTotalShares,
        multiRewards: multiRewardsAddress,
        lastActivityAt: timestamp,
      };
      context.SFPosition.set(updatedPosition);

      // Update stats
      if (stats) {
        const updatedStats = {
          ...stats,
          totalUnstaked: stats.totalUnstaked + amount,
          lastActivityAt: timestamp,
        };
        context.SFVaultStats.set(updatedStats);
      }
    }

    if (multiRewardsPosition) {
      let newStakedShares = multiRewardsPosition.stakedShares - amount;
      if (newStakedShares < BigInt(0)) {
        newStakedShares = BigInt(0);
      }

      const updatedMultiRewardsPosition = {
        ...multiRewardsPosition,
        stakedShares: newStakedShares,
        totalUnstaked: multiRewardsPosition.totalUnstaked + amount,
        lastActivityAt: timestamp,
      };
      context.SFMultiRewardsPosition.set(updatedMultiRewardsPosition);
    }

    // Record action for activity feed
    recordAction(context, {
      actionType: "sf_rewards_unstake",
      actor: user,
      primaryCollection: vaultAddress,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      numeric1: amount,  // Shares unstaked
      context: {
        vault: vaultAddress,
        multiRewards: multiRewardsAddress,
        kitchenTokenSymbol: config.kitchenTokenSymbol,
      },
    });
  }
);

/**
 * Handle MultiRewards RewardPaid events
 * Event: RewardPaid(address indexed user, address indexed rewardsToken, uint256 reward)
 */
indexer.onEvent(
  { contract: "SFMultiRewards", event: "RewardPaid" },
  async ({ event, context }) => {
    const multiRewardsAddress = event.srcAddress.toLowerCase();

    // Look up vault from MultiRewards address
    const vaultInfo = await getVaultFromMultiRewards(
      context,
      multiRewardsAddress,
      BigInt(event.block.number)
    );

    if (!vaultInfo) {
      context.log.warn(`Unknown MultiRewards address: ${multiRewardsAddress}`);
      return;
    }

    const { vault: vaultAddress, config } = vaultInfo;
    const timestamp = BigInt(event.block.timestamp);
    const user = event.params.user.toLowerCase();
    const rewardsToken = event.params.rewardsToken.toLowerCase();
    const reward = event.params.reward; // HENLO amount claimed

    // Create position ID
    const positionId = `${BERACHAIN_ID}_${user}_${vaultAddress}`;
    const statsId = `${BERACHAIN_ID}_${vaultAddress}`;

    // Fetch existing position, stats, and multiRewards position in parallel
    const multiRewardsPositionId = `${BERACHAIN_ID}_${user}_${multiRewardsAddress}`;
    const [position, stats, multiRewardsPosition] = await Promise.all([
      context.SFPosition.get(positionId),
      context.SFVaultStats.get(statsId),
      context.SFMultiRewardsPosition.get(multiRewardsPositionId),
    ]);

    // Skip writes during preload
    if ((context as any).isPreload) return;

    // Update position's total claimed
    if (position) {
      const updatedPosition = {
        ...position,
        totalClaimed: position.totalClaimed + reward,
        multiRewards: multiRewardsAddress,
        lastActivityAt: timestamp,
      };
      context.SFPosition.set(updatedPosition);
    }

    // Update vault stats total claimed (income metric!)
    if (stats) {
      const updatedStats = {
        ...stats,
        totalClaimed: stats.totalClaimed + reward,
        claimCount: stats.claimCount + 1,
        lastActivityAt: timestamp,
      };
      context.SFVaultStats.set(updatedStats);
    }

    // Track per-MultiRewards position claims
    if (multiRewardsPosition) {
      const updatedMultiRewardsPosition = {
        ...multiRewardsPosition,
        totalClaimed: multiRewardsPosition.totalClaimed + reward,
        lastActivityAt: timestamp,
      };
      context.SFMultiRewardsPosition.set(updatedMultiRewardsPosition);
    }

    // Record action for activity feed
    recordAction(context, {
      actionType: "sf_rewards_claim",
      actor: user,
      primaryCollection: vaultAddress,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      numeric1: reward,  // HENLO claimed
      context: {
        vault: vaultAddress,
        multiRewards: multiRewardsAddress,
        rewardsToken,
        kitchenTokenSymbol: config.kitchenTokenSymbol,
      },
    });
  }
);

/**
 * Handle MultiRewards RebatePaid events
 * Event: RebatePaid(address indexed user, uint256 amount)
 *
 * Rebates are automatic HENLO rewards sent to badge holders when the keeper
 * processes fee tokens. This handler records rebate activity for the user's
 * activity feed.
 */
indexer.onEvent(
  { contract: "SFMultiRewards", event: "RebatePaid" },
  async ({ event, context }) => {
    const multiRewardsAddress = event.srcAddress.toLowerCase();

    // Look up vault from MultiRewards address
    const vaultInfo = await getVaultFromMultiRewards(
      context,
      multiRewardsAddress,
      BigInt(event.block.number)
    );

    if (!vaultInfo) {
      context.log.warn(`Unknown MultiRewards address for rebate: ${multiRewardsAddress}`);
      return;
    }

    // Skip writes during preload (no entity reads needed for rebate)
    if ((context as any).isPreload) return;

    const { vault: vaultAddress, config } = vaultInfo;
    const timestamp = BigInt(event.block.timestamp);
    const user = event.params.user.toLowerCase();
    const amount = event.params.amount; // HENLO rebate amount

    // Record action for activity feed
    // Note: Rebates don't update position.totalClaimed since they're sent directly
    // to the user's wallet, not claimed from the vault
    recordAction(context, {
      actionType: "sf_rewards_rebate",
      actor: user,
      primaryCollection: vaultAddress,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      numeric1: amount, // HENLO rebate amount
      context: {
        vault: vaultAddress,
        multiRewards: multiRewardsAddress,
        kitchenTokenSymbol: config.kitchenTokenSymbol,
      },
    });
  }
);
