/*
 * Mirror Observability tracking on Optimism.
 *
 * Tracks:
 * - WritingEditionPurchased: Article NFT purchases from Mirror's WritingEditions contracts
 *
 * This tracks Mibera lore articles purchased on Optimism.
 * The Observability contract emits events for all WritingEditions clones,
 * but we filter to only process Mibera-related articles.
 */

import {
  indexer,
  type MirrorArticlePurchase,
  type MirrorArticleStats,
} from "envio";

import { recordAction } from "../lib/actions";
import {
  isMiberaArticle,
  getArticleKey,
} from "./mirror-observability/constants";

// Collection key for action tracking
const COLLECTION_KEY = "mibera_articles";

/**
 * Handle WritingEditionPurchased events
 * Tracks article NFT purchases from Mirror's WritingEditions contracts
 * Only processes Mibera-related articles
 */
indexer.onEvent(
  { contract: "MirrorObservability", event: "WritingEditionPurchased" },
  async ({ event, context }) => {
      const { clone, tokenId, recipient, price, message } = event.params;
      const cloneLower = clone.toLowerCase();

      // Filter: Only process Mibera articles
      if (!isMiberaArticle(cloneLower)) {
        return;
      }

      const recipientLower = recipient.toLowerCase();
      const tokenIdBigInt = BigInt(tokenId.toString());
      const priceBigInt = BigInt(price.toString());
      const timestamp = BigInt(event.block.timestamp);
      const chainId = event.chainId;
      const eventId = `${event.transaction.hash}_${event.logIndex}`;

      // Get the human-readable article key (e.g., "lore_1_introducing_mibera")
      const articleKey = getArticleKey(cloneLower) || "unknown";

      // Create purchase event record
      const purchase: MirrorArticlePurchase = {
        id: eventId,
        clone: cloneLower,
        tokenId: tokenIdBigInt,
        recipient: recipientLower,
        price: priceBigInt,
        message: message || undefined,
        timestamp,
        blockNumber: BigInt(event.block.number),
        transactionHash: event.transaction.hash,
        chainId,
      };

      context.MirrorArticlePurchase.set(purchase);

      // Record mint action for quest tracking
      recordAction(context, {
        id: eventId,
        actionType: "mint_article",
        actor: recipientLower,
        primaryCollection: COLLECTION_KEY,
        timestamp,
        chainId,
        txHash: event.transaction.hash,
        logIndex: event.logIndex,
        numeric1: priceBigInt,
        numeric2: tokenIdBigInt,
        context: {
          clone: cloneLower,
          articleKey,
          tokenId: tokenIdBigInt.toString(),
          price: priceBigInt.toString(),
          message: message || "",
        },
      });

      // Update article stats
      const statsId = `${cloneLower}_${chainId}`;
      const existingStats = await context.MirrorArticleStats.get(statsId);

      if (existingStats) {
        context.MirrorArticleStats.set({
          ...existingStats,
          totalPurchases: existingStats.totalPurchases + 1,
          totalRevenue: existingStats.totalRevenue + priceBigInt,
          lastPurchaseTime: timestamp,
        });
      } else {
        // First purchase for this article
        const newStats: MirrorArticleStats = {
          id: statsId,
          clone: cloneLower,
          totalPurchases: 1,
          totalRevenue: priceBigInt,
          uniqueCollectors: 1,
          lastPurchaseTime: timestamp,
          chainId,
        };
        context.MirrorArticleStats.set(newStats);
      }
  }
);
