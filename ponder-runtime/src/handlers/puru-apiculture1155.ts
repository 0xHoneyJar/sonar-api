// ponder-runtime/src/handlers/puru-apiculture1155.ts
//
// PORTED FROM: src/handlers/puru-apiculture1155.ts (envio, source-of-truth)
// Contract: PuruApiculture1155 (ERC-1155 on Base, 4 deploys — multi-address).
//
// F-6 re-dispatch: ACTIVE. Contract registered in ponder.config.mibera.ts
// (Base 8453, 4 addresses: apiculture / elemental_jani / boarding_passes /
// introducing_kizuna).
//
// All 4 deploys share one PuruApiculture1155 contract entry in the ponder
// config (Ponder allows an `address: string[]` for multi-deploy contracts).
// The handler dispatches to a per-contract collection key via
// PURU_COLLECTION_KEYS lookup against event.log.address.
//
// Subject: nft.mint.detected.purupuru-apiculture.v1 (shared across all 4).

import { ponder } from "ponder:registry";
import { erc1155MintEvent, trackedHolder, action } from "../../ponder.schema";
import { isLiveEvent } from "../lib/sync-status";
import { reorgSafeEmit } from "../lib/reorg-safe-emit";
import { buildMintEnvelope } from "../lib/nats-publisher";
import { recordAction } from "../lib/record-action";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

// Verbatim port of envio src/handlers/puru-apiculture1155.ts:31-36.
const PURU_COLLECTION_KEYS: Record<string, string> = {
  "0x6cfb9280767a3596ee6af887d900014a755ffc75": "puru_apiculture",
  "0xcd3ab1b6e95cdb40a19286d863690eb407335b21": "puru_elemental_jani",
  "0x154a563ab6c037bd0f041ac91600ffa9fe2f5fa0": "puru_boarding_passes",
  "0x85a72eee14dcaa1ccc5616df39acde212280dccb": "puru_introducing_kizuna",
};

function getCollectionKey(contractAddress: string): string {
  return PURU_COLLECTION_KEYS[contractAddress] ?? contractAddress;
}

function isMintFromZero(from: string): boolean {
  return from.toLowerCase() === ZERO_ADDRESS;
}

function isBurnAddress(addr: string): boolean {
  const l = addr.toLowerCase();
  return l === ZERO_ADDRESS || l === DEAD_ADDRESS;
}

// ────────────────────────────────────────────────────────────────────────────
// TransferSingle
// ────────────────────────────────────────────────────────────────────────────
ponder.on("PuruApiculture1155:TransferSingle", async ({ event, context }) => {
  const { operator, from, to, id, value } = event.args;
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const tokenId = BigInt(id.toString());
  const quantity = BigInt(value.toString());
  if (quantity === 0n) return;

  const contractAddress = event.log.address.toLowerCase();
  const collectionKey = getCollectionKey(contractAddress);
  const operatorLower = operator.toLowerCase();
  const timestamp = event.block.timestamp;
  const chainId = context.chain.id;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;
  const eventId = `${txHash}_${logIndex}`;

  const isMint = isMintFromZero(fromLower);
  const isBurn = isBurnAddress(toLower) && !isMint;

  if (isMint) {
    await context.db
      .insert(erc1155MintEvent)
      .values({
        id: eventId,
        collectionKey,
        tokenId,
        value: quantity,
        minter: toLower as `0x${string}`,
        operator: operatorLower as `0x${string}`,
        timestamp,
        blockNumber: event.block.number,
        transactionHash: txHash as `0x${string}`,
        chainId,
      })
      .onConflictDoNothing();

    await recordAction(context, {
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

    if (await isLiveEvent(event, context as any)) {
      const envelope = buildMintEnvelope("purupuru-apiculture", {
        chain_id: chainId,
        contract: contractAddress,
        token_id: tokenId.toString(),
        minter: toLower,
        block_number: Number(event.block.number),
        transaction_hash: txHash,
        timestamp: new Date(Number(timestamp) * 1000).toISOString(),
      });
      await reorgSafeEmit(context, envelope, event, chainId);
    }
  } else if (isBurn) {
    await recordAction(context, {
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
    await recordAction(context, {
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

  // Holder tracking — adjust sender (non-mint) and receiver (non-burn).
  if (!isMint) {
    await adjustHolder1155(context, {
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
    await adjustHolder1155(context, {
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
});

// ────────────────────────────────────────────────────────────────────────────
// TransferBatch
// ────────────────────────────────────────────────────────────────────────────
ponder.on("PuruApiculture1155:TransferBatch", async ({ event, context }) => {
  const { operator, from, to, ids, values } = event.args;
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const contractAddress = event.log.address.toLowerCase();
  const collectionKey = getCollectionKey(contractAddress);
  const operatorLower = operator.toLowerCase();
  const timestamp = event.block.timestamp;
  const chainId = context.chain.id;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  const idsArray = Array.from(ids);
  const valuesArray = Array.from(values);
  const length = Math.min(idsArray.length, valuesArray.length);
  const isMint = isMintFromZero(fromLower);
  const isBurn = isBurnAddress(toLower) && !isMint;
  let totalQuantity = 0n;

  for (let index = 0; index < length; index += 1) {
    const rawId = idsArray[index];
    const rawValue = valuesArray[index];
    if (rawId === undefined || rawValue === undefined || rawValue === null) continue;
    const quantity = BigInt(rawValue.toString());
    if (quantity === 0n) continue;
    totalQuantity += quantity;

    const tokenId = BigInt(rawId.toString());
    const eventId = `${txHash}_${logIndex}_${index}`;

    if (isMint) {
      await context.db
        .insert(erc1155MintEvent)
        .values({
          id: eventId,
          collectionKey,
          tokenId,
          value: quantity,
          minter: toLower as `0x${string}`,
          operator: operatorLower as `0x${string}`,
          timestamp,
          blockNumber: event.block.number,
          transactionHash: txHash as `0x${string}`,
          chainId,
        })
        .onConflictDoNothing();

      await recordAction(context, {
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

      if (await isLiveEvent(event, context as any)) {
        const envelope = buildMintEnvelope("purupuru-apiculture", {
          chain_id: chainId,
          contract: contractAddress,
          token_id: tokenId.toString(),
          minter: toLower,
          block_number: Number(event.block.number),
          transaction_hash: txHash,
          timestamp: new Date(Number(timestamp) * 1000).toISOString(),
        });
        await reorgSafeEmit(context, envelope, event, chainId);
      }
    } else if (isBurn) {
      await recordAction(context, {
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
      await recordAction(context, {
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

  // Holder tracking — one adjustment per batch using accumulated total.
  if (totalQuantity > 0n) {
    if (!isMint) {
      await adjustHolder1155(context, {
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
      await adjustHolder1155(context, {
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
});

// ────────────────────────────────────────────────────────────────────────────
// adjustHolder1155 — verbatim port of envio's adjustHolder1155 (lines 381-445).
// Tracks per-(contract, chain, holder) NFT counts in trackedHolder.
// Emits a hold1155 action on every update for downstream cohort queries.
// ────────────────────────────────────────────────────────────────────────────
interface AdjustHolderArgs {
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

async function adjustHolder1155(context: any, args: AdjustHolderArgs): Promise<void> {
  if (args.delta === 0n) return;

  const address = args.holderAddress.toLowerCase();
  if (address === ZERO_ADDRESS) return;

  const id = `${args.contractAddress}_${args.chainId}_${address}`;
  const existing = await context.db.find(trackedHolder, { id });
  const currentCount = BigInt(existing?.tokenCount ?? 0);
  const nextCount = currentCount + args.delta;
  const tokenCount = nextCount < 0n ? 0 : Number(nextCount);

  const actionId = `${args.txHash}_${args.logIndex}_${args.direction}`;

  await recordAction(context, {
    id: actionId,
    actionType: "hold1155",
    actor: address,
    primaryCollection: args.collectionKey.toLowerCase(),
    timestamp: args.timestamp,
    chainId: args.chainId,
    txHash: args.txHash,
    logIndex: args.logIndex,
    numeric1: BigInt(tokenCount),
    context: {
      contract: args.contractAddress,
      collectionKey: args.collectionKey.toLowerCase(),
      tokenCount,
      direction: args.direction,
    },
  });

  if (nextCount <= 0n) {
    if (existing) {
      await context.db.delete(trackedHolder, { id });
    }
    return;
  }

  if (existing) {
    await context.db.update(trackedHolder, { id }).set({
      tokenCount: Number(nextCount),
    });
  } else {
    await context.db
      .insert(trackedHolder)
      .values({
        id,
        contract: args.contractAddress as `0x${string}`,
        collectionKey: args.collectionKey,
        chainId: args.chainId,
        address: address as `0x${string}`,
        tokenCount: Number(nextCount),
      })
      .onConflictDoNothing();
  }
}
