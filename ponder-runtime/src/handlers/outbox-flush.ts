// ponder-runtime/src/handlers/outbox-flush.ts
//
// Per SDD §5.3 (FIXED per BLOCKER SKP-003 CRITICAL) — block-tick handler that
// drains the pending_emits outbox.
//
// SDD corrections enforced (cookbook-verified):
//   - C-3: block events keyed by block-FILTER NAME ("OutboxFlushEth:block"),
//     NOT by chain. One handler per block-filter from ponder.config.mibera.ts.
//   - C-4: context.db has find/insert/update/delete/sql. Multi-row reads use
//     `context.db.sql.select()`; single-row by-PK uses `db.find`; PK-keyed
//     updates use `db.update(table, key).set(...)`; PK-keyed deletes use
//     `db.delete(table, key)`.

import { ponder } from "ponder:registry";
import { eq, and, isNull, lte } from "ponder";
import { pendingEmits, deadLetterEmits } from "../../ponder.schema";
import { publishEnvelope, type PonderEnvelope } from "../lib/nats-publisher";
import {
  isDeadLetter,
  isEligibleForRetry,
  wrapLastError,
  unwrapFirstSeenAtMs,
  fireOutboxAlert,
  type OutboxAlertEvent,
} from "../lib/outbox-retry";

// Per-tick row scan cap. Defends against thundering herd after a long outage.
const MAX_ROWS_PER_TICK = Number(process.env.OUTBOX_MAX_ROWS_PER_TICK ?? "100");

ponder.on("OutboxFlushEth:block", async ({ event, context }) => {
  await flushReadyEmits(event, context);
});

ponder.on("OutboxFlushBase:block", async ({ event, context }) => {
  await flushReadyEmits(event, context);
});

ponder.on("OutboxFlushBera:block", async ({ event, context }) => {
  await flushReadyEmits(event, context);
});

// F-3 re-dispatch: Optimism added to chain list. Outbox flush per chain stays
// chain-scoped via context.chain.id inside flushReadyEmits.
ponder.on("OutboxFlushOp:block", async ({ event, context }) => {
  await flushReadyEmits(event, context);
});

async function flushReadyEmits(event: any, context: any): Promise<void> {
  const chainId: number = context.chain.id;
  const currentBlock: bigint = event.block.number;
  const nowMs = Date.now();

  // C-4: multi-row read via context.db.sql.select() — drizzle escape hatch.
  const ready = await context.db.sql
    .select()
    .from(pendingEmits)
    .where(
      and(
        eq(pendingEmits.chainId, chainId),
        isNull(pendingEmits.publishedAt),
        lte(pendingEmits.targetBlock, currentBlock),
      ),
    )
    .limit(MAX_ROWS_PER_TICK);

  for (const entry of ready) {
    // DLQ check FIRST — exhausted/stale rows skip directly to DLQ.
    const dlq = isDeadLetter(entry, nowMs);
    if (dlq.dead) {
      await moveToDeadLetter(context, entry, dlq.reason!, nowMs);
      const firstSeen = unwrapFirstSeenAtMs(entry.lastError);
      const alert: OutboxAlertEvent = {
        reason: dlq.reason!,
        rowId: entry.id,
        chainId: entry.chainId,
        txHash: entry.txHash,
        envelopeType: entry.envelopeType,
        attemptCount: entry.attemptCount,
        lastError: entry.lastError,
        firstSeenMs: firstSeen,
      };
      void fireOutboxAlert(alert);
      continue;
    }

    if (!isEligibleForRetry(entry, nowMs)) {
      continue;
    }

    try {
      const envelope = JSON.parse(entry.envelopeJson) as PonderEnvelope;
      await publishEnvelope(envelope);
      // C-4: db.update(table, key).set(...) — keyed by PK.
      await context.db
        .update(pendingEmits, { id: entry.id })
        .set({ publishedAt: BigInt(nowMs) });
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      await context.db
        .update(pendingEmits, { id: entry.id })
        .set({
          attemptCount: entry.attemptCount + 1,
          lastError: wrapLastError(errMsg, entry.lastError, nowMs),
        });
      // do NOT re-throw — next tick retries.
    }
  }
}

async function moveToDeadLetter(
  context: any,
  entry: any,
  reason: "max-attempts" | "stale-timeout",
  failedAtMs: number,
): Promise<void> {
  try {
    await context.db
      .insert(deadLetterEmits)
      .values({
        id: entry.id,
        chainId: entry.chainId,
        txHash: entry.txHash,
        logIndex: entry.logIndex,
        envelopeType: entry.envelopeType,
        eventBlock: entry.eventBlock,
        targetBlock: entry.targetBlock,
        envelopeJson: entry.envelopeJson,
        attemptCount: entry.attemptCount,
        lastError: entry.lastError,
        failedAt: BigInt(failedAtMs),
        reason,
      })
      .onConflictDoNothing();
    // C-4: db.delete(table, key) — single-row by-PK delete.
    await context.db.delete(pendingEmits, { id: entry.id });
  } catch (err) {
    console.error(
      `[outbox-flush] DLQ move failed for id=${entry.id}: ${(err as Error).message}`,
    );
  }
}
