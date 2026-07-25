/*
 * Generic ERC-1155 holder tracking for Kitchen-admitted collections.
 *
 * The ERC-721 sibling is tracked-erc721.ts; this is the same shape for the
 * `TrackedErc1155` / `EthTrackedErc1155` belt contracts that Kitchen's config
 * patcher appends addresses to.
 *
 * SEMANTIC DIFFERENCE from the ERC-721 path — ERC-1155 balances are per-id and
 * NON-EXCLUSIVE. Many wallets hold the same tokenId at once, so there is no
 * single owner per token and this handler deliberately never writes the
 * one-owner-per-tokenId `Token` entity. Forcing 1155 data into that shape is
 * exactly the wrong answer this work exists to undo.
 *
 * Writes:
 * - TrackedHolder1155 — per-(contract, chain, tokenId, wallet) balance
 * - TrackedHolder     — per-(contract, chain, wallet) aggregate unit count, the
 *                       row Kitchen's collection-status seam aggregates over
 */

import {
  indexer,
  type EvmOnEventContext,
  type TrackedHolder as TrackedHolderEntity,
  type TrackedHolder1155 as TrackedHolder1155Entity,
} from "envio";

import { ZERO_ADDRESS } from "./constants";
import { isBurnAddress } from "../lib/mint-detection";
import {
  aggregateBatchDeltas,
  erc1155HolderId,
  nextBalance,
} from "../lib/erc1155-holder";

const ZERO = ZERO_ADDRESS.toLowerCase();

/** Structural shapes shared by TrackedErc1155 + EthTrackedErc1155 (identical ABI),
 *  kept structural so ONE handler serves both registrations — see tracked-erc721.ts. */
type TransferSingleEvent = {
  srcAddress: string;
  chainId: number;
  params: { from: string; to: string; id: bigint; value: bigint };
  block: { timestamp: number | bigint };
};

type TransferBatchEvent = {
  srcAddress: string;
  chainId: number;
  params: { from: string; to: string; ids: readonly bigint[]; values: readonly bigint[] };
  block: { timestamp: number | bigint };
};

export async function handleTrackedErc1155TransferSingle(
  event: TransferSingleEvent,
  context: EvmOnEventContext,
): Promise<void> {
  const quantity = BigInt(event.params.value.toString());
  if (quantity === 0n) return;

  await applyDeltas({
    context,
    contractAddress: event.srcAddress.toLowerCase(),
    chainId: event.chainId,
    from: event.params.from.toLowerCase(),
    to: event.params.to.toLowerCase(),
    perToken: new Map([[BigInt(event.params.id.toString()), quantity]]),
    timestamp: BigInt(event.block.timestamp),
  });
}

export async function handleTrackedErc1155TransferBatch(
  event: TransferBatchEvent,
  context: EvmOnEventContext,
): Promise<void> {
  // aggregateBatchDeltas drops zero-value entries and folds repeated ids, so a
  // batch carrying the same id twice moves the balance once by the sum.
  const perToken = aggregateBatchDeltas(
    event.params.ids.map((id) => BigInt(id.toString())),
    event.params.values.map((value) => BigInt(value.toString())),
  );
  if (perToken.size === 0) return;

  await applyDeltas({
    context,
    contractAddress: event.srcAddress.toLowerCase(),
    chainId: event.chainId,
    from: event.params.from.toLowerCase(),
    to: event.params.to.toLowerCase(),
    perToken,
    timestamp: BigInt(event.block.timestamp),
  });
}

indexer.onEvent(
  { contract: "TrackedErc1155", event: "TransferSingle" },
  ({ event, context }) => handleTrackedErc1155TransferSingle(event, context),
);
indexer.onEvent(
  { contract: "TrackedErc1155", event: "TransferBatch" },
  ({ event, context }) => handleTrackedErc1155TransferBatch(event, context),
);
indexer.onEvent(
  { contract: "EthTrackedErc1155", event: "TransferSingle" },
  ({ event, context }) => handleTrackedErc1155TransferSingle(event, context),
);
indexer.onEvent(
  { contract: "EthTrackedErc1155", event: "TransferBatch" },
  ({ event, context }) => handleTrackedErc1155TransferBatch(event, context),
);

interface ApplyDeltasArgs {
  context: EvmOnEventContext;
  contractAddress: string;
  chainId: number;
  from: string;
  to: string;
  /** tokenId → units moved from `from` to `to`. Always positive. */
  perToken: ReadonlyMap<bigint, bigint>;
  timestamp: bigint;
}

/**
 * Debit the sender and credit the recipient, per tokenId and in aggregate.
 * Mints (from zero) skip the debit; burns (to zero/dead) skip the credit —
 * the zero and burn addresses are not holders.
 */
async function applyDeltas(args: ApplyDeltasArgs): Promise<void> {
  // A self-transfer is a no-op that would otherwise debit and credit the same
  // row in sequence, briefly deleting it at zero.
  if (args.from === args.to) return;

  const debit = args.from !== ZERO;
  const credit = !isBurnAddress(args.to);

  let total = 0n;
  for (const [tokenId, quantity] of args.perToken) {
    total += quantity;
    if (debit) {
      await adjustTokenBalance(args, tokenId, args.from, -quantity);
    }
    if (credit) {
      await adjustTokenBalance(args, tokenId, args.to, quantity);
    }
  }

  if (total === 0n) return;
  if (debit) await adjustAggregate(args, args.from, -total);
  if (credit) await adjustAggregate(args, args.to, total);
}

async function adjustTokenBalance(
  args: ApplyDeltasArgs,
  tokenId: bigint,
  holderAddress: string,
  delta: bigint,
): Promise<void> {
  if (delta === 0n) return;
  const address = holderAddress.toLowerCase();
  if (address === ZERO) return;

  const id = erc1155HolderId(args.contractAddress, args.chainId, tokenId, address);
  const existing = await args.context.TrackedHolder1155.get(id);
  const current = existing?.balance ?? 0n;
  const { stored, shouldDelete } = nextBalance(current, delta);

  if (current + delta < 0n) {
    context_warn(
      args.context,
      `TrackedHolder1155 underflow clamp contract=${args.contractAddress} chain=${args.chainId} tokenId=${tokenId.toString()} holder=${address} current=${current.toString()} delta=${delta.toString()}`,
    );
  }

  if (shouldDelete) {
    if (existing) args.context.TrackedHolder1155.deleteUnsafe(id);
    return;
  }

  const row: TrackedHolder1155Entity = {
    id,
    contract: args.contractAddress,
    // Generic path: the on-chain contract address IS the collection key. Named
    // keys stay the business of the bespoke handlers that own those contracts.
    collectionKey: args.contractAddress,
    chainId: args.chainId,
    tokenId,
    address,
    balance: stored,
    lastUpdated: args.timestamp,
  };
  args.context.TrackedHolder1155.set(row);
}

/**
 * Aggregate unit count per wallet. This is the row Kitchen's status seam counts
 * (TrackedHolder_aggregate), so a 1155 collection reports a holder graph the
 * same way a 721 one does.
 */
async function adjustAggregate(
  args: ApplyDeltasArgs,
  holderAddress: string,
  delta: bigint,
): Promise<void> {
  if (delta === 0n) return;
  const address = holderAddress.toLowerCase();
  if (address === ZERO) return;

  const id = `${args.contractAddress}_${args.chainId}_${address}`;
  const existing = await args.context.TrackedHolder.get(id);
  const current = BigInt(existing?.tokenCount ?? 0);
  const { stored, shouldDelete } = nextBalance(current, delta);

  if (shouldDelete) {
    if (existing) args.context.TrackedHolder.deleteUnsafe(id);
    return;
  }

  const holder: TrackedHolderEntity = {
    id,
    contract: args.contractAddress,
    collectionKey: args.contractAddress,
    chainId: args.chainId,
    address,
    tokenCount: Number(stored),
  };
  args.context.TrackedHolder.set(holder);
}

/** context.log is present at runtime but absent from some generated contexts. */
function context_warn(context: EvmOnEventContext, message: string): void {
  context.log?.warn?.(`[tracked-erc1155] ${message}`);
}
