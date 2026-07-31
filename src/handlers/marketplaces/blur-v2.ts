/*
 * BlurExchangeV2 — Execution721Packed. Ethereum only.
 *
 * Where all current Blur volume is (682 sales in 15,000 blocks, 2026-07-31).
 * Structurally unlike every other venue here in two ways.
 *
 * 1. FIELDS ARE BIT-PACKED into two uint256s rather than named args:
 *
 *      tokenIdListingIndexTrader = tokenId << 168 | listingIndex << 160 | trader
 *      collectionPriceSide       = side << 248 | price << 160 | collection
 *
 *    Verified by decoding real logs: one resolved to BAYC #4785 at 8.5 ETH,
 *    another to Moonbirds #9080 at 0.5735 ETH — both collections in the registry.
 *
 * 2. ONLY ONE PARTY IS ON THE LOG. `trader` is the order's maker; `side` says
 *    which end of the trade that is, and the counterparty is the TRANSACTION
 *    SENDER. Confirmed against 4 real fills by cross-checking each against the
 *    ERC-721 Transfer in the same transaction:
 *
 *      side 0 → trader SOLD  (a listing was filled) → buyer  = tx.from
 *      side 1 → trader BOUGHT (a bid was accepted)  → seller = tx.from
 *
 *    tx.from matched the Transfer counterparty in all four. That is why this
 *    lane selects `from` in field_selection — no other lane needs it.
 *
 * The sibling event 0xf4092a7c… is NOT a sale: 92 transactions emitting only it
 * contained zero ERC-721 Transfers. Execution721Packed alone covers every V2 sale.
 */
import { indexer } from "envio";

import { eventIdentity } from "../../lib/actions";
import { ZERO_ADDRESS } from "../../lib/mint-detection";
import { recordSale } from "../../lib/sale";
import { isTrackedContract } from "../../registry/contracts";

const MASK_160 = (1n << 160n) - 1n;
const MASK_88 = (1n << 88n) - 1n;

const toAddress = (v: bigint): string => `0x${v.toString(16).padStart(40, "0")}`;

indexer.onEvent(
  { contract: "BlurV2", event: "Execution721Packed" },
  async ({ event, context }) => {
    const chainId = Number(event.chainId);

    const packedTrader = BigInt(event.params.tokenIdListingIndexTrader);
    const packedCollection = BigInt(event.params.collectionPriceSide);

    const collection = toAddress(packedCollection & MASK_160);
    if (!isTrackedContract(chainId, collection)) return;

    const trader = toAddress(packedTrader & MASK_160);
    const tokenId = packedTrader >> 168n;
    const price = (packedCollection >> 160n) & MASK_88;
    const side = packedCollection >> 248n;

    // The counterparty is whoever sent the transaction.
    const counterparty = String(
      (event.transaction as { from?: string }).from ?? "",
    ).toLowerCase();
    if (!counterparty) return; // no `from` selected → cannot name both sides

    const seller = side === 0n ? trader : counterparty;
    const buyer = side === 0n ? counterparty : trader;
    if (seller === buyer) return; // self-trade
    if (seller === ZERO_ADDRESS || buyer === ZERO_ADDRESS) return;

    recordSale(context, eventIdentity(event), {
      seller,
      buyer,
      // Execution721Packed is, as the name says, ERC-721 only.
      items: [{ contract: collection, tokenId, quantity: 1n, tokenStandard: "ERC721" }],
      amountPaid: price,
      // The packed event carries no currency. Blur v2 settles in ETH or Blur Pool
      // (BETH), which is 1:1 wrapped ETH — so the amount is ETH-denominated either
      // way and comparable to native sales. Recorded as native rather than invented.
      paymentToken: ZERO_ADDRESS,
      operator: String(event.srcAddress).toLowerCase(),
      marketplace: "blur_v2",
      chainId,
    });
  },
);
