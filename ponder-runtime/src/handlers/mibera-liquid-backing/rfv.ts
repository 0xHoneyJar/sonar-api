// ponder-runtime/src/handlers/mibera-liquid-backing/rfv.ts
//
// PORTED FROM: src/handlers/mibera-liquid-backing.ts (envio, source-of-truth)
// Handler 9 of 9: RFVChanged.
//
// RFV ("Real Floor Value") is the treasury's per-NFT backing value. The
// contract emits RFVChanged on every meaningful treasury event. We store
// the current RFV on TreasuryStats AND a per-day snapshot on
// DailyRfvSnapshot for chart-history.
//
// "One snapshot per day" semantics — last write wins for the day. envio
// achieved this via context.DailyRfvSnapshot.set(). Ponder achieves it via
// insert(...).onConflictDoUpdate(...): the snapshot id is `${chainId}_${day}`
// so subsequent same-day fires overwrite.

import { ponder } from "ponder:registry";
import {
  dailyRfvSnapshot,
  treasuryActivity,
} from "../../../ponder.schema";
import { recordAction } from "../../lib/record-action";
import {
  BERACHAIN_ID,
  LIQUID_BACKING_ADDRESS,
  getDayFromTimestamp,
  getOrCreateStats,
  setStats,
} from "./shared";

ponder.on("MiberaLiquidBacking:RFVChanged", async ({ event, context }) => {
  const timestamp = event.block.timestamp;
  const blockNumber = event.block.number;
  const newRFV = event.args.newRFV;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  // Update stats with new RFV
  const stats = await getOrCreateStats(context);
  await setStats(context, {
    ...stats,
    realFloorValue: newRFV,
    lastRfvUpdate: timestamp,
    lastActivityAt: timestamp,
  });

  // Daily snapshot (one row per day; last RFV of the day wins)
  const day = getDayFromTimestamp(timestamp);
  const snapshotId = `${BERACHAIN_ID}_${day}`;
  await context.db
    .insert(dailyRfvSnapshot)
    .values({
      id: snapshotId,
      day,
      rfv: newRFV,
      timestamp,
      chainId: BERACHAIN_ID,
    })
    .onConflictDoUpdate(() => ({
      rfv: newRFV,
      timestamp,
    }));

  // Activity
  const activityId = `${txHash}_${logIndex}`;
  await context.db
    .insert(treasuryActivity)
    .values({
      id: activityId,
      activityType: "rfv_updated",
      tokenId: null,
      user: null,
      amount: newRFV,
      timestamp,
      blockNumber,
      transactionHash: txHash as `0x${string}`,
      chainId: BERACHAIN_ID,
    })
    .onConflictDoNothing();

  await recordAction(context, {
    actionType: "treasury_rfv_updated",
    actor: LIQUID_BACKING_ADDRESS,
    primaryCollection: LIQUID_BACKING_ADDRESS,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash,
    logIndex,
    numeric1: newRFV,
  });
});
