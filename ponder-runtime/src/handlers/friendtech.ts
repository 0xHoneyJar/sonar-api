// ponder-runtime/src/handlers/friendtech.ts
//
// PORTED FROM: src/handlers/friendtech.ts (envio, source-of-truth)
// Contract: FriendtechShares (Base 8453, 0xCF205808...d4d4)
//
// Tracks Trade events for Mibera-related subjects only.
// No NATS publish (envio doesn't publish friendtech to NATS — secondary trade
// data, not first-class mint events). Pure entity-write handler.

import { ponder } from "ponder:registry";
import {
  friendtechTrade,
  friendtechHolder,
  friendtechSubjectStats,
  action,
} from "../../ponder.schema";

// Mibera-related subject addresses + their canonical keys. PORTED VERBATIM
// FROM: src/handlers/friendtech/constants.ts.
const MIBERA_SUBJECTS: Record<string, string> = {
  "0x1defc6b7320f9480f3b2d77e396a942f2803559d": "jani_key",
  "0x956d9b56b20c28993b9baaed1465376ce996e3ed": "charlotte_fang_key",
};

const COLLECTION_KEY = "friendtech";

ponder.on("FriendtechShares:Trade", async ({ event, context }) => {
  const { trader, subject, isBuy, shareAmount, ethAmount, supply } = event.args;

  const subjectLower = subject.toLowerCase();
  const subjectKey = MIBERA_SUBJECTS[subjectLower];

  // Only track Mibera-related subjects — early return matches envio.
  if (!subjectKey) return;

  const traderLower = trader.toLowerCase();
  const timestamp = event.block.timestamp;
  const chainId = context.chain.id;
  const tradeId = `${event.transaction.hash}_${event.log.logIndex}`;
  const shareAmountBigInt = BigInt(shareAmount.toString());
  const ethAmountBigInt = BigInt(ethAmount.toString());
  const supplyBigInt = BigInt(supply.toString());

  // Trade event record
  await context.db
    .insert(friendtechTrade)
    .values({
      id: tradeId,
      trader: traderLower as `0x${string}`,
      subject: subjectLower as `0x${string}`,
      subjectKey,
      isBuy,
      shareAmount: shareAmountBigInt,
      ethAmount: ethAmountBigInt,
      supply: supplyBigInt,
      timestamp,
      blockNumber: event.block.number,
      transactionHash: event.transaction.hash as `0x${string}`,
      chainId,
    })
    .onConflictDoNothing();

  // Holder balance (with null-safe access — mirrors envio)
  const holderId = `${subjectLower}_${traderLower}_${chainId}`;
  const existingHolder = await context.db.find(friendtechHolder, { id: holderId });
  const shareAmountInt = Number(shareAmountBigInt);

  const balanceDelta = isBuy ? shareAmountInt : -shareAmountInt;
  const currentBalance = existingHolder?.balance ?? 0;
  const newBalance = Math.max(0, currentBalance + balanceDelta);

  if (existingHolder) {
    await context.db.update(friendtechHolder, { id: holderId }).set({
      balance: newBalance,
      totalBought: existingHolder.totalBought + (isBuy ? shareAmountInt : 0),
      totalSold: existingHolder.totalSold + (isBuy ? 0 : shareAmountInt),
      lastTradeTime: timestamp,
    });
  } else {
    await context.db
      .insert(friendtechHolder)
      .values({
        id: holderId,
        subject: subjectLower as `0x${string}`,
        subjectKey,
        holder: traderLower as `0x${string}`,
        balance: newBalance,
        totalBought: isBuy ? shareAmountInt : 0,
        totalSold: isBuy ? 0 : shareAmountInt,
        firstTradeTime: timestamp,
        lastTradeTime: timestamp,
        chainId,
      })
      .onConflictDoNothing();
  }

  // Subject stats — mirrors envio's unique-holders approximation
  const statsId = `${subjectLower}_${chainId}`;
  const existingStats = await context.db.find(friendtechSubjectStats, { id: statsId });

  let uniqueHoldersDelta = 0;
  if (isBuy && !existingHolder) {
    uniqueHoldersDelta = 1;
  } else if (!isBuy && existingHolder && currentBalance > 0 && newBalance <= 0) {
    uniqueHoldersDelta = -1;
  }

  if (existingStats) {
    await context.db.update(friendtechSubjectStats, { id: statsId }).set({
      totalSupply: supplyBigInt,
      uniqueHolders: Math.max(0, existingStats.uniqueHolders + uniqueHoldersDelta),
      totalTrades: existingStats.totalTrades + 1,
      totalBuys: existingStats.totalBuys + (isBuy ? 1 : 0),
      totalSells: existingStats.totalSells + (isBuy ? 0 : 1),
      totalVolumeEth: existingStats.totalVolumeEth + ethAmountBigInt,
      lastTradeTime: timestamp,
    });
  } else {
    await context.db
      .insert(friendtechSubjectStats)
      .values({
        id: statsId,
        subject: subjectLower as `0x${string}`,
        subjectKey,
        totalSupply: supplyBigInt,
        uniqueHolders: Math.max(0, uniqueHoldersDelta),
        totalTrades: 1,
        totalBuys: isBuy ? 1 : 0,
        totalSells: isBuy ? 0 : 1,
        totalVolumeEth: ethAmountBigInt,
        lastTradeTime: timestamp,
        chainId,
      })
      .onConflictDoNothing();
  }

  // Action record for activity feed/missions
  await context.db
    .insert(action)
    .values({
      id: tradeId,
      actionType: isBuy ? "friendtech_buy" : "friendtech_sell",
      actor: traderLower as `0x${string}`,
      primaryCollection: COLLECTION_KEY,
      timestamp,
      chainId,
      txHash: event.transaction.hash as `0x${string}`,
      numeric1: shareAmountBigInt,
      numeric2: ethAmountBigInt,
      context: JSON.stringify({
        subject: subjectLower,
        subjectKey,
        supply: supplyBigInt.toString(),
        newBalance,
      }),
    })
    .onConflictDoNothing();
});
