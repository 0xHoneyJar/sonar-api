// ponder-runtime/src/lib/reorg-safe-emit.ts
//
// Per SDD §5.3 (FIXED per BLOCKER SKP-003 CRITICAL) + cookbook §T-A0.9 + §R-1.
//
// Reorg-safe NATS emission via outbox + deterministic ID idempotency.
//
// Flow:
//   1. Handler computes deterministic_id = keccak256(chainId|txHash|logIndex|envelopeType)
//   2. For chains with confirmations=0: inline-publish (no reorg buffering needed)
//   3. For chains with confirmations>0: insert into pending_emits with
//      targetBlock = event.block.number + depth, onConflictDoNothing.
//   4. onConflictDoNothing absorbs duplicate handler invocations (reorg
//      replay): same canonical inputs → same id → 5x duplicate insert → 1 row
//      (verified driver-level in cookbook §T-A0.9).

import { keccak256, toBytes } from "viem";
import { pendingEmits } from "../../ponder.schema";
import { confirmationsFor } from "./sync-status";
import { publishEnvelope, type PonderEnvelope } from "./nats-publisher";

// SDD §5.3 — kept in lockstep with CONFIRMATIONS_BY_CHAIN in sync-status.ts.
export const REORG_DEPTH_BY_CHAIN: Record<number, bigint> = {
  1:       12n,
  10:       0n,
  8453:     0n,
  42161:    0n,
  7777777:  0n,
  80094:  200n,
};

export function deterministicEmitId(
  chainId: number,
  txHash: `0x${string}`,
  logIndex: number,
  envelopeType: string,
): string {
  const canonical = `${chainId}|${txHash.toLowerCase()}|${logIndex}|${envelopeType}`;
  return keccak256(toBytes(canonical));
}

// Event shape — Ponder events expose:
//   - event.transaction.hash (the tx hash)
//   - event.log.logIndex
//   - event.block.number
// envio's events used .transaction.hash + .logIndex (no .log.). Ponder pivots
// the log fields onto event.log. We accept either shape via union typing —
// the lib reads transactionHash via a helper that handles both. Most callers
// pass the Ponder-shape event; tests pass a structural mock.
export interface ReorgSafeEmitEventShape {
  log: { logIndex: number };
  transaction: { hash: `0x${string}` };
  block: { number: bigint };
}

/**
 * Wraps an envelope in reorg-safe outbox semantics.
 *
 * For chains with depth=0 (Base/Optimism/etc.): inline-publishes.
 * For chains with depth>0 (Ethereum 12 / Berachain 200): inserts a
 * pending_emits row with targetBlock = event.block + depth.
 *
 * IMPORTANT: callers MUST gate this behind `isLiveEvent(event, context)` —
 * historical (cold-sync) events must NOT touch this function (SDD §4.2
 * HISTORICAL SYNC GATE). reorgSafeEmit does NOT re-check live-status; it
 * trusts the caller's gate.
 */
// Context is typed `any` to accept BOTH (a) the unit-test mock objects (which
// pass only the minimum surface — `db.insert(table).values(...).onConflictDoNothing()`),
// and (b) the production Ponder IndexingContext (which is a much wider type
// that's internal + version-coupled). Documenting the structural contract
// here keeps it explicit even though the compiler can't enforce it:
//
//   context.db.insert(pendingEmits)
//             .values(<schema-matching row>)
//             .onConflictDoNothing()
//
// Drift in this contract is a runtime error, not a compile error. The
// outbox-flush handler is the production caller; its `any`-typed event/context
// arguments make the same trade-off.
export async function reorgSafeEmit(
  context: any,
  envelope: PonderEnvelope,
  event: ReorgSafeEmitEventShape,
  chainId: number,
): Promise<void> {
  const depth = REORG_DEPTH_BY_CHAIN[chainId] ?? 12n;

  if (depth === 0n) {
    // L2 path — inline publish. Failures are caught + logged inside
    // publishEnvelope, but the call STILL throws on connection-class errors
    // so the outbox-flush path can bump attempt counts. For the L2 inline
    // path we swallow because the handler is fire-and-forget — the indexer
    // DB write upstream is durable.
    try {
      await publishEnvelope(envelope);
    } catch {
      // intentionally swallow — see comment above
    }
    return;
  }

  const txHash = event.transaction.hash;
  const id = deterministicEmitId(
    chainId,
    txHash,
    event.log.logIndex,
    envelope.type,
  );

  await context.db
    .insert(pendingEmits)
    .values({
      id,
      chainId,
      txHash: txHash.toLowerCase() as `0x${string}`,
      logIndex: event.log.logIndex,
      envelopeType: envelope.type,
      eventBlock: event.block.number,
      targetBlock: event.block.number + depth,
      envelopeJson: JSON.stringify(envelope),
      publishedAt: null,
      attemptCount: 0,
      lastError: null,
    })
    .onConflictDoNothing();
}

export function reorgDepthFor(chainId: number): bigint {
  return REORG_DEPTH_BY_CHAIN[chainId] ?? confirmationsFor(chainId);
}
