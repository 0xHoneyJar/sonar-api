/*
 * Mibera Premint tracking handlers.
 *
 * Tracks participation and refund events from the Mibera premint contract.
 * Records individual events plus aggregates user and phase-level statistics.
 */

import { indexer } from "envio";
import type { PremintParticipation, PremintRefund, PremintUser, PremintPhaseStats } from "envio";

import { recordAction } from "../lib/actions";

const COLLECTION_KEY = "mibera_premint";

/**
 * Handle Participated events - user contributed to premint
 */
indexer.onEvent({ contract: "MiberaPremint", event: "Participated" },
  async ({ event, context }) => {
    try {
      const { phase, user, amount } = event.params;

      if (amount === 0n) {
        return; // skip zero-amount participations
      }

      const userAddress = user.toLowerCase();
      const timestamp = BigInt(event.block.timestamp);
      const chainId = event.chainId;
      const id = `${event.transaction.hash}_${event.logIndex}`;

      // Record individual participation event
      const participation: PremintParticipation = {
        id,
        phase,
        user: userAddress,
        amount,
        timestamp,
        blockNumber: BigInt(event.block.number),
        transactionHash: event.transaction.hash,
        chainId,
      };

      context.PremintParticipation.set(participation);

      // Update user aggregate stats
      const userId = `${userAddress}_${chainId}`;
      const existingUser = await context.PremintUser.get(userId);

      // Use safe BigInt arithmetic with floor at 0n for netContribution
      const totalContributed = (existingUser?.totalContributed ?? 0n) + amount;
      const totalRefunded = existingUser?.totalRefunded ?? 0n;
      const netContribution = totalContributed > totalRefunded
        ? totalContributed - totalRefunded
        : 0n;

      const premintUser: PremintUser = {
        id: userId,
        user: userAddress,
        totalContributed,
        totalRefunded,
        netContribution,
        participationCount: (existingUser?.participationCount ?? 0) + 1,
        refundCount: existingUser?.refundCount ?? 0,
        firstParticipationTime:
          existingUser?.firstParticipationTime ?? timestamp,
        lastActivityTime: timestamp,
        chainId,
      };

      context.PremintUser.set(premintUser);

      // Update phase stats
      const phaseId = `${phase}_${chainId}`;
      const existingPhase = await context.PremintPhaseStats.get(phaseId);
      const isNewParticipant = !existingUser;

      // Use safe BigInt arithmetic for phase stats
      const phaseTotalContributed = (existingPhase?.totalContributed ?? 0n) + amount;
      const phaseTotalRefunded = existingPhase?.totalRefunded ?? 0n;
      const phaseNetContribution = phaseTotalContributed > phaseTotalRefunded
        ? phaseTotalContributed - phaseTotalRefunded
        : 0n;

      const phaseStats: PremintPhaseStats = {
        id: phaseId,
        phase,
        totalContributed: phaseTotalContributed,
        totalRefunded: phaseTotalRefunded,
        netContribution: phaseNetContribution,
        uniqueParticipants:
          (existingPhase?.uniqueParticipants ?? 0) + (isNewParticipant ? 1 : 0),
        participationCount: (existingPhase?.participationCount ?? 0) + 1,
        refundCount: existingPhase?.refundCount ?? 0,
        chainId,
      };

      context.PremintPhaseStats.set(phaseStats);

      // Record action for activity feed/missions
      recordAction(context, {
        id,
        actionType: "premint_participate",
        actor: userAddress,
        primaryCollection: COLLECTION_KEY,
        timestamp,
        chainId,
        txHash: event.transaction.hash,
        logIndex: event.logIndex,
        numeric1: amount,
        numeric2: phase,
        context: {
          phase: phase.toString(),
          contract: event.srcAddress.toLowerCase(),
        },
      });
    } catch (error) {
      context.log.error(
        `[MiberaPremint] Participated handler failed for tx ${event.transaction.hash}: ${error}`
      );
    }
  }
);

/**
 * Handle Refunded events - user received refund from premint
 */
indexer.onEvent({ contract: "MiberaPremint", event: "Refunded" },
  async ({ event, context }) => {
    try {
      const { phase, user, amount } = event.params;

      if (amount === 0n) {
        return; // skip zero-amount refunds
      }

      const userAddress = user.toLowerCase();
      const timestamp = BigInt(event.block.timestamp);
      const chainId = event.chainId;
      const id = `${event.transaction.hash}_${event.logIndex}`;

      // Record individual refund event
      const refund: PremintRefund = {
        id,
        phase,
        user: userAddress,
        amount,
        timestamp,
        blockNumber: BigInt(event.block.number),
        transactionHash: event.transaction.hash,
        chainId,
      };

      context.PremintRefund.set(refund);

      // Update user aggregate stats
      const userId = `${userAddress}_${chainId}`;
      const existingUser = await context.PremintUser.get(userId);

      // Use safe BigInt arithmetic with floor at 0n for netContribution
      const totalContributed = existingUser?.totalContributed ?? 0n;
      const totalRefunded = (existingUser?.totalRefunded ?? 0n) + amount;
      const netContribution = totalContributed > totalRefunded
        ? totalContributed - totalRefunded
        : 0n;

      const premintUser: PremintUser = {
        id: userId,
        user: userAddress,
        totalContributed,
        totalRefunded,
        netContribution,
        participationCount: existingUser?.participationCount ?? 0,
        refundCount: (existingUser?.refundCount ?? 0) + 1,
        firstParticipationTime: existingUser?.firstParticipationTime ?? undefined,
        lastActivityTime: timestamp,
        chainId,
      };

      context.PremintUser.set(premintUser);

      // Update phase stats
      const phaseId = `${phase}_${chainId}`;
      const existingPhase = await context.PremintPhaseStats.get(phaseId);

      // Use safe BigInt arithmetic for phase stats
      const phaseTotalContributed = existingPhase?.totalContributed ?? 0n;
      const phaseTotalRefunded = (existingPhase?.totalRefunded ?? 0n) + amount;
      const phaseNetContribution = phaseTotalContributed > phaseTotalRefunded
        ? phaseTotalContributed - phaseTotalRefunded
        : 0n;

      const phaseStats: PremintPhaseStats = {
        id: phaseId,
        phase,
        totalContributed: phaseTotalContributed,
        totalRefunded: phaseTotalRefunded,
        netContribution: phaseNetContribution,
        uniqueParticipants: existingPhase?.uniqueParticipants ?? 0,
        participationCount: existingPhase?.participationCount ?? 0,
        refundCount: (existingPhase?.refundCount ?? 0) + 1,
        chainId,
      };

      context.PremintPhaseStats.set(phaseStats);

      // Record action for activity feed/missions
      recordAction(context, {
        id,
        actionType: "premint_refund",
        actor: userAddress,
        primaryCollection: COLLECTION_KEY,
        timestamp,
        chainId,
        txHash: event.transaction.hash,
        logIndex: event.logIndex,
        numeric1: amount,
        numeric2: phase,
        context: {
          phase: phase.toString(),
          contract: event.srcAddress.toLowerCase(),
        },
      });
    } catch (error) {
      context.log.error(
        `[MiberaPremint] Refunded handler failed for tx ${event.transaction.hash}: ${error}`
      );
    }
  }
);
