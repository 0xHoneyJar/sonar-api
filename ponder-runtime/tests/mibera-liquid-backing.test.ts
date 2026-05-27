// ponder-runtime/tests/mibera-liquid-backing.test.ts
//
// Unit tests for the F-2 mibera-liquid-backing handler split (loans / treasury
// / rfv). The handlers themselves register via ponder.on() at module-load
// time — exercising them end-to-end requires the ponder runtime. The tests
// here focus on the SHARED HELPERS in shared.ts:
//
//   - encodeTokenIds / decodeTokenIds round-trip (uint256-safe via JSON)
//   - getDayFromTimestamp boundary cases
//   - getOrCreateStats / getOrCreateLoanStats return correctly-shaped
//     defaults when the singleton row is absent
//
// The end-to-end handler exercise lives in the byte-parity test
// (byte-parity.test.ts fixture 07) + the entity-parity audit script
// (scripts/parity-check.sh).

import { describe, expect, it } from "vitest";
import {
  encodeTokenIds,
  decodeTokenIds,
  getDayFromTimestamp,
  getOrCreateStats,
  getOrCreateLoanStats,
  STATS_ID,
  BERACHAIN_ID,
  SECONDS_PER_DAY,
} from "../src/handlers/mibera-liquid-backing/shared";

describe("mibera-liquid-backing/shared — encode/decode tokenIds", () => {
  it("round-trips an empty array", () => {
    const encoded = encodeTokenIds([]);
    expect(encoded).toBe("[]");
    expect(decodeTokenIds(encoded)).toEqual([]);
  });

  it("round-trips a single bigint", () => {
    const encoded = encodeTokenIds([42n]);
    expect(encoded).toBe('["42"]');
    expect(decodeTokenIds(encoded)).toEqual([42n]);
  });

  it("round-trips multiple bigints", () => {
    const ids = [1n, 2n, 3n, 100n];
    const encoded = encodeTokenIds(ids);
    expect(decodeTokenIds(encoded)).toEqual(ids);
  });

  it("preserves uint256 fidelity for very large numbers", () => {
    // Max uint256 = 2^256 - 1; well beyond JS safe-integer range.
    const huge = (2n ** 256n) - 1n;
    const encoded = encodeTokenIds([huge]);
    expect(decodeTokenIds(encoded)).toEqual([huge]);
  });

  it("decodeTokenIds returns empty array on invalid JSON", () => {
    expect(decodeTokenIds("not-json")).toEqual([]);
    expect(decodeTokenIds("")).toEqual([]);
  });
});

describe("mibera-liquid-backing/shared — getDayFromTimestamp", () => {
  it("returns 0 for epoch", () => {
    expect(getDayFromTimestamp(0n)).toBe(0);
  });

  it("returns 1 for the first second of day 1", () => {
    expect(getDayFromTimestamp(BigInt(SECONDS_PER_DAY))).toBe(1);
  });

  it("returns the same day for timestamps within the same UTC day", () => {
    // Two timestamps 1 hour apart on the same day should map to the same day.
    const t1 = BigInt(SECONDS_PER_DAY * 100);                // day 100 start
    const t2 = BigInt(SECONDS_PER_DAY * 100 + 3600);         // 1h later
    expect(getDayFromTimestamp(t1)).toBe(getDayFromTimestamp(t2));
    expect(getDayFromTimestamp(t1)).toBe(100);
  });

  it("rolls over correctly across day boundaries", () => {
    expect(getDayFromTimestamp(BigInt(SECONDS_PER_DAY * 50 + SECONDS_PER_DAY - 1))).toBe(50);
    expect(getDayFromTimestamp(BigInt(SECONDS_PER_DAY * 51))).toBe(51);
  });
});

describe("mibera-liquid-backing/shared — singleton defaults", () => {
  // Mock context where db.find always returns undefined → exercises the
  // "create default in-memory" branch.
  const emptyContext = {
    db: {
      find: async () => undefined,
    },
  };

  it("getOrCreateStats returns the correct default shape", async () => {
    const stats = await getOrCreateStats(emptyContext);
    expect(stats).toEqual({
      id: STATS_ID,
      totalItemsOwned: 0,
      totalItemsEverOwned: 0,
      totalItemsSold: 0,
      realFloorValue: 0n,
      lastRfvUpdate: null,
      lastActivityAt: 0n,
      chainId: BERACHAIN_ID,
    });
  });

  it("getOrCreateLoanStats returns the correct default shape", async () => {
    const stats = await getOrCreateLoanStats(emptyContext);
    expect(stats).toEqual({
      id: STATS_ID,
      totalActiveLoans: 0,
      totalLoansCreated: 0,
      totalLoansRepaid: 0,
      totalLoansDefaulted: 0,
      totalAmountLoaned: 0n,
      totalNftsWithLoans: 0,
      chainId: BERACHAIN_ID,
    });
  });

  it("getOrCreateStats returns the existing row when present", async () => {
    const existing = {
      id: STATS_ID,
      totalItemsOwned: 5,
      totalItemsEverOwned: 10,
      totalItemsSold: 5,
      realFloorValue: 1000n,
      lastRfvUpdate: 100n,
      lastActivityAt: 200n,
      chainId: BERACHAIN_ID,
    };
    const populatedContext = {
      db: { find: async () => existing },
    };
    const stats = await getOrCreateStats(populatedContext);
    expect(stats).toEqual(existing);
  });

  it("STATS_ID matches the documented chainId_global format", () => {
    expect(STATS_ID).toBe(`${BERACHAIN_ID}_global`);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Module-load smoke is intentionally not done here: the handler modules
// import `from "ponder:registry"` which is a Ponder virtual module injected
// at build time. Importing them directly under vitest would always fail
// with ERR_MODULE_NOT_FOUND. Build-time validation is the canonical check
// (typecheck via `npx tsc -p ponder-runtime/tsconfig.json --noEmit` covers
// this — verified clean during F-2/F-3/F-6 dispatch).
// ────────────────────────────────────────────────────────────────────────────
