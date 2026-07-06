import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqdClient } from "../src/svm/sqd-client";
import { SqdLivenessError, SqdLivenessMonitor } from "../src/svm/sqd-liveness-monitor";

// Helper: create a minimal SqdClient stub with controllable lastBlockReceivedAt and currentHeight
function makeClientStub(opts: { lastBlockReceivedAt?: number; height?: number } = {}): SqdClient {
  const stub = Object.create(SqdClient.prototype) as SqdClient;
  stub.lastBlockReceivedAt = opts.lastBlockReceivedAt ?? 0;
  stub.currentHeight = vi.fn().mockResolvedValue(opts.height ?? 100_000);
  return stub;
}

beforeEach(() => {
  // Ensure test env gate is OFF for monitor construction (tests control it via deps)
  delete process.env.SQD_LIVENESS_DISABLED;
});

afterEach(() => {
  delete process.env.SQD_LIVENESS_DISABLED;
});

describe("SqdLivenessMonitor — stall detection", () => {
  it("emits warn when no blocks received for > STALL_THRESHOLD_MS", async () => {
    const NOW = 1_000_000_000;
    const STALL_THRESHOLD = 120_000;
    const client = makeClientStub({ lastBlockReceivedAt: NOW - STALL_THRESHOLD - 1 });
    const warns: string[] = [];
    const monitor = new SqdLivenessMonitor(client, {
      now: () => NOW,
      fetchReferenceSlot: vi.fn().mockResolvedValue(100_000),
      triggerReconnect: vi.fn().mockResolvedValue(undefined),
      log: { warn: (m) => warns.push(m), error: () => {} },
    });
    await monitor.check();
    expect(warns.some((w) => w.includes("[SQD STALL]"))).toBe(true);
  });

  it("does NOT warn when blocks received recently", async () => {
    const NOW = 1_000_000_000;
    const client = makeClientStub({ lastBlockReceivedAt: NOW - 10_000 }); // 10s ago = OK
    const warns: string[] = [];
    const monitor = new SqdLivenessMonitor(client, {
      now: () => NOW,
      fetchReferenceSlot: vi.fn().mockResolvedValue(100_000),
      log: { warn: (m) => warns.push(m), error: () => {} },
    });
    await monitor.check();
    expect(warns.some((w) => w.includes("[SQD STALL]"))).toBe(false);
  });

  it("does NOT warn when lastBlockReceivedAt is 0 (stream not started)", async () => {
    const NOW = 1_000_000_000;
    const client = makeClientStub({ lastBlockReceivedAt: 0 }); // never started
    const warns: string[] = [];
    const monitor = new SqdLivenessMonitor(client, {
      now: () => NOW,
      fetchReferenceSlot: vi.fn().mockResolvedValue(100_000),
      log: { warn: (m) => warns.push(m), error: () => {} },
    });
    await monitor.check();
    expect(warns.some((w) => w.includes("[SQD STALL]"))).toBe(false);
  });

  it("throws SqdLivenessError after MAX_RECONNECT_ATTEMPTS failed reconnects", async () => {
    const NOW = 1_000_000_000;
    const STALL_THRESHOLD = 120_000;
    const client = makeClientStub({ lastBlockReceivedAt: NOW - STALL_THRESHOLD - 1 });
    const errors: string[] = [];
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const monitor = new SqdLivenessMonitor(client, {
      now: () => NOW,
      fetchReferenceSlot: vi.fn().mockResolvedValue(100_000),
      triggerReconnect: reconnect,
      log: { warn: () => {}, error: (m) => errors.push(m) },
    });
    // Run 6 checks (max reconnects = 5, so check #6 should throw)
    for (let i = 0; i < 5; i++) await monitor.check();
    await expect(monitor.check()).rejects.toBeInstanceOf(SqdLivenessError);
    expect(errors.some((e) => e.includes("[SQD HALT]"))).toBe(true);
  });
});

describe("SqdLivenessMonitor — chain lag detection (BLOCKER-2)", () => {
  it("emits warn when SQD height lags reference tip by > LAG_THRESHOLD_SLOTS", async () => {
    const NOW = 1_000_000_000;
    const client = makeClientStub({ lastBlockReceivedAt: NOW - 10_000, height: 99_000 }); // SQD at 99k
    const warns: string[] = [];
    const monitor = new SqdLivenessMonitor(client, {
      now: () => NOW,
      fetchReferenceSlot: vi.fn().mockResolvedValue(100_000), // reference at 100k = 1k slots ahead
      log: { warn: (m) => warns.push(m), error: () => {} },
    });
    await monitor.check();
    expect(warns.some((w) => w.includes("[SQD LAG]"))).toBe(true);
  });

  it("lag check uses INDEPENDENT reference RPC, not SQD-vs-SQD", async () => {
    // The reference slot is fetched from fetchReferenceSlot (independent RPC), NOT from client.currentHeight()
    // This test verifies that the lag monitor calls both independently
    const NOW = 1_000_000_000;
    const client = makeClientStub({ lastBlockReceivedAt: NOW - 10_000, height: 100_000 });
    const refFetch = vi.fn().mockResolvedValue(100_000); // reference same as SQD — no lag
    const warns: string[] = [];
    const monitor = new SqdLivenessMonitor(client, {
      now: () => NOW,
      fetchReferenceSlot: refFetch,
      log: { warn: (m) => warns.push(m), error: () => {} },
    });
    await monitor.check();
    expect(refFetch).toHaveBeenCalledTimes(1); // independent RPC was called
    expect(warns.some((w) => w.includes("[SQD LAG]"))).toBe(false); // no lag (same height)
  });

  it("does NOT warn when lag is within threshold", async () => {
    const NOW = 1_000_000_000;
    const client = makeClientStub({ lastBlockReceivedAt: NOW - 10_000, height: 99_900 }); // 100 slots behind
    const warns: string[] = [];
    const monitor = new SqdLivenessMonitor(client, {
      now: () => NOW,
      fetchReferenceSlot: vi.fn().mockResolvedValue(100_000), // 100 slots gap < 500 threshold
      log: { warn: (m) => warns.push(m), error: () => {} },
    });
    await monitor.check();
    expect(warns.some((w) => w.includes("[SQD LAG]"))).toBe(false);
  });
});

describe("SqdLivenessMonitor — gap detection", () => {
  it("emits warn when block sequence is not contiguous", () => {
    const NOW = 1_000_000_000;
    const client = makeClientStub({ lastBlockReceivedAt: NOW - 10_000 });
    const warns: string[] = [];
    const monitor = new SqdLivenessMonitor(client, {
      now: () => NOW,
      fetchReferenceSlot: vi.fn().mockResolvedValue(100_000),
      log: { warn: (m) => warns.push(m), error: () => {} },
    });
    monitor.lastDecodedBlock = 100;
    monitor.recordBlock(200); // gap: 101-199 skipped
    expect(warns.some((w) => w.includes("[SQD GAP]"))).toBe(true);
  });

  it("does NOT warn when blocks are contiguous", () => {
    const NOW = 1_000_000_000;
    const client = makeClientStub({ lastBlockReceivedAt: NOW - 10_000 });
    const warns: string[] = [];
    const monitor = new SqdLivenessMonitor(client, {
      now: () => NOW,
      fetchReferenceSlot: vi.fn().mockResolvedValue(100_000),
      log: { warn: (m) => warns.push(m), error: () => {} },
    });
    monitor.lastDecodedBlock = 100;
    monitor.recordBlock(101);
    expect(warns.some((w) => w.includes("[SQD GAP]"))).toBe(false);
  });
});

describe("SqdLivenessMonitor — empty-block no-stall (FL-4)", () => {
  it("lastBlockReceivedAt advances on empty blocks — no stall fires for quiet blocks", async () => {
    // FL-4: lastBlockReceivedAt advances on any received block, even zero-event blocks
    // This is tested at the SqdClient level (lastBlockReceivedAt updated on any block), but
    // the monitor respects it — recent lastBlockReceivedAt = no stall even if zero events
    const NOW = 1_000_000_000;
    const client = makeClientStub({ lastBlockReceivedAt: NOW - 10_000 }); // recent = not stalled
    const warns: string[] = [];
    const monitor = new SqdLivenessMonitor(client, {
      now: () => NOW,
      fetchReferenceSlot: vi.fn().mockResolvedValue(100_000),
      log: { warn: (m) => warns.push(m), error: () => {} },
    });
    await monitor.check();
    expect(warns.some((w) => w.includes("[SQD STALL]"))).toBe(false);
  });
});

describe("SqdLivenessMonitor — CI gate", () => {
  it("start() is a no-op when SQD_LIVENESS_DISABLED=1", () => {
    process.env.SQD_LIVENESS_DISABLED = "1";
    const client = makeClientStub();
    const monitor = new SqdLivenessMonitor(client);
    // Should not throw and should not start an interval
    expect(() => monitor.start()).not.toThrow();
    monitor.stop(); // no-op
  });
});
