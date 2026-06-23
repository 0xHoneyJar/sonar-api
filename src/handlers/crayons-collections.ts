/*
 * Crayons ERC721 Collections - Transfer Indexing
 *
 * Indexes Transfer events for Crayons ERC721 Base collections deployed by the Crayons Factory.
 * Stores ownership in Token, movements in Transfer, per-collection Holder balances, and CollectionStat.
 *
 * Collection identifier: the on-chain collection address (lowercase string).
 */

import { indexer } from "envio";

import { processErc721Transfer } from "../lib/erc721-holders";

indexer.onEvent(
  { contract: "CrayonsCollection", event: "Transfer" },
  async ({ event, context }) => {
    await processErc721Transfer({
      event,
      context,
      collectionAddress: event.srcAddress.toLowerCase(),
    });
  }
);
