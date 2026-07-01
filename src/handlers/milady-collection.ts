/**
 * Milady Collection Transfer Handler
 *
 * Tracks NFT burns for the Milady Maker collection on Ethereum mainnet.
 * Only records transfers to burn addresses (zero or dead address).
 */

import { indexer, type NftBurn, type NftBurnStats } from "envio";
import { recordAction } from "../lib/actions";
import { isBurnTransfer } from "../lib/mint-detection";

const MILADY_COLLECTION_ADDRESS = "0x5af0d9827e0c53e4799bb226655a1de152a425a5";
const MILADY_COLLECTION_KEY = "milady";
const ETHEREUM_CHAIN_ID = 1;

/**
 * Handle Transfer - Track NFT burns (transfers to zero/dead address)
 * Event: Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
 */
indexer.onEvent(
  { contract: "MiladyCollection", event: "Transfer" },
  async ({ event, context }) => {
    const timestamp = BigInt(event.block.timestamp);
    const from = event.params.from.toLowerCase();
    const to = event.params.to.toLowerCase();
    const tokenId = event.params.tokenId;
    const txHash = event.transaction.hash;

    const isBurn = isBurnTransfer(from, to);

    // Only track burns for Milady - we don't need full transfer history
    if (isBurn) {
      // Record burn event
      const burnId = `${txHash}_${event.logIndex}`;
      const burn: NftBurn = {
        id: burnId,
        collectionKey: MILADY_COLLECTION_KEY,
        tokenId,
        from,
        timestamp,
        blockNumber: BigInt(event.block.number),
        transactionHash: txHash,
        chainId: ETHEREUM_CHAIN_ID,
      };
      context.NftBurn.set(burn);

      // Update burn stats
      const statsId = `${ETHEREUM_CHAIN_ID}_${MILADY_COLLECTION_KEY}`;
      const existingStats = await context.NftBurnStats.get(statsId);
      const burnerMarkerId = `burner:${from}:${ETHEREUM_CHAIN_ID}`;
      const existingBurnerMarker = await context.NftBurn.get(burnerMarkerId);
      const uniqueBurnersDelta = existingBurnerMarker ? 0 : 1;

      if (!existingBurnerMarker) {
        context.NftBurn.set({
          id: burnerMarkerId,
          collectionKey: MILADY_COLLECTION_KEY,
          tokenId: 0n,
          from,
          timestamp,
          blockNumber: BigInt(event.block.number),
          transactionHash: txHash,
          chainId: ETHEREUM_CHAIN_ID,
        });
      }

      const stats: NftBurnStats = {
        id: statsId,
        chainId: ETHEREUM_CHAIN_ID,
        collectionKey: MILADY_COLLECTION_KEY,
        totalBurned: (existingStats?.totalBurned ?? 0) + 1,
        uniqueBurners: (existingStats?.uniqueBurners ?? 0) + uniqueBurnersDelta,
        lastBurnTime: timestamp,
        firstBurnTime: existingStats?.firstBurnTime ?? timestamp,
      };
      context.NftBurnStats.set(stats);

      // Record action for activity feeds
      recordAction(context, {
        actionType: "milady_burn",
        actor: from,
        primaryCollection: MILADY_COLLECTION_ADDRESS,
        timestamp,
        chainId: ETHEREUM_CHAIN_ID,
        txHash,
        logIndex: event.logIndex,
        numeric1: tokenId,
      });
    }
  }
);
