// ponder-runtime/src/handlers/mibera-liquid-backing/loans.ts
//
// PORTED FROM: src/handlers/mibera-liquid-backing.ts (envio, source-of-truth)
// Handlers 1-4 of 9: loan lifecycle (received / payed-back / item-loaned /
// item-sent-back).
//
// Backing loan = user pledges collateral NFTs for a $ loan amount.
// Item loan    = user takes a single NFT from treasury on credit.
//
// Identifiers:
//   - backing loan id = `${chainId}_backing_${onchainLoanId}`
//   - item loan id    = `${chainId}_item_${onchainLoanId}`
// These two namespaces never collide because loanType is part of the id.

import { ponder } from "ponder:registry";
import { miberaLoan } from "../../../ponder.schema";
import { recordAction } from "../../lib/record-action";
import {
  BERACHAIN_ID,
  LIQUID_BACKING_ADDRESS,
  encodeTokenIds,
  decodeTokenIds,
  getOrCreateLoanStats,
  setLoanStats,
} from "./shared";

// ────────────────────────────────────────────────────────────────────────────
// 1. LoanReceived (backing loan created)
//    Event: LoanReceived(uint256 loanId, uint256[] ids, uint256 amount, uint256 expiry)
// ────────────────────────────────────────────────────────────────────────────
ponder.on("MiberaLiquidBacking:LoanReceived", async ({ event, context }) => {
  const timestamp = event.block.timestamp;
  const loanId = event.args.loanId;
  const tokenIds = event.args.ids;
  const amount = event.args.amount;
  const expiry = event.args.expiry;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;
  const user = (event.transaction.from ?? "").toLowerCase();

  const loanEntityId = `${BERACHAIN_ID}_backing_${loanId.toString()}`;

  await context.db
    .insert(miberaLoan)
    .values({
      id: loanEntityId,
      loanId,
      loanType: "backing",
      user: user as `0x${string}`,
      tokenIds: encodeTokenIds(tokenIds),
      amount,
      expiry,
      status: "ACTIVE",
      createdAt: timestamp,
      repaidAt: null,
      defaultedAt: null,
      transactionHash: txHash as `0x${string}`,
      chainId: BERACHAIN_ID,
    })
    .onConflictDoNothing();

  // Update loan stats
  const loanStats = await getOrCreateLoanStats(context);
  await setLoanStats(context, {
    ...loanStats,
    totalActiveLoans: loanStats.totalActiveLoans + 1,
    totalLoansCreated: loanStats.totalLoansCreated + 1,
    totalAmountLoaned: loanStats.totalAmountLoaned + amount,
    totalNftsWithLoans: loanStats.totalNftsWithLoans + tokenIds.length,
  });

  // Action record
  await recordAction(context, {
    actionType: "loan_received",
    actor: user,
    primaryCollection: LIQUID_BACKING_ADDRESS,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash,
    logIndex,
    numeric1: loanId,
    numeric2: amount,
    context: {
      tokenIds: tokenIds.map((id) => id.toString()),
      expiry: expiry.toString(),
    },
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. BackingLoanPayedBack (backing loan repaid)
//    Event: BackingLoanPayedBack(uint256 loanId, uint256 newTotalBacking)
// ────────────────────────────────────────────────────────────────────────────
ponder.on("MiberaLiquidBacking:BackingLoanPayedBack", async ({ event, context }) => {
  const timestamp = event.block.timestamp;
  const loanId = event.args.loanId;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  const loanEntityId = `${BERACHAIN_ID}_backing_${loanId.toString()}`;
  const existingLoan = await context.db.find(miberaLoan, { id: loanEntityId });

  let actor: string = LIQUID_BACKING_ADDRESS;
  if (existingLoan) {
    actor = existingLoan.user;
    const tokenIds = decodeTokenIds(existingLoan.tokenIds);

    await context.db
      .update(miberaLoan, { id: loanEntityId })
      .set({
        status: "REPAID",
        repaidAt: timestamp,
      });

    const loanStats = await getOrCreateLoanStats(context);
    await setLoanStats(context, {
      ...loanStats,
      totalActiveLoans: Math.max(0, loanStats.totalActiveLoans - 1),
      totalLoansRepaid: loanStats.totalLoansRepaid + 1,
      totalNftsWithLoans: Math.max(0, loanStats.totalNftsWithLoans - tokenIds.length),
    });
  }

  await recordAction(context, {
    actionType: "loan_repaid",
    actor,
    primaryCollection: LIQUID_BACKING_ADDRESS,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash,
    logIndex,
    numeric1: loanId,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. ItemLoaned (single-NFT item loan created)
//    Event: ItemLoaned(uint256 loanId, uint256 itemId, uint256 expiry)
// ────────────────────────────────────────────────────────────────────────────
ponder.on("MiberaLiquidBacking:ItemLoaned", async ({ event, context }) => {
  const timestamp = event.block.timestamp;
  const loanId = event.args.loanId;
  const itemId = event.args.itemId;
  const expiry = event.args.expiry;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;
  const user = (event.transaction.from ?? "").toLowerCase();

  const loanEntityId = `${BERACHAIN_ID}_item_${loanId.toString()}`;

  await context.db
    .insert(miberaLoan)
    .values({
      id: loanEntityId,
      loanId,
      loanType: "item",
      user: user as `0x${string}`,
      tokenIds: encodeTokenIds([itemId]),
      amount: 0n, // Item loans don't carry a $ amount
      expiry,
      status: "ACTIVE",
      createdAt: timestamp,
      repaidAt: null,
      defaultedAt: null,
      transactionHash: txHash as `0x${string}`,
      chainId: BERACHAIN_ID,
    })
    .onConflictDoNothing();

  const loanStats = await getOrCreateLoanStats(context);
  await setLoanStats(context, {
    ...loanStats,
    totalActiveLoans: loanStats.totalActiveLoans + 1,
    totalLoansCreated: loanStats.totalLoansCreated + 1,
    totalNftsWithLoans: loanStats.totalNftsWithLoans + 1,
  });

  await recordAction(context, {
    actionType: "item_loaned",
    actor: user,
    primaryCollection: LIQUID_BACKING_ADDRESS,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash,
    logIndex,
    numeric1: loanId,
    numeric2: itemId,
    context: { expiry: expiry.toString() },
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. LoanItemSentBack (item loan returned)
//    Event: LoanItemSentBack(uint256 loanId, uint256 newTotalBacking)
// ────────────────────────────────────────────────────────────────────────────
ponder.on("MiberaLiquidBacking:LoanItemSentBack", async ({ event, context }) => {
  const timestamp = event.block.timestamp;
  const loanId = event.args.loanId;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  const loanEntityId = `${BERACHAIN_ID}_item_${loanId.toString()}`;
  const existingLoan = await context.db.find(miberaLoan, { id: loanEntityId });

  let actor: string = LIQUID_BACKING_ADDRESS;
  if (existingLoan) {
    actor = existingLoan.user;

    await context.db
      .update(miberaLoan, { id: loanEntityId })
      .set({
        status: "REPAID",
        repaidAt: timestamp,
      });

    const loanStats = await getOrCreateLoanStats(context);
    await setLoanStats(context, {
      ...loanStats,
      totalActiveLoans: Math.max(0, loanStats.totalActiveLoans - 1),
      totalLoansRepaid: loanStats.totalLoansRepaid + 1,
      totalNftsWithLoans: Math.max(0, loanStats.totalNftsWithLoans - 1),
    });
  }

  await recordAction(context, {
    actionType: "item_loan_returned",
    actor,
    primaryCollection: LIQUID_BACKING_ADDRESS,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash,
    logIndex,
    numeric1: loanId,
  });
});
