// ponder-runtime/src/lib/outbox-retry.ts
//
// Per Sprint A-2 T-A2.9 (SKP-002 CRITICAL) — outbox retry + DLQ + alert.
//
// AC (sprint.md):
//   - Max 10 attempts exponential backoff
//   - Rows older than 5 min in pending state → DLQ + alert
//   - Simulated NATS-unavailable test: rows survive + re-emit on reconnect +
//     alert fires at 5min threshold
//
// Retry-backoff curve: exponential with cap.
// The block-tick handler fires once per chain block (~2-12s). Each row is
// eligible IFF `now - lastAttemptAtMs > backoff` where backoff = MIN(baseBackoff
// * 2^attemptCount, MAX_BACKOFF_MS). lastAttemptAtMs + firstSeenAtMs are
// encoded into `lastError` as a JSON wrapper to avoid an additional schema
// column (lastError is otherwise opaque text — the JSON-wrapper is safe).

export const OUTBOX_RETRY_CONFIG = {
  maxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS ?? "10"),
  staleAfterMs: Number(process.env.OUTBOX_STALE_AFTER_MS ?? String(5 * 60_000)),
  maxBackoffMs: Number(process.env.OUTBOX_MAX_BACKOFF_MS ?? String(60_000)),
  baseBackoffMs: Number(process.env.OUTBOX_BASE_BACKOFF_MS ?? "1000"),
} as const;

/**
 * Exponential: baseBackoffMs * 2^attemptCount, capped at maxBackoffMs.
 *   attempts=0 → 1s ; attempts=1 → 2s ; attempts=6 → capped at 60s
 */
export function backoffMsFor(attemptCount: number): number {
  const exp = Math.min(attemptCount, 20);
  const computed = OUTBOX_RETRY_CONFIG.baseBackoffMs * Math.pow(2, exp);
  return Math.min(computed, OUTBOX_RETRY_CONFIG.maxBackoffMs);
}

export function isEligibleForRetry(
  row: { attemptCount: number; lastError: string | null },
  nowMs: number = Date.now(),
): boolean {
  if (row.attemptCount === 0) return true;
  const lastAt = unwrapLastAttemptAt(row.lastError);
  if (lastAt === null) return true;
  return nowMs - lastAt >= backoffMsFor(row.attemptCount - 1);
}

export function isDeadLetter(
  row: { attemptCount: number; eventBlock: bigint; lastError: string | null },
  nowMs: number = Date.now(),
): { dead: boolean; reason: "max-attempts" | "stale-timeout" | null } {
  if (row.attemptCount >= OUTBOX_RETRY_CONFIG.maxAttempts) {
    return { dead: true, reason: "max-attempts" };
  }
  const firstSeen = unwrapFirstSeenAtMs(row.lastError);
  if (firstSeen !== null && nowMs - firstSeen >= OUTBOX_RETRY_CONFIG.staleAfterMs) {
    return { dead: true, reason: "stale-timeout" };
  }
  return { dead: false, reason: null };
}

// --- lastError wrapper -----------------------------------------------------

interface LastErrorWrapper {
  ts: number; // last attempt ms
  fs: number; // first seen ms
  err: string;
}

export function wrapLastError(err: string, prevWrapper: string | null, nowMs: number = Date.now()): string {
  const fs = unwrapFirstSeenAtMs(prevWrapper) ?? nowMs;
  const wrapper: LastErrorWrapper = { ts: nowMs, fs, err: String(err).slice(0, 1000) };
  return JSON.stringify(wrapper);
}

function tryParseWrapper(lastError: string | null): LastErrorWrapper | null {
  if (!lastError) return null;
  try {
    const parsed = JSON.parse(lastError) as LastErrorWrapper;
    if (typeof parsed?.ts === "number" && typeof parsed?.fs === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function unwrapLastAttemptAt(lastError: string | null): number | null {
  return tryParseWrapper(lastError)?.ts ?? null;
}

export function unwrapFirstSeenAtMs(lastError: string | null): number | null {
  return tryParseWrapper(lastError)?.fs ?? null;
}

export function unwrapLastErrorMessage(lastError: string | null): string | null {
  return tryParseWrapper(lastError)?.err ?? lastError;
}

// --- alert hook ------------------------------------------------------------

export interface OutboxAlertEvent {
  reason: "max-attempts" | "stale-timeout";
  rowId: string;
  chainId: number;
  txHash: string;
  envelopeType: string;
  attemptCount: number;
  lastError: string | null;
  firstSeenMs: number | null;
}

export type AlertHook = (event: OutboxAlertEvent) => void | Promise<void>;

let alertHook: AlertHook = (event) => {
  console.error(
    `[OUTBOX-DLQ-ALERT] reason=${event.reason} id=${event.rowId} ` +
      `chain=${event.chainId} tx=${event.txHash} envelopeType=${event.envelopeType} ` +
      `attempts=${event.attemptCount} lastError=${event.lastError ?? "null"}`,
  );
};

export function setOutboxAlertHook(hook: AlertHook): void {
  alertHook = hook;
}

export async function fireOutboxAlert(event: OutboxAlertEvent): Promise<void> {
  try {
    await alertHook(event);
  } catch (err) {
    console.error("[OUTBOX-DLQ-ALERT] alert hook itself threw:", err);
  }
}
