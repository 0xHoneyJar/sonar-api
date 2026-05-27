// ponder-runtime/src/handlers/mibera-liquid-backing/treasury.ts
//
// PORTED FROM: src/handlers/mibera-liquid-backing.ts (envio, source-of-truth)
// Handlers 5-8 of 9: treasury lifecycle.
//
// - BackingLoanExpired: a backing loan defaulted; collateral NFTs become
//   treasury-owned. We don't know which specific tokenIds without
//   contract-state queries, so we record the event + flip the loan status,
//   and TreasuryStats's count is left untouched (the per-item flip is
//   handled when ItemRedeemed/ItemLoanExpired fire downstream).
// - ItemLoanExpired: a single-NFT item loan defaulted. The itemId is the
//   loanId (per contract design — itemLoanDetails uses loanId as the key).
// - ItemPurchased: someone bought a treasury item — flip isTreasuryOwned
//   to false + record purchasePrice (which envio reads from current RFV).
// - ItemRedeemed: someone redeemed an NFT INTO the treasury — flip
//   isTreasuryOwned to true.

import { ponder } from "ponder:registry";
import {
  miberaLoan,
  treasuryItem,
  treasuryActivity,
} from "../../../ponder.schema";
import { recordAction } from "../../lib/record-action";
import { decodeTokenIds } from "./shared";
import {
  BERACHAIN_ID,
  LIQUID_BACKING_ADDRESS,
  getOrCreateStats,
  setStats,
  getOrCreateLoanStats,
  setLoanStats,
} from "./shared";

// ────────────────────────────────────────────────────────────────────────────
// 5. BackingLoanExpired (backing loan defaulted)
//    Event: BackingLoanExpired(uint256 loanId, uint256 newTotalBacking)
// ────────────────────────────────────────────────────────────────────────────
ponder.on("MiberaLiquidBacking:BackingLoanExpired", async ({ event, context }) => {
  const timestamp = event.block.timestamp;
  const blockNumber = event.block.number;
  const loanId = event.args.loanId;
  const newTotalBacking = event.args.newTotalBacking;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  const loanEntityId = `${BERACHAIN_ID}_backing_${loanId.toString()}`;
  const existingLoan = await context.db.find(miberaLoan, { id: loanEntityId });

  let loanUser: string | null = null;
  if (existingLoan) {
    loanUser = existingLoan.user;
    const tokenIds = decodeTokenIds(existingLoan.tokenIds);

    await context.db
      .update(miberaLoan, { id: loanEntityId })
      .set({
        status: "DEFAULTED",
        defaultedAt: timestamp,
      });

    const loanStats = await getOrCreateLoanStats(context);
    await setLoanStats(context, {
      ...loanStats,
      totalActiveLoans: Math.max(0, loanStats.totalActiveLoans - 1),
      totalLoansDefaulted: loanStats.totalLoansDefaulted + 1,
      totalNftsWithLoans: Math.max(0, loanStats.totalNftsWithLoans - tokenIds.length),
    });
  }

  // Record activity — we don't know specific tokenIds here for backing loans.
  const activityId = `${txHash}_${logIndex}`;
  await context.db
    .insert(treasuryActivity)
    .values({
      id: activityId,
      activityType: "backing_loan_defaulted",
      tokenId: null,
      user: loanUser as `0x${string}` | null,
      amount: newTotalBacking,
      timestamp,
      blockNumber,
      transactionHash: txHash as `0x${string}`,
      chainId: BERACHAIN_ID,
    })
    .onConflictDoNothing();

  // Stats: only update lastActivityAt (we don't know how many items entered).
  const stats = await getOrCreateStats(context);
  await setStats(context, {
    ...stats,
    lastActivityAt: timestamp,
  });

  await recordAction(context, {
    actionType: "treasury_backing_loan_expired",
    actor: LIQUID_BACKING_ADDRESS,
    primaryCollection: LIQUID_BACKING_ADDRESS,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash,
    logIndex,
    numeric1: loanId,
    numeric2: newTotalBacking,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. ItemLoanExpired (single-item loan defaulted)
//    Event: ItemLoanExpired(uint256 loanId, uint256 newTotalBacking)
// ────────────────────────────────────────────────────────────────────────────
ponder.on("MiberaLiquidBacking:ItemLoanExpired", async ({ event, context }) => {
  const timestamp = event.block.timestamp;
  const blockNumber = event.block.number;
  const loanId = event.args.loanId;
  const newTotalBacking = event.args.newTotalBacking;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  // Loan-side: flip status to DEFAULTED.
  const loanEntityId = `${BERACHAIN_ID}_item_${loanId.toString()}`;
  const existingLoan = await context.db.find(miberaLoan, { id: loanEntityId });

  if (existingLoan) {
    await context.db
      .update(miberaLoan, { id: loanEntityId })
      .set({
        status: "DEFAULTED",
        defaultedAt: timestamp,
      });

    const loanStats = await getOrCreateLoanStats(context);
    await setLoanStats(context, {
      ...loanStats,
      totalActiveLoans: Math.max(0, loanStats.totalActiveLoans - 1),
      totalLoansDefaulted: loanStats.totalLoansDefaulted + 1,
      totalNftsWithLoans: Math.max(0, loanStats.totalNftsWithLoans - 1),
    });
  }

  // Item-side: contract treats loanId as the itemId.
  const itemIdStr = loanId.toString();
  const existingItem = await context.db.find(treasuryItem, { id: itemIdStr });
  const wasAlreadyOwned = existingItem?.isTreasuryOwned === true;

  if (existingItem) {
    await context.db
      .update(treasuryItem, { id: itemIdStr })
      .set({
        isTreasuryOwned: true,
        acquiredAt: timestamp,
        acquiredVia: "item_loan_default",
        acquiredTxHash: txHash as `0x${string}`,
        purchasedAt: null,
        purchasedBy: null,
        purchasedTxHash: null,
        purchasePrice: null,
      });
  } else {
    await context.db
      .insert(treasuryItem)
      .values({
        id: itemIdStr,
        tokenId: loanId,
        isTreasuryOwned: true,
        acquiredAt: timestamp,
        acquiredVia: "item_loan_default",
        acquiredTxHash: txHash as `0x${string}`,
        purchasedAt: null,
        purchasedBy: null,
        purchasedTxHash: null,
        purchasePrice: null,
        chainId: BERACHAIN_ID,
      })
      .onConflictDoNothing();
  }

  // Stats
  const stats = await getOrCreateStats(context);
  await setStats(context, {
    ...stats,
    totalItemsOwned: stats.totalItemsOwned + (wasAlreadyOwned ? 0 : 1),
    totalItemsEverOwned: stats.totalItemsEverOwned + (wasAlreadyOwned ? 0 : 1),
    lastActivityAt: timestamp,
  });

  // Activity
  const activityId = `${txHash}_${logIndex}`;
  await context.db
    .insert(treasuryActivity)
    .values({
      id: activityId,
      activityType: "item_acquired",
      tokenId: loanId,
      user: null,
      amount: newTotalBacking,
      timestamp,
      blockNumber,
      transactionHash: txHash as `0x${string}`,
      chainId: BERACHAIN_ID,
    })
    .onConflictDoNothing();

  await recordAction(context, {
    actionType: "treasury_item_acquired",
    actor: LIQUID_BACKING_ADDRESS,
    primaryCollection: LIQUID_BACKING_ADDRESS,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash,
    logIndex,
    numeric1: loanId,
    context: { source: "item_loan_default" },
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. ItemPurchased (treasury item sold)
//    Event: ItemPurchased(uint256 itemId, uint256 newTotalBacking)
// ────────────────────────────────────────────────────────────────────────────
ponder.on("MiberaLiquidBacking:ItemPurchased", async ({ event, context }) => {
  const timestamp = event.block.timestamp;
  const blockNumber = event.block.number;
  const itemId = event.args.itemId;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;
  const buyer = (event.transaction.from ?? "").toLowerCase();

  const itemIdStr = itemId.toString();
  const existingItem = await context.db.find(treasuryItem, { id: itemIdStr });

  // Read current RFV to record purchasePrice.
  const stats = await getOrCreateStats(context);
  const rfvAtPurchase = stats.realFloorValue;

  if (existingItem) {
    await context.db
      .update(treasuryItem, { id: itemIdStr })
      .set({
        isTreasuryOwned: false,
        purchasedAt: timestamp,
        purchasedBy: buyer as `0x${string}`,
        purchasedTxHash: txHash as `0x${string}`,
        purchasePrice: rfvAtPurchase,
      });
  } else {
    // Item exists on-chain but wasn't indexed yet (historical case).
    await context.db
      .insert(treasuryItem)
      .values({
        id: itemIdStr,
        tokenId: itemId,
        isTreasuryOwned: false,
        acquiredAt: null,
        acquiredVia: null,
        acquiredTxHash: null,
        purchasedAt: timestamp,
        purchasedBy: buyer as `0x${string}`,
        purchasedTxHash: txHash as `0x${string}`,
        purchasePrice: rfvAtPurchase,
        chainId: BERACHAIN_ID,
      })
      .onConflictDoNothing();
  }

  // Stats
  const wasOwned = existingItem?.isTreasuryOwned === true;
  await setStats(context, {
    ...stats,
    totalItemsOwned: Math.max(0, stats.totalItemsOwned - (wasOwned ? 1 : 0)),
    totalItemsSold: stats.totalItemsSold + 1,
    lastActivityAt: timestamp,
  });

  // Activity
  const activityId = `${txHash}_${logIndex}`;
  await context.db
    .insert(treasuryActivity)
    .values({
      id: activityId,
      activityType: "item_purchased",
      tokenId: itemId,
      user: buyer as `0x${string}`,
      amount: rfvAtPurchase,
      timestamp,
      blockNumber,
      transactionHash: txHash as `0x${string}`,
      chainId: BERACHAIN_ID,
    })
    .onConflictDoNothing();

  await recordAction(context, {
    actionType: "treasury_purchase",
    actor: buyer || LIQUID_BACKING_ADDRESS,
    primaryCollection: LIQUID_BACKING_ADDRESS,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash,
    logIndex,
    numeric1: itemId,
    numeric2: rfvAtPurchase,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 8. ItemRedeemed (NFT deposited into the treasury)
//    Event: ItemRedeemed(uint256 itemId, uint256 newTotalBacking)
// ────────────────────────────────────────────────────────────────────────────
ponder.on("MiberaLiquidBacking:ItemRedeemed", async ({ event, context }) => {
  const timestamp = event.block.timestamp;
  const blockNumber = event.block.number;
  const itemId = event.args.itemId;
  const newTotalBacking = event.args.newTotalBacking;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;
  const depositor = (event.transaction.from ?? "").toLowerCase();

  const itemIdStr = itemId.toString();
  const existingItem = await context.db.find(treasuryItem, { id: itemIdStr });
  const wasAlreadyOwned = existingItem?.isTreasuryOwned === true;

  if (existingItem) {
    await context.db
      .update(treasuryItem, { id: itemIdStr })
      .set({
        isTreasuryOwned: true,
        acquiredAt: timestamp,
        acquiredVia: "redemption",
        acquiredTxHash: txHash as `0x${string}`,
        // Clear purchase fields — item is being re-acquired.
        purchasedAt: null,
        purchasedBy: null,
        purchasedTxHash: null,
        purchasePrice: null,
      });
  } else {
    await context.db
      .insert(treasuryItem)
      .values({
        id: itemIdStr,
        tokenId: itemId,
        isTreasuryOwned: true,
        acquiredAt: timestamp,
        acquiredVia: "redemption",
        acquiredTxHash: txHash as `0x${string}`,
        purchasedAt: null,
        purchasedBy: null,
        purchasedTxHash: null,
        purchasePrice: null,
        chainId: BERACHAIN_ID,
      })
      .onConflictDoNothing();
  }

  // Stats
  const stats = await getOrCreateStats(context);
  await setStats(context, {
    ...stats,
    totalItemsOwned: stats.totalItemsOwned + (wasAlreadyOwned ? 0 : 1),
    totalItemsEverOwned: stats.totalItemsEverOwned + (wasAlreadyOwned ? 0 : 1),
    lastActivityAt: timestamp,
  });

  // Activity
  const activityId = `${txHash}_${logIndex}`;
  await context.db
    .insert(treasuryActivity)
    .values({
      id: activityId,
      activityType: "item_acquired",
      tokenId: itemId,
      user: depositor as `0x${string}`,
      amount: newTotalBacking,
      timestamp,
      blockNumber,
      transactionHash: txHash as `0x${string}`,
      chainId: BERACHAIN_ID,
    })
    .onConflictDoNothing();

  await recordAction(context, {
    actionType: "treasury_item_redeemed",
    actor: depositor || LIQUID_BACKING_ADDRESS,
    primaryCollection: LIQUID_BACKING_ADDRESS,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash,
    logIndex,
    numeric1: itemId,
    numeric2: newTotalBacking,
  });
});
