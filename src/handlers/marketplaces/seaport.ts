/*
 * Seaport (OpenSea) — OrderFulfilled.
 *
 * One binding covers v1.1 through v1.6 on every chain: the OrderFulfilled ABI is
 * stable across versions, and Seaport deploys deterministically so each version
 * has the same address everywhere.
 *
 * Measured 2026-07-25: an OrderFulfilled log is present on 98.2% of Base
 * secondary transfers and resolves to (contract, tokenId, price, paymentToken)
 * on 94.5% of them. That measurement is Base-specific — Seaport's share is lower
 * on Ethereum, which is what the Blur decoder covers.
 */
import { indexer } from "envio";

import { eventIdentity } from "../../lib/actions";
import { ZERO_ADDRESS } from "../../lib/mint-detection";
import { recordSale, type SaleItem } from "../../lib/sale";
import { isTrackedContract } from "../../registry/contracts";

// offer legs are [itemType, token, identifier, amount];
// consideration adds a 5th (recipient). The first four align, so one reader serves both.
const ITEM_TYPE = 0;
const TOKEN = 1;
const IDENTIFIER = 2;
const AMOUNT = 3;

const ITEM_TYPE_NATIVE = 0; // ETH/BERA
const ITEM_TYPE_ERC20 = 1; // WETH/WBERA/USDC/…
const ITEM_TYPE_ERC721 = 2;
const ITEM_TYPE_ERC1155 = 3;

/** Native settlement has no token address; record the zero address so the
 *  denomination is always explicit and floor/average math cannot mix currencies. */
const NATIVE_TOKEN = ZERO_ADDRESS;

/**
 * An offer or consideration leg as envio delivers it — a struct with numeric
 * keys, NOT a JS array. Indexed access is identical at runtime; this type is
 * what lets one reader serve both without claiming array methods.
 */
type SeaportItem = { readonly [index: number]: unknown };

interface PaymentItem {
  token: string;
  amount: bigint;
}

function readNftItem(item: SeaportItem): SaleItem | null {
  const itemType = Number(item[ITEM_TYPE]);
  if (itemType !== ITEM_TYPE_ERC721 && itemType !== ITEM_TYPE_ERC1155) return null;
  return {
    contract: String(item[TOKEN]).toLowerCase(),
    tokenId: BigInt(String(item[IDENTIFIER])),
    // ERC-721 orders carry amount 1; ERC-1155 orders carry the real quantity.
    quantity: itemType === ITEM_TYPE_ERC1155 ? BigInt(String(item[AMOUNT])) : 1n,
    tokenStandard: itemType === ITEM_TYPE_ERC1155 ? "ERC1155" : "ERC721",
  };
}

function readPaymentItem(item: SeaportItem): PaymentItem | null {
  const itemType = Number(item[ITEM_TYPE]);
  if (itemType === ITEM_TYPE_NATIVE) {
    return { token: NATIVE_TOKEN, amount: BigInt(String(item[AMOUNT])) };
  }
  if (itemType === ITEM_TYPE_ERC20) {
    return { token: String(item[TOKEN]).toLowerCase(), amount: BigInt(String(item[AMOUNT])) };
  }
  return null;
}

/**
 * Total settled value and the currency it settled in.
 *
 * Payment legs are summed per token: item price + marketplace fee + royalty all
 * settle in the same currency, so the sum is the gross the buyer paid.
 *
 * Returns null when no single currency can express the price — nothing priceable
 * was present, or the order settled in MORE THAN ONE currency. A mixed-currency
 * order has no honest single number: reporting the largest leg understates the
 * sale while presenting itself as the full price, silently corrupting floor and
 * average math. A null price is excluded from that math; a truncated one is not.
 */
function settlement(items: readonly SeaportItem[]): PaymentItem | null {
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
  // Every leg summed to zero. A fill that settles for 0 has an EXACT price of 0 —
  // conflating it with "could not determine" defeats the nullable-price design.
  // Only a total absence of payment legs is genuinely unknown.
  const [first] = [...byToken.keys()];
  return first === undefined ? null : { token: first, amount: 0n };
}

indexer.onEvent(
  { contract: "Seaport", event: "OrderFulfilled" },
  async ({ event, context }) => {
    const { offerer, recipient, offer, consideration } = event.params;
    const chainId = Number(event.chainId);

    const offererLower = offerer.toLowerCase();
    const recipientLower = recipient.toLowerCase();

    if (offererLower === recipientLower) return; // self-trade
    // matchOrders/matchAdvancedOrders emit OrderFulfilled with recipient = 0x0 and
    // one event per matched order. Attributing a side to 0x0 would invent a
    // counterparty and double-count the trade.
    if (offererLower === ZERO_ADDRESS || recipientLower === ZERO_ADDRESS) return;
    if (!offer || offer.length === 0) return;

    // NFT in `offer` — a listing being filled, offerer sells.
    // NFT in `consideration` — a bid being accepted, offerer buys.
    let items: SaleItem[] = offer
      .map(readNftItem)
      .filter((n: SaleItem | null): n is SaleItem => n !== null);
    let seller: string;
    let buyer: string;

    if (items.length > 0) {
      seller = offererLower;
      buyer = recipientLower;
    } else {
      items = consideration
        .map(readNftItem)
        .filter((n: SaleItem | null): n is SaleItem => n !== null);
      if (items.length === 0) return;
      buyer = offererLower;
      seller = recipientLower;
    }

    // Price = every payment leg, whichever side it sits on.
    //
    // Scoping this per scenario priced the SAME trade differently depending on who
    // initiated it. Caught replaying real Base fills: on an accepted bid the buyer
    // offers the bid amount AND the consideration carries a separate marketplace-fee
    // leg, so summing only `offer` understated the trade by the fee, while a
    // listing-fill summed all of `consideration` and reported the gross. A floor
    // price across both would compare listings against bids on different bases.
    const paid = settlement([...offer, ...consideration]);

    // Eligibility is per (chain, contract), straight off the registry. Every
    // registered NFT is eligible — a name allowlist would silently drop a
    // collection the moment one is added.
    items = items.filter((n) => isTrackedContract(chainId, n.contract));
    if (items.length === 0) return;

    recordSale(context, eventIdentity(event), {
      seller,
      buyer,
      items,
      amountPaid: paid?.amount ?? null,
      paymentToken: paid?.token,
      operator: String(event.srcAddress).toLowerCase(),
      marketplace: "seaport",
      chainId,
    });
  },
);
