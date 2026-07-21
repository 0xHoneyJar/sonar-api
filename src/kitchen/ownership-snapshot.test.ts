import { describe, expect, it } from "vitest";

import {
  buildOwnershipSnapshot,
  computeConcentration,
  computeGini,
  countWhaleCandidates,
  holdersFromBalanceMap,
  parseAsOfToUnixSeconds,
  parseCaip10,
  replayHold721Actions,
} from "./ownership-snapshot.js";

describe("computeConcentration / gini", () => {
  it("returns zeros for empty holdings", () => {
    expect(computeConcentration([])).toEqual({ top10_share: 0, hhi: 0, gini: 0 });
    expect(computeGini([])).toBe(0);
  });

  it("marks monopoly as top10=1 hhi=1 gini=0 (single holder)", () => {
    const c = computeConcentration([100]);
    expect(c.top10_share).toBe(1);
    expect(c.hhi).toBe(1);
    expect(c.gini).toBe(0);
  });

  it("computes top10 share and hhi for a skewed distribution", () => {
    const c = computeConcentration([90, 5, 3, 2]);
    expect(c.top10_share).toBe(1);
    expect(c.hhi).toBeCloseTo(0.9 ** 2 + 0.05 ** 2 + 0.03 ** 2 + 0.02 ** 2, 6);
    expect(c.gini).toBeGreaterThan(0.5);
  });
});

describe("countWhaleCandidates", () => {
  it("uses count-stable top 5% cut", () => {
    const balances = Array.from({ length: 100 }, () => 1);
    expect(countWhaleCandidates(balances)).toBe(5);
  });

  it("returns at least 1 when any positive holders exist", () => {
    expect(countWhaleCandidates([3, 2])).toBe(1);
  });
});

describe("parseCaip10 / parseAsOfToUnixSeconds", () => {
  it("parses eip155 caip10 and lowercases address", () => {
    const s = parseCaip10("eip155:1:0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9");
    expect(s).toMatchObject({
      network_namespace: "eip155",
      network_reference: "1",
      address: "0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9",
    });
  });

  it("rejects non-eip155 and bad addresses", () => {
    expect(parseCaip10("solana:mainnet:abc")).toBeNull();
    expect(parseCaip10("eip155:1:notanaddress")).toBeNull();
  });

  it("parses day-only as_of as end of UTC day", () => {
    const sec = parseAsOfToUnixSeconds("2026-06-21");
    expect(sec).toBe(Math.floor(Date.UTC(2026, 5, 21, 23, 59, 59) / 1000));
  });

  it("rejects invalid calendar dates", () => {
    expect(parseAsOfToUnixSeconds("2026-02-31")).toBeNull();
  });
});

describe("replayHold721Actions", () => {
  it("applies numeric1 running balances up to cutoff", () => {
    const map = replayHold721Actions(
      [
        { id: "a_in", actor: "0xaaa", timestamp: 100, numeric1: 2, direction: "in" },
        { id: "b_in", actor: "0xbbb", timestamp: 200, numeric1: 1, direction: "in" },
        { id: "a_out", actor: "0xaaa", timestamp: 300, numeric1: 0, direction: "out" },
        { id: "a_late", actor: "0xaaa", timestamp: 400, numeric1: 5, direction: "in" },
      ],
      300,
    );
    expect(holdersFromBalanceMap(map)).toEqual([{ address: "0xbbb", balance: 1 }]);
  });
});

describe("buildOwnershipSnapshot", () => {
  const subject = parseCaip10("eip155:1:0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9")!;

  it("builds E2 snapshot with concentration and whale candidates", () => {
    const snap = buildOwnershipSnapshot({
      subject,
      holders: [
        { address: "0xaaa", balance: 50 },
        { address: "0xbbb", balance: 30 },
        { address: "0xccc", balance: 20 },
      ],
      asOfUnixSeconds: null,
      observedAtMs: 1_700_000_000_000,
    });
    expect(snap.coverage.ownership).toBe("available");
    expect(snap.as_of).toBeNull();
    expect(snap.holder_count).toBe(3);
    expect(snap.concentration).toMatchObject({ top10_share: 1 });
    expect(snap.whale_candidate_count).toBe(1);
    expect(snap.holders[0]?.address).toBe("0xaaa");
  });

  it("returns insufficient_data envelope when requested", () => {
    const snap = buildOwnershipSnapshot({
      subject,
      holders: [],
      asOfUnixSeconds: parseAsOfToUnixSeconds("2026-06-21"),
      insufficient: {
        status: "insufficient_data",
        reason: "indexed history starts after as_of",
      },
    });
    expect(snap.coverage.ownership).toBe("unavailable");
    expect(snap.as_of).toBe("2026-06-21");
    expect(snap.metrics).toMatchObject({ status: "insufficient_data" });
  });
});
