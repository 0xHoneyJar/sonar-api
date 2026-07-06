/**
 * T-7: Kill switch tests — SQD_LIVE_TAIL_ENABLED=false halts the live-tail lane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLiveTailEnabled, runSqdLoader, type SqdLoaderDeps } from "../src/svm/sqd-loader";
import { SqdClient } from "../src/svm/sqd-client";

afterEach(() => {
  delete process.env.SQD_LIVE_TAIL_ENABLED;
  vi.restoreAllMocks();
});

describe("isLiveTailEnabled", () => {
  it("returns true when SQD_LIVE_TAIL_ENABLED is unset (default enabled)", () => {
    delete process.env.SQD_LIVE_TAIL_ENABLED;
    expect(isLiveTailEnabled()).toBe(true);
  });

  it("returns false and logs when SQD_LIVE_TAIL_ENABLED=false", () => {
    process.env.SQD_LIVE_TAIL_ENABLED = "false";
    const logs: string[] = [];
    expect(isLiveTailEnabled((m) => logs.push(m))).toBe(false);
    expect(logs.some((l) => l.includes("[SQD]") && l.includes("disabled"))).toBe(true);
  });

  it("returns true when SQD_LIVE_TAIL_ENABLED=true", () => {
    process.env.SQD_LIVE_TAIL_ENABLED = "true";
    expect(isLiveTailEnabled()).toBe(true);
  });

  it("returns true when SQD_LIVE_TAIL_ENABLED=1 (only exact 'false' triggers kill)", () => {
    process.env.SQD_LIVE_TAIL_ENABLED = "1";
    expect(isLiveTailEnabled()).toBe(true);
  });
});

describe("runSqdLoader — kill switch", () => {
  it("returns empty result immediately when SQD_LIVE_TAIL_ENABLED=false, without calling client", async () => {
    process.env.SQD_LIVE_TAIL_ENABLED = "false";

    const deps: SqdLoaderDeps = {
      client: { head: vi.fn(), stream: vi.fn(), currentHeight: vi.fn(), lastBlockReceivedAt: 0 } as unknown as SqdClient,
      members: vi.fn().mockResolvedValue(["J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w"]),
      cursorSlot: vi.fn().mockResolvedValue(null),
      knownMints: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      syncStatus: vi.fn(),
      log: vi.fn(),
    };

    const result = await runSqdLoader({ collectionKey: "pythians", fromSlot: 0 }, deps);

    // All counts should be zero
    expect(result.requests).toBe(0);
    expect(result.blocks).toBe(0);
    expect(result.eventsUpserted).toBe(0);
    expect(result.chunks).toBe(0);

    // client.head and stream should never be called
    expect((deps.client.head as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((deps.client.stream as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    // members() should not be called either (we bail before resolving members)
    // Note: if implementation calls members() before kill switch check, that's also acceptable
    // The key invariant is no network calls (client methods) and empty result
  });
});
