/**
 * Mibera Liquid Backing Handlers
 *
 * Tracks backing loans, item loans, RFV updates, and marketplace for defaulted NFTs
 * Enables real-time loan tracking and treasury marketplace queries
 */

import { indexer } from "envio";
import type { TreasuryItem, TreasuryStats, TreasuryActivity, MiberaLoan, MiberaLoanStats, DailyRfvSnapshot } from "envio";
import { recordAction } from "../lib/actions";

const BERACHAIN_ID = 80094;
const LIQUID_BACKING_ADDRESS = "0xaa04f13994a7fcd86f3bbbf4054d239b88f2744d";
const SECONDS_PER_DAY = 86400;

/**
 * Helper: Get or create TreasuryStats singleton
 */
async function getOrCreateStats(
  context: any
): Promise<TreasuryStats> {
  const statsId = `${BERACHAIN_ID}_global`;
  const existing = await context.TreasuryStats.get(statsId);

  if (existing) return existing;

  return {
    id: statsId,
    totalItemsOwned: 0,
    totalItemsEverOwned: 0,
    totalItemsSold: 0,
    realFloorValue: BigInt(0),
    lastRfvUpdate: undefined,
    lastActivityAt: BigInt(0),
    chainId: BERACHAIN_ID,
  };
}

/**
 * Helper: Get or create MiberaLoanStats singleton
 */
async function getOrCreateLoanStats(
  context: any
): Promise<MiberaLoanStats> {
  const statsId = `${BERACHAIN_ID}_global`;
  const existing = await context.MiberaLoanStats.get(statsId);

  if (existing) return existing;

  return {
    id: statsId,
    totalActiveLoans: 0,
    totalLoansCreated: 0,
    totalLoansRepaid: 0,
    totalLoansDefaulted: 0,
    totalAmountLoaned: BigInt(0),
    totalNftsWithLoans: 0,
    chainId: BERACHAIN_ID,
  };
}

/**
 * Helper: Get day number from timestamp (days since epoch)
 */
function getDayFromTimestamp(timestamp: bigint): number {
  return Math.floor(Number(timestamp) / SECONDS_PER_DAY);
}

// ============================================================================
// LOAN LIFECYCLE HANDLERS
// ============================================================================

/**
 * Handle LoanReceived - User creates a backing loan (collateral-based)
 * Event: LoanReceived(uint256 loanId, uint256[] ids, uint256 amount, uint256 expiry)
 */
indexer.onEvent({ contract: "MiberaLiquidBacking", event: "LoanReceived" },
  async ({ event, context }) => {
    const timestamp = BigInt(event.block.timestamp);
    const loanId = event.params.loanId;
    const tokenIds = event.params.ids;
    const amount = event.params.amount;
    const expiry = event.params.expiry;
    const txHash = event.transaction.hash;
    const user = event.transaction.from?.toLowerCase() || "";

    // Create loan entity
    const loanEntityId = `${BERACHAIN_ID}_backing_${loanId.toString()}`;
    const loan: MiberaLoan = {
      id: loanEntityId,
      loanId,
      loanType: "backing",
      user,
      tokenIds: tokenIds.map(id => id),
      amount,
      expiry,
      status: "ACTIVE",
      createdAt: timestamp,
      repaidAt: undefined,
      defaultedAt: undefined,
      transactionHash: txHash,
      chainId: BERACHAIN_ID,
    };
    context.MiberaLoan.set(loan);

    // Update loan stats
    const loanStats = await getOrCreateLoanStats(context);
    context.MiberaLoanStats.set({
      ...loanStats,
      totalActiveLoans: loanStats.totalActiveLoans + 1,
      totalLoansCreated: loanStats.totalLoansCreated + 1,
      totalAmountLoaned: loanStats.totalAmountLoaned + amount,
      totalNftsWithLoans: loanStats.totalNftsWithLoans + tokenIds.length,
    });

    // Record action
    recordAction(context, {
      actionType: "loan_received",
      actor: user,
      primaryCollection: LIQUID_BACKING_ADDRESS,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash,
      logIndex: event.logIndex,
      numeric1: loanId,
      numeric2: amount,
      context: { tokenIds: tokenIds.map(id => id.toString()), expiry: expiry.toString() },
    });
  }
);

/**
 * Handle BackingLoanPayedBack - User repays backing loan
 * Event: BackingLoanPayedBack(uint256 loanId, uint256 newTotalBacking)
 */
indexer.onEvent({ contract: "MiberaLiquidBacking", event: "BackingLoanPayedBack" },
  async ({ event, context }) => {
    const timestamp = BigInt(event.block.timestamp);
    const loanId = event.params.loanId;
    const txHash = event.transaction.hash;

    // Update loan status
    const loanEntityId = `${BERACHAIN_ID}_backing_${loanId.toString()}`;
    const existingLoan = await context.MiberaLoan.get(loanEntityId);

    if (existingLoan) {
      context.MiberaLoan.set({
        ...existingLoan,
        status: "REPAID",
        repaidAt: timestamp,
      });

      // Update loan stats
      const loanStats = await getOrCreateLoanStats(context);
      context.MiberaLoanStats.set({
        ...loanStats,
        totalActiveLoans: Math.max(0, loanStats.totalActiveLoans - 1),
        totalLoansRepaid: loanStats.totalLoansRepaid + 1,
        totalNftsWithLoans: Math.max(0, loanStats.totalNftsWithLoans - existingLoan.tokenIds.length),
      });
    }

    // Record action
    recordAction(context, {
      actionType: "loan_repaid",
      actor: existingLoan?.user || LIQUID_BACKING_ADDRESS,
      primaryCollection: LIQUID_BACKING_ADDRESS,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash,
      logIndex: event.logIndex,
      numeric1: loanId,
    });
  }
);

/**
 * Handle ItemLoaned - User takes an item loan (single NFT from treasury)
 * Event: ItemLoaned(uint256 loanId, uint256 itemId, uint256 expiry)
 */
indexer.onEvent({ contract: "MiberaLiquidBacking", event: "ItemLoaned" },
  async ({ event, context }) => {
    const timestamp = BigInt(event.block.timestamp);
    const loanId = event.params.loanId;
    const itemId = event.params.itemId;
    const expiry = event.params.expiry;
    const txHash = event.transaction.hash;
    const user = event.transaction.from?.toLowerCase() || "";

    // Create loan entity
    const loanEntityId = `${BERACHAIN_ID}_item_${loanId.toString()}`;
    const loan: MiberaLoan = {
      id: loanEntityId,
      loanId,
      loanType: "item",
      user,
      tokenIds: [itemId],
      amount: BigInt(0), // Item loans don't have an amount
      expiry,
      status: "ACTIVE",
      createdAt: timestamp,
      repaidAt: undefined,
      defaultedAt: undefined,
      transactionHash: txHash,
      chainId: BERACHAIN_ID,
    };
    context.MiberaLoan.set(loan);

    // Update loan stats
    const loanStats = await getOrCreateLoanStats(context);
    context.MiberaLoanStats.set({
      ...loanStats,
      totalActiveLoans: loanStats.totalActiveLoans + 1,
      totalLoansCreated: loanStats.totalLoansCreated + 1,
      totalNftsWithLoans: loanStats.totalNftsWithLoans + 1,
    });

    // Record action
    recordAction(context, {
      actionType: "item_loaned",
      actor: user,
      primaryCollection: LIQUID_BACKING_ADDRESS,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash,
      logIndex: event.logIndex,
      numeric1: loanId,
      numeric2: itemId,
      context: { expiry: expiry.toString() },
    });
  }
);

/**
 * Handle LoanItemSentBack - User returns item loan
 * Event: LoanItemSentBack(uint256 loanId, uint256 newTotalBacking)
 */
indexer.onEvent({ contract: "MiberaLiquidBacking", event: "LoanItemSentBack" },
  async ({ event, context }) => {
    const timestamp = BigInt(event.block.timestamp);
    const loanId = event.params.loanId;
    const txHash = event.transaction.hash;

    // Update loan status
    const loanEntityId = `${BERACHAIN_ID}_item_${loanId.toString()}`;
    const existingLoan = await context.MiberaLoan.get(loanEntityId);

    if (existingLoan) {
      context.MiberaLoan.set({
        ...existingLoan,
        status: "REPAID",
        repaidAt: timestamp,
      });

      // Update loan stats
      const loanStats = await getOrCreateLoanStats(context);
      context.MiberaLoanStats.set({
        ...loanStats,
        totalActiveLoans: Math.max(0, loanStats.totalActiveLoans - 1),
        totalLoansRepaid: loanStats.totalLoansRepaid + 1,
        totalNftsWithLoans: Math.max(0, loanStats.totalNftsWithLoans - 1),
      });
    }

    // Record action
    recordAction(context, {
      actionType: "item_loan_returned",
      actor: existingLoan?.user || LIQUID_BACKING_ADDRESS,
      primaryCollection: LIQUID_BACKING_ADDRESS,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash,
      logIndex: event.logIndex,
      numeric1: loanId,
    });
  }
);

// ============================================================================
// LOAN DEFAULT HANDLERS (existing handlers updated)
// ============================================================================

/**
 * Handle BackingLoanExpired - NFT(s) become treasury-owned when backing loan defaults
 * Event: BackingLoanExpired(uint256 loanId, uint256 newTotalBacking)
 *
 * Note: BackingLoanExpired involves collateral NFTs from a loan, not a single tokenId.
 * The loan contains multiple collateral items. We record the event but can't determine
 * specific tokenIds without querying the contract.
 */
indexer.onEvent({ contract: "MiberaLiquidBacking", event: "BackingLoanExpired" },
  async ({ event, context }) => {
    const timestamp = BigInt(event.block.timestamp);
    const loanId = event.params.loanId;
    const newTotalBacking = event.params.newTotalBacking;
    const txHash = event.transaction.hash;

    // Update loan status to DEFAULTED
    const loanEntityId = `${BERACHAIN_ID}_backing_${loanId.toString()}`;
    const existingLoan = await context.MiberaLoan.get(loanEntityId);

    if (existingLoan) {
      context.MiberaLoan.set({
        ...existingLoan,
        status: "DEFAULTED",
        defaultedAt: timestamp,
      });

      // Update loan stats
      const loanStats = await getOrCreateLoanStats(context);
      context.MiberaLoanStats.set({
        ...loanStats,
        totalActiveLoans: Math.max(0, loanStats.totalActiveLoans - 1),
        totalLoansDefaulted: loanStats.totalLoansDefaulted + 1,
        totalNftsWithLoans: Math.max(0, loanStats.totalNftsWithLoans - existingLoan.tokenIds.length),
      });
    }

    // Record activity (we don't know specific tokenIds for backing loans)
    const activityId = `${txHash}_${event.logIndex}`;
    const activity: TreasuryActivity = {
      id: activityId,
      activityType: "backing_loan_defaulted",
      tokenId: undefined,
      user: existingLoan?.user,
      amount: newTotalBacking,
      timestamp,
      blockNumber: BigInt(event.block.number),
      transactionHash: txHash,
      chainId: BERACHAIN_ID,
    };
    context.TreasuryActivity.set(activity);

    // Update stats - we can't know exact count increase without contract query
    const stats = await getOrCreateStats(context);
    context.TreasuryStats.set({
      ...stats,
      lastActivityAt: timestamp,
    });

    // Record action for activity feed
    recordAction(context, {
      actionType: "treasury_backing_loan_expired",
      actor: LIQUID_BACKING_ADDRESS,
      primaryCollection: LIQUID_BACKING_ADDRESS,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash,
      logIndex: event.logIndex,
      numeric1: loanId,
      numeric2: newTotalBacking,
    });
  }
);

/**
 * Handle ItemLoanExpired - NFT becomes treasury-owned when item loan defaults
 * Event: ItemLoanExpired(uint256 loanId, uint256 newTotalBacking)
 *
 * For item loans, the loanId can be used to look up the specific itemId.
 * The item that was loaned now belongs to the treasury.
 */
indexer.onEvent({ contract: "MiberaLiquidBacking", event: "ItemLoanExpired" },
  async ({ event, context }) => {
    const timestamp = BigInt(event.block.timestamp);
    const loanId = event.params.loanId;
    const newTotalBacking = event.params.newTotalBacking;
    const txHash = event.transaction.hash;

    // Update loan status to DEFAULTED
    const loanEntityId = `${BERACHAIN_ID}_item_${loanId.toString()}`;
    const existingLoan = await context.MiberaLoan.get(loanEntityId);

    if (existingLoan) {
      context.MiberaLoan.set({
        ...existingLoan,
        status: "DEFAULTED",
        defaultedAt: timestamp,
      });

      // Update loan stats
      const loanStats = await getOrCreateLoanStats(context);
      context.MiberaLoanStats.set({
        ...loanStats,
        totalActiveLoans: Math.max(0, loanStats.totalActiveLoans - 1),
        totalLoansDefaulted: loanStats.totalLoansDefaulted + 1,
        totalNftsWithLoans: Math.max(0, loanStats.totalNftsWithLoans - 1),
      });
    }

    // For item loans, we use loanId as tokenId (based on contract structure)
    // The itemLoanDetails function uses loanId to track the item
    const itemIdStr = loanId.toString();
    const existingItem = await context.TreasuryItem.get(itemIdStr);

    const treasuryItem: TreasuryItem = existingItem
      ? {
          ...existingItem,
          isTreasuryOwned: true,
          acquiredAt: timestamp,
          acquiredVia: "item_loan_default",
          acquiredTxHash: txHash,
          // Clear purchase fields if item is being re-acquired
          purchasedAt: undefined,
          purchasedBy: undefined,
          purchasedTxHash: undefined,
          purchasePrice: undefined,
        }
      : {
          id: itemIdStr,
          tokenId: loanId,
          isTreasuryOwned: true,
          acquiredAt: timestamp,
          acquiredVia: "item_loan_default",
          acquiredTxHash: txHash,
          purchasedAt: undefined,
          purchasedBy: undefined,
          purchasedTxHash: undefined,
          purchasePrice: undefined,
          chainId: BERACHAIN_ID,
        };
    context.TreasuryItem.set(treasuryItem);

    // Update stats
    const stats = await getOrCreateStats(context);
    const wasAlreadyOwned = existingItem?.isTreasuryOwned === true;
    context.TreasuryStats.set({
      ...stats,
      totalItemsOwned: stats.totalItemsOwned + (wasAlreadyOwned ? 0 : 1),
      totalItemsEverOwned: stats.totalItemsEverOwned + (wasAlreadyOwned ? 0 : 1),
      lastActivityAt: timestamp,
    });

    // Record activity
    const activityId = `${txHash}_${event.logIndex}`;
    context.TreasuryActivity.set({
      id: activityId,
      activityType: "item_acquired",
      tokenId: loanId,
      user: undefined,
      amount: newTotalBacking,
      timestamp,
      blockNumber: BigInt(event.block.number),
      transactionHash: txHash,
      chainId: BERACHAIN_ID,
    });

    recordAction(context, {
      actionType: "treasury_item_acquired",
      actor: LIQUID_BACKING_ADDRESS,
      primaryCollection: LIQUID_BACKING_ADDRESS,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash,
      logIndex: event.logIndex,
      numeric1: loanId,
      context: { source: "item_loan_default" },
    });
  }
);

/**
 * Handle ItemPurchased - NFT purchased from treasury
 * Event: ItemPurchased(uint256 itemId, uint256 newTotalBacking)
 */
indexer.onEvent({ contract: "MiberaLiquidBacking", event: "ItemPurchased" },
  async ({ event, context }) => {
    const timestamp = BigInt(event.block.timestamp);
    const itemId = event.params.itemId;
    const newTotalBacking = event.params.newTotalBacking;
    const txHash = event.transaction.hash;
    const buyer = event.transaction.from?.toLowerCase();

    // Update treasury item
    const itemIdStr = itemId.toString();
    const existingItem = await context.TreasuryItem.get(itemIdStr);

    // Get current RFV for purchase price recording
    const stats = await getOrCreateStats(context);

    if (existingItem) {
      context.TreasuryItem.set({
        ...existingItem,
        isTreasuryOwned: false,
        purchasedAt: timestamp,
        purchasedBy: buyer,
        purchasedTxHash: txHash,
        purchasePrice: stats.realFloorValue,
      });
    } else {
      // Item exists on-chain but wasn't indexed yet (historical case)
      context.TreasuryItem.set({
        id: itemIdStr,
        tokenId: itemId,
        isTreasuryOwned: false,
        acquiredAt: undefined,
        acquiredVia: undefined,
        acquiredTxHash: undefined,
        purchasedAt: timestamp,
        purchasedBy: buyer,
        purchasedTxHash: txHash,
        purchasePrice: stats.realFloorValue,
        chainId: BERACHAIN_ID,
      });
    }

    // Update stats
    const wasOwned = existingItem?.isTreasuryOwned === true;
    context.TreasuryStats.set({
      ...stats,
      totalItemsOwned: Math.max(0, stats.totalItemsOwned - (wasOwned ? 1 : 0)),
      totalItemsSold: stats.totalItemsSold + 1,
      lastActivityAt: timestamp,
    });

    // Record activity
    const activityId = `${txHash}_${event.logIndex}`;
    context.TreasuryActivity.set({
      id: activityId,
      activityType: "item_purchased",
      tokenId: itemId,
      user: buyer,
      amount: stats.realFloorValue,
      timestamp,
      blockNumber: BigInt(event.block.number),
      transactionHash: txHash,
      chainId: BERACHAIN_ID,
    });

    recordAction(context, {
      actionType: "treasury_purchase",
      actor: buyer || LIQUID_BACKING_ADDRESS,
      primaryCollection: LIQUID_BACKING_ADDRESS,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash,
      logIndex: event.logIndex,
      numeric1: itemId,
      numeric2: stats.realFloorValue,
    });
  }
);

/**
 * Handle ItemRedeemed - NFT deposited into treasury
 * Event: ItemRedeemed(uint256 itemId, uint256 newTotalBacking)
 */
indexer.onEvent({ contract: "MiberaLiquidBacking", event: "ItemRedeemed" },
  async ({ event, context }) => {
    const timestamp = BigInt(event.block.timestamp);
    const itemId = event.params.itemId;
    const newTotalBacking = event.params.newTotalBacking;
    const txHash = event.transaction.hash;
    const depositor = event.transaction.from?.toLowerCase();

    // Create/update treasury item
    const itemIdStr = itemId.toString();
    const existingItem = await context.TreasuryItem.get(itemIdStr);

    const treasuryItem: TreasuryItem = existingItem
      ? {
          ...existingItem,
          isTreasuryOwned: true,
          acquiredAt: timestamp,
          acquiredVia: "redemption",
          acquiredTxHash: txHash,
          // Clear purchase fields if item is being re-acquired
          purchasedAt: undefined,
          purchasedBy: undefined,
          purchasedTxHash: undefined,
          purchasePrice: undefined,
        }
      : {
          id: itemIdStr,
          tokenId: itemId,
          isTreasuryOwned: true,
          acquiredAt: timestamp,
          acquiredVia: "redemption",
          acquiredTxHash: txHash,
          purchasedAt: undefined,
          purchasedBy: undefined,
          purchasedTxHash: undefined,
          purchasePrice: undefined,
          chainId: BERACHAIN_ID,
        };
    context.TreasuryItem.set(treasuryItem);

    // Update stats
    const stats = await getOrCreateStats(context);
    const wasAlreadyOwned = existingItem?.isTreasuryOwned === true;
    context.TreasuryStats.set({
      ...stats,
      totalItemsOwned: stats.totalItemsOwned + (wasAlreadyOwned ? 0 : 1),
      totalItemsEverOwned: stats.totalItemsEverOwned + (wasAlreadyOwned ? 0 : 1),
      lastActivityAt: timestamp,
    });

    // Record activity
    const activityId = `${txHash}_${event.logIndex}`;
    context.TreasuryActivity.set({
      id: activityId,
      activityType: "item_acquired",
      tokenId: itemId,
      user: depositor,
      amount: newTotalBacking,
      timestamp,
      blockNumber: BigInt(event.block.number),
      transactionHash: txHash,
      chainId: BERACHAIN_ID,
    });

    recordAction(context, {
      actionType: "treasury_item_redeemed",
      actor: depositor || LIQUID_BACKING_ADDRESS,
      primaryCollection: LIQUID_BACKING_ADDRESS,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash,
      logIndex: event.logIndex,
      numeric1: itemId,
      numeric2: newTotalBacking,
    });
  }
);

/**
 * Handle RFVChanged - Real Floor Value updated
 * Event: RFVChanged(uint256 indexed newRFV)
 *
 * Also creates daily RFV snapshots for historical charting
 */
indexer.onEvent({ contract: "MiberaLiquidBacking", event: "RFVChanged" },
  async ({ event, context }) => {
    const timestamp = BigInt(event.block.timestamp);
    const newRFV = event.params.newRFV;
    const txHash = event.transaction.hash;

    // Update stats with new RFV
    const stats = await getOrCreateStats(context);
    context.TreasuryStats.set({
      ...stats,
      realFloorValue: newRFV,
      lastRfvUpdate: timestamp,
      lastActivityAt: timestamp,
    });

    // Create/update daily RFV snapshot (one per day, always latest RFV for that day)
    const day = getDayFromTimestamp(timestamp);
    const snapshotId = `${BERACHAIN_ID}_${day}`;
    const snapshot: DailyRfvSnapshot = {
      id: snapshotId,
      day,
      rfv: newRFV,
      timestamp,
      chainId: BERACHAIN_ID,
    };
    context.DailyRfvSnapshot.set(snapshot);

    // Record activity
    const activityId = `${txHash}_${event.logIndex}`;
    context.TreasuryActivity.set({
      id: activityId,
      activityType: "rfv_updated",
      tokenId: undefined,
      user: undefined,
      amount: newRFV,
      timestamp,
      blockNumber: BigInt(event.block.number),
      transactionHash: txHash,
      chainId: BERACHAIN_ID,
    });

    recordAction(context, {
      actionType: "treasury_rfv_updated",
      actor: LIQUID_BACKING_ADDRESS,
      primaryCollection: LIQUID_BACKING_ADDRESS,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash,
      logIndex: event.logIndex,
      numeric1: newRFV,
    });
  }
);
