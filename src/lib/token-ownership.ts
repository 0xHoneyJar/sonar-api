/*
 * token-ownership.ts — single owner of the per-token current-ownership
 * projection (Token entity), FR-2 / #153.
 *
 * EVANS I-3 (R2): the Token↔Holder reconciliation invariant (FR-2c:
 * `count(Token where owner=X, !isBurned) == holder balance`) was previously
 * maintained by TWO hand-duplicated `updateTokenOwnership` functions
 * (tracked-erc721.ts + mibera-collection.ts) that differed ONLY in
 * owner-resolution. This file owns the canonical Token write in ONE place;
 * callers resolve the `candidateOwner` and delegate here, so the burn / key /
 * upsert / mintedAt logic can never drift between the two handlers again.
 *
 * Keyed `${collection}_${chainId}_${tokenId}` to match the canonical Token
 * shape (src/lib/erc721-holders.ts). Burns (candidateOwner is a burn address)
 * mark isBurned=true and set owner=ZERO.
 */

import { type EvmOnEventContext, type Token as TokenEntity } from "envio";

import { ZERO_ADDRESS } from "../handlers/constants";
import { isBurnAddress } from "./mint-detection";

const ZERO = ZERO_ADDRESS.toLowerCase();

export interface WriteTokenOwnershipArgs {
  context: EvmOnEventContext;
  collection: string;
  chainId: number;
  tokenId: bigint;
  /**
   * The owner-resolution decision made by the caller. tracked-erc721 passes
   * `to` (tracked collections don't stake); mibera-collection passes the
   * staking-aware `effectiveOwner`. This is the ONLY axis the two callers may
   * differ on — everything below is single-sourced.
   */
  candidateOwner: string;
  from: string;
  timestamp: bigint;
}

/**
 * Canonical Token{owner} write. Upserts the per-token current-owner record so
 * enumeration (`getNftsForOwner`) reconciles with the aggregate holder count.
 */
export async function writeTokenOwnership({
  context,
  collection,
  chainId,
  tokenId,
  candidateOwner,
  from,
  timestamp,
}: WriteTokenOwnershipArgs): Promise<void> {
  const burned = isBurnAddress(candidateOwner);
  const owner = burned ? ZERO : candidateOwner;

  const tokenKey = `${collection}_${chainId}_${tokenId}`;
  const existing = await context.Token.get(tokenKey);

  const token: TokenEntity = existing
    ? {
        ...existing,
        owner,
        isBurned: burned,
        lastTransferTime: timestamp,
      }
    : {
        id: tokenKey,
        collection,
        chainId,
        tokenId,
        owner,
        isBurned: burned,
        mintedAt: from === ZERO ? timestamp : BigInt(0),
        lastTransferTime: timestamp,
      };

  context.Token.set(token);
}
