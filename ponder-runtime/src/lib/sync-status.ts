// ponder-runtime/src/lib/sync-status.ts
//
// Per BLOCKER SKP-001 CRITICAL + cookbook §T-A0.10 + §C-5.
//
// Handlers MUST NOT emit NATS envelopes during cold sync. The check
// composes TWO signals (SDD §4.2):
//
//   1. **In-handler block-distance**: head_block - event.block.number < CONFIRMATIONS
//      where CONFIRMATIONS is the per-chain reorg-safety depth.
//   2. **In-process sync state** (server-level gate, NOT this module's
//      responsibility): the NATS publisher only starts accepting AFTER
//      Ponder's /ready endpoint returns 200. Pre-/ready, the outbox buffers;
//      post-/ready, the block-tick handler drains it.
//
// This module implements gate (1) only.
//
// CAVEAT (cookbook §C-5): Ponder's ReadonlyClient does NOT expose
// `getBlockNumber()`. Use `context.client.getBlock({ blockTag: "latest" })`.
// One RPC call per event during live mode; eRPC absorbs the load. In-process
// HEAD_CACHE_TTL_MS-based cache amortizes the cost on event bursts.

export const CONFIRMATIONS_BY_CHAIN: Record<number, bigint> = {
  1:       12n,    // Ethereum mainnet
  10:       0n,    // Optimism (L2 instant)
  8453:     0n,    // Base (L2 instant)
  42161:    0n,    // Arbitrum (L2 instant)
  7777777:  0n,    // Zora (L2 instant)
  80094:  200n,    // Berachain (matches SDD §5.3 REORG_DEPTH_BY_CHAIN)
};

export const DEFAULT_CONFIRMATIONS = 12n;

export function confirmationsFor(chainId: number): bigint {
  return CONFIRMATIONS_BY_CHAIN[chainId] ?? DEFAULT_CONFIRMATIONS;
}

const HEAD_CACHE_TTL_MS = 2_000;

interface HeadCacheEntry {
  number: bigint;
  fetchedAtMs: number;
}

const headCache = new Map<number, HeadCacheEntry>();

export function __resetHeadCacheForTests(): void {
  headCache.clear();
}

async function readHead(
  chainId: number,
  client: { getBlock: (args: { blockTag: "latest" }) => Promise<{ number: bigint }> },
): Promise<bigint> {
  const now = Date.now();
  const cached = headCache.get(chainId);
  if (cached && now - cached.fetchedAtMs < HEAD_CACHE_TTL_MS) {
    return cached.number;
  }
  const block = await client.getBlock({ blockTag: "latest" });
  headCache.set(chainId, { number: block.number, fetchedAtMs: now });
  return block.number;
}

/**
 * Returns true iff `event.block.number` is within CONFIRMATIONS of head —
 * i.e. the event is in the realtime window and SHOULD be published to NATS.
 */
export async function isLiveEvent(
  event: { block: { number: bigint } },
  context: {
    client: { getBlock: (args: { blockTag: "latest" }) => Promise<{ number: bigint }> };
    chain: { id: number };
  },
): Promise<boolean> {
  const head = await readHead(context.chain.id, context.client);
  const confirmations = confirmationsFor(context.chain.id);
  if (head < event.block.number) {
    // Clock skew / RPC lag — treat as live to avoid dropping.
    return true;
  }
  return head - event.block.number < confirmations;
}
