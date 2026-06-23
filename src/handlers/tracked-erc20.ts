/*
 * Unified ERC-20 Token Handler
 * Tracks token balances for HENLO, HENLOCKED tier tokens, and MiberaMaker
 * Also handles burn tracking and holder stats for HENLO token
 */

import { indexer, type TrackedTokenBalance } from "envio";
import { TOKEN_CONFIGS } from "./tracked-erc20/constants";
import { isBurnTransfer, trackBurn, ZERO_ADDRESS } from "./tracked-erc20/burn-tracking";
import { updateHolderBalances, updateHolderStats } from "./tracked-erc20/holder-stats";
import { recordAction } from "../lib/actions";

// Tokens that should record Actions for activity tracking
const ACTIVITY_TRACKED_TOKENS = new Set(["miberamaker"]);

/**
 * Handles ERC-20 Transfer events for tracked tokens
 * Routes to appropriate feature handlers based on token config
 */
indexer.onEvent({ contract: "TrackedErc20", event: "Transfer" }, async ({ event, context }) => {
    const { from, to, value } = event.params;
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;
    const tokenAddress = event.srcAddress.toLowerCase();

    // Get token config from address
    const config = TOKEN_CONFIGS[tokenAddress];
    if (!config) {
      // Token not in our tracked list, skip
      return;
    }

    // Normalize addresses
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();
    const zeroAddress = ZERO_ADDRESS.toLowerCase();

    // Preload: prime balance reads for sender and receiver
    const fromId = `${fromLower}_${tokenAddress}_${chainId}`;
    const toId = `${toLower}_${tokenAddress}_${chainId}`;
    if (fromLower !== zeroAddress && toLower !== zeroAddress) {
      await Promise.all([
        context.TrackedTokenBalance.get(fromId),
        context.TrackedTokenBalance.get(toId),
      ]);
    } else if (fromLower !== zeroAddress) {
      await context.TrackedTokenBalance.get(fromId);
    } else if (toLower !== zeroAddress) {
      await context.TrackedTokenBalance.get(toId);
    }

    // Skip writes during preload
    if ((context as any).isPreload) return;

    // 1. Balance tracking (ALL tokens)
    await updateBalance(
      context,
      tokenAddress,
      config.key,
      chainId,
      fromLower,
      toLower,
      value,
      timestamp,
      zeroAddress
    );

    // 2. Holder stats (if enabled - HENLO only)
    if (config.holderStats) {
      try {
        const { holderDelta, supplyDelta } = await updateHolderBalances(event, context, config);

        // Update holder statistics if there were changes
        if (holderDelta !== 0 || supplyDelta !== BigInt(0)) {
          await updateHolderStats(context, chainId, holderDelta, supplyDelta, timestamp);
        }
      } catch (error) {
        context.log.error(`[TrackedErc20] Holder stats error for token ${tokenAddress} on chain ${chainId}: ${error}`);
      }
    }

    // 3. Burn tracking (if enabled + is burn)
    if (config.burnTracking && isBurnTransfer(toLower)) {
      try {
        await trackBurn(event, context, config, fromLower, toLower);
      } catch (error) {
        context.log.error(`[TrackedErc20] Burn tracking error for token ${tokenAddress} on chain ${chainId}: ${error}`);
      }
    }

    // 4. Activity tracking for specific tokens (e.g., MiberaMaker)
    if (ACTIVITY_TRACKED_TOKENS.has(config.key)) {
      const isMint = fromLower === zeroAddress;
      const isBurn = isBurnTransfer(toLower);

      // Determine action type: buy (receive), sell (send), mint, or burn
      let actionType: string;
      let actor: string;

      if (isMint) {
        actionType = `${config.key}_mint`;
        actor = toLower;
      } else if (isBurn) {
        actionType = `${config.key}_burn`;
        actor = fromLower;
      } else {
        // For regular transfers, we record both sender (sell) and receiver (buy)
        // Record as the receiver (buyer) - this captures DEX trades
        actionType = `${config.key}_transfer`;
        actor = toLower;
      }

      recordAction(context, {
        id: `${event.transaction.hash}_${event.logIndex}`,
        actionType,
        actor,
        primaryCollection: config.key,
        timestamp,
        chainId,
        txHash: event.transaction.hash,
        logIndex: event.logIndex,
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
  }
);

/**
 * Updates TrackedTokenBalance records for sender and receiver
 */
async function updateBalance(
  context: any,
  tokenAddress: string,
  tokenKey: string,
  chainId: number,
  fromLower: string,
  toLower: string,
  value: bigint,
  timestamp: bigint,
  zeroAddress: string
) {
  // Handle sender (decrease balance) - skip if mint (from zero address)
  if (fromLower !== zeroAddress) {
    const fromId = `${fromLower}_${tokenAddress}_${chainId}`;
    const fromBalance = await context.TrackedTokenBalance.get(fromId);

    if (fromBalance) {
      const newBalance = fromBalance.balance - value;
      const updatedFromBalance: TrackedTokenBalance = {
        ...fromBalance,
        balance: newBalance,
        lastUpdated: timestamp,
      };
      context.TrackedTokenBalance.set(updatedFromBalance);
    } else {
      // Create record with negative balance (shouldn't happen in practice)
      const newFromBalance: TrackedTokenBalance = {
        id: fromId,
        address: fromLower,
        tokenAddress,
        tokenKey,
        chainId,
        balance: -value,
        lastUpdated: timestamp,
      };
      context.TrackedTokenBalance.set(newFromBalance);
    }
  }

  // Handle receiver (increase balance) - skip if burn (to zero address)
  // Note: We still track burns in TrackedTokenBalance for completeness
  if (toLower !== zeroAddress) {
    const toId = `${toLower}_${tokenAddress}_${chainId}`;
    const toBalance = await context.TrackedTokenBalance.get(toId);

    if (toBalance) {
      const newBalance = toBalance.balance + value;
      const updatedToBalance: TrackedTokenBalance = {
        ...toBalance,
        balance: newBalance,
        lastUpdated: timestamp,
      };
      context.TrackedTokenBalance.set(updatedToBalance);
    } else {
      // Create new record for first-time holder
      const newToBalance: TrackedTokenBalance = {
        id: toId,
        address: toLower,
        tokenAddress,
        tokenKey,
        chainId,
        balance: value,
        lastUpdated: timestamp,
      };
      context.TrackedTokenBalance.set(newToBalance);
    }
  }
}
