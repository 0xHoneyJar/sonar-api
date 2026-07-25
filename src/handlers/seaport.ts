/**
 * Seaport Handler - Tracks marketplace trades for activity feed
 *
 * Creates MintActivity records for both SALE and PURCHASE events.
 * Collection eligibility comes from the ACTIVE belt config, not a hardcoded map —
 * onboarding a collection through Kitchen is sufficient (bug-20260725-224d57 F2).
 *
 * Measured 2026-07-25 (grimoires/loa/context/2026-07-25-marketplace-sale-detection.md):
 * a Seaport OrderFulfilled log is present on 98.2% of Base secondary transfers and
 * resolves to (contract, tokenId, price, paymentToken) on 94.5% of them. tx.to
 * matching caught 0 cases the log did not, so this log is the sole sale signal here.
 */

import { indexer, type MintActivity } from "envio";
import { isTrackedNftContract } from "./marketplaces/tracked-nft-contracts";

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
const ITEM_TYPE_ERC20 = 1; // WETH/WBERA/USDC/…
const ITEM_TYPE_ERC721 = 2;
const ITEM_TYPE_ERC1155 = 3;

/** Native settlement has no token address; record the zero address so the
 *  denomination is always explicit and floor/average math cannot mix currencies. */
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

/** Same literal, different meaning: an unusable counterparty. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface NftItem {
  contract: string;
  tokenId: bigint;
  quantity: bigint;
  tokenStandard: "ERC721" | "ERC1155";
}

/** A payment leg: the settlement currency and its amount. */
interface PaymentItem {
  token: string;
  amount: bigint;
}

/**
 * Read an NFT item from an offer OR a consideration tuple.
 *
 * Safe for both because the two shapes share their first four fields —
 * offer is [itemType, token, identifier, amount] and consideration is
 * [itemType, token, identifier, amount, recipient]. The OFFER_* indices below
 * therefore address consideration items correctly too; keep the two constant
 * blocks aligned on 0..3 or split this into two readers.
 */
function readNftItem(item: readonly unknown[]): NftItem | null {
  const itemType = Number(item[OFFER_ITEM_TYPE]);
  if (itemType !== ITEM_TYPE_ERC721 && itemType !== ITEM_TYPE_ERC1155) return null;
  return {
    contract: String(item[OFFER_TOKEN]).toLowerCase(),
    tokenId: BigInt(String(item[OFFER_IDENTIFIER])),
    // ERC-721 orders carry amount 1; ERC-1155 orders carry the real quantity.
    quantity: itemType === ITEM_TYPE_ERC1155 ? BigInt(String(item[OFFER_AMOUNT])) : 1n,
    tokenStandard: itemType === ITEM_TYPE_ERC1155 ? "ERC1155" : "ERC721",
  };
}

function readPaymentItem(item: readonly unknown[]): PaymentItem | null {
  const itemType = Number(item[CONS_ITEM_TYPE]);
  if (itemType === ITEM_TYPE_NATIVE) {
    return { token: NATIVE_TOKEN, amount: BigInt(String(item[CONS_AMOUNT])) };
  }
  if (itemType === ITEM_TYPE_ERC20) {
    return {
      token: String(item[CONS_TOKEN]).toLowerCase(),
      amount: BigInt(String(item[CONS_AMOUNT])),
    };
  }
  return null;
}

/**
 * Total settled value, and the currency it was settled in.
 *
 * Payment legs are summed per token: item price + marketplace fee + royalty all
 * settle in the same currency, so the sum is the gross price the buyer paid.
 *
 * Returns null when no single currency can express the price — either nothing
 * priceable was present, or the order settled in MORE THAN ONE currency. A
 * mixed-currency order has no honest single-number price: reporting the largest leg
 * would understate the sale while still presenting itself as the full price, which
 * silently corrupts floor/average math (review MEDIUM-2). A null price is excluded
 * from that math; a truncated one is not.
 *
 * A null price still produces a row — an unpriced sale is a real disposal, and
 * dropping it made "never sold" and "sold, could not price it" indistinguishable
 * (the prior `amountPaid > 0n` guard discarded every non-native, non-wrapped
 * settlement, e.g. USDC).
 */
function settlement(items: readonly (readonly unknown[])[]): PaymentItem | null {
  const byToken = new Map<string, bigint>();
  for (const raw of items) {
    const pay = readPaymentItem(raw);
    if (!pay) continue;
    byToken.set(pay.token, (byToken.get(pay.token) ?? 0n) + pay.amount);
  }

  const nonZero = [...byToken].filter(([, amount]) => amount > 0n);
  if (nonZero.length > 1) return null; // genuinely mixed — no honest single price
  if (nonZero.length === 1) {
    const [token, amount] = nonZero[0];
    return { token, amount };
  }
  // Every leg summed to zero. A Seaport fill that settles for 0 has an EXACT price
  // of 0 — conflating it with "could not determine" would defeat the whole point of
  // the nullable-price design (BB SEA-006). Only a total absence of payment legs is
  // genuinely unknown.
  const [first] = [...byToken.keys()];
  return first === undefined ? null : { token: first, amount: 0n };
}

/**
 * Split an order total across its NFT items.
 *
 * loa:shortcut: equal split. A Seaport bundle carries one aggregate consideration
 * and no per-item price, so equal division is the only derivation the log supports.
 * The remainder lands on the first row so the parts sum exactly to the total.
 * Upgrade trigger: if per-item pricing ever matters (bundles were 0 of 800 sampled
 * Base sales), source it from per-item OrderFulfilled variants instead of dividing.
 */
function splitPrice(total: bigint | null, parts: number): (bigint | null)[] {
  if (total === null) return Array.from({ length: parts }, () => null);
  const base = total / BigInt(parts);
  const remainder = total - base * BigInt(parts);
  return Array.from({ length: parts }, (_, i) => (i === 0 ? base + remainder : base));
}

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
    const chainId = Number(event.chainId);
    const logIndex = Number(event.logIndex);

    const offererLower = offerer.toLowerCase();
    const recipientLower = recipient.toLowerCase();

    // Skip if offerer and recipient are the same (self-trade)
    if (offererLower === recipientLower) return;
    // Seaport's matchOrders/matchAdvancedOrders paths emit OrderFulfilled with
    // recipient = address(0) and one event per matched order. Attributing a SALE or
    // PURCHASE to 0x0 would invent a counterparty and double-count the trade
    // (BB SEA-002). Not observed in 1,482 sampled orders, but cheap to exclude.
    if (offererLower === ZERO_ADDRESS || recipientLower === ZERO_ADDRESS) return;
    if (!offer || offer.length === 0) return;

    // Scenario 1 — NFT is offered: the offerer is the seller, paid via consideration.
    // Scenario 2 — payment is offered: the offerer is the buyer, and the NFT they
    // receive sits in consideration.
    let nftItems: NftItem[] = offer
      .map(readNftItem)
      .filter((n: NftItem | null): n is NftItem => n !== null);
    let seller: string;
    let buyer: string;
    let paid: PaymentItem | null;

    if (nftItems.length > 0) {
      seller = offererLower;
      buyer = recipientLower;
      paid = settlement(consideration);
    } else {
      nftItems = consideration
        .map(readNftItem)
        .filter((n: NftItem | null): n is NftItem => n !== null);
      if (nftItems.length === 0) return;
      buyer = offererLower;
      seller = recipientLower;
      paid = settlement(offer);
    }

    // Eligibility is per (chain, contract): config.yaml is the source of truth.
    nftItems = nftItems.filter((n: NftItem) =>
      isTrackedNftContract(chainId, n.contract),
    );
    if (nftItems.length === 0) return;

    // The marketplace contract that emitted the fill — score-api's sale rule keys
    // on this. Previously hardcoded undefined, so it was null on 100% of live rows.
    const operator = event.srcAddress
      ? String(event.srcAddress).toLowerCase()
      : undefined;

    const prices = splitPrice(paid?.amount ?? null, nftItems.length);

    nftItems.forEach((nft: NftItem, i: number) => {
      const amountPaid = prices[i];
      const common = {
        contract: nft.contract,
        tokenStandard: nft.tokenStandard,
        tokenId: nft.tokenId,
        quantity: nft.quantity,
        amountPaid: amountPaid ?? undefined,
        paymentToken: paid?.token,
        timestamp,
        blockNumber,
        transactionHash: txHash,
        operator,
        chainId,
      };

      // id = txHash + logIndex + item index + user + type.
      //
      // logIndex pins the specific OrderFulfilled log, and `i` pins the item within
      // that log, so no two emitted rows can ever share an id. Weaker keys collide
      // and `.set` silently overwrites: `txHash_tokenId_user_TYPE` collided across
      // collections (review HIGH-1), and adding the contract still collided when one
      // order lists the same ERC-1155 tokenId twice, or when a seller fills two bids
      // for the same token in one tx (BB SEA-001 — observed once in 1,482 sampled
      // real orders). Contract and tokenId remain available as columns.
      //
      // This changes the id FORMAT for existing chain-1/80094 rows. Field values are
      // unchanged; score-api joins on (txHash, tokenId), not on id.
      const saleActivity: MintActivity = {
        ...common,
        id: `${txHash}_${logIndex}_${i}_${seller}_SALE`,
        user: seller,
        activityType: "SALE",
      };
      context.MintActivity.set(saleActivity);

      const purchaseActivity: MintActivity = {
        ...common,
        id: `${txHash}_${logIndex}_${i}_${buyer}_PURCHASE`,
        user: buyer,
        activityType: "PURCHASE",
      };
      context.MintActivity.set(purchaseActivity);
    });
  }
);
