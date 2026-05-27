/*
 * Generalized ERC721 mint tracking handler.
 *
 * Captures Transfer events where the token is minted (from zero address)
 * and stores normalized MintEvent entities for downstream consumers.
 */

import { GeneralMints, MintEvent } from "generated";

import { recordAction } from "../lib/actions";
import { publishMintEvent, type CollectionSlug } from "../lib/events-publisher";

import { ZERO_ADDRESS } from "./constants";
import { MINT_COLLECTION_KEYS } from "./mints/constants";

const ZERO = ZERO_ADDRESS.toLowerCase();

/**
 * Mibera-family allowlist for events-pillar v1 publish. ONLY collection keys
 * in this map publish to NATS — every other GeneralMints contract continues
 * to write its Envio MintEvent (above) and stays out of the cross-cell event
 * substrate for now (per build doc "What NOT to build").
 *
 * Maps the local `collectionKey` (from MINT_COLLECTION_KEYS, see ./mints/constants.ts)
 * to the cluster topic specifier (CollectionSlug).
 *
 * Scoping decisions (judgment-call documented for the dispatching agent):
 *   - `mibera_vm` (Shadows) is OMITTED — vm-minted.ts publishes that handler's
 *     trait-enriched envelope on the canonical `mibera-shadow` subject. We
 *     omit it here to avoid double-publishing the same mint with a
 *     less-enriched payload.
 *   - Main Mibera ERC-721 (`mibera`) is NOT routed through GeneralMints —
 *     it has its own MiberaCollection handler in mibera-collection.ts where
 *     the publish lives.
 *   - `mibera_drugs`, `mibera_gif`, `mibera_tarot` ARE mibera-family and
 *     ARE part of this gate. Subject: `nft.mint.detected.mibera-collection.v1`
 *     (the cross-cell consumer treats them as members of the broader mibera
 *     collection family; per-token-class discrimination is the consumer's job).
 */
const MINT_PUBLISH_ALLOWLIST: Record<string, CollectionSlug> = {
  mibera_drugs: "mibera-collection",
  mibera_gif: "mibera-collection",
  mibera_tarot: "mibera-collection",
};

export const handleGeneralMintTransfer = GeneralMints.Transfer.handler(
  async ({ event, context }) => {
    const { from, to, tokenId } = event.params;

    const fromLower = from.toLowerCase();
    if (fromLower !== ZERO) {
      return; // Skip non-mint transfers
    }

    const contractAddress = event.srcAddress.toLowerCase();
    const collectionKey =
      MINT_COLLECTION_KEYS[contractAddress] ?? contractAddress;

    const id = `${event.transaction.hash}_${event.logIndex}`;
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;
    const minter = to.toLowerCase();
    const mintEvent: MintEvent = {
      id,
      collectionKey,
      tokenId: BigInt(tokenId.toString()),
      minter,
      timestamp,
      blockNumber: BigInt(event.block.number),
      transactionHash: event.transaction.hash,
      chainId,
      encodedTraits: undefined, // Will be populated by VM Minted handler if applicable
    };

    context.MintEvent.set(mintEvent);

    recordAction(context, {
      id,
      actionType: "mint",
      actor: minter,
      primaryCollection: collectionKey,
      timestamp,
      chainId,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      numeric1: 1n,
      context: {
        tokenId: tokenId.toString(),
        contract: contractAddress,
      },
    });

    // Events-pillar v1: gated publish for the mibera-family allowlist only.
    // Non-allowlisted collections fall through unchanged (Envio write above
    // is the durable record). Fail-soft inside publishMintEvent.
    const publishSlug = MINT_PUBLISH_ALLOWLIST[collectionKey];
    if (publishSlug) {
      await publishMintEvent({
        log: context.log,
        collectionSlug: publishSlug,
        payload: {
          chain_id: chainId,
          contract: contractAddress,
          token_id: tokenId.toString(),
          minter,
          block_number: event.block.number,
          transaction_hash: event.transaction.hash,
          timestamp: new Date(Number(timestamp) * 1000).toISOString(),
        },
      });
    }
  }
);
