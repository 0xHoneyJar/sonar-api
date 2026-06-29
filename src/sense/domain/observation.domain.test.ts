import { describe, it, expect } from "vitest";
import {
  grounded,
  refuted,
  unverifiable,
  matchGrounding,
  mapObservation,
  OBSERVATION_SCHEMA_VERSION,
  type Observation,
} from "./observation.domain";

const BERA = 80094;

describe("Observation envelope", () => {
  it("grounded() stamps grounding, schema_version, and default confidence 1", () => {
    const o = grounded({ value: 42n, source: "viem:berachain", chain_id: BERA, trace_id: "t-1" });
    expect(o.grounding).toBe("grounded");
    expect(o.value).toBe(42n);
    expect(o.confidence).toBe(1);
    expect(o.tier).toBe("bronze"); // default
    expect(o.schema_version).toBe(OBSERVATION_SCHEMA_VERSION);
    expect(o.trace_id).toBe("t-1");
    // block_number omitted (not carried as an `undefined` key) when absent
    expect("block_number" in o).toBe(false);
  });

  it("refuted() and unverifiable() default confidence to 0 but stay DISTINCT states", () => {
    const r = refuted({ value: "0xA", source: "viem:berachain", chain_id: BERA, trace_id: "t-2" });
    const u = unverifiable({ value: "0xB", source: "viem:berachain", chain_id: BERA, trace_id: "t-3" });
    expect(r.confidence).toBe(0);
    expect(u.confidence).toBe(0);
    // refuted and unverifiable are NOT one "not-ok" bucket — never collapse
    expect(r.grounding).toBe("refuted");
    expect(u.grounding).toBe("unverifiable");
    expect(r.grounding).not.toBe(u.grounding);
    // refuted still hands back the (contradicted) value — downgrade, not drop
    expect(r.value).toBe("0xA");
  });

  it("carries block_number/tier when supplied and honours a confidence override", () => {
    const o = grounded({
      value: true,
      source: "belt-gateway",
      chain_id: BERA,
      trace_id: "t-4",
      block_number: 123,
      tier: "silver",
      confidence: 0.8,
    });
    expect(o.block_number).toBe(123);
    expect(o.tier).toBe("silver");
    expect(o.confidence).toBe(0.8);
  });

  it("matchGrounding dispatches three distinguishable behaviours", () => {
    const decide = (o: Observation<unknown>) =>
      matchGrounding(o, {
        grounded: () => "trust",
        refuted: () => "reject",
        unverifiable: () => "degrade",
      });
    expect(decide(grounded({ value: 1, source: "s", chain_id: BERA, trace_id: "g" }))).toBe("trust");
    expect(decide(refuted({ value: 1, source: "s", chain_id: BERA, trace_id: "r" }))).toBe("reject");
    expect(decide(unverifiable({ value: 1, source: "s", chain_id: BERA, trace_id: "u" }))).toBe("degrade");
    // all three outcomes are genuinely different
    expect(new Set(["trust", "reject", "degrade"]).size).toBe(3);
  });

  it("serializes without a block_number key when absent (JCS-friendly)", () => {
    const o = grounded({ value: "0xabc", source: "s", chain_id: BERA, trace_id: "t" });
    expect(JSON.stringify(o)).not.toContain("block_number");
  });

  it("mapObservation transforms the value but preserves the epistemic frame", () => {
    const wei = grounded({
      value: 1_000_000_000_000_000_000n,
      source: "viem:berachain",
      chain_id: BERA,
      trace_id: "t-map",
      block_number: 99,
      tier: "silver",
      confidence: 0.9,
    });
    const formatted = mapObservation(wei, (v) => `${v}`);
    expect(formatted.value).toBe("1000000000000000000");
    // frame preserved across the transform
    expect(formatted.grounding).toBe("grounded");
    expect(formatted.tier).toBe("silver");
    expect(formatted.source).toBe("viem:berachain");
    expect(formatted.chain_id).toBe(BERA);
    expect(formatted.block_number).toBe(99);
    expect(formatted.confidence).toBe(0.9);
    expect(formatted.trace_id).toBe("t-map");
  });

  it("clamps an out-of-range confidence override into [0,1]", () => {
    expect(grounded({ value: 1, source: "s", chain_id: BERA, trace_id: "hi", confidence: 2.5 }).confidence).toBe(1);
    expect(grounded({ value: 1, source: "s", chain_id: BERA, trace_id: "lo", confidence: -3 }).confidence).toBe(0);
  });
});
