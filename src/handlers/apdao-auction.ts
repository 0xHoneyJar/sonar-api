/*
 * APDAO Auction House Event Handlers
 * Handles auction lifecycle: creation, bidding, extension, settlement, and queue management
 */

import {
  indexer,
  type ApdaoAuction,
  type ApdaoBid,
  type ApdaoQueuedToken,
  type ApdaoAuctionStats,
} from "envio";

const CHAIN_ID = 80094;

/**
 * Get or initialize global auction stats
 */
async function getOrCreateStats(context: any): Promise<ApdaoAuctionStats> {
  const statsId = `${CHAIN_ID}_global`;
  let stats = await context.ApdaoAuctionStats.get(statsId);
  if (!stats) {
    stats = {
      id: statsId,
      totalAuctions: 0,
      totalSettled: 0,
      totalBids: 0,
      totalVolume: BigInt(0),
      lastAuctionTime: undefined,
      lastSettledTime: undefined,
      chainId: CHAIN_ID,
    };
  }
  return stats;
}

/**
 * AuctionCreated — New auction starts for a seat token
 */
indexer.onEvent(
  { contract: "ApdaoAuctionHouse", event: "AuctionCreated" },
  async ({ event, context }) => {
    try {
      const { apdaoId, startTime, endTime } = event.params;
      const timestamp = BigInt(event.block.timestamp);

      const auctionId = `${CHAIN_ID}_${apdaoId}`;
      const auction: ApdaoAuction = {
        id: auctionId,
        apdaoId: BigInt(apdaoId.toString()),
        startTime: BigInt(startTime.toString()),
        endTime: BigInt(endTime.toString()),
        winner: undefined,
        amount: undefined,
        settled: false,
        bidCount: 0,
        createdAt: timestamp,
        settledAt: undefined,
        transactionHash: event.transaction.hash,
        chainId: CHAIN_ID,
      };

      context.ApdaoAuction.set(auction);

      // Update stats
      const stats = await getOrCreateStats(context);
      context.ApdaoAuctionStats.set({
        ...stats,
        totalAuctions: stats.totalAuctions + 1,
        lastAuctionTime: timestamp,
      });
    } catch (error) {
      context.log.error(
        `[ApdaoAuction] AuctionCreated handler failed for tx ${event.transaction.hash}: ${error}`
      );
    }
  }
);

/**
 * AuctionBid — Someone bids on an active auction
 */
indexer.onEvent(
  { contract: "ApdaoAuctionHouse", event: "AuctionBid" },
  async ({ event, context }) => {
    try {
      const { apdaoId, sender, value, extended } = event.params;
      const timestamp = BigInt(event.block.timestamp);
      const senderLower = sender.toLowerCase();

      // Create bid record
      const bidId = `${event.transaction.hash}_${event.logIndex}`;
      const bid: ApdaoBid = {
        id: bidId,
        apdaoId: BigInt(apdaoId.toString()),
        sender: senderLower,
        value: BigInt(value.toString()),
        extended,
        timestamp,
        blockNumber: BigInt(event.block.number),
        transactionHash: event.transaction.hash,
        chainId: CHAIN_ID,
      };

      context.ApdaoBid.set(bid);

      // Update auction bid count + stats in parallel
      const auctionId = `${CHAIN_ID}_${apdaoId}`;
      const [auction, stats] = await Promise.all([
        context.ApdaoAuction.get(auctionId),
        getOrCreateStats(context),
      ]);
      if (auction) {
        context.ApdaoAuction.set({
          ...auction,
          bidCount: auction.bidCount + 1,
        });
      }
      context.ApdaoAuctionStats.set({
        ...stats,
        totalBids: stats.totalBids + 1,
      });
    } catch (error) {
      context.log.error(
        `[ApdaoAuction] AuctionBid handler failed for tx ${event.transaction.hash}: ${error}`
      );
    }
  }
);

/**
 * AuctionExtended — Auction end time extended due to a late bid
 */
indexer.onEvent(
  { contract: "ApdaoAuctionHouse", event: "AuctionExtended" },
  async ({ event, context }) => {
    try {
      const { apdaoId, endTime } = event.params;

      const auctionId = `${CHAIN_ID}_${apdaoId}`;
      const auction = await context.ApdaoAuction.get(auctionId);
      if (auction) {
        context.ApdaoAuction.set({
          ...auction,
          endTime: BigInt(endTime.toString()),
        });
      }
    } catch (error) {
      context.log.error(
        `[ApdaoAuction] AuctionExtended handler failed for tx ${event.transaction.hash}: ${error}`
      );
    }
  }
);

/**
 * AuctionSettled — Auction finalized with winner and amount
 */
indexer.onEvent(
  { contract: "ApdaoAuctionHouse", event: "AuctionSettled" },
  async ({ event, context }) => {
    try {
      const { apdaoId, winner, amount } = event.params;
      const timestamp = BigInt(event.block.timestamp);
      const winnerLower = winner.toLowerCase();
      const settledAmount = BigInt(amount.toString());

      const auctionId = `${CHAIN_ID}_${apdaoId}`;
      const [auction, stats] = await Promise.all([
        context.ApdaoAuction.get(auctionId),
        getOrCreateStats(context),
      ]);
      if (auction) {
        context.ApdaoAuction.set({
          ...auction,
          winner: winnerLower,
          amount: settledAmount,
          settled: true,
          settledAt: timestamp,
        });
      }
      context.ApdaoAuctionStats.set({
        ...stats,
        totalSettled: stats.totalSettled + 1,
        totalVolume: stats.totalVolume + settledAmount,
        lastSettledTime: timestamp,
      });
    } catch (error) {
      context.log.error(
        `[ApdaoAuction] AuctionSettled handler failed for tx ${event.transaction.hash}: ${error}`
      );
    }
  }
);

/**
 * TokensAddedToAuctionQueue — Owner adds seats to the exit auction queue
 */
indexer.onEvent(
  { contract: "ApdaoAuctionHouse", event: "TokensAddedToAuctionQueue" },
  async ({ event, context }) => {
    try {
      const { tokenIds, owner } = event.params;
      const timestamp = BigInt(event.block.timestamp);
      const ownerLower = owner.toLowerCase();

      for (const tokenId of tokenIds) {
        const queuedId = `${CHAIN_ID}_${tokenId}`;
        const queued: ApdaoQueuedToken = {
          id: queuedId,
          tokenId: BigInt(tokenId.toString()),
          owner: ownerLower,
          queuedAt: timestamp,
          transactionHash: event.transaction.hash,
          isQueued: true,
          removedAt: undefined,
          chainId: CHAIN_ID,
        };

        context.ApdaoQueuedToken.set(queued);
      }
    } catch (error) {
      context.log.error(
        `[ApdaoAuction] TokensAddedToAuctionQueue handler failed for tx ${event.transaction.hash}: ${error}`
      );
    }
  }
);

/**
 * TokensRemovedFromAuctionQueue — Owner removes seats from the exit auction queue
 */
indexer.onEvent(
  { contract: "ApdaoAuctionHouse", event: "TokensRemovedFromAuctionQueue" },
  async ({ event, context }) => {
    try {
      const { tokenIds } = event.params;
      const timestamp = BigInt(event.block.timestamp);

      // Batch-fetch all tokens in parallel instead of sequential loop
      const queuedIds = tokenIds.map((tokenId) => `${CHAIN_ID}_${tokenId}`);
      const existingTokens = await Promise.all(
        queuedIds.map((queuedId) => context.ApdaoQueuedToken.get(queuedId))
      );

      for (const existing of existingTokens) {
        if (existing) {
          context.ApdaoQueuedToken.set({
            ...existing,
            isQueued: false,
            removedAt: timestamp,
          });
        }
      }
    } catch (error) {
      context.log.error(
        `[ApdaoAuction] TokensRemovedFromAuctionQueue handler failed for tx ${event.transaction.hash}: ${error}`
      );
    }
  }
);
