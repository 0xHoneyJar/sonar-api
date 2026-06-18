/*
 * Aquabera Wall Tracking Handlers
 *
 * Tracks deposits and withdrawals to the Aquabera HENLO/BERA vault.
 * Identifies contributions from the wall contract and tracks unique builders.
 */

import {
  indexer,
  type AquaberaDeposit,
  type AquaberaWithdrawal,
  type AquaberaBuilder,
  type AquaberaStats,
} from "envio";

import { recordAction } from "../lib/actions";

// Wall contract address that makes special contributions (Poku Trump)
const WALL_CONTRACT_ADDRESS =
  "0x05c98986Fc75D63eF973C648F22687d1a8056CD6".toLowerCase();
const BERACHAIN_ID = 80094;

/*
 * Handle DepositForwarded events - when users add liquidity through the Aquabera forwarder
 */
indexer.onEvent(
  { contract: "AquaberaVault", event: "DepositForwarded" },
  async ({ event, context }) => {
    const timestamp = BigInt(event.block.timestamp);
    const depositor = event.params.sender.toLowerCase(); // The sender is who initiated the deposit
    const assets = event.params.amount; // BERA/WBERA amount deposited (THIS IS THE CORRECT WBERA AMOUNT)
    const shares = event.params.shares; // LP tokens received
    const vault = event.params.vault.toLowerCase(); // The vault receiving the deposit
    const token = event.params.token.toLowerCase(); // Token being deposited (BERA or WBERA)
    const recipient = event.params.to.toLowerCase(); // Who receives the LP tokens
    const isWallContribution = depositor === WALL_CONTRACT_ADDRESS;

    // Create deposit record
    const depositId = `${event.transaction.hash}_${event.logIndex}`;
    const deposit: AquaberaDeposit = {
      id: depositId,
      amount: assets,
      shares: shares,
      timestamp: timestamp,
      blockNumber: BigInt(event.block.number),
      transactionHash: event.transaction.hash,
      from: depositor,
      isWallContribution: isWallContribution,
      chainId: BERACHAIN_ID,
    };
    context.AquaberaDeposit.set(deposit);

    // Batch all entity queries for parallel execution
    const builderId = depositor;
    const statsId = "global";
    const chainStatsId = `${BERACHAIN_ID}`;

    const [builder, stats, chainStats] = await Promise.all([
      context.AquaberaBuilder.get(builderId),
      context.AquaberaStats.get(statsId),
      context.AquaberaStats.get(chainStatsId),
    ]);

    // Prepare builder (create if doesn't exist)
    const builderToUpdate = builder || {
      id: builderId,
      address: depositor,
      totalDeposited: BigInt(0),
      totalWithdrawn: BigInt(0),
      netDeposited: BigInt(0),
      currentShares: BigInt(0),
      depositCount: 0,
      withdrawalCount: 0,
      firstDepositTime: timestamp,
      lastActivityTime: timestamp,
      isWallContract: isWallContribution,
      chainId: BERACHAIN_ID,
    };

    // Update builder stats with immutable pattern
    const updatedBuilder = {
      ...builderToUpdate,
      totalDeposited: builderToUpdate.totalDeposited + assets,
      netDeposited: builderToUpdate.netDeposited + assets,
      currentShares: builderToUpdate.currentShares + shares,
      depositCount: builderToUpdate.depositCount + 1,
      lastActivityTime: timestamp,
    };
    context.AquaberaBuilder.set(updatedBuilder);

    // Prepare global stats (create if doesn't exist)
    const statsToUpdate = stats || {
      id: statsId,
      totalBera: BigInt(0),
      totalShares: BigInt(0),
      totalDeposited: BigInt(0),
      totalWithdrawn: BigInt(0),
      uniqueBuilders: 0,
      depositCount: 0,
      withdrawalCount: 0,
      wallContributions: BigInt(0),
      wallDepositCount: 0,
      lastUpdateTime: timestamp,
      chainId: BERACHAIN_ID,
    };

    // Calculate unique builders increment
    const uniqueBuildersIncrement =
      !builder || builder.depositCount === 0 ? 1 : 0;

    // Update global stats with immutable pattern
    const updatedStats = {
      ...statsToUpdate,
      totalBera: statsToUpdate.totalBera + assets,
      totalShares: statsToUpdate.totalShares + shares,
      totalDeposited: statsToUpdate.totalDeposited + assets,
      uniqueBuilders: statsToUpdate.uniqueBuilders + uniqueBuildersIncrement,
      depositCount: statsToUpdate.depositCount + 1,
      wallContributions: isWallContribution
        ? statsToUpdate.wallContributions + assets
        : statsToUpdate.wallContributions,
      wallDepositCount: isWallContribution
        ? statsToUpdate.wallDepositCount + 1
        : statsToUpdate.wallDepositCount,
      lastUpdateTime: timestamp,
    };
    context.AquaberaStats.set(updatedStats);

    // Prepare chain stats (create if doesn't exist)
    const chainStatsToUpdate = chainStats || {
      id: chainStatsId,
      totalBera: BigInt(0),
      totalShares: BigInt(0),
      totalDeposited: BigInt(0),
      totalWithdrawn: BigInt(0),
      uniqueBuilders: 0,
      depositCount: 0,
      withdrawalCount: 0,
      wallContributions: BigInt(0),
      wallDepositCount: 0,
      lastUpdateTime: timestamp,
      chainId: BERACHAIN_ID,
    };

    // Update chain stats with immutable pattern
    const updatedChainStats = {
      ...chainStatsToUpdate,
      totalBera: chainStatsToUpdate.totalBera + assets,
      totalShares: chainStatsToUpdate.totalShares + shares,
      totalDeposited: chainStatsToUpdate.totalDeposited + assets,
      uniqueBuilders: chainStatsToUpdate.uniqueBuilders + uniqueBuildersIncrement,
      depositCount: chainStatsToUpdate.depositCount + 1,
      wallContributions: isWallContribution
        ? chainStatsToUpdate.wallContributions + assets
        : chainStatsToUpdate.wallContributions,
      wallDepositCount: isWallContribution
        ? chainStatsToUpdate.wallDepositCount + 1
        : chainStatsToUpdate.wallDepositCount,
      lastUpdateTime: timestamp,
    };
    context.AquaberaStats.set(updatedChainStats);

    // Removed verbose logging - uncomment for debugging if needed
    // context.log.info(
    //   `Aquabera deposit: ${assets} BERA from ${depositor}${
    //     isWallContribution ? " (WALL CONTRIBUTION)" : ""
    //   } for ${shares} shares`
    // );

    recordAction(context, {
      id: depositId,
      actionType: "deposit",
      actor: depositor,
      primaryCollection: "henlo_build",
      timestamp,
      chainId: event.chainId,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      numeric1: assets,
      numeric2: shares,
      context: {
        vault,
        token,
        recipient,
        isWallContribution,
        forwarder: event.srcAddress.toLowerCase(),
      },
    });
  }
);

/*
 * Handle Withdraw events - NOT IMPLEMENTED
 * Note: The Aquabera forwarder doesn't emit withdrawal events
 * Withdrawals would need to be tracked directly from the vault or through other means
 */
/*
export const handleAquaberaWithdraw = AquaberaVault.Withdraw.handler(
  async ({ event, context }) => {
    const timestamp = BigInt(event.block.timestamp);
    const withdrawer = event.params.owner.toLowerCase();
    const assets = event.params.assets; // BERA amount
    const shares = event.params.shares; // LP tokens burned

    // Create withdrawal record
    const withdrawalId = `${event.transaction.hash}_${event.logIndex}`;
    const withdrawal: AquaberaWithdrawal = {
      id: withdrawalId,
      amount: assets,
      shares: shares,
      timestamp: timestamp,
      blockNumber: BigInt(event.block.number),
      transactionHash: event.transaction.hash,
      from: withdrawer,
      chainId: BERACHAIN_ID,
    };
    context.AquaberaWithdrawal.set(withdrawal);

    // Update builder stats
    const builderId = withdrawer;
    let builder = await context.AquaberaBuilder.get(builderId);
    
    if (builder) {
      // Update builder stats with immutable pattern
      const updatedBuilder = {
        ...builder,
        totalWithdrawn: builder.totalWithdrawn + assets,
        netDeposited: builder.netDeposited - assets,
        currentShares: builder.currentShares > shares 
          ? builder.currentShares - shares 
          : BigInt(0), // Prevent negative shares
        withdrawalCount: builder.withdrawalCount + 1,
        lastActivityTime: timestamp,
      };
      context.AquaberaBuilder.set(updatedBuilder);
    }

    // Update global stats
    const statsId = "global";
    let stats = await context.AquaberaStats.get(statsId);
    
    if (stats) {
      // Update stats with immutable pattern
      const updatedStats = {
        ...stats,
        totalBera: stats.totalBera > assets 
          ? stats.totalBera - assets 
          : BigInt(0), // Prevent negative balance
        totalShares: stats.totalShares > shares 
          ? stats.totalShares - shares 
          : BigInt(0),
        totalWithdrawn: stats.totalWithdrawn + assets,
        withdrawalCount: stats.withdrawalCount + 1,
        lastUpdateTime: timestamp,
      };
      context.AquaberaStats.set(updatedStats);
    }

    // Also update chain-specific stats
    const chainStatsId = `${BERACHAIN_ID}`;
    let chainStats = await context.AquaberaStats.get(chainStatsId);
    
    if (chainStats) {
      // Update chain stats with immutable pattern
      const updatedChainStats = {
        ...chainStats,
        totalBera: chainStats.totalBera > assets 
          ? chainStats.totalBera - assets 
          : BigInt(0),
        totalShares: chainStats.totalShares > shares 
          ? chainStats.totalShares - shares 
          : BigInt(0),
        totalWithdrawn: chainStats.totalWithdrawn + assets,
        withdrawalCount: chainStats.withdrawalCount + 1,
        lastUpdateTime: timestamp,
      };
      context.AquaberaStats.set(updatedChainStats);
    }

    context.log.info(
      `Aquabera withdrawal: ${assets} BERA to ${withdrawer} for ${shares} shares`
    );
  }
);
*/
