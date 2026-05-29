// ponder-runtime/src/handlers/mirror-observability.ts
//
// PORTED FROM: src/handlers/mirror-observability.ts (envio, source-of-truth).
// Contract: MirrorObservability (Optimism 10) — WritingEditionPurchased.
//
// B-1 green-belt (Group H): Mirror article purchases. Mirror's WritingEditions
// observability contract emits WritingEditionPurchased for ALL clones; we
// filter to Mibera article clones (constants below, verbatim from envio
// src/handlers/mirror-observability/constants.ts).
//
// Writes:
//   - mirror_article_purchase (APPEND; id = `${txHash}_${logIndex}`)
//   - mirror_article_stats    (ROLLUP; id = `${cloneLower}_${chainId}`)
//   - action                  (recordAction — "mint_article")
//
// API-pivot from envio (verbatim rules — same as tracked-erc20.ts):
//   - event.params               → event.args
//   - event.chainId              → context.chain.id
//   - event.srcAddress           → event.log.address (n/a here)
//   - event.logIndex             → event.log.logIndex
//   - event.block.timestamp      → ALREADY bigint (no BigInt() wrap)
//   - event.block.number         → event.block.number (already bigint)
//   - event.transaction.hash     → event.transaction.hash
//   - context.<E>.get(id)        → await context.db.find(<table>, { id })
//   - context.<E>.set (APPEND)   → context.db.insert(<table>).values(obj).onConflictDoNothing()
//   - context.<E>.set (ROLLUP)   → find → update OR insert().onConflictDoNothing()
//
// Envio wrapped tokenId/price in BigInt(x.toString()); ponder decodes uint256
// args as bigint directly, so those coercions are dropped.

import { ponder } from "ponder:registry";
import {
  mirrorArticlePurchase,
  mirrorArticleStats,
} from "../../ponder.schema";
import { recordAction } from "../lib/record-action";

// Collection key for action tracking (verbatim from envio).
const COLLECTION_KEY = "mibera_articles";

// ─────────────────────────────────────────────────────────────────────────
// Mibera article clone addresses (lowercase). Verbatim from envio
// src/handlers/mirror-observability/constants.ts — the Observability contract
// emits for ALL WritingEditions clones; only these Mibera lore articles are
// indexed.
// ─────────────────────────────────────────────────────────────────────────
const MIBERA_ARTICLE_CONTRACTS: Map<string, string> = new Map([
  ["0x6b31859e5e32a5212f1ba4d7b377604b9d4c7a60", "lore_1_introducing_mibera"],
  ["0x9247edf18518c4dccfa7f8b2345a1e8a4738204f", "lore_2_honey_online_offline"],
  ["0xb2c7f411aa425d3fce42751e576a01b1ff150385", "lore_3_bera_kali_acc"],
  ["0xa12064e3b1f6102435e77aa68569e79955070357", "lore_4_bgt_network_spirituality"],
  ["0x6ca29eed22f04c1ec6126c59922844811dcbcdfa", "lore_5_initiation_ritual"],
  ["0x7988434e1469d35fa5f442e649de45d47c3df23c", "lore_6_miberamaker_design"],
  ["0x96c200ec4cca0bc57444cfee888cfba78a1ddbd8", "lore_7_miberamaker_design"],
]);

const MIBERA_ARTICLE_ADDRESSES: Set<string> = new Set(
  MIBERA_ARTICLE_CONTRACTS.keys()
);

function isMiberaArticle(cloneAddress: string): boolean {
  return MIBERA_ARTICLE_ADDRESSES.has(cloneAddress.toLowerCase());
}

function getArticleKey(cloneAddress: string): string | undefined {
  return MIBERA_ARTICLE_CONTRACTS.get(cloneAddress.toLowerCase());
}

ponder.on(
  "MirrorObservability:WritingEditionPurchased",
  async ({ event, context }) => {
    const { clone, tokenId, recipient, price, message } = event.args;
    const cloneLower = clone.toLowerCase();

    // Filter: Only process Mibera articles.
    if (!isMiberaArticle(cloneLower)) {
      return;
    }

    const recipientLower = recipient.toLowerCase();
    const timestamp = event.block.timestamp; // already bigint
    const chainId = context.chain.id;
    const eventId = `${event.transaction.hash}_${event.log.logIndex}`;

    // Human-readable article key (e.g., "lore_1_introducing_mibera").
    const articleKey = getArticleKey(cloneLower) || "unknown";

    // ── 1. Purchase record (APPEND) ──────────────────────────────────────
    await context.db
      .insert(mirrorArticlePurchase)
      .values({
        id: eventId,
        clone: cloneLower,
        tokenId,
        recipient: recipientLower,
        price,
        message: message || null,
        timestamp,
        blockNumber: event.block.number,
        transactionHash: event.transaction.hash,
        chainId,
      })
      .onConflictDoNothing();

    // ── 2. Mint action for quest tracking ────────────────────────────────
    await recordAction(context, {
      id: eventId,
      actionType: "mint_article",
      actor: recipientLower,
      primaryCollection: COLLECTION_KEY,
      timestamp,
      chainId,
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      numeric1: price,
      numeric2: tokenId,
      context: {
        clone: cloneLower,
        articleKey,
        tokenId: tokenId.toString(),
        price: price.toString(),
        message: message || "",
      },
    });

    // ── 3. Article stats (ROLLUP) ────────────────────────────────────────
    const statsId = `${cloneLower}_${chainId}`;
    const existingStats = await context.db.find(mirrorArticleStats, {
      id: statsId,
    });

    if (existingStats) {
      await context.db
        .update(mirrorArticleStats, { id: statsId })
        .set({
          totalPurchases: existingStats.totalPurchases + 1,
          totalRevenue: existingStats.totalRevenue + price,
          lastPurchaseTime: timestamp,
        });
    } else {
      // First purchase for this article.
      await context.db
        .insert(mirrorArticleStats)
        .values({
          id: statsId,
          clone: cloneLower,
          totalPurchases: 1,
          totalRevenue: price,
          uniqueCollectors: 1,
          lastPurchaseTime: timestamp,
          chainId,
        })
        .onConflictDoNothing();
    }
  }
);
