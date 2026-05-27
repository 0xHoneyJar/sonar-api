// ponder-runtime/src/handlers/mibera-premint.ts
//
// PORTED FROM: src/handlers/mibera-premint.ts (envio, source-of-truth)
// Contract: MiberaPremint (Berachain — config flagged as gap, see below)
//
// SKELETON / NOT REGISTERED:
// A-1's ponder.config.mibera.ts does NOT include MiberaPremint contract. This
// handler's logic is faithfully ported from envio so when B-1 green belt adds
// the contract, the single `ponder.on` line at the bottom of this file
// activates it. Until then, the file compiles + types check but no events
// route to it.
//
// Per A-2 instructions: "If any of the 12 handlers has logic you don't
// understand, document the gap and skip it cleanly". This is the "config
// gap" variant — logic understood + ported, registration gated on B-1.

import { ponder } from "ponder:registry";
import {
  premintParticipation,
  premintRefund,
  premintUser,
  premintPhaseStats,
  action,
} from "../../ponder.schema";

const COLLECTION_KEY = "mibera_premint";

export async function handleParticipated({ event, context }: any) {
  try {
    const { phase, user, amount } = event.args;
    if (amount === 0n) return;

    const userAddress = user.toLowerCase();
    const timestamp = event.block.timestamp;
    const chainId = context.chain.id;
    const id = `${event.transaction.hash}_${event.log.logIndex}`;

    await context.db
      .insert(premintParticipation)
      .values({
        id,
        phase,
        user: userAddress as `0x${string}`,
        amount,
        timestamp,
        blockNumber: event.block.number,
        transactionHash: event.transaction.hash as `0x${string}`,
        chainId,
      })
      .onConflictDoNothing();

    // User aggregate stats — null-safe BigInt math (floor at 0n for netContribution)
    const userId = `${userAddress}_${chainId}`;
    const existingUser = await context.db.find(premintUser, { id: userId });

    const totalContributed = (existingUser?.totalContributed ?? 0n) + amount;
    const totalRefunded = existingUser?.totalRefunded ?? 0n;
    const netContribution = totalContributed > totalRefunded
      ? totalContributed - totalRefunded
      : 0n;

    if (existingUser) {
      await context.db.update(premintUser, { id: userId }).set({
        totalContributed,
        totalRefunded,
        netContribution,
        participationCount: existingUser.participationCount + 1,
        lastActivityTime: timestamp,
      });
    } else {
      await context.db
        .insert(premintUser)
        .values({
          id: userId,
          user: userAddress as `0x${string}`,
          totalContributed,
          totalRefunded,
          netContribution,
          participationCount: 1,
          refundCount: 0,
          firstParticipationTime: timestamp,
          lastActivityTime: timestamp,
          chainId,
        })
        .onConflictDoNothing();
    }

    // Phase stats
    const phaseId = `${phase}_${chainId}`;
    const existingPhase = await context.db.find(premintPhaseStats, { id: phaseId });
    const isNewParticipant = !existingUser;

    const phaseTotalContributed = (existingPhase?.totalContributed ?? 0n) + amount;
    const phaseTotalRefunded = existingPhase?.totalRefunded ?? 0n;
    const phaseNetContribution = phaseTotalContributed > phaseTotalRefunded
      ? phaseTotalContributed - phaseTotalRefunded
      : 0n;

    if (existingPhase) {
      await context.db.update(premintPhaseStats, { id: phaseId }).set({
        totalContributed: phaseTotalContributed,
        totalRefunded: phaseTotalRefunded,
        netContribution: phaseNetContribution,
        uniqueParticipants: existingPhase.uniqueParticipants + (isNewParticipant ? 1 : 0),
        participationCount: existingPhase.participationCount + 1,
      });
    } else {
      await context.db
        .insert(premintPhaseStats)
        .values({
          id: phaseId,
          phase,
          totalContributed: phaseTotalContributed,
          totalRefunded: phaseTotalRefunded,
          netContribution: phaseNetContribution,
          uniqueParticipants: 1,
          participationCount: 1,
          refundCount: 0,
          chainId,
        })
        .onConflictDoNothing();
    }

    await context.db
      .insert(action)
      .values({
        id,
        actionType: "premint_participate",
        actor: userAddress as `0x${string}`,
        primaryCollection: COLLECTION_KEY,
        timestamp,
        chainId,
        txHash: event.transaction.hash as `0x${string}`,
        numeric1: amount,
        numeric2: phase,
        context: JSON.stringify({
          phase: phase.toString(),
          contract: event.log.address.toLowerCase(),
        }),
      })
      .onConflictDoNothing();
  } catch (error) {
    console.error(`[MiberaPremint] Participated handler failed: ${error}`);
  }
}

export async function handleRefunded({ event, context }: any) {
  try {
    const { phase, user, amount } = event.args;
    if (amount === 0n) return;

    const userAddress = user.toLowerCase();
    const timestamp = event.block.timestamp;
    const chainId = context.chain.id;
    const id = `${event.transaction.hash}_${event.log.logIndex}`;

    await context.db
      .insert(premintRefund)
      .values({
        id,
        phase,
        user: userAddress as `0x${string}`,
        amount,
        timestamp,
        blockNumber: event.block.number,
        transactionHash: event.transaction.hash as `0x${string}`,
        chainId,
      })
      .onConflictDoNothing();

    const userId = `${userAddress}_${chainId}`;
    const existingUser = await context.db.find(premintUser, { id: userId });

    const totalContributed = existingUser?.totalContributed ?? 0n;
    const totalRefunded = (existingUser?.totalRefunded ?? 0n) + amount;
    const netContribution = totalContributed > totalRefunded
      ? totalContributed - totalRefunded
      : 0n;

    if (existingUser) {
      await context.db.update(premintUser, { id: userId }).set({
        totalContributed,
        totalRefunded,
        netContribution,
        refundCount: existingUser.refundCount + 1,
        lastActivityTime: timestamp,
      });
    } else {
      await context.db
        .insert(premintUser)
        .values({
          id: userId,
          user: userAddress as `0x${string}`,
          totalContributed,
          totalRefunded,
          netContribution,
          participationCount: 0,
          refundCount: 1,
          firstParticipationTime: null,
          lastActivityTime: timestamp,
          chainId,
        })
        .onConflictDoNothing();
    }

    const phaseId = `${phase}_${chainId}`;
    const existingPhase = await context.db.find(premintPhaseStats, { id: phaseId });

    const phaseTotalContributed = existingPhase?.totalContributed ?? 0n;
    const phaseTotalRefunded = (existingPhase?.totalRefunded ?? 0n) + amount;
    const phaseNetContribution = phaseTotalContributed > phaseTotalRefunded
      ? phaseTotalContributed - phaseTotalRefunded
      : 0n;

    if (existingPhase) {
      await context.db.update(premintPhaseStats, { id: phaseId }).set({
        totalContributed: phaseTotalContributed,
        totalRefunded: phaseTotalRefunded,
        netContribution: phaseNetContribution,
        refundCount: existingPhase.refundCount + 1,
      });
    } else {
      await context.db
        .insert(premintPhaseStats)
        .values({
          id: phaseId,
          phase,
          totalContributed: phaseTotalContributed,
          totalRefunded: phaseTotalRefunded,
          netContribution: phaseNetContribution,
          uniqueParticipants: 0,
          participationCount: 0,
          refundCount: 1,
          chainId,
        })
        .onConflictDoNothing();
    }

    await context.db
      .insert(action)
      .values({
        id,
        actionType: "premint_refund",
        actor: userAddress as `0x${string}`,
        primaryCollection: COLLECTION_KEY,
        timestamp,
        chainId,
        txHash: event.transaction.hash as `0x${string}`,
        numeric1: amount,
        numeric2: phase,
        context: JSON.stringify({
          phase: phase.toString(),
          contract: event.log.address.toLowerCase(),
        }),
      })
      .onConflictDoNothing();
  } catch (error) {
    console.error(`[MiberaPremint] Refunded handler failed: ${error}`);
  }
}

// F-3 re-dispatch: ACTIVE. Contract registered in ponder.config.mibera.ts.
ponder.on("MiberaPremint:Participated", handleParticipated);
ponder.on("MiberaPremint:Refunded",     handleRefunded);
