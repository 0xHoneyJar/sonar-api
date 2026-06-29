import { describe, it, expect } from "vitest";
import { parityReport, parityKey, activityParityKey, type ParityKey } from "../../src/canonical/parity";
import type { NftActivity } from "@0xhoneyjar/events";

// parityReport reads only tx/asset_ref/verb — a minimal cast is sufficient + keeps the test focused.
const act = (tx: string, asset_ref: string, verb: string): NftActivity => ({ tx, asset_ref, verb }) as NftActivity;
const key = (tx: string, asset_ref: string, verb: string): ParityKey => ({ tx, asset_ref, verb });

describe("parityReport — the executable S5 consumer-parity gate", () => {
  it("perfect parity: canonical covers exactly legacy → parityHolds, no diffs", () => {
    const canonical = [act("0xtx1", "1", "sale"), act("0xtx2", "2", "transfer")];
    const legacy = [key("0xtx1", "1", "sale"), key("0xtx2", "2", "transfer")];
    const r = parityReport(canonical, legacy);
    expect(r.parityHolds).toBe(true);
    expect(r.matched).toHaveLength(2);
    expect(r.canonicalOnly).toHaveLength(0);
    expect(r.legacyOnly).toHaveLength(0);
  });

  it("FAILURE: a legacy activity missing from canonical → parityHolds FALSE (the cardinal-sin guard)", () => {
    const canonical = [act("0xtx1", "1", "sale")];
    const legacy = [key("0xtx1", "1", "sale"), key("0xtx9", "9", "mint")]; // canonical lost the mint
    const r = parityReport(canonical, legacy);
    expect(r.parityHolds).toBe(false);
    expect(r.legacyOnly).toEqual([parityKey(key("0xtx9", "9", "mint"))]);
    expect(r.legacyOnlyByVerb).toEqual({ mint: 1 });
  });

  it("MAJOR-3: a market-routed sale's routing-hop transfer is canonicalOnly but parity STILL holds (quantified)", () => {
    // canonical: the sale (matches legacy) + the routing-hop transfer (the known over-emit)
    const canonical = [act("0xtxA", "7", "sale"), act("0xtxA", "7", "transfer")];
    const legacy = [key("0xtxA", "7", "sale")]; // the consumer's current fetcher only knows the sale
    const r = parityReport(canonical, legacy);
    expect(r.parityHolds).toBe(true); // over-emit does NOT break parity (it loses nothing legacy has)
    expect(r.canonicalOnly).toEqual([activityParityKey(act("0xtxA", "7", "transfer"))]);
    expect(r.canonicalOnlyByVerb).toEqual({ transfer: 1 }); // surfaced + counted for the S5 decision
    expect(r.verbDisagreements).toHaveLength(0); // a pure over-emit is NOT a misclassification
  });

  it("MAJOR-1: a demoted sale (canonical transfer vs legacy sale, same tx+asset) is a verbDisagreement, not a tolerable over-emit", () => {
    const canonical = [act("0xtxA", "7", "transfer")]; // producer demoted the sale (e.g. a join-miss)
    const legacy = [key("0xtxA", "7", "sale")];
    const r = parityReport(canonical, legacy);
    expect(r.parityHolds).toBe(false); // the sale the consumer relies on is lost
    expect(r.verbDisagreements).toEqual([
      { tx: "0xtxA", asset_ref: "7", canonicalVerbs: ["transfer"], legacyVerbs: ["sale"] },
    ]);
    // it ALSO appears in the raw only-buckets, but verbDisagreements names it so it can't hide
    expect(r.canonicalOnlyByVerb).toEqual({ transfer: 1 });
    expect(r.legacyOnlyByVerb).toEqual({ sale: 1 });
  });

  it("exposes cardinalities + the presence-only flag (MAJOR-2 / MINOR-2 guards)", () => {
    const r = parityReport([act("t", "1", "mint")], [key("t", "1", "mint"), key("t2", "2", "sale")]);
    expect(r.canonicalCount).toBe(1);
    expect(r.legacyCount).toBe(2);
    expect(r.valueParityChecked).toBe(false);
  });

  it("dedups by (tx,asset_ref,verb): duplicate canonical legs collapse to one key", () => {
    const canonical = [act("0xtxA", "7", "sale"), act("0xtxA", "7", "sale")];
    const legacy = [key("0xtxA", "7", "sale")];
    const r = parityReport(canonical, legacy);
    expect(r.matched).toHaveLength(1);
    expect(r.canonicalOnly).toHaveLength(0);
    expect(r.parityHolds).toBe(true);
  });

  it("tallies canonicalOnly + legacyOnly by verb across a mix", () => {
    const canonical = [act("t1", "1", "mint"), act("t2", "2", "sale"), act("t2", "2", "transfer")];
    const legacy = [key("t1", "1", "mint"), key("t2", "2", "sale"), key("t3", "3", "burn")];
    const r = parityReport(canonical, legacy);
    expect(r.parityHolds).toBe(false); // t3 burn lost
    expect(r.legacyOnlyByVerb).toEqual({ burn: 1 });
    expect(r.canonicalOnlyByVerb).toEqual({ transfer: 1 });
    expect(r.matched).toHaveLength(2);
  });

  it("keys are consistent + collision-proof (JSON-encoded — MINOR-1)", () => {
    expect(parityKey(key("0xabc", "123", "sale"))).toBe('["0xabc","123","sale"]');
    expect(activityParityKey(act("0xabc", "123", "sale"))).toBe('["0xabc","123","sale"]');
    // a delimiter-bearing component cannot false-merge two distinct tuples
    expect(parityKey(key("a|b", "c", "sale"))).not.toBe(parityKey(key("a", "b|c", "sale")));
  });
});
