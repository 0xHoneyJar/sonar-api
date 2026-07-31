/*
 * The ERC-20 lane. One handler, one binding, every chain — balance per
 * (wallet, token, chain).
 *
 * Deliberately plain: balances and an Action stream, nothing else. The handler
 * this replaces carried per-token feature flags (burn-source attribution, holder
 * stats) that were specific to one token and made up ~80% of its size. Those are
 * product features, not indexer infrastructure; if they come back they come back
 * as their own thing, not as branches here.
 *
 * WARNING: ERC-20's Transfer shares a topic0 with ERC-721's. The two differ only
 * in whether the third argument is indexed, so a contract registered under the
 * wrong `standard` decodes into garbage rather than failing. The registry test
 * asserts no address is registered under two standards on one chain.
 */
import { indexer, type EvmOnEventContext, type TrackedTokenBalance } from "envio";

import { recordAction } from "../lib/actions";
import { ZERO_ADDRESS, isBurnAddress } from "../lib/mint-detection";
import { collectionKeys } from "../registry/contracts";

const ZERO = ZERO_ADDRESS.toLowerCase();

const TOKEN_KEYS: Record<string, string> = collectionKeys("erc20");

/** Balance row key: one row per (wallet, token, chain). */
function balanceId(address: string, token: string, chainId: number): string {
  return `${address}_${token}_${chainId}`;
}

interface AdjustArgs {
  context: EvmOnEventContext;
  address: string;
  token: string;
  tokenKey: string;
  chainId: number;
  delta: bigint;
  timestamp: bigint;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  transactionIndex: number | undefined;
  direction: "in" | "out";
}

async function adjustBalance(a: AdjustArgs): Promise<void> {
  if (a.address === ZERO) return;

  const id = balanceId(a.address, a.token, a.chainId);
  const existing = await a.context.TrackedTokenBalance.get(id);
  const raw = (existing?.balance ?? 0n) + a.delta;
  // A balance at or below zero deletes the row: an absent row and a zero row
  // must not both mean "holds none", or holder counts double-count.
  const stored = raw > 0n ? raw : 0n;

  recordAction(a.context, {
    id: `${a.txHash}_${a.logIndex}_${a.direction}`,
    actionType: "hold20",
    actor: a.address,
    primaryCollection: a.tokenKey,
    timestamp: a.timestamp,
    chainId: a.chainId,
    txHash: a.txHash,
    logIndex: a.logIndex,
    blockNumber: a.blockNumber,
    transactionIndex: a.transactionIndex,
    numeric1: stored,
    context: {
      token: a.token,
      tokenKey: a.tokenKey,
      balance: stored.toString(),
      direction: a.direction,
    },
  });

  if (raw <= 0n) {
    if (existing) a.context.TrackedTokenBalance.deleteUnsafe(id);
    return;
  }

  const row: TrackedTokenBalance = {
    id,
    address: a.address,
    tokenAddress: a.token,
    tokenKey: a.tokenKey,
    chainId: a.chainId,
    balance: stored,
    lastUpdated: a.timestamp,
  };
  a.context.TrackedTokenBalance.set(row);
}

indexer.onEvent(
  { contract: "TrackedErc20", event: "Transfer" },
  async ({ event, context }) => {
    const { from, to, value } = event.params;
    const token = event.srcAddress.toLowerCase();
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();
    const chainId = event.chainId;

    if (fromLower !== ZERO && toLower !== ZERO) {
      await Promise.all([
        context.TrackedTokenBalance.get(balanceId(fromLower, token, chainId)),
        context.TrackedTokenBalance.get(balanceId(toLower, token, chainId)),
      ]);
    }
    if ((context as any).isPreload) return;

    const amount = BigInt(value.toString());
    if (amount === 0n) return;

    const tokenKey = (TOKEN_KEYS[token] ?? token).toLowerCase();
    const timestamp = BigInt(event.block.timestamp);
    const blockNumber = BigInt(event.block.number);
    const txHash = event.transaction.hash;
    const logIndex = Number(event.logIndex);
    const transactionIndex =
      (event.transaction as { transactionIndex?: number | bigint }).transactionIndex === undefined
        ? undefined
        : Number((event.transaction as { transactionIndex?: number | bigint }).transactionIndex);

    const isMint = fromLower === ZERO;
    const isBurn = isBurnAddress(toLower) && !isMint;

    const actionType = isMint ? "mint20" : isBurn ? "burn20" : "transfer20";
    recordAction(context, {
      id: `${txHash}_${logIndex}_${actionType}`,
      actionType,
      actor: isBurn ? fromLower : toLower,
      primaryCollection: tokenKey,
      timestamp,
      chainId,
      txHash,
      logIndex,
      blockNumber,
      transactionIndex,
      numeric1: amount,
      context: { token, from: fromLower, to: toLower, amount: amount.toString() },
    });

    const common = {
      context,
      token,
      tokenKey,
      chainId,
      timestamp,
      txHash,
      logIndex,
      blockNumber,
      transactionIndex,
    };
    if (!isMint) {
      await adjustBalance({ ...common, address: fromLower, delta: -amount, direction: "out" });
    }
    if (!isBurn && toLower !== ZERO) {
      await adjustBalance({ ...common, address: toLower, delta: amount, direction: "in" });
    }
  },
);
