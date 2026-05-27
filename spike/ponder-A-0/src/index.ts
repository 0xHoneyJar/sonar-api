// A-0 Verification Spike — handlers
//
// Validates each verification task in line with the spec:
//   T-A0.2  blocks: declaration + per-block handler
//   T-A0.3  multi-row query pattern (Ponder API; see CORRECTION note)
//   T-A0.4  onConflictDoNothing / onConflictDoUpdate semantics
//   T-A0.6  uint256 column type roundtrip
//   T-A0.9  deterministic outbox ID (chainId|txHash|logIndex|envelopeType)
//   T-A0.10 live-status from Ponder sync state (not wall-clock alone)
//
// ──────────────────────────────────────────────────────────────────────────
// MAJOR SDD CORRECTION (see COOKBOOK §T-A0.3): Ponder 0.16.6's `context.db`
// has a CUSTOM API — `find / insert / update / delete / sql`. Raw Drizzle
// `select().from().where()` is NOT directly on `context.db`. To do multi-row
// queries you reach the underlying drizzle via `context.db.sql.select(...)`
// (a `ReadonlyDrizzle`). The SDD draft inverted this — it wrote
//   "CORRECT API: Drizzle select pattern, NOT context.db.find(...)"
// when the actual answer is: db.find for single-row by-primary-key, db.sql
// for raw drizzle escape hatch.
// ──────────────────────────────────────────────────────────────────────────
import { ponder } from "ponder:registry";
import { token, pendingEmits, blockTickCounter } from "ponder:schema";
import { and, eq, lte, isNull } from "ponder";
import { keccak256, toBytes } from "viem";

// ─── Live-event detection (T-A0.10) ────────────────────────────────────────
// SDD §4.2 currently uses wall-clock alone:
//   isLive = Date.now() - eventMs < LIVE_THRESHOLD_MS (1h)
// Per IMP-005 + SKP-003 HIGH, this is INSUFFICIENT — wall-clock drifts, NTP
// failures, RPC clock skew, and post-catch-up real-time blocks all confuse it.
//
// CORRECT formulation (SDD CORRECTION FLAG, see COOKBOOK §T-A0.10):
//   isLive = (head_block - event.block.number) < CONFIRMATIONS
//            && sync_status === 'realtime'
//
// Ponder 0.16.6 surfaces head-block via context.client (a viem PublicClient).
// `sync_status` is observable in metrics (`ponder_indexing_completed_seconds`,
// `ponder_sync_block`) and via the `/ready` endpoint Ponder exposes by
// default. For handler-side checks, the head-block diff is the load-bearing
// test.
const LIVE_CONFIRMATIONS_BY_CHAIN: Record<number, bigint> = {
  1: 12n,       // Ethereum
  10: 0n,       // Optimism
  8453: 0n,     // Base
  42161: 0n,    // Arbitrum
  7777777: 0n,  // Zora
  80094: 200n,  // Berachain
};

// CRITICAL SPIKE FINDING (see COOKBOOK §T-A0.10): Ponder 0.16.6's
// `context.client` (a `ReadonlyClient`) does NOT expose
// `getBlockNumber()` — only the block-dependent / block-required action
// subset of viem's PublicActions. To get the chain head, use
// `getBlock({ blockTag: "latest" })`. This costs one RPC call per
// invocation — handler authors SHOULD cache it per-block-tick rather
// than per-event.
async function isLiveEvent(
  context: any,
  eventBlock: bigint,
  chainId: number,
): Promise<boolean> {
  const head = await context.client.getBlock({ blockTag: "latest" });
  const confirmations = LIVE_CONFIRMATIONS_BY_CHAIN[chainId] ?? 12n;
  return head.number - eventBlock < confirmations;
}

// ─── Deterministic outbox ID (T-A0.9) ──────────────────────────────────────
// Collision domains covered (see COOKBOOK §T-A0.9 for the analysis):
//   - same-tx-multi-logs: logIndex differentiates
//   - cross-chain same-contract: chainId differentiates
//   - reorged-logs: same input → same id → onConflictDoNothing absorbs
//   - handler-replay: same input → same id → onConflictDoNothing absorbs
//   - multi-envelope-per-event: envelopeType differentiates
function deterministicEmitId(
  chainId: number,
  txHash: `0x${string}`,
  logIndex: number,
  envelopeType: string,
): string {
  const canonical = `${chainId}|${txHash.toLowerCase()}|${logIndex}|${envelopeType}`;
  return keccak256(toBytes(canonical));
}

// ─── Contract handler — Milady Transfer ────────────────────────────────────
// Exercises T-A0.4 (onConflictDoUpdate), T-A0.6 (uint256 token IDs), and
// T-A0.9 (deterministic outbox ID) end-to-end against a real ERC-721 stream.
ponder.on("MiladyCollection:Transfer", async ({ event, context }) => {
  const chainId = context.chain.id;
  const collection = event.log.address;
  const tokenId = event.args.tokenId; // bigint from viem
  const owner = event.args.to;

  // T-A0.6: uint256 roundtrip. Schema uses `mode: 'bigint'` so drizzle gives
  // us bigint↔Postgres-numeric without manual .toString() coercion.
  // T-A0.4: onConflictDoUpdate — on duplicate (reorg, replay), update owner
  // only; do NOT overwrite blockNumber/timestamp which would mask the
  // original mint event.
  await context.db
    .insert(token)
    .values({
      id: `${chainId}-${collection.toLowerCase()}-${tokenId.toString()}`,
      chainId,
      collection,
      tokenId,
      owner,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
    })
    .onConflictDoUpdate({ owner });

  // T-A0.9: deterministic outbox row. Multiple envelope-types per event are
  // possible; here we emit one ("transfer") but the id schema scales to N.
  const envelopeType = "transfer";
  const id = deterministicEmitId(
    chainId,
    event.transaction.hash,
    event.log.logIndex,
    envelopeType,
  );

  const live = await isLiveEvent(context, event.block.number, chainId);

  if (live) {
    // T-A0.9 + T-A0.4: onConflictDoNothing absorbs reorg / handler-replay.
    await context.db
      .insert(pendingEmits)
      .values({
        id,
        chainId,
        txHash: event.transaction.hash,
        logIndex: event.log.logIndex,
        envelopeType,
        eventBlock: event.block.number,
        targetBlock:
          event.block.number + (LIVE_CONFIRMATIONS_BY_CHAIN[chainId] ?? 12n),
        envelopeJson: JSON.stringify({
          chainId,
          collection,
          tokenId: tokenId.toString(),
          owner,
          blockNumber: event.block.number.toString(),
        }),
        publishedAt: null,
        attemptCount: 0,
      })
      .onConflictDoNothing();
  }
  // Historical (non-live) events: DB write only, no outbox row.
});

// ─── Block handler — outbox flush (T-A0.2 + T-A0.3) ────────────────────────
// SDD CORRECTION (see COOKBOOK §T-A0.2): block-event names are
//   `<BlockFilterName>:block`
// NOT `<chainName>:block` as the SDD §5.3 draft suggested. The block-filter
// declared in ponder.config.ts → blocks.OutboxFlushEth is what receives the
// :block event. context.chain.{name,id} provides the chain identity.
//
// SDD CORRECTION (see COOKBOOK §T-A0.3): multi-row reads go through
// `context.db.sql` (the underlying drizzle), NOT `context.db.select()`.
// `context.db` is the Ponder API; `context.db.sql` is the Drizzle escape
// hatch with all of Drizzle's selectors/builders.
ponder.on("OutboxFlushEth:block", async ({ event, context }) => {
  const chainId = context.chain.id;

  // T-A0.2 evidence: write a tick counter so we can verify post-run that
  // the block handler fired the expected number of times.
  await context.db
    .insert(blockTickCounter)
    .values({ chainId, lastBlock: event.block.number, tickCount: 1n })
    .onConflictDoUpdate((row) => ({
      lastBlock: event.block.number,
      tickCount: row.tickCount + 1n,
    }));

  // T-A0.3: multi-row read via context.db.sql (ReadonlyDrizzle escape hatch)
  const ready = await context.db.sql
    .select()
    .from(pendingEmits)
    .where(
      and(
        eq(pendingEmits.chainId, chainId),
        isNull(pendingEmits.publishedAt),
        lte(pendingEmits.targetBlock, event.block.number),
      ),
    );

  for (const entry of ready) {
    try {
      // In production this would publish to NATS / JetStream; here we just
      // mark the row as published to exercise the update path.
      console.log(
        `[outbox] would publish envelope id=${entry.id} block=${entry.eventBlock} target=${entry.targetBlock}`,
      );

      // T-A0.3 CORRECTION: db.update(table, key) takes the primary key, not
      // a where-builder. The Ponder API enforces single-row updates by PK.
      await context.db
        .update(pendingEmits, { id: entry.id })
        .set({ publishedAt: BigInt(Date.now()) });
    } catch (err) {
      await context.db
        .update(pendingEmits, { id: entry.id })
        .set({
          attemptCount: entry.attemptCount + 1,
          lastError: String(err).slice(0, 1000),
        });
      // do NOT throw — let next tick retry
    }
  }
});
