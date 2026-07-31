/*
 * The one place a sale becomes rows.
 *
 * Every marketplace decoder answers the same four questions — who sold, who
 * bought, which NFTs, and what was paid — and hands the answer here. Nothing
 * about the venue's ABI reaches this file, so a new marketplace is a decoder
 * and nothing else.
 *
 * Two rows per NFT: a SALE keyed to the seller and a PURCHASE keyed to the
 * buyer. Both carry identical facts. The duplication is deliberate — it makes
 * "this wallet's activity" a single-column query on `user` instead of an OR
 * across two columns.
 *
 * The belt never asserts that a Transfer WAS a sale. The ERC-721 lane records
 * the movement and this records the settlement; they are joined downstream on
 * (chainId, txHash, contract, tokenId). Absence of a sale row means UNKNOWN,
 * not "not a sale" — inferring the flag from the transfer alone scored ~29%
 * precision on 409 sampled transfers.
 */
import type { EvmOnEventContext, MintActivity } from "envio";

import type { EventIdentity } from "./actions";
import type { Marketplace } from "../registry/marketplaces";

export interface SaleItem {
  /** Lowercased NFT contract. */
  contract: string;
  tokenId: bigint;
  quantity: bigint;
  tokenStandard: "ERC721" | "ERC1155";
}

export interface Sale {
  seller: string;
  buyer: string;
  items: readonly SaleItem[];
  /**
   * Gross settled value across the whole order, or null when no single number
   * is honest — nothing priceable, or a genuinely mixed-currency order. A null
   * price still produces rows: an unpriced sale is a real disposal, and dropping
   * it makes "never sold" and "sold, could not price it" indistinguishable.
   */
  amountPaid: bigint | null;
  /** Settlement currency; zero address = the chain's native coin. */
  paymentToken: string | undefined;
  /** The marketplace contract that emitted the fill. */
  operator: string;
  /** Which venue, for downstream attribution. */
  marketplace: Marketplace;
  chainId: number;
}

/**
 * Split an order total across its NFT items.
 *
 * loa:shortcut: equal split. A bundle carries one aggregate price and no
 * per-item breakdown, so equal division is the only derivation the log supports.
 * The remainder lands on the first row so the parts sum exactly to the total.
 * Upgrade trigger: if per-item pricing matters (bundles were 0 of 800 sampled
 * Base sales), source it from per-item events instead of dividing.
 */
export function splitPrice(total: bigint | null, parts: number): (bigint | null)[] {
  if (total === null) return Array.from({ length: parts }, () => null);
  const base = total / BigInt(parts);
  const remainder = total - base * BigInt(parts);
  return Array.from({ length: parts }, (_, i) => (i === 0 ? base + remainder : base));
}

/**
 * Write the SALE/PURCHASE pair for every item in a sale.
 *
 * id = txHash + logIndex + item index + user + type. logIndex pins the specific
 * log and `i` pins the item within it, so no two rows can collide. Weaker keys
 * DO collide and `.set` overwrites silently: keying on (txHash, tokenId, user,
 * type) collided across collections, and adding the contract still collided when
 * one order lists the same ERC-1155 tokenId twice, or a seller fills two bids for
 * the same token in one tx.
 */
export function recordSale(
  context: EvmOnEventContext,
  id: EventIdentity,
  sale: Sale,
): void {
  if (sale.items.length === 0) return;
  const prices = splitPrice(sale.amountPaid, sale.items.length);

  sale.items.forEach((item, i) => {
    const common = {
      contract: item.contract,
      tokenStandard: item.tokenStandard,
      tokenId: item.tokenId,
      quantity: item.quantity,
      amountPaid: prices[i] ?? undefined,
      paymentToken: sale.paymentToken,
      timestamp: id.timestamp,
      blockNumber: id.blockNumber,
      transactionHash: id.txHash,
      operator: sale.operator,
      chainId: sale.chainId,
    };

    const saleRow: MintActivity = {
      ...common,
      id: `${id.txHash}_${id.logIndex}_${i}_${sale.seller}_SALE`,
      user: sale.seller,
      activityType: "SALE",
    };
    context.MintActivity.set(saleRow);

    const purchaseRow: MintActivity = {
      ...common,
      id: `${id.txHash}_${id.logIndex}_${i}_${sale.buyer}_PURCHASE`,
      user: sale.buyer,
      activityType: "PURCHASE",
    };
    context.MintActivity.set(purchaseRow);
  });
}
