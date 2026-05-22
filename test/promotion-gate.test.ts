/**
 * promotion-gate.test.ts — test-first harness for the blue→green promotion gate
 * (S1 Task 1.1, SDD §6, FR-4). Exercises the pure gate functions over fixture
 * snapshots: blue-vs-blue self-parity MUST pass; each injected failure (short
 * block height, entity-count drift beyond tolerance, missing/renamed schema
 * field) MUST fail. No live endpoints — the gate is pure over snapshots so the
 * S2 dry-run wires real blue/green data into the same functions.
 */
import { describe, it, expect } from "vitest";
import {
  runGate,
  checkBlockHeights,
  checkEntityCounts,
  checkSchemaSuperset,
  allowedDelta,
  FOOTPRINT,
} from "../scripts/promotion-gate.js";

// A complete, healthy blue snapshot (counts = SDD §6.2 AC-R7 footprint baselines).
const blueSnapshot = () => ({
  chainMeta: { "80094": 9_000_000, "8453": 2_500_000, "10": 108_000_000, "1": 13_200_000 },
  counts: {
    MiberaTransfer: 39_714, MintActivity: 10_000, NftBurn: 39, BgtBoostEvent: 1_470_000,
    Erc1155MintEvent: 7_607, FriendtechTrade: 1_317, PaddleSupply: 363, MintEvent: 3_588,
    TreasuryActivity: 11_819, Action: 2_070_000, MiberaLoan: 176, MiberaStakedToken: 1_603,
  },
  schema: "type Action { id: ID! timestamp: BigInt! } type PaddleSupply { id: ID! blockNumber: BigInt! }",
});

// deep clone helper (snapshots are plain JSON)
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

describe("promotion-gate — self-parity (a gate that fails its own identity is broken)", () => {
  it("PASSES when green is identical to blue (AC: self-parity exit 0)", () => {
    const blue = blueSnapshot();
    const green = clone(blue);
    const r = runGate(blue, green);
    expect(r.pass).toBe(true);
    expect(r.part1.failures).toEqual([]);
    expect(r.part2.failures).toEqual([]);
    expect(r.part3.failures).toEqual([]);
  });

  it("covers all 12 footprint entities (AC: 12/12 coverage)", () => {
    expect(FOOTPRINT).toHaveLength(12);
    const blue = blueSnapshot();
    for (const f of FOOTPRINT) expect(blue.counts).toHaveProperty(f.entity);
  });
});

describe("promotion-gate — Part 1 block-height parity (negative cases)", () => {
  it("FAILS when green is behind blue on any chain (still backfilling)", () => {
    const blue = blueSnapshot();
    const green = clone(blue);
    green.chainMeta["8453"] = 2_400_000; // green behind on Base
    const r = checkBlockHeights(blue.chainMeta, green.chainMeta);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/8453/);
  });

  it("FAILS when green is missing a chain blue has (silent-skip — KF-013/D6)", () => {
    const blue = blueSnapshot();
    const green = clone(blue);
    delete green.chainMeta["1"]; // green never seeded ETH
    const r = checkBlockHeights(blue.chainMeta, green.chainMeta);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/chain 1/);
  });

  it("PASSES when green is ahead (≥) on every chain", () => {
    const blue = blueSnapshot();
    const green = clone(blue);
    for (const c of Object.keys(green.chainMeta)) green.chainMeta[c] += 100;
    expect(checkBlockHeights(blue.chainMeta, green.chainMeta).pass).toBe(true);
  });
});

describe("promotion-gate — Part 2 entity-count reconciliation (negative cases)", () => {
  it("FAILS on a dropped-entity class beyond tolerance (KF-012 silent loss)", () => {
    const blue = blueSnapshot();
    const green = clone(blue);
    green.counts.BgtBoostEvent = 1_400_000; // 70k missing — well beyond floor
    const r = checkEntityCounts(blue.counts, green.counts, FOOTPRINT);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/BgtBoostEvent/);
  });

  it("FAILS exact-match (low-cardinality) on even a single missing row", () => {
    const blue = blueSnapshot();
    const green = clone(blue);
    green.counts.MiberaLoan = 175; // one loan missing — exact entity
    const r = checkEntityCounts(blue.counts, green.counts, FOOTPRINT);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/MiberaLoan/);
  });

  it("FAIL-CLOSED when a count is missing (unknown → FAIL, never PASS) (SR-7a/IMP-004)", () => {
    const blue = blueSnapshot();
    const green = clone(blue);
    delete (green.counts as Record<string, number>).Action;
    const r = checkEntityCounts(blue.counts, green.counts, FOOTPRINT);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/Action/);
  });

  it("ALLOWS small head drift within the absolute floor on high-cardinality", () => {
    const blue = blueSnapshot();
    const green = clone(blue);
    green.counts.Action = 2_070_000 + 300; // within max(0.1%, floor)
    expect(checkEntityCounts(blue.counts, green.counts, FOOTPRINT).pass).toBe(true);
  });
});

describe("promotion-gate — allowedDelta tolerance model (R-G)", () => {
  it("exact entities allow zero drift", () => {
    expect(allowedDelta(176, { exact: true })).toBe(0);
  });
  it("high-cardinality uses max(rel, floor)", () => {
    // 0.1% of 2.07M = 2070; floor 500 → 2070
    expect(allowedDelta(2_070_000, { rel: 0.001, floor: 500 })).toBe(2_070);
    // 0.1% of 39714 = 39.7→40; floor 50 → 50 (floor wins)
    expect(allowedDelta(39_714, { rel: 0.001, floor: 50 })).toBe(50);
  });
});

describe("promotion-gate — Part 3 schema superset (additive-only, FR-7)", () => {
  it("PASSES when green schema ⊇ blue (additive: green adds a field)", () => {
    const blue = "type Action { id: ID! timestamp: BigInt! }";
    const green = "type Action { id: ID! timestamp: BigInt! blockNumber: BigInt! }"; // additive
    expect(checkSchemaSuperset(blue, green).pass).toBe(true);
  });

  it("FAILS when green is missing a blue field (non-additive removal)", () => {
    const blue = "type Action { id: ID! timestamp: BigInt! }";
    const green = "type Action { id: ID! }"; // dropped timestamp
    const r = checkSchemaSuperset(blue, green);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/timestamp/);
  });

  it("FAILS on a nullability contraction (BigInt! → BigInt or vice versa)", () => {
    const blue = "type PaddleSupply { id: ID! firstSupplyTime: BigInt }";
    const green = "type PaddleSupply { id: ID! firstSupplyTime: BigInt! }"; // nullability changed
    expect(checkSchemaSuperset(blue, green).pass).toBe(false);
  });

  it("FAILS when green drops an entire type blue has", () => {
    const blue = "type Action { id: ID! } type PaddleSupply { id: ID! }";
    const green = "type Action { id: ID! }";
    const r = checkSchemaSuperset(blue, green);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/PaddleSupply/);
  });
});
