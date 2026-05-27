/*
 * Mibera Sets ERC-1155 tracking on Optimism.
 *
 * Tracks:
 * - Mints: transfers from zero address OR distribution wallet (airdrops)
 * - Transfers: all other transfers between users
 *
 * Token IDs:
 *   - 8, 9, 10, 11: Strong Set
 *   - 12: Super Set
 */

import { MiberaSets, Erc1155MintEvent } from "generated";

import { recordAction } from "../lib/actions";
import { publishMintEvent } from "../lib/events-publisher";
import { isMintOrAirdrop } from "../lib/mint-detection";
import { isMarketplaceAddress } from "./marketplaces/constants";

// Distribution wallet that airdropped Sets (transfers FROM this address = mints)
const DISTRIBUTION_WALLET = "0x4a8c9a29b23c4eac0d235729d5e0d035258cdfa7";
const AIRDROP_WALLETS = new Set([DISTRIBUTION_WALLET]);

// Collection key for action tracking
const COLLECTION_KEY = "mibera_sets";

// Token ID classifications
const STRONG_SET_TOKEN_IDS = [8n, 9n, 10n, 11n];
const SUPER_SET_TOKEN_ID = 12n;

/**
 * Get the set tier based on token ID
 */
function getSetTier(tokenId: bigint): string {
  if (STRONG_SET_TOKEN_IDS.includes(tokenId)) {
    return "strong";
  }
  if (tokenId === SUPER_SET_TOKEN_ID) {
    return "super";
  }
  return "unknown";
}

/**
 * Handle TransferSingle events
 * Tracks mints (from zero/distribution) and transfers (between users)
 */
export const handleMiberaSetsSingle = MiberaSets.TransferSingle.handler(
  async ({ event, context }) => {
    const { operator, from, to, id, value } = event.params;
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();

    const tokenId = BigInt(id.toString());
    const quantity = BigInt(value.toString());

    if (quantity === 0n) {
      return;
    }

    const contractAddress = event.srcAddress.toLowerCase();
    const operatorLower = operator.toLowerCase();
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;
    const eventId = `${event.transaction.hash}_${event.logIndex}`;
    const setTier = getSetTier(tokenId);

    // Check if this is a mint or a transfer
    const isMintEvent = isMintOrAirdrop(fromLower, AIRDROP_WALLETS);

    if (isMintEvent) {
      // Create mint event record
      const mintEvent: Erc1155MintEvent = {
        id: eventId,
        collectionKey: COLLECTION_KEY,
        tokenId,
        value: quantity,
        minter: toLower,
        operator: operatorLower,
        timestamp,
        blockNumber: BigInt(event.block.number),
        transactionHash: event.transaction.hash,
        chainId,
      };

      context.Erc1155MintEvent.set(mintEvent);

      // Record mint action
      recordAction(context, {
        id: eventId,
        actionType: "mint1155",
        actor: toLower,
        primaryCollection: COLLECTION_KEY,
        timestamp,
        chainId,
        txHash: event.transaction.hash,
        logIndex: event.logIndex,
        numeric1: quantity,
        numeric2: tokenId,
        context: {
          tokenId: tokenId.toString(),
          setTier,
          operator: operatorLower,
          contract: contractAddress,
          from: fromLower,
        },
      });

      // Events-pillar v1: publish Mibera Sets mint envelope.
      // Subject: nft.mint.detected.mibera-sets.v1. Fail-soft.
      await publishMintEvent({
        log: context.log,
        collectionSlug: "mibera-sets",
        payload: {
          chain_id: chainId,
          contract: contractAddress,
          token_id: tokenId.toString(),
          minter: toLower,
          block_number: event.block.number,
          transaction_hash: event.transaction.hash,
          timestamp: new Date(Number(timestamp) * 1000).toISOString(),
        },
      });
    } else {
      // Record transfer action (secondary market / user-to-user)
      recordAction(context, {
        id: eventId,
        actionType: "transfer1155",
        actor: toLower,
        primaryCollection: COLLECTION_KEY,
        timestamp,
        chainId,
        txHash: event.transaction.hash,
        logIndex: event.logIndex,
        numeric1: quantity,
        numeric2: tokenId,
        context: {
          tokenId: tokenId.toString(),
          setTier,
          from: fromLower,
          to: toLower,
          operator: operatorLower,
          contract: contractAddress,
          isSecondary: true,
          viaMarketplace: isMarketplaceAddress(operatorLower),
        },
      });
    }
  }
);

/**
 * Handle TransferBatch events
 * Tracks mints (from zero/distribution) and transfers (between users)
 */
export const handleMiberaSetsBatch = MiberaSets.TransferBatch.handler(
  async ({ event, context }) => {
    const { operator, from, to, ids, values } = event.params;
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();

    const contractAddress = event.srcAddress.toLowerCase();
    const operatorLower = operator.toLowerCase();
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;
    const txHash = event.transaction.hash;

    const idsArray = Array.from(ids);
    const valuesArray = Array.from(values);
    const length = Math.min(idsArray.length, valuesArray.length);

    // Check if this is a mint or a transfer
    const isMintEvent = isMintOrAirdrop(fromLower, AIRDROP_WALLETS);

    for (let index = 0; index < length; index += 1) {
      const rawId = idsArray[index];
      const rawValue = valuesArray[index];

      if (rawId === undefined || rawValue === undefined || rawValue === null) {
        continue;
      }

      const quantity = BigInt(rawValue.toString());
      if (quantity === 0n) {
        continue;
      }

      const tokenId = BigInt(rawId.toString());
      const eventId = `${txHash}_${event.logIndex}_${index}`;
      const setTier = getSetTier(tokenId);

      if (isMintEvent) {
        // Create mint event record
        const mintEvent: Erc1155MintEvent = {
          id: eventId,
          collectionKey: COLLECTION_KEY,
          tokenId,
          value: quantity,
          minter: toLower,
          operator: operatorLower,
          timestamp,
          blockNumber: BigInt(event.block.number),
          transactionHash: txHash,
          chainId,
        };

        context.Erc1155MintEvent.set(mintEvent);

        // Record mint action
        recordAction(context, {
          id: eventId,
          actionType: "mint1155",
          actor: toLower,
          primaryCollection: COLLECTION_KEY,
          timestamp,
          chainId,
          txHash,
          logIndex: event.logIndex,
          numeric1: quantity,
          numeric2: tokenId,
          context: {
            tokenId: tokenId.toString(),
            setTier,
            operator: operatorLower,
            contract: contractAddress,
            from: fromLower,
            batchIndex: index,
          },
        });

        // Events-pillar v1: publish one envelope per token in the batch.
        // Subject: nft.mint.detected.mibera-sets.v1. Fail-soft.
        await publishMintEvent({
          log: context.log,
          collectionSlug: "mibera-sets",
          payload: {
            chain_id: chainId,
            contract: contractAddress,
            token_id: tokenId.toString(),
            minter: toLower,
            block_number: event.block.number,
            transaction_hash: txHash,
            timestamp: new Date(Number(timestamp) * 1000).toISOString(),
          },
        });
      } else {
        // Record transfer action (secondary market / user-to-user)
        recordAction(context, {
          id: eventId,
          actionType: "transfer1155",
          actor: toLower,
          primaryCollection: COLLECTION_KEY,
          timestamp,
          chainId,
          txHash,
          logIndex: event.logIndex,
          numeric1: quantity,
          numeric2: tokenId,
          context: {
            tokenId: tokenId.toString(),
            setTier,
            from: fromLower,
            to: toLower,
            operator: operatorLower,
            contract: contractAddress,
            batchIndex: index,
            isSecondary: true,
            viaMarketplace: isMarketplaceAddress(operatorLower),
          },
        });
      }
    }
  }
);
