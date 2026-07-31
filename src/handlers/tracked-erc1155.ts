/*
 * The ERC-1155 lane. One handler, one binding, every chain — the ERC-721 lane's
 * shape, with a balance per (contract, chain, tokenId, wallet) instead of a
 * token count per wallet.
 *
 * No per-collection map and no allowlist: keys come from the registry, and
 * indexer.onEvent only delivers events for addresses bound in config.yaml, so
 * arrival already proves the collection is tracked.
 *
 * TransferSingle and TransferBatch share one path — a batch is folded to one
 * delta per tokenId first (see aggregateBatchDeltas for why summing matters).
 */
import { indexer, type EvmOnEventContext, type TrackedHolder1155 } from "envio";

import { recordAction } from "../lib/actions";
import { ZERO_ADDRESS, isBurnAddress } from "../lib/mint-detection";
import { collectionKeys, isCustodialAddress } from "../registry/contracts";
import {
  aggregateBatchDeltas,
  erc1155HolderId,
  nextBalance,
} from "../lib/erc1155-holder";

const ZERO = ZERO_ADDRESS.toLowerCase();

const COLLECTION_KEYS: Record<string, string> = collectionKeys("erc1155");

/** Fields both TransferSingle and TransferBatch carry. */
interface TransferMeta {
  contractAddress: string;
  collectionKey: string;
  chainId: number;
  from: string;
  to: string;
  txHash: string;
  logIndex: number;
  timestamp: bigint;
  blockNumber: bigint;
  transactionIndex: number | undefined;
}

type Erc1155Event = {
  srcAddress: string;
  chainId: number;
  logIndex: number | bigint;
  transaction: { hash: string; transactionIndex?: number | bigint };
  block: { timestamp: number | bigint; number: number | bigint };
};

function meta(event: Erc1155Event, from: string, to: string): TransferMeta {
  const contractAddress = event.srcAddress.toLowerCase();
  return {
    contractAddress,
    collectionKey: (COLLECTION_KEYS[contractAddress] ?? contractAddress).toLowerCase(),
    chainId: event.chainId,
    from: from.toLowerCase(),
    to: to.toLowerCase(),
    txHash: event.transaction.hash,
    logIndex: Number(event.logIndex),
    timestamp: BigInt(event.block.timestamp),
    blockNumber: BigInt(event.block.number),
    transactionIndex:
      event.transaction.transactionIndex === undefined
        ? undefined
        : Number(event.transaction.transactionIndex),
  };
}

/**
 * Apply one (tokenId, quantity) leg: debit `from`, credit `to`, and emit the
 * matching Action. `seq` disambiguates legs within a batch so two tokenIds in
 * one log cannot collide on an Action id.
 */
async function applyLeg(
  context: EvmOnEventContext,
  m: TransferMeta,
  tokenId: bigint,
  quantity: bigint,
  seq: number,
): Promise<void> {
  if (quantity <= 0n) return;

  const isMint = m.from === ZERO;
  const isBurn = isBurnAddress(m.to) && !isMint;

  // Custody, not ownership — mirrors the ERC-721 lane: a deposit into a staking
  // vault leaves the depositor holding, so neither balance moves.
  const depositToCustody = isCustodialAddress(m.chainId, m.to) && !isMint;
  const withdrawFromCustody = isCustodialAddress(m.chainId, m.from) && m.to !== ZERO;
  const custodyMove = depositToCustody || withdrawFromCustody;

  const actionType = isMint ? "mint1155" : isBurn ? "burn1155" : "transfer1155";
  recordAction(context, {
    id: `${m.txHash}_${m.logIndex}_${seq}_${actionType}`,
    actionType,
    actor: isBurn ? m.from : m.to,
    primaryCollection: m.collectionKey,
    timestamp: m.timestamp,
    chainId: m.chainId,
    txHash: m.txHash,
    logIndex: m.logIndex,
    blockNumber: m.blockNumber,
    transactionIndex: m.transactionIndex,
    numeric1: quantity,
    context: {
      tokenId: tokenId.toString(),
      contract: m.contractAddress,
      from: m.from,
      to: m.to,
      quantity: quantity.toString(),
    },
  });

  if (custodyMove) return;

  if (!isMint) await adjustBalance(context, m, tokenId, -quantity, seq, "out");
  if (!isBurn && m.to !== ZERO) await adjustBalance(context, m, tokenId, quantity, seq, "in");
}

async function adjustBalance(
  context: EvmOnEventContext,
  m: TransferMeta,
  tokenId: bigint,
  delta: bigint,
  seq: number,
  direction: "in" | "out",
): Promise<void> {
  const address = direction === "in" ? m.to : m.from;
  if (address === ZERO) return;

  const id = erc1155HolderId(m.contractAddress, m.chainId, tokenId, address);
  const existing = await context.TrackedHolder1155.get(id);
  const { stored, shouldDelete } = nextBalance(existing?.balance ?? 0n, delta);

  recordAction(context, {
    id: `${m.txHash}_${m.logIndex}_${seq}_${direction}`,
    actionType: "hold1155",
    actor: address,
    primaryCollection: m.collectionKey,
    timestamp: m.timestamp,
    chainId: m.chainId,
    txHash: m.txHash,
    logIndex: m.logIndex,
    blockNumber: m.blockNumber,
    transactionIndex: m.transactionIndex,
    numeric1: stored,
    context: {
      contract: m.contractAddress,
      collectionKey: m.collectionKey,
      tokenId: tokenId.toString(),
      balance: stored.toString(),
      direction,
    },
  });

  if (shouldDelete) {
    if (existing) context.TrackedHolder1155.deleteUnsafe(id);
    return;
  }

  const row: TrackedHolder1155 = {
    id,
    contract: m.contractAddress,
    collectionKey: m.collectionKey,
    chainId: m.chainId,
    tokenId,
    address,
    balance: stored,
    lastUpdated: m.timestamp,
  };
  context.TrackedHolder1155.set(row);
}

indexer.onEvent(
  { contract: "TrackedErc1155", event: "TransferSingle" },
  async ({ event, context }) => {
    const { from, to, id, value } = event.params;
    const m = meta(event as unknown as Erc1155Event, from, to);
    if (m.from !== ZERO && m.to !== ZERO) {
      await Promise.all([
        context.TrackedHolder1155.get(
          erc1155HolderId(m.contractAddress, m.chainId, BigInt(id.toString()), m.from),
        ),
        context.TrackedHolder1155.get(
          erc1155HolderId(m.contractAddress, m.chainId, BigInt(id.toString()), m.to),
        ),
      ]);
    }
    if ((context as any).isPreload) return;
    await applyLeg(context, m, BigInt(id.toString()), BigInt(value.toString()), 0);
  },
);

indexer.onEvent(
  { contract: "TrackedErc1155", event: "TransferBatch" },
  async ({ event, context }) => {
    const { from, to, ids, values } = event.params;
    const m = meta(event as unknown as Erc1155Event, from, to);
    const deltas = aggregateBatchDeltas(
      (ids as readonly unknown[]).map((v) => BigInt(v!.toString())),
      (values as readonly unknown[]).map((v) => BigInt(v!.toString())),
    );

    if (m.from !== ZERO && m.to !== ZERO) {
      await Promise.all(
        [...deltas.keys()].flatMap((tokenId) => [
          context.TrackedHolder1155.get(
            erc1155HolderId(m.contractAddress, m.chainId, tokenId, m.from),
          ),
          context.TrackedHolder1155.get(
            erc1155HolderId(m.contractAddress, m.chainId, tokenId, m.to),
          ),
        ]),
      );
    }
    if ((context as any).isPreload) return;

    let seq = 0;
    for (const [tokenId, quantity] of deltas) {
      await applyLeg(context, m, tokenId, quantity, seq);
      seq += 1;
    }
  },
);
