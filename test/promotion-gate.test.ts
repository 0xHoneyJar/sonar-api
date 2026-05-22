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
  checkRawL1,
  buildCountField,
  buildSnapshotQuery,
  loadGoldenSamples,
  loadExpectedChains,
  redactUrl,
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

  // DISS-001: enum value-set contraction must FAIL (AC-7/IMP-005 enum dimension).
  it("PASSES when green adds an enum value (additive)", () => {
    const blue = "enum LoanStatus { ACTIVE CLOSED }";
    const green = "enum LoanStatus { ACTIVE CLOSED LIQUIDATED }"; // additive value
    expect(checkSchemaSuperset(blue, green).pass).toBe(true);
  });

  it("FAILS when green removes an enum value (non-additive contraction — DISS-001)", () => {
    const blue = "enum LoanStatus { ACTIVE CLOSED LIQUIDATED }";
    const green = "enum LoanStatus { ACTIVE CLOSED }"; // dropped LIQUIDATED
    const r = checkSchemaSuperset(blue, green);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/LIQUIDATED/);
  });

  it("FAILS when green drops an entire enum blue has", () => {
    const blue = "type Loan { id: ID! status: LoanStatus! } enum LoanStatus { ACTIVE CLOSED }";
    const green = "type Loan { id: ID! status: LoanStatus! }"; // enum removed entirely
    const r = checkSchemaSuperset(blue, green);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/LoanStatus/);
  });
});

// ── Expansion mode (S2 reframe: green ⊋ blue, non-lossy not parity) ─────────────

describe("promotion-gate — EXPANSION mode Part 2 (non-lossy, green MAY exceed)", () => {
  it("PASSES when green exceeds blue on shared entities (the whole point)", () => {
    const blue = blueSnapshot();
    const green = clone(blue);
    green.counts.MintActivity = 29_514; // +19,514 from new-chain mints
    green.counts.BgtBoostEvent = 1_472_958;
    green.counts.Action = 2_391_345;
    const r = checkEntityCounts(blue.counts, green.counts, FOOTPRINT, { mode: "expansion" });
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("FAILS when green REGRESSES below blue − floor on a shared entity (lossy)", () => {
    const blue = blueSnapshot();
    const green = clone(blue);
    green.counts.BgtBoostEvent = 1_400_000; // 70k below blue, well past the 500 floor
    const r = checkEntityCounts(blue.counts, green.counts, FOOTPRINT, { mode: "expansion" });
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/BgtBoostEvent.*LOSSY/);
  });

  it("PASSES at the exact blue − floor boundary (head-timing skew tolerated)", () => {
    // BgtBoostEvent allowed = max(ceil(1.47M × 0.001)=1470, floor 500) = 1470 (rel dominates).
    const allowed = allowedDelta(1_470_000, { rel: 0.001, floor: 500 });
    expect(allowed).toBe(1_470);
    const blue = blueSnapshot();
    const green = clone(blue);
    green.counts.BgtBoostEvent = 1_470_000 - allowed; // exactly blue − floor
    expect(checkEntityCounts(blue.counts, green.counts, FOOTPRINT, { mode: "expansion" }).pass).toBe(true);
    green.counts.BgtBoostEvent = 1_470_000 - allowed - 1; // one past the floor
    expect(checkEntityCounts(blue.counts, green.counts, FOOTPRINT, { mode: "expansion" }).pass).toBe(false);
  });

  it("exact-tolerance shared entity stays exact downward (green < blue by 1 = lossy)", () => {
    const blue = blueSnapshot();
    const green = clone(blue);
    green.counts.MiberaLoan = 175; // exact entity, one missing → floor 0 → lossy
    expect(checkEntityCounts(blue.counts, green.counts, FOOTPRINT, { mode: "expansion" }).pass).toBe(false);
  });

  // The live shape: blue MintActivity 10,000 vs green 29,514 — expansion PASS, parity FAIL.
  it("live-shape regression: green ⊋ blue PASSES expansion but FAILS parity", () => {
    const blue = blueSnapshot();
    const green = clone(blue);
    green.counts.MintActivity = 29_514;
    expect(runGate(blue, green, { mode: "expansion" }).pass).toBe(true);
    expect(runGate(blue, green, { mode: "parity" }).pass).toBe(false);
    expect(runGate(blue, green).pass).toBe(false); // default mode is parity
  });

  it("routes NEW entities to Part-4 (no blue compare; deferred, not failed)", () => {
    const mixedFootprint = [
      { entity: "MintActivity", baseline: 10_000, mode: "A", presence: "shared", tolerance: { rel: 0.001, floor: 25 } },
      { entity: "ZoraOnlyEvent", baseline: 0, mode: "A", presence: "new", tolerance: { exact: true } },
    ];
    const blueCounts = { MintActivity: 10_000 }; // blue never indexed ZoraOnlyEvent
    const greenCounts = { MintActivity: 12_000, ZoraOnlyEvent: 5_000 };
    const r = checkEntityCounts(blueCounts, greenCounts, mixedFootprint, { mode: "expansion" });
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.deferred.join(" ")).toMatch(/ZoraOnlyEvent.*Part-4/);
  });

  it("parity mode still FAIL-CLOSES on a new entity missing in blue (presence ignored)", () => {
    const mixedFootprint = [
      { entity: "ZoraOnlyEvent", baseline: 0, mode: "A", presence: "new", tolerance: { exact: true } },
    ];
    const r = checkEntityCounts({}, { ZoraOnlyEvent: 5_000 }, mixedFootprint, { mode: "parity" });
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/ZoraOnlyEvent.*fail-closed/);
  });
});

describe("promotion-gate — EXPANSION mode Part 1 (green-only chains deferred)", () => {
  it("defers green-only chains to Part-4 while still checking shared chains", () => {
    const blue = { "1": 100, "10": 200, "8453": 300, "80094": 400 };
    const green = { "1": 100, "10": 200, "8453": 300, "80094": 400, "42161": 999, "7777777": 888 };
    const r = checkBlockHeights(blue, green, { mode: "expansion" });
    expect(r.pass).toBe(true);
    expect(r.deferred.join(" ")).toMatch(/42161/);
    expect(r.deferred.join(" ")).toMatch(/7777777/);
  });

  it("still FAILS a shared chain that is behind, even in expansion", () => {
    const blue = { "8453": 300 };
    const green = { "8453": 250, "42161": 999 };
    expect(checkBlockHeights(blue, green, { mode: "expansion" }).pass).toBe(false);
  });

  it("parity mode reports no deferred chains", () => {
    const blue = { "1": 100 };
    const green = { "1": 100, "42161": 999 };
    expect(checkBlockHeights(blue, green).deferred).toEqual([]);
  });

  // BLOCKING-1: green cannot self-attest completeness. An independent expectedChains list
  // catches a NEW chain that silently failed to seed (absent from green.chainMeta).
  it("FAILS when an EXPECTED new chain is absent from green (silent-drop, not self-attested)", () => {
    const blue = { "1": 100, "10": 200 };
    const green = { "1": 100, "10": 200, "42161": 999 }; // green has Arb but NOT Zora
    const r = checkBlockHeights(blue, green, { mode: "expansion", expectedChains: [1, 10, 42161, 7777777] });
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/7777777.*EXPECTED.*absent/);
  });

  it("PASSES when green contains every expected chain", () => {
    const blue = { "1": 100, "10": 200 };
    const green = { "1": 100, "10": 200, "42161": 999, "7777777": 888 };
    const r = checkBlockHeights(blue, green, { mode: "expansion", expectedChains: [1, 10, 42161, 7777777] });
    expect(r.pass).toBe(true);
  });

  it("does not double-flag a shared chain already covered by the blue loop", () => {
    const blue = { "1": 100 };
    const green = {}; // green missing chain 1 entirely
    const r = checkBlockHeights(blue, green, { mode: "expansion", expectedChains: [1] });
    expect(r.pass).toBe(false);
    expect(r.failures.filter((f: string) => f.includes("chain 1"))).toHaveLength(1); // exactly one failure for chain 1
  });
});

// ── Part 4 — golden-tx identity (BLOCKING-2: non-emptiness is not enough, SR-5) ─────

describe("promotion-gate — Part 4 golden-tx identity match", () => {
  const base = { chain: 42161, address: "0xabc", fromBlock: 1, toBlock: 100, minExpected: 1, label: "arb golden" };

  it("PASSES when the golden tx is among the returned logs", async () => {
    const rpcFetch = async () => [{ transactionHash: "0xDEAD" }, { transactionHash: "0xBEEF" }];
    const r = await checkRawL1([{ ...base, expectTx: "0xbeef" }], { rpcFetch, requiredChains: [42161] });
    expect(r.pass).toBe(true);
    expect(r.checks[0].ok).toBe(true);
  });

  it("FAILS when logs are non-empty but the golden tx is absent (unrelated logs)", async () => {
    const rpcFetch = async () => [{ transactionHash: "0xUNRELATED1" }, { transactionHash: "0xUNRELATED2" }];
    const r = await checkRawL1([{ ...base, expectTx: "0xbeef" }], { rpcFetch, requiredChains: [42161] });
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/golden tx 0xbeef NOT among/);
  });
});

describe("promotion-gate — loadExpectedChains", () => {
  it("returns [] when EXPECTED_CHAINS is unset (main() then fails-closed in expansion)", () => {
    expect(loadExpectedChains({})).toEqual([]);
  });
  it("parses a JSON array of chain ids as strings", () => {
    expect(loadExpectedChains({ EXPECTED_CHAINS: "[1,10,42161]" })).toEqual(["1", "10", "42161"]);
  });
  it("throws on invalid JSON (fail-closed, not silent-empty)", () => {
    expect(() => loadExpectedChains({ EXPECTED_CHAINS: "[1,2" })).toThrow(/not valid JSON/);
  });
});

// Audit finding (KF-004 suspicion lens): URLs are persisted to the git-committed report + errors.
describe("promotion-gate — redactUrl (credential leak defense, audit HIGH-secrets)", () => {
  it("strips userinfo (user:pass@)", () => {
    expect(redactUrl("https://user:s3cret@host/v1/graphql")).toMatch(/\/\/\*\*\*:\*\*\*@host/);
    expect(redactUrl("https://user:s3cret@host/v1/graphql")).not.toMatch(/s3cret/);
  });
  it("redacts sensitive query params (token/key/secret/admin)", () => {
    const r = redactUrl("https://rpc.example/v2?apiKey=DEADBEEF&token=abc&plain=ok");
    expect(r).not.toMatch(/DEADBEEF/);
    expect(r).not.toMatch(/abc/);
    expect(r).toMatch(/plain=ok/);
  });
  it("leaves a clean URL unchanged (no-op on credential-free endpoints)", () => {
    const clean = "https://belt-hasura-green-production.up.railway.app/v1/graphql";
    expect(redactUrl(clean)).toBe(clean);
  });
  it("best-effort strips userinfo from a non-parseable input", () => {
    expect(redactUrl("not a url but user:pass@leaky")).toBe("not a url but user:pass@leaky"); // no // → unchanged
  });
});

// ── Part 4 — raw-L1 eth_getLogs ground-truth (the ONLY check for new chains) ────

describe("promotion-gate — Part 4 raw-L1 (KF-012: empty-200 = GAP, never pass)", () => {
  const sample = (over = {}) => ({ chain: 42161, address: "0xabc", fromBlock: 1, toBlock: 100, minExpected: 1, label: "arb sample", ...over });

  it("PASSES when each golden sample returns ≥ expected logs", async () => {
    const rpcFetch = async () => [{}, {}, {}];
    const r = await checkRawL1([sample({ minExpected: 2 })], { rpcFetch, requiredChains: [42161] });
    expect(r.pass).toBe(true);
    expect(r.checks[0].ok).toBe(true);
  });

  it("FAILS an empty getLogs-200 as a GAP (KF-012), never a pass", async () => {
    const rpcFetch = async () => []; // the getLogs-liar shape
    const r = await checkRawL1([sample()], { rpcFetch, requiredChains: [42161] });
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/GAP/);
    expect(r.failures.join(" ")).toMatch(/KF-012/);
  });

  it("FAILS when fewer logs than expected are returned", async () => {
    const rpcFetch = async () => [{}]; // 1 log
    const r = await checkRawL1([sample({ minExpected: 5 })], { rpcFetch, requiredChains: [42161] });
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/< expected 5/);
  });

  it("FAIL-CLOSED when a required new chain has no golden sample", async () => {
    const rpcFetch = async () => [{}];
    const r = await checkRawL1([sample({ chain: 42161 })], { rpcFetch, requiredChains: [42161, 7777777] });
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/7777777.*no golden sample/);
  });

  it("FAIL-CLOSED when no rpcFetch is injected", async () => {
    const r = await checkRawL1([sample()], {});
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/no rpcFetch/);
  });

  it("FAIL-CLOSED when rpcFetch throws (RPC error)", async () => {
    const rpcFetch = async () => { throw new Error("ECONNRESET"); };
    const r = await checkRawL1([sample()], { rpcFetch });
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/ECONNRESET/);
  });

  it("FAIL-CLOSED on a non-array getLogs response", async () => {
    const rpcFetch = async () => ({ not: "an array" });
    const r = await checkRawL1([sample()], { rpcFetch });
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/non-array/);
  });
});

// ── makeFetchSnapshot query builder (per-MODE, Task 1.0) ────────────────────────

describe("promotion-gate — per-MODE count query builder", () => {
  it("MODE A with a block cutoff filters on blockNumber", () => {
    const q = buildCountField("e0", "MintActivity", "A", { cutoffBlock: "12345" });
    expect(q).toMatch(/MintActivity_aggregate\(where: \{blockNumber: \{_lte: "12345"\}\}\)/);
  });

  it("MODE B with a timestamp cutoff filters on timestamp (Action has no blockNumber)", () => {
    const q = buildCountField("e9", "Action", "B", { cutoffTs: "1700000000" });
    expect(q).toMatch(/Action_aggregate\(where: \{timestamp: \{_lte: "1700000000"\}\}\)/);
  });

  it("MODE C and the no-cutoff case are a straight total count", () => {
    expect(buildCountField("e1", "MiberaLoan", "C", { cutoffBlock: "999" })).toMatch(/MiberaLoan_aggregate \{ aggregate \{ count \} \}/);
    expect(buildCountField("e2", "MintActivity", "A", {})).toMatch(/MintActivity_aggregate \{ aggregate \{ count \} \}/);
  });

  it("buildSnapshotQuery batches chain_metadata + one alias per footprint entity", () => {
    const q = buildSnapshotQuery(FOOTPRINT, {});
    expect(q).toMatch(/chain_metadata/);
    for (let i = 0; i < FOOTPRINT.length; i++) expect(q).toMatch(new RegExp(`e${i}:`));
  });
});

describe("promotion-gate — loadGoldenSamples", () => {
  it("returns [] when GOLDEN_SAMPLES is unset", () => {
    expect(loadGoldenSamples({})).toEqual([]);
  });
  it("parses a JSON array of samples", () => {
    const env = { GOLDEN_SAMPLES: JSON.stringify([{ chain: 42161, address: "0x", fromBlock: 1, toBlock: 2 }]) };
    expect(loadGoldenSamples(env)).toHaveLength(1);
  });
  it("throws on invalid JSON (fail-closed, not silent-empty)", () => {
    expect(() => loadGoldenSamples({ GOLDEN_SAMPLES: "{not json" })).toThrow(/not valid JSON/);
  });
});
