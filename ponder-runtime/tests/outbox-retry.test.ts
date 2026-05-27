// ponder-runtime/tests/outbox-retry.test.ts — T-A2.9 AC unit tests

import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  OUTBOX_RETRY_CONFIG,
  backoffMsFor,
  isEligibleForRetry,
  isDeadLetter,
  wrapLastError,
  unwrapLastAttemptAt,
  unwrapFirstSeenAtMs,
  unwrapLastErrorMessage,
  fireOutboxAlert,
  setOutboxAlertHook,
} from "../src/lib/outbox-retry";

describe("OUTBOX_RETRY_CONFIG defaults", () => {
  it("max attempts = 10", () => expect(OUTBOX_RETRY_CONFIG.maxAttempts).toBe(10));
  it("stale-after = 5 minutes", () =>
    expect(OUTBOX_RETRY_CONFIG.staleAfterMs).toBe(5 * 60_000));
  it("max backoff = 60s", () => expect(OUTBOX_RETRY_CONFIG.maxBackoffMs).toBe(60_000));
  it("base backoff = 1s", () => expect(OUTBOX_RETRY_CONFIG.baseBackoffMs).toBe(1000));
});

describe("backoffMsFor — exponential w/ cap", () => {
  it("0 attempts → 1s", () => expect(backoffMsFor(0)).toBe(1000));
  it("1 attempt → 2s", () => expect(backoffMsFor(1)).toBe(2000));
  it("2 attempts → 4s", () => expect(backoffMsFor(2)).toBe(4000));
  it("5 attempts → 32s", () => expect(backoffMsFor(5)).toBe(32_000));
  it("6 attempts → 60s cap", () => expect(backoffMsFor(6)).toBe(60_000));
  it("100 attempts → still 60s cap (no overflow)", () =>
    expect(backoffMsFor(100)).toBe(60_000));
});

describe("isEligibleForRetry", () => {
  it("0 attempts always eligible", () => {
    expect(isEligibleForRetry({ attemptCount: 0, lastError: null })).toBe(true);
  });

  it("attempt 1 within backoff → not eligible", () => {
    const now = 1_000_000;
    const lastAt = now - 500;
    const lastError = wrapLastError("err", null, lastAt);
    expect(isEligibleForRetry({ attemptCount: 1, lastError }, now)).toBe(false);
  });

  it("attempt 1 past backoff → eligible", () => {
    const now = 1_000_000;
    const lastAt = now - 2000;
    const lastError = wrapLastError("err", null, lastAt);
    expect(isEligibleForRetry({ attemptCount: 1, lastError }, now)).toBe(true);
  });
});

describe("isDeadLetter", () => {
  it("not dead under attempt cap", () => {
    expect(isDeadLetter({ attemptCount: 5, eventBlock: 100n, lastError: null }).dead).toBe(false);
  });

  it("dead at max attempts (10)", () => {
    const result = isDeadLetter({ attemptCount: 10, eventBlock: 100n, lastError: null });
    expect(result.dead).toBe(true);
    expect(result.reason).toBe("max-attempts");
  });

  it("dead by stale-timeout at 5min boundary", () => {
    const now = 10_000_000;
    const lastError = wrapLastError("transient", null, now - 5 * 60_000);
    const result = isDeadLetter({ attemptCount: 3, eventBlock: 100n, lastError }, now);
    expect(result.dead).toBe(true);
    expect(result.reason).toBe("stale-timeout");
  });

  it("NOT dead just before 5min boundary", () => {
    const now = 10_000_000;
    const lastError = wrapLastError("err", null, now - (5 * 60_000 - 1));
    expect(isDeadLetter({ attemptCount: 3, eventBlock: 100n, lastError }, now).dead).toBe(false);
  });

  it("max-attempts takes precedence over stale-timeout", () => {
    const now = 10_000_000;
    const lastError = wrapLastError("err", null, now - 10 * 60_000);
    expect(isDeadLetter({ attemptCount: 10, eventBlock: 100n, lastError }, now).reason).toBe(
      "max-attempts",
    );
  });
});

describe("lastError wrapper", () => {
  it("round-trips ts / fs / err", () => {
    const wrapped = wrapLastError("connection refused", null, 12345);
    expect(unwrapLastAttemptAt(wrapped)).toBe(12345);
    expect(unwrapFirstSeenAtMs(wrapped)).toBe(12345);
    expect(unwrapLastErrorMessage(wrapped)).toBe("connection refused");
  });

  it("preserves first-seen across re-wraps", () => {
    const first = wrapLastError("err1", null, 1000);
    const second = wrapLastError("err2", first, 2000);
    expect(unwrapFirstSeenAtMs(second)).toBe(1000);
    expect(unwrapLastAttemptAt(second)).toBe(2000);
    expect(unwrapLastErrorMessage(second)).toBe("err2");
  });

  it("graceful with invalid wrapper", () => {
    expect(unwrapLastAttemptAt(null)).toBe(null);
    expect(unwrapLastAttemptAt("not-json")).toBe(null);
    expect(unwrapLastErrorMessage(null)).toBe(null);
  });

  it("truncates errors > 1000 chars", () => {
    const huge = "x".repeat(5000);
    const wrapped = wrapLastError(huge, null, 1000);
    const parsed = JSON.parse(wrapped);
    expect(parsed.err.length).toBeLessThanOrEqual(1000);
  });
});

describe("fireOutboxAlert", () => {
  beforeEach(() => {
    setOutboxAlertHook((event) => {
      console.error(`[OUTBOX-DLQ-ALERT] ${event.reason} ${event.rowId}`);
    });
  });

  it("invokes hook with full event payload", async () => {
    const recv: any[] = [];
    setOutboxAlertHook((event) => {
      recv.push(event);
    });
    await fireOutboxAlert({
      reason: "max-attempts",
      rowId: "0xabc",
      chainId: 1,
      txHash: "0xdef",
      envelopeType: "mint",
      attemptCount: 10,
      lastError: "boom",
      firstSeenMs: 1000,
    });
    expect(recv).toHaveLength(1);
    expect(recv[0].reason).toBe("max-attempts");
  });

  it("does not throw when hook itself throws", async () => {
    setOutboxAlertHook(() => {
      throw new Error("hook explosion");
    });
    await expect(
      fireOutboxAlert({
        reason: "stale-timeout",
        rowId: "0xabc",
        chainId: 1,
        txHash: "0xdef",
        envelopeType: "mint",
        attemptCount: 3,
        lastError: null,
        firstSeenMs: null,
      }),
    ).resolves.toBeUndefined();
  });
});
