// ponder-runtime/src/handlers/apdao-auction.ts
//
// PORTED FROM: src/handlers/apdao-auction.ts (envio, source-of-truth).
// Contract: ApdaoAuctionHouse proxy (Berachain 80094) — ApiologyDAO seat
// auction lifecycle + exit-auction queue management.
//
// B-1 green-belt (Group G). Writes:
//   - apdao_auction        (ROLLUP-LWW; id = `${chainId}_${apdaoId}`)
//   - apdao_bid            (APPEND;     id = `${txHash}_${logIndex}`)
//   - apdao_queued_token   (ROLLUP-LWW; id = `${chainId}_${tokenId}`)
//   - apdao_auction_stats  (ROLLUP;     id = `${chainId}_global`)
//
// No NATS publish (the envio handler emits no events; matches mirror /
// paddlefi / candies — local indexing only).
//
// API-pivot from envio (verbatim rules — same as mirror-observability.ts /
// general-mints.ts):
//   - event.params               → event.args
//   - CHAIN_ID (hardcoded 80094)  → context.chain.id (this contract is
//                                    Berachain-only, so the value is identical
//                                    to envio's CHAIN_ID = 80094; used for both
//                                    the chain_id column AND id construction,
//                                    preserving envio's id shape exactly)
//   - event.logIndex             → event.log.logIndex
//   - event.block.timestamp      → ALREADY bigint (drop envio's BigInt() wrap)
//   - event.block.number         → ALREADY bigint (drop envio's BigInt() wrap)
//   - event.transaction.hash     → event.transaction.hash
//   - context.<E>.get(id)        → await context.db.find(<table>, { id })
//   - context.<E>.set (APPEND)   → context.db.insert(<table>).values(obj).onConflictDoNothing()
//   - context.<E>.set (ROLLUP)   → find → update OR insert (read-modify-write)
//   - context.log.error(...)     → console.error(...) (ponder 0.16.6's indexing
//                                    context has NO .log surface — verified LIVE,
//                                    commit 879221ff; bgt.ts:96 flagged the same)
//
// Envio wrapped uint256 args in BigInt(x.toString()); ponder decodes uint256
// args (apdaoId / value / amount / startTime / endTime / tokenId) as bigint
// directly, so those coercions are dropped. ApdaoAuction.startTime/endTime are
// BigInt (NOT Timestamp scalar) in the envio schema → ponder t.bigint(),
// written directly from the decoded uint256 bigint args.

import { ponder } from "ponder:registry";
import {
  apdaoAuction,
  apdaoBid,
  apdaoQueuedToken,
  apdaoAuctionStats,
} from "../../ponder.schema";

// ─────────────────────────────────────────────────────────────────────────
// Stats helper — mirrors envio's getOrCreateStats(): returns the existing
// global stats row OR a fresh default object (NOT yet persisted). The caller
// then applies the delta and upserts. Initial values verbatim from envio
// (totalAuctions/totalSettled/totalBids = 0, totalVolume = 0n, last*Time
// = null, chainId).
// ─────────────────────────────────────────────────────────────────────────
type StatsRow = {
  id: string;
  totalAuctions: number;
  totalSettled: number;
  totalBids: number;
  totalVolume: bigint;
  lastAuctionTime: bigint | null;
  lastSettledTime: bigint | null;
  chainId: number;
};

async function getOrCreateStats(
  context: any,
  chainId: number,
  statsId: string
): Promise<StatsRow> {
  const existing = await context.db.find(apdaoAuctionStats, { id: statsId });
  if (existing) {
    return existing as StatsRow;
  }
  // envio: lastAuctionTime/lastSettledTime = undefined → ponder nullable column.
  return {
    id: statsId,
    totalAuctions: 0,
    totalSettled: 0,
    totalBids: 0,
    totalVolume: 0n,
    lastAuctionTime: null,
    lastSettledTime: null,
    chainId,
  };
}

// Upsert the global stats row from a fully-computed StatsRow (envio's
// context.ApdaoAuctionStats.set({...stats, ...delta}) → find-aware update/insert).
async function setStats(context: any, stats: StatsRow): Promise<void> {
  const existing = await context.db.find(apdaoAuctionStats, { id: stats.id });
  if (existing) {
    await context.db
      .update(apdaoAuctionStats, { id: stats.id })
      .set({
        totalAuctions: stats.totalAuctions,
        totalSettled: stats.totalSettled,
        totalBids: stats.totalBids,
        totalVolume: stats.totalVolume,
        lastAuctionTime: stats.lastAuctionTime,
        lastSettledTime: stats.lastSettledTime,
      });
  } else {
    await context.db.insert(apdaoAuctionStats).values(stats).onConflictDoNothing();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// AuctionCreated — New auction starts for a seat token.
//   envio: src/handlers/apdao-auction.ts:40-76
// ─────────────────────────────────────────────────────────────────────────
ponder.on("ApdaoAuctionHouse:AuctionCreated", async ({ event, context }) => {
  try {
    const { apdaoId, startTime, endTime } = event.args;
    const timestamp = event.block.timestamp; // already bigint
    const chainId = context.chain.id;

    const auctionId = `${chainId}_${apdaoId}`;

    // ── 1. Auction record (ROLLUP-LWW; new row, but onConflictDoNothing keeps
    //       the create idempotent on replay — re-create never overwrites a row
    //       that bids/settles have since mutated). ──────────────────────────
    await context.db
      .insert(apdaoAuction)
      .values({
        id: auctionId,
        apdaoId,
        startTime,
        endTime,
        winner: null,
        amount: null,
        settled: false,
        bidCount: 0,
        createdAt: timestamp,
        settledAt: null,
        transactionHash: event.transaction.hash,
        chainId,
      })
      .onConflictDoNothing();

    // ── 2. Stats (ROLLUP): totalAuctions + 1, lastAuctionTime = now. ────────
    const statsId = `${chainId}_global`;
    const stats = await getOrCreateStats(context, chainId, statsId);
    await setStats(context, {
      ...stats,
      totalAuctions: stats.totalAuctions + 1,
      lastAuctionTime: timestamp,
    });
  } catch (error) {
    console.error(
      `[ApdaoAuction] AuctionCreated handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// AuctionBid — Someone bids on an active auction.
//   envio: src/handlers/apdao-auction.ts:81-125
// ─────────────────────────────────────────────────────────────────────────
ponder.on("ApdaoAuctionHouse:AuctionBid", async ({ event, context }) => {
  try {
    const { apdaoId, sender, value, extended } = event.args;
    const timestamp = event.block.timestamp; // already bigint
    const chainId = context.chain.id;
    const senderLower = sender.toLowerCase();

    // ── 1. Bid record (APPEND; id = txHash_logIndex). ──────────────────────
    const bidId = `${event.transaction.hash}_${event.log.logIndex}`;
    await context.db
      .insert(apdaoBid)
      .values({
        id: bidId,
        apdaoId,
        sender: senderLower,
        value,
        extended,
        timestamp,
        blockNumber: event.block.number, // already bigint
        transactionHash: event.transaction.hash,
        chainId,
      })
      .onConflictDoNothing();

    // ── 2. Auction bidCount + 1 (if the auction row exists). ────────────────
    const auctionId = `${chainId}_${apdaoId}`;
    const auction = await context.db.find(apdaoAuction, { id: auctionId });
    if (auction) {
      await context.db
        .update(apdaoAuction, { id: auctionId })
        .set({ bidCount: auction.bidCount + 1 });
    }

    // ── 3. Stats (ROLLUP): totalBids + 1 (always, per envio). ───────────────
    const statsId = `${chainId}_global`;
    const stats = await getOrCreateStats(context, chainId, statsId);
    await setStats(context, {
      ...stats,
      totalBids: stats.totalBids + 1,
    });
  } catch (error) {
    console.error(
      `[ApdaoAuction] AuctionBid handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// AuctionExtended — Auction end time extended due to a late bid.
//   envio: src/handlers/apdao-auction.ts:130-148
// ─────────────────────────────────────────────────────────────────────────
ponder.on("ApdaoAuctionHouse:AuctionExtended", async ({ event, context }) => {
  try {
    const { apdaoId, endTime } = event.args;
    const chainId = context.chain.id;

    const auctionId = `${chainId}_${apdaoId}`;
    const auction = await context.db.find(apdaoAuction, { id: auctionId });
    if (auction) {
      await context.db
        .update(apdaoAuction, { id: auctionId })
        .set({ endTime });
    }
  } catch (error) {
    console.error(
      `[ApdaoAuction] AuctionExtended handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// AuctionSettled — Auction finalized with winner and amount.
//   envio: src/handlers/apdao-auction.ts:153-186
// ─────────────────────────────────────────────────────────────────────────
ponder.on("ApdaoAuctionHouse:AuctionSettled", async ({ event, context }) => {
  try {
    const { apdaoId, winner, amount } = event.args;
    const timestamp = event.block.timestamp; // already bigint
    const chainId = context.chain.id;
    const winnerLower = winner.toLowerCase();
    const settledAmount = amount; // already bigint

    const auctionId = `${chainId}_${apdaoId}`;

    // ── 1. Auction finalize (if the auction row exists). ────────────────────
    const auction = await context.db.find(apdaoAuction, { id: auctionId });
    if (auction) {
      await context.db
        .update(apdaoAuction, { id: auctionId })
        .set({
          winner: winnerLower,
          amount: settledAmount,
          settled: true,
          settledAt: timestamp,
        });
    }

    // ── 2. Stats (ROLLUP): totalSettled + 1, totalVolume += amount,
    //       lastSettledTime = now (always, per envio). ──────────────────────
    const statsId = `${chainId}_global`;
    const stats = await getOrCreateStats(context, chainId, statsId);
    await setStats(context, {
      ...stats,
      totalSettled: stats.totalSettled + 1,
      totalVolume: stats.totalVolume + settledAmount,
      lastSettledTime: timestamp,
    });
  } catch (error) {
    console.error(
      `[ApdaoAuction] AuctionSettled handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// TokensAddedToAuctionQueue — Owner adds seats to the exit auction queue.
//   envio: src/handlers/apdao-auction.ts:191-220
// ─────────────────────────────────────────────────────────────────────────
ponder.on(
  "ApdaoAuctionHouse:TokensAddedToAuctionQueue",
  async ({ event, context }) => {
    try {
      const { tokenIds, owner } = event.args;
      const timestamp = event.block.timestamp; // already bigint
      const chainId = context.chain.id;
      const ownerLower = owner.toLowerCase();

      for (const tokenId of tokenIds) {
        const queuedId = `${chainId}_${tokenId}`;
        // ROLLUP-LWW: re-adding flips isQueued back true + clears removedAt.
        // envio's context.ApdaoQueuedToken.set is an unconditional upsert; in
        // ponder we find→update OR insert to replicate the overwrite-on-re-add.
        const existing = await context.db.find(apdaoQueuedToken, {
          id: queuedId,
        });
        if (existing) {
          await context.db
            .update(apdaoQueuedToken, { id: queuedId })
            .set({
              tokenId,
              owner: ownerLower,
              queuedAt: timestamp,
              transactionHash: event.transaction.hash,
              isQueued: true,
              removedAt: null,
            });
        } else {
          await context.db
            .insert(apdaoQueuedToken)
            .values({
              id: queuedId,
              tokenId,
              owner: ownerLower,
              queuedAt: timestamp,
              transactionHash: event.transaction.hash,
              isQueued: true,
              removedAt: null,
              chainId,
            })
            .onConflictDoNothing();
        }
      }
    } catch (error) {
      console.error(
        `[ApdaoAuction] TokensAddedToAuctionQueue handler failed for tx ${event.transaction.hash}: ${error}`
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// TokensRemovedFromAuctionQueue — Owner removes seats from the exit queue.
//   envio: src/handlers/apdao-auction.ts:225-253
// ─────────────────────────────────────────────────────────────────────────
ponder.on(
  "ApdaoAuctionHouse:TokensRemovedFromAuctionQueue",
  async ({ event, context }) => {
    try {
      const { tokenIds } = event.args;
      const timestamp = event.block.timestamp; // already bigint
      const chainId = context.chain.id;

      // envio batch-fetched in parallel then updated existing rows only.
      const queuedIds = tokenIds.map((tokenId) => `${chainId}_${tokenId}`);
      const existingTokens = await Promise.all(
        queuedIds.map((queuedId) =>
          context.db.find(apdaoQueuedToken, { id: queuedId })
        )
      );

      for (const existing of existingTokens) {
        if (existing) {
          await context.db
            .update(apdaoQueuedToken, { id: existing.id })
            .set({
              isQueued: false,
              removedAt: timestamp,
            });
        }
      }
    } catch (error) {
      console.error(
        `[ApdaoAuction] TokensRemovedFromAuctionQueue handler failed for tx ${event.transaction.hash}: ${error}`
      );
    }
  }
);
