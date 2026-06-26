/*
 * id.test.ts — content-addressed label id (SDD §2.1, DH-2). Pins the anti-ambiguity properties.
 */
import { describe, it, expect } from "vitest";
import { labelId, labelKeyTuple, type LabelKey } from "../../src/labels/id";

const base: LabelKey = {
  chain: "solana",
  address: "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix",
  collectionScope: "pythians",
  entityType: "marketplace_escrow",
  method: "chain-mechanical",
  evidenceRef: "SIG_ABC",
};

describe("labelId", () => {
  it("is stable — identical key → identical id (idempotent re-ingest)", () => {
    expect(labelId(base)).toBe(labelId({ ...base }));
  });

  it("is a 64-char sha256 hex", () => {
    expect(labelId(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes null collectionScope from empty string (DH-2 no-ambiguity)", () => {
    expect(labelId({ ...base, collectionScope: null })).not.toBe(labelId({ ...base, collectionScope: "" }));
  });

  it("changes id when any keyed field changes (method / type / scope / evidence)", () => {
    const id0 = labelId(base);
    expect(labelId({ ...base, method: "operator-attested" })).not.toBe(id0);
    expect(labelId({ ...base, entityType: "team" })).not.toBe(id0);
    expect(labelId({ ...base, collectionScope: "mibera" })).not.toBe(id0);
    expect(labelId({ ...base, evidenceRef: "SIG_XYZ" })).not.toBe(id0);
  });

  it("resists the delimiter-collision class — ('sol','ana…') ≠ ('solana',…)", () => {
    const a = labelId({ ...base, chain: "sol", address: "ana" + base.address });
    const b = labelId({ ...base, chain: "solana", address: base.address });
    expect(a).not.toBe(b);
  });

  it("key tuple is fixed-order (6 fields, chain first, evidenceRef last) — validity_from excluded (M4)", () => {
    const t = labelKeyTuple(base);
    expect(t).toHaveLength(6);
    expect(t[0]).toBe("solana");
    expect(t[5]).toBe("SIG_ABC");
  });

  it("is idempotent across re-ingest at different times (validity_from not in the id, M4)", () => {
    // same evidence → same id regardless of when re-ingested (no validityFrom field exists on the key)
    expect(labelId(base)).toBe(labelId({ ...base }));
  });
});
