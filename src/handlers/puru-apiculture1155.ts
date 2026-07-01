/*
 * Purupuru ERC-1155 tracking on Base.
 *
 * Handles all THJ APAC / Purupuru ERC-1155 collections:
 * - Apiculture Szn 0 (Zora platform, token ID 4 = Purupuru edition)
 * - Elemental Jani (party.app, 13 token IDs)
 * - Boarding Passes (party.app, 4 token IDs)
 * - Introducing Kizuna (party.app, 11 token IDs)
 *
 * Tracks:
 * - Mints: transfers from zero address (mint1155 action + Erc1155MintEvent)
 * - Burns: transfers to zero/dead address (burn1155 action)
 * - Transfers: all other transfers between users (transfer1155 action)
 * - Holders: aggregate token count per wallet per contract (TrackedHolder + hold1155 action)
 */

import {
  indexer,
  type Erc1155MintEvent,
  type TrackedHolder as TrackedHolderEntity,
  type TrackedHolder1155 as TrackedHolder1155Entity,
  type EvmOnEventContext,
} from "envio";

import { recordAction } from "../lib/actions";
import { publishMintEvent } from "../lib/events-publisher";
import { isMintFromZero, isBurnAddress } from "../lib/mint-detection";
import {
  aggregateBatchDeltas,
  erc1155HolderId,
  nextBalance,
} from "../lib/erc1155-holder";
import { touchAddress } from "../lib/touch-address";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Collection key mapping — each contract gets its own key for action tracking
const PURU_COLLECTION_KEYS: Record<string, string> = {
  "0x6cfb9280767a3596ee6af887d900014a755ffc75": "puru_apiculture",
  "0xcd3ab1b6e95cdb40a19286d863690eb407335b21": "puru_elemental_jani",
  "0x154a563ab6c037bd0f041ac91600ffa9fe2f5fa0": "puru_boarding_passes",
  "0x85a72eee14dcaa1ccc5616df39acde212280dccb": "puru_introducing_kizuna",
};

function getCollectionKey(contractAddress: string): string {
  return PURU_COLLECTION_KEYS[contractAddress] ?? contractAddress;
}

/**
 * Handle TransferSingle events
 */
indexer.onEvent({ contract: "PuruApiculture1155", event: "TransferSingle" },
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
    const collectionKey = getCollectionKey(contractAddress);
    const operatorLower = operator.toLowerCase();
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;
    const txHash = event.transaction.hash;
    const logIndex = event.logIndex;
    const eventId = `${txHash}_${logIndex}`;

    const isMint = isMintFromZero(fromLower);
    const isBurn = isBurnAddress(toLower) && !isMint;

    if (isMint) {
      context.Erc1155MintEvent.set({
        id: eventId,
        collectionKey,
        tokenId,
        value: quantity,
        minter: toLower,
        operator: operatorLower,
        timestamp,
        blockNumber: BigInt(event.block.number),
        transactionHash: txHash,
        chainId,
      });

      recordAction(context, {
        id: eventId,
        actionType: "mint1155",
        actor: toLower,
        primaryCollection: collectionKey,
        timestamp,
        chainId,
        txHash,
        logIndex,
        numeric1: quantity,
        numeric2: tokenId,
        context: {
          tokenId: tokenId.toString(),
          operator: operatorLower,
          contract: contractAddress,
          from: fromLower,
        },
      });

      // Events-pillar v1: publish PuruPuru ERC-1155 mint envelope. All 4
      // puru-family contracts (apiculture, elemental_jani, boarding_passes,
      // introducing_kizuna) share the single `purupuru-apiculture.v1` subject
      // per the build doc — per-contract discrimination is the consumer's
      // job via the `contract` payload field. Fail-soft.
      await publishMintEvent({
        log: context.log,
        collectionSlug: "purupuru-apiculture",
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
    } else if (isBurn) {
      recordAction(context, {
        id: eventId,
        actionType: "burn1155",
        actor: fromLower,
        primaryCollection: collectionKey,
        timestamp,
        chainId,
        txHash,
        logIndex,
        numeric1: quantity,
        numeric2: tokenId,
        context: {
          tokenId: tokenId.toString(),
          contract: contractAddress,
          burnAddress: toLower,
        },
      });
    } else {
      recordAction(context, {
        id: eventId,
        actionType: "transfer1155",
        actor: toLower,
        primaryCollection: collectionKey,
        timestamp,
        chainId,
        txHash,
        logIndex,
        numeric1: quantity,
        numeric2: tokenId,
        context: {
          tokenId: tokenId.toString(),
          from: fromLower,
          to: toLower,
          operator: operatorLower,
          contract: contractAddress,
        },
      });
    }

    // Holder tracking — adjust sender and receiver counts
    if (!isMint) {
      await adjustHolder1155({
        context,
        contractAddress,
        collectionKey,
        chainId,
        holderAddress: fromLower,
        delta: -quantity,
        txHash,
        logIndex,
        timestamp,
        direction: "out",
      });
    }

    if (!isBurnAddress(toLower)) {
      await adjustHolder1155({
        context,
        contractAddress,
        collectionKey,
        chainId,
        holderAddress: toLower,
        delta: quantity,
        txHash,
        logIndex,
        timestamp,
        direction: "in",
      });
    }

    if (fromLower !== toLower) {
      if (!isMint) {
        await adjustHolder1155Token(context, {
          contractAddress,
          collectionKey,
          chainId,
          tokenId,
          holderAddress: fromLower,
          delta: -quantity,
          timestamp,
        });
      }
      if (!isBurnAddress(toLower)) {
        await adjustHolder1155Token(context, {
          contractAddress,
          collectionKey,
          chainId,
          tokenId,
          holderAddress: toLower,
          delta: quantity,
          timestamp,
        });
      }
    }

    await touchAddress(context, chainId, fromLower);
    if (!isBurnAddress(toLower)) {
      await touchAddress(context, chainId, toLower);
    }
  }
);

/**
 * Handle TransferBatch events
 */
indexer.onEvent({ contract: "PuruApiculture1155", event: "TransferBatch" },
  async ({ event, context }) => {
    const { operator, from, to, ids, values } = event.params;
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();

    const contractAddress = event.srcAddress.toLowerCase();
    const collectionKey = getCollectionKey(contractAddress);
    const operatorLower = operator.toLowerCase();
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;
    const txHash = event.transaction.hash;
    const logIndex = event.logIndex;

    const idsArray = Array.from(ids);
    const valuesArray = Array.from(values);
    const length = Math.min(idsArray.length, valuesArray.length);

    const isMint = isMintFromZero(fromLower);
    const isBurn = isBurnAddress(toLower) && !isMint;

    // Accumulate total quantity across all token IDs for holder tracking
    let totalQuantity = 0n;

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

      totalQuantity += quantity;

      const tokenId = BigInt(rawId.toString());
      const eventId = `${txHash}_${logIndex}_${index}`;

      if (isMint) {
        context.Erc1155MintEvent.set({
          id: eventId,
          collectionKey,
          tokenId,
          value: quantity,
          minter: toLower,
          operator: operatorLower,
          timestamp,
          blockNumber: BigInt(event.block.number),
          transactionHash: txHash,
          chainId,
        });

        recordAction(context, {
          id: eventId,
          actionType: "mint1155",
          actor: toLower,
          primaryCollection: collectionKey,
          timestamp,
          chainId,
          txHash,
          logIndex,
          numeric1: quantity,
          numeric2: tokenId,
          context: {
            tokenId: tokenId.toString(),
            operator: operatorLower,
            contract: contractAddress,
            from: fromLower,
            batchIndex: index,
          },
        });

        // Events-pillar v1: publish one envelope per token in the batch.
        // Subject: nft.mint.detected.purupuru-apiculture.v1. Fail-soft.
        await publishMintEvent({
          log: context.log,
          collectionSlug: "purupuru-apiculture",
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
      } else if (isBurn) {
        recordAction(context, {
          id: eventId,
          actionType: "burn1155",
          actor: fromLower,
          primaryCollection: collectionKey,
          timestamp,
          chainId,
          txHash,
          logIndex,
          numeric1: quantity,
          numeric2: tokenId,
          context: {
            tokenId: tokenId.toString(),
            contract: contractAddress,
            burnAddress: toLower,
            batchIndex: index,
          },
        });
      } else {
        recordAction(context, {
          id: eventId,
          actionType: "transfer1155",
          actor: toLower,
          primaryCollection: collectionKey,
          timestamp,
          chainId,
          txHash,
          logIndex,
          numeric1: quantity,
          numeric2: tokenId,
          context: {
            tokenId: tokenId.toString(),
            from: fromLower,
            to: toLower,
            operator: operatorLower,
            contract: contractAddress,
            batchIndex: index,
          },
        });
      }
    }

    // Holder tracking — adjust once per batch using accumulated total
    if (totalQuantity > 0n) {
      if (!isMint) {
        await adjustHolder1155({
          context,
          contractAddress,
          collectionKey,
          chainId,
          holderAddress: fromLower,
          delta: -totalQuantity,
          txHash,
          logIndex,
          timestamp,
          direction: "out",
        });
      }

      if (!isBurnAddress(toLower)) {
        await adjustHolder1155({
          context,
          contractAddress,
          collectionKey,
          chainId,
          holderAddress: toLower,
          delta: totalQuantity,
          txHash,
          logIndex,
          timestamp,
          direction: "in",
        });
      }
    }

    if (fromLower !== toLower) {
      const perTokenDeltas = aggregateBatchDeltas(
        idsArray.map((id) => BigInt(id.toString())),
        valuesArray.map((value) => BigInt(value.toString())),
      );
      for (const [tokenId, qty] of perTokenDeltas) {
        if (!isMint) {
          await adjustHolder1155Token(context, {
            contractAddress,
            collectionKey,
            chainId,
            tokenId,
            holderAddress: fromLower,
            delta: -qty,
            timestamp,
          });
        }
        if (!isBurnAddress(toLower)) {
          await adjustHolder1155Token(context, {
            contractAddress,
            collectionKey,
            chainId,
            tokenId,
            holderAddress: toLower,
            delta: qty,
            timestamp,
          });
        }
      }
    }

    await touchAddress(context, chainId, fromLower);
    if (!isBurnAddress(toLower)) {
      await touchAddress(context, chainId, toLower);
    }
  }
);

// --- Holder tracking ---

interface AdjustHolder1155Args {
  context: EvmOnEventContext;
  contractAddress: string;
  collectionKey: string;
  chainId: number;
  holderAddress: string;
  delta: bigint;
  txHash: string;
  logIndex: number;
  timestamp: bigint;
  direction: "in" | "out";
}

async function adjustHolder1155({
  context,
  contractAddress,
  collectionKey,
  chainId,
  holderAddress,
  delta,
  txHash,
  logIndex,
  timestamp,
  direction,
}: AdjustHolder1155Args) {
  if (delta === 0n) {
    return;
  }

  const address = holderAddress.toLowerCase();
  if (address === ZERO_ADDRESS) {
    return;
  }

  const id = `${contractAddress}_${chainId}_${address}`;
  const existing = await context.TrackedHolder.get(id);
  const currentCount = BigInt(existing?.tokenCount ?? 0);
  const nextCount = currentCount + delta;
  const tokenCount = nextCount < 0n ? 0 : Number(nextCount);

  const actionId = `${txHash}_${logIndex}_${direction}`;

  recordAction(context, {
    id: actionId,
    actionType: "hold1155",
    actor: address,
    primaryCollection: collectionKey.toLowerCase(),
    timestamp,
    chainId,
    txHash,
    logIndex,
    numeric1: BigInt(tokenCount),
    context: {
      contract: contractAddress,
      collectionKey: collectionKey.toLowerCase(),
      tokenCount,
      direction,
    },
  });

  if (nextCount <= 0n) {
    if (existing) {
      context.TrackedHolder.deleteUnsafe(id);
    }
    return;
  }

  const holder: TrackedHolderEntity = {
    id,
    contract: contractAddress,
    collectionKey,
    chainId,
    address,
    tokenCount: Number(nextCount),
  };

  context.TrackedHolder.set(holder);
}

interface AdjustHolderTokenArgs {
  contractAddress: string;
  collectionKey: string;
  chainId: number;
  tokenId: bigint;
  holderAddress: string;
  delta: bigint;
  timestamp: bigint;
}

async function adjustHolder1155Token(
  context: EvmOnEventContext,
  args: AdjustHolderTokenArgs,
): Promise<void> {
  if (args.delta === 0n) return;

  const address = args.holderAddress.toLowerCase();
  if (address === ZERO_ADDRESS) return;

  const id = erc1155HolderId(
    args.contractAddress,
    args.chainId,
    args.tokenId,
    address,
  );
  const existing = await context.TrackedHolder1155.get(id);
  const current = existing?.balance ?? 0n;
  const { stored, shouldDelete } = nextBalance(current, args.delta);

  if (shouldDelete && current + args.delta < 0n) {
    context.log.warn(
      `[puru-apiculture1155] TrackedHolder1155 underflow clamp contract=${args.contractAddress} chain=${args.chainId} tokenId=${args.tokenId.toString()} holder=${address} current=${current.toString()} delta=${args.delta.toString()}`,
    );
  }

  if (shouldDelete) {
    if (existing) {
      context.TrackedHolder1155.deleteUnsafe(id);
    }
    return;
  }

  const row: TrackedHolder1155Entity = {
    id,
    contract: args.contractAddress,
    collectionKey: args.collectionKey,
    chainId: args.chainId,
    tokenId: args.tokenId,
    address,
    balance: stored,
    lastUpdated: args.timestamp,
  };

  context.TrackedHolder1155.set(row);
}
