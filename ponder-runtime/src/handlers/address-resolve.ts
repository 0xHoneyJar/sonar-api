// ponder-runtime/src/handlers/address-resolve.ts
//
// Block-tick resolver for address-type classification (sonar-api#63).
// Mirrors the outbox-flush block-handler pattern: a per-chain block filter
// (AddressResolveBase) scans a table for due rows, processes a capped batch,
// and writes results. Here the work is an eth_getCode state read per address.
//
// Why a block-handler (not inline on first-sight): getCode is an RPC call; doing
// it on every transfer would couple the hot path to RPC latency + rate limits.
// touchAddress enqueues a cheap "pending" row; this drains the queue off-path.
//
// Scope: Base only for now — the puru collections (the proven consumer need,
// #62/#63) are all Base 8453. The entity + helpers are chain-agnostic; add
// AddressResolve<Chain> block filters + ponder.on() registrations to extend.

import { ponder } from "ponder:registry";
import { eq, and, or, isNotNull, lte, asc } from "ponder";
import { addressType } from "../../ponder.schema";
import { classifyCode, needsRecheck } from "../lib/address-type";

// Defensive env parsing — a bad value (0, negative, NaN, non-numeric) must not
// stall the resolver (limit 0 = process nothing forever) or crash BigInt().
function envPosInt(name: string, def: number): number {
  const n = Math.floor(Number(process.env[name]));
  return Number.isFinite(n) && n > 0 ? n : def;
}
function envPosBigInt(name: string, def: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : def;
  } catch {
    return def;
  }
}

// Per-tick scan cap — bounds the getCode burst per block-tick (mirrors
// outbox-flush's MAX_ROWS_PER_TICK). eRPC caches finalized getCode (TTL:0), so
// re-reads of unchanged addresses are free; this caps only the cold reads.
const MAX_PER_TICK = envPosInt("ADDRESS_RESOLVE_MAX_PER_TICK", 50);

// Re-resolution window for an eoa: ~1 day of Base blocks (2s) — long enough for a
// counterfactual ERC-4337 wallet to have deployed, short enough to be timely.
const RECHECK_WINDOW_BLOCKS = envPosBigInt("ADDRESS_RESOLVE_RECHECK_BLOCKS", 43200n);

// Only resolve when the indexer is within this many blocks of head. During
// historical backfill the block-tick fires for old blocks; resolving then would
// (a) storm getCode and (b) classify against stale state. Skip until caught up;
// the queue drains once at head. Classification reflects CURRENT chain state.
const CAUGHT_UP_THRESHOLD_BLOCKS = envPosBigInt("ADDRESS_RESOLVE_CAUGHT_UP_BLOCKS", 100n);

ponder.on("AddressResolveBase:block", async ({ event, context }) => {
  await resolveDue(event, context);
});

async function resolveDue(event: any, context: any): Promise<void> {
  const chainId: number = context.chain.id;
  const currentBlock: bigint = event.block.number;

  // Caught-up gate (self-contained head read; eRPC caches 'latest' ~5s).
  let head: bigint;
  try {
    head = (await context.client.getBlock({ blockTag: "latest" })).number;
  } catch {
    return; // transient RPC error — next tick retries.
  }
  if (head > currentBlock && head - currentBlock > CAUGHT_UP_THRESHOLD_BLOCKS) {
    return; // still backfilling — don't resolve yet.
  }

  // Persist the BLOCK timestamp, not wall-clock: replay/reorg re-executes this
  // handler and must produce identical indexed state (Date.now() would not).
  // Resolution only runs near head (caught-up gate), so this ≈ now anyway.
  const resolvedTs: bigint = event.block.timestamp;

  // Due = never-resolved ("pending") OR an eoa whose re-check window has elapsed.
  const due = await context.db.sql
    .select()
    .from(addressType)
    .where(
      and(
        eq(addressType.chainId, chainId),
        or(
          eq(addressType.type, "pending"),
          and(
            eq(addressType.type, "eoa"),
            isNotNull(addressType.recheckAfter),
            lte(addressType.recheckAfter, currentBlock),
          ),
        ),
      ),
    )
    // Deterministic, fair order — retry/fairness must not depend on DB plan order.
    .orderBy(asc(addressType.id))
    .limit(MAX_PER_TICK);

  for (const row of due) {
    let code: string | undefined;
    try {
      // Pin to currentBlock (not latest) so the classification is deterministic
      // with resolvedAtBlock across replay/reorg. The caught-up gate keeps
      // currentBlock ≈ head, so this is also effectively-current AND recent
      // enough for non-archive nodes; later counterfactual deploys are caught by
      // the eoa re-check at a newer block.
      code = await context.client.getCode({
        address: row.address as `0x${string}`,
        blockNumber: currentBlock,
      });
    } catch {
      continue; // transient RPC error — row stays due, next tick retries.
    }

    const type = classifyCode(code);
    // An eoa stays on a RECURRING re-check cadence: a counterfactual ERC-4337
    // wallet can deploy (empty → contract) at any later block, and re-scheduling
    // on every resolution means that flip is caught within one window — with no
    // dependence on the address being re-seen. contract / delegated_eoa are
    // terminal (delegated stays human even if re-delegated).
    const recheckAfter = needsRecheck(type)
      ? currentBlock + RECHECK_WINDOW_BLOCKS
      : null;

    await context.db.update(addressType, { id: row.id }).set({
      type,
      resolvedAtBlock: currentBlock,
      lastResolved: resolvedTs,
      recheckAfter,
    });
  }
}
