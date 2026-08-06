/*
 * The ERC-20 lane. One handler, one binding, every chain — balance per
 * (wallet, token, chain).
 *
 * Deliberately plain: balances ONLY, no Action stream. The per-event rows
 * (transfer20/hold20/mint20) were removed 2026-08-06: at 24% of a full sync
 * they were ~3 rows per Transfer and 44 GB of a 44 GB database, and their only
 * would-be consumer (score-api) ingests erc20 communities as holdings
 * snapshots off TrackedTokenBalance, never as bronze events. Balances lose no
 * accuracy — every transfer is still processed, just not persisted as a row.
 * If per-transfer history is ever needed, restore the recordAction calls
 * (git history at 52e5e189^) and re-index; the chain is the archive.
 *
 * WARNING: ERC-20's Transfer shares a topic0 with ERC-721's. The two differ only
 * in whether the third argument is indexed, so a contract registered under the
 * wrong `standard` decodes into garbage rather than failing. The registry test
 * asserts no address is registered under two standards on one chain.
 */
import { indexer, type EvmOnEventContext, type TrackedTokenBalance } from "envio";

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
}

async function adjustBalance(a: AdjustArgs): Promise<void> {
  if (a.address === ZERO) return;

  const id = balanceId(a.address, a.token, a.chainId);
  const existing = await a.context.TrackedTokenBalance.get(id);
  const raw = (existing?.balance ?? 0n) + a.delta;

  // A balance at or below zero deletes the row: an absent row and a zero row
  // must not both mean "holds none", or holder counts double-count.
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
    balance: raw,
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

    const isMint = fromLower === ZERO;
    const isBurn = isBurnAddress(toLower) && !isMint;

    const common = { context, token, tokenKey, chainId, timestamp };
    if (!isMint) {
      await adjustBalance({ ...common, address: fromLower, delta: -amount });
    }
    if (!isBurn && toLower !== ZERO) {
      await adjustBalance({ ...common, address: toLower, delta: amount });
    }
  },
);
