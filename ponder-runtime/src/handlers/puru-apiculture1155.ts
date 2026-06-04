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
import { erc1155MintEvent, trackedHolder, trackedHolder1155, action } from "../../ponder.schema";
import { erc1155HolderId, nextBalance, aggregateBatchDeltas } from "../lib/erc1155-holder";
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

  // Per-tokenId holder tracking (sonar-api#62) — the per-edition twin of the
  // whole-contract rollup above, keyed one notch finer by tokenId. A genuine
  // self-transfer (from===to, never a mint or burn) leaves every per-edition
  // balance unchanged, so skip it — this also sidesteps running the sender and
  // receiver legs against the same row within one event.
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

  // Per-tokenId holder tracking (sonar-api#62) — sum per tokenId first so each
  // edition's balance row is touched exactly once, even if the batch repeats an
  // id. Skip genuine self-transfers (from===to): they leave every per-edition
  // balance unchanged. idsArray/valuesArray are already bigint[] (ponder decodes
  // the uint256[] args); aggregateBatchDeltas guards length-mismatch + zero.
  if (fromLower !== toLower) {
    const perTokenDeltas = aggregateBatchDeltas(idsArray, valuesArray);
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

// ────────────────────────────────────────────────────────────────────────────
// adjustHolder1155Token — per-tokenId twin of adjustHolder1155 (sonar-api#62).
// Maintains trackedHolder1155 ({contract}_{chainId}_{tokenId}_{address} → balance)
// with the same floor-at-zero + delete-on-empty running-balance rule, keyed one
// notch finer. No hold1155 action is emitted: the events surface is unchanged;
// only the balance/holder side gains tokenId granularity (issue #62 "events stay
// exactly as they are"). balance is uint256-safe bigint (numeric(78,0)).
// ────────────────────────────────────────────────────────────────────────────
interface AdjustHolderTokenArgs {
  contractAddress: string;
  collectionKey: string;
  chainId: number;
  tokenId: bigint;
  holderAddress: string;
  delta: bigint;
  timestamp: bigint;
}

async function adjustHolder1155Token(context: any, args: AdjustHolderTokenArgs): Promise<void> {
  if (args.delta === 0n) return;

  const address = args.holderAddress.toLowerCase();
  if (address === ZERO_ADDRESS) return;

  const id = erc1155HolderId(args.contractAddress, args.chainId, args.tokenId, address);
  const existing = await context.db.find(trackedHolder1155, { id });
  // balance is numeric(78,0, mode:"bigint") → ponder returns a native bigint.
  const current = existing ? existing.balance : 0n;
  const { stored, shouldDelete } = nextBalance(current, args.delta);

  if (shouldDelete) {
    if (existing) {
      await context.db.delete(trackedHolder1155, { id });
    }
    return;
  }

  if (existing) {
    await context.db.update(trackedHolder1155, { id }).set({
      balance: stored,
      lastUpdated: args.timestamp,
    });
  } else {
    await context.db
      .insert(trackedHolder1155)
      .values({
        id,
        contract: args.contractAddress as `0x${string}`,
        collectionKey: args.collectionKey,
        chainId: args.chainId,
        tokenId: args.tokenId,
        address: address as `0x${string}`,
        balance: stored,
        lastUpdated: args.timestamp,
      })
      .onConflictDoNothing();
  }
}
