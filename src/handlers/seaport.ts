/**
 * Seaport Handler - Tracks marketplace trades for activity feed
 *
 * Creates MintActivity records for both SALE and PURCHASE events
 * Supports multi-chain, multi-collection tracking via TRACKED_COLLECTIONS config
 */

import { indexer, type MintActivity } from "envio";

// Tuple indices for offer: [itemType, token, identifier, amount]
const OFFER_ITEM_TYPE = 0;
const OFFER_TOKEN = 1;
const OFFER_IDENTIFIER = 2;
const OFFER_AMOUNT = 3;

// Tuple indices for consideration: [itemType, token, identifier, amount, recipient]
const CONS_ITEM_TYPE = 0;
const CONS_TOKEN = 1;
const CONS_IDENTIFIER = 2;
const CONS_AMOUNT = 3;

// Seaport item types
const ITEM_TYPE_NATIVE = 0; // ETH/BERA
const ITEM_TYPE_ERC20 = 1;  // WETH/WBERA
const ITEM_TYPE_ERC721 = 2;

/**
 * Tracked collection configuration
 * Maps lowercase collection addresses to their chain and accepted payment tokens
 */
interface TrackedCollection {
  chainId: number;
  /** ERC20 payment token addresses (lowercase). Native payments (itemType 0) are always accepted. */
  wrappedNativeToken: string;
}

const TRACKED_COLLECTIONS: Record<string, TrackedCollection> = {
  // Berachain - Mibera Collection
  "0x6666397dfe9a8c469bf65dc744cb1c733416c420": {
    chainId: 80094,
    wrappedNativeToken: "0x6969696969696969696969696969696969696969", // WBERA
  },
  // Base - Purupuru / THJ APAC collections
  "0xcd3ab1b6e95cdb40a19286d863690eb407335b21": {
    chainId: 8453,
    wrappedNativeToken: "0x4200000000000000000000000000000000000006", // WETH on Base
  },
  "0x154a563ab6c037bd0f041ac91600ffa9fe2f5fa0": {
    chainId: 8453,
    wrappedNativeToken: "0x4200000000000000000000000000000000000006", // WETH on Base
  },
  "0x85a72eee14dcaa1ccc5616df39acde212280dccb": {
    chainId: 8453,
    wrappedNativeToken: "0x4200000000000000000000000000000000000006", // WETH on Base
  },
};

/**
 * Handle OrderFulfilled - Track Seaport marketplace trades
 * Creates both SALE (for seller) and PURCHASE (for buyer) activity records
 */
indexer.onEvent(
  { contract: "Seaport", event: "OrderFulfilled" },
  async ({ event, context }) => {
    const { offerer, recipient, offer, consideration } = event.params;
    const timestamp = BigInt(event.block.timestamp);
    const blockNumber = BigInt(event.block.number);
    const txHash = event.transaction.hash;

    const offererLower = offerer.toLowerCase();
    const recipientLower = recipient.toLowerCase();

    // Skip if offerer and recipient are the same (self-trade)
    if (offererLower === recipientLower) {
      return;
    }

    // Check if offer array has items
    if (!offer || offer.length === 0) {
      return;
    }

    const firstOffer = offer[0];
    const firstOfferToken = String(firstOffer[OFFER_TOKEN]).toLowerCase();
    const firstOfferItemType = Number(firstOffer[OFFER_ITEM_TYPE]);

    let amountPaid = 0n;
    let tokenId: bigint | undefined;
    let seller: string | undefined;
    let buyer: string | undefined;
    let collection: TrackedCollection | undefined;
    let contractAddress: string | undefined;

    // Scenario 1: NFT offered (offerer is seller listing their NFT)
    const offeredCollection = TRACKED_COLLECTIONS[firstOfferToken];
    if (offeredCollection && firstOfferItemType === ITEM_TYPE_ERC721) {
      tokenId = BigInt(firstOffer[OFFER_IDENTIFIER].toString());
      seller = offererLower;
      buyer = recipientLower;
      collection = offeredCollection;
      contractAddress = firstOfferToken;

      // Sum up payments from consideration (native + wrapped native)
      for (const item of consideration) {
        const itemType = Number(item[CONS_ITEM_TYPE]);
        if (itemType === ITEM_TYPE_NATIVE) {
          amountPaid += BigInt(item[CONS_AMOUNT].toString());
        } else if (
          itemType === ITEM_TYPE_ERC20 &&
          String(item[CONS_TOKEN]).toLowerCase() === offeredCollection.wrappedNativeToken
        ) {
          amountPaid += BigInt(item[CONS_AMOUNT].toString());
        }
      }
    }
    // Scenario 2: Payment offered (offerer is buyer paying for NFT)
    else if (
      firstOfferItemType === ITEM_TYPE_NATIVE ||
      firstOfferItemType === ITEM_TYPE_ERC20
    ) {
      // Look for a tracked NFT in consideration
      for (const item of consideration) {
        const consToken = String(item[CONS_TOKEN]).toLowerCase();
        const consItemType = Number(item[CONS_ITEM_TYPE]);
        const trackedColl = TRACKED_COLLECTIONS[consToken];

        if (trackedColl && consItemType === ITEM_TYPE_ERC721) {
          tokenId = BigInt(item[CONS_IDENTIFIER].toString());
          buyer = offererLower;
          seller = recipientLower;
          collection = trackedColl;
          contractAddress = consToken;

          // Payment amount comes from the offer
          amountPaid = BigInt(firstOffer[OFFER_AMOUNT].toString());
          break;
        }
      }
    }

    // If we found a valid tracked trade, create activity records
    if (
      tokenId !== undefined &&
      seller &&
      buyer &&
      amountPaid > 0n &&
      collection &&
      contractAddress
    ) {
      // Create SALE record for seller
      const saleId = `${txHash}_${tokenId}_${seller}_SALE`;
      const saleActivity: MintActivity = {
        id: saleId,
        user: seller,
        contract: contractAddress,
        tokenStandard: "ERC721",
        tokenId,
        quantity: 1n,
        amountPaid,
        activityType: "SALE",
        timestamp,
        blockNumber,
        transactionHash: txHash,
        operator: undefined,
        chainId: collection.chainId,
      };
      context.MintActivity.set(saleActivity);

      // Create PURCHASE record for buyer
      const purchaseId = `${txHash}_${tokenId}_${buyer}_PURCHASE`;
      const purchaseActivity: MintActivity = {
        id: purchaseId,
        user: buyer,
        contract: contractAddress,
        tokenStandard: "ERC721",
        tokenId,
        quantity: 1n,
        amountPaid,
        activityType: "PURCHASE",
        timestamp,
        blockNumber,
        transactionHash: txHash,
        operator: undefined,
        chainId: collection.chainId,
      };
      context.MintActivity.set(purchaseActivity);
    }
  }
);
