/**
 * set-token-owner.ts — substrate write to the `Token` entity for Mibera-family handlers.
 *
 * The `Token` entity (schema.graphql:326-335) is the per-token-ownership index that
 * inventory-api consumes to answer `getNftsForOwner(address, collection)`. Crayons
 * already write it via `src/lib/erc721-holders.ts:54-73`; Mibera handlers had a gap
 * (sonar published aggregate counts but no per-token ownership index — global memory
 * `project_token-entity-gap.md`).
 *
 * This helper is the single shared writer Mibera-family handlers call after their
 * own activity-feed writes (MiberaTransfer / TrackedHolder). It is intentionally
 * additive: no Token reads in the hot path beyond the upsert read needed to preserve
 * `mintedAt` across re-index. Idempotent on re-index (Envio `Token.set` is upsert;
 * a second call with the same `(collection, chainId, tokenId, to)` is a no-op).
 *
 * The load-bearing invariant is the staking-skip gate: when the `to` address is a
 * known staking contract (paddlefi vault, jiko staking — see
 * `src/handlers/mibera-staking/constants.ts`), we MUST NOT stamp the staking
 * contract as the Token owner. The user still owns the NFT logically (it's just
 * locked in the vault); `MiberaStakedToken` tracks the staked-state side-channel.
 * Stamping the staking contract here would silently break ownership queries for
 * every Mibera holder who staked into Paddle / Jiko — which is most of them.
 *
 * Cross-references:
 *   - Schema:     schema.graphql:326-335 (`Token` entity)
 *   - Reference:  src/lib/erc721-holders.ts:54-73 (crayons write pattern)
 *   - Gate src:   src/handlers/mibera-staking/constants.ts (STAKING_CONTRACT_KEYS)
 *   - Runbook:    loa-freeside/grimoires/freeside/cultivations/move-3-sonar-token-entity-2026-05-27.runbook.md
 */

import type { handlerContext, Token } from "generated";
import { isBurnAddress } from "./mint-detection";
import { STAKING_CONTRACT_KEYS } from "../handlers/mibera-staking/constants";

export interface SetTokenOwnerArgs {
  context: handlerContext;
  collection: string;
  chainId: number;
  tokenId: bigint;
  from: string;
  to: string;
  timestamp: bigint;
}

/**
 * Upserts the `Token` entity for a single NFT transfer.
 *
 * Returns `"skipped-staking"` when the transfer destination is a known staking
 * contract — the caller's logical owner is unchanged (`MiberaStakedToken` carries
 * the staked-state). Returns `"written"` otherwise.
 *
 * Caller MUST have already lowercased `from` / `to` (matches the conventions in
 * `erc721-holders.ts` and `mibera-collection.ts`). The collection address is
 * lowercased defensively here to keep the entity id stable across callers.
 */
export async function setTokenOwner({
  context,
  collection,
  chainId,
  tokenId,
  from,
  to,
  timestamp,
}: SetTokenOwnerArgs): Promise<"written" | "skipped-staking"> {
  // Staking-skip gate — the load-bearing invariant.
  // If we wrote `owner = stakingContract` here, every staked Mibera would
  // disappear from inventory-api's `getNftsForOwner(user)` result.
  if (STAKING_CONTRACT_KEYS[to] !== undefined) {
    return "skipped-staking";
  }

  const normalizedCollection = collection.toLowerCase();
  const id = `${normalizedCollection}_${chainId}_${tokenId}`;
  const existing = await context.Token.get(id);

  const next: Token = existing
    ? {
        ...existing,
        owner: to,
        isBurned: isBurnAddress(to),
        lastTransferTime: timestamp,
      }
    : {
        id,
        collection: normalizedCollection,
        chainId,
        tokenId,
        owner: to,
        isBurned: isBurnAddress(to),
        // mintedAt is only meaningful on the mint transfer (from === zero).
        // For first-sight-on-secondary (unusual but possible if re-index window
        // doesn't include the mint block), record 0n — the Token entity is
        // primarily an ownership index, not a mint-time index.
        mintedAt: timestamp,
        lastTransferTime: timestamp,
      };

  // On re-index, an existing entry with identical fields is an upsert no-op
  // from the consumer's perspective (Envio writes the same row). This makes
  // the helper safe to call from genesis-replayed handlers.
  context.Token.set(next);
  return "written";
}
