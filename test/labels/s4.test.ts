/*
 * s4.test.ts — confidence derivation (H-5), own-indexed classifier (T4.5), reconcile gate + fallback (H-6),
 * and the bounded worker (DH-7).
 */
import { describe, it, expect } from "vitest";
import { confidenceFor, effectiveConfidence, HALF_LIFE_DAYS } from "../../src/labels/confidence";
import { classifyAddress, classifyFlows } from "../../src/labels/classify-from-events";
import { makeReconcileStep, reconcileQueueWorker, type Reconciler } from "../../src/labels/reconcile";
import { LabelReject, type LabelInput, type RunSql } from "../../src/labels/types";

const ctx = { runSql: (async () => ({})) as RunSql, log: () => {} };
const row = (over: Partial<LabelInput> = {}): LabelInput => ({
  address: "A", chain: "solana", collectionScope: "pythians", entity: "e", label: "L",
  entityType: "marketplace_escrow", method: "chain-mechanical", evidenceRef: "r", ...over,
});

describe("confidenceFor (H-5)", () => {
  it("is method-derived, not free-form", () => {
    expect(confidenceFor("chain-mechanical")).toBe(1.0);
    expect(confidenceFor("operator-attested")).toBe(1.0);
    expect(confidenceFor("program-metadata")).toBe(0.95);
    expect(confidenceFor("own-indexed", { patternStrength: 1 })).toBeCloseTo(0.95);
    expect(confidenceFor("own-indexed", { patternStrength: 0 })).toBeCloseTo(0.8);
    expect(confidenceFor("external-attested")).toBe(0.5);
    expect(confidenceFor("external-attested", { corroborated: true })).toBe(0.9);
  });
  it("decays open windows except chain-mechanical/operator-attested (∞)", () => {
    expect(HALF_LIFE_DAYS["chain-mechanical"]).toBeNull();
    expect(effectiveConfidence("chain-mechanical", 1, 9999)).toBe(1);
    expect(effectiveConfidence("own-indexed", 0.9, 180)).toBeCloseTo(0.45); // one half-life
  });
});

describe("classifyAddress (T4.5)", () => {
  it("escrow = high inflow AND outflow (Magic Eden shape)", () => {
    expect(classifyAddress({ address: "ME", toCount: 4067, fromCount: 1653 })?.entityType).toBe("marketplace_escrow");
  });
  it("distributor = heavy fan-out, ~no inflow (pyThKE shape)", () => {
    expect(classifyAddress({ address: "D", toCount: 5, fromCount: 3182 })?.entityType).toBe("distributor");
  });
  it("ignores low-volume / ambiguous addresses", () => {
    expect(classifyAddress({ address: "x", toCount: 3, fromCount: 4 })).toBeNull();
    expect(classifyFlows([{ address: "x", toCount: 3, fromCount: 4 }])).toHaveLength(0);
  });
});

describe("makeReconcileStep (H-6/SP-5)", () => {
  const step = (o: Reconciler) => makeReconcileStep(o);
  it("verified when source available + ok", async () => {
    const out = await step(async () => ({ available: true, ok: true })).apply(row(), ctx);
    expect(out.status).toBe("verified");
  });
  it("rejects when available + not ok", async () => {
    await expect(step(async () => ({ available: true, ok: false })).apply(row(), ctx)).rejects.toBeInstanceOf(LabelReject);
  });
  it("unverified (never blocks) when source unavailable — Helius down", async () => {
    const out = await step(async () => ({ available: false, ok: false })).apply(row(), ctx);
    expect(out.status).toBe("unverified");
  });
  it("passes non-chain-derived through (operator-attested/external/heuristic)", async () => {
    const r = row({ method: "operator-attested" });
    expect(await step(async () => ({ available: true, ok: false })).apply(r, ctx)).toEqual(r);
  });
});

describe("reconcileQueueWorker (DH-7)", () => {
  const oneUnverified = (sql: string) =>
    /SELECT id, address/.test(sql)
      ? { result: [["id"], ["ID1", "A", "solana", "pythians", "e", "L", "marketplace_escrow", "chain-mechanical", "r"]] }
      : null;

  it("verifies an unverified row when Helius recovers", async () => {
    const calls: string[] = [];
    const runSql: RunSql = (async (sql: string) => {
      calls.push(sql);
      return (oneUnverified(sql) ?? {}) as never;
    }) as RunSql;
    const res = await reconcileQueueWorker({ runSql, reconcile: async () => ({ available: true, ok: true }) });
    expect(res.verified).toBe(1);
    expect(calls.some((s) => /SET status = 'verified'/.test(s))).toBe(true);
    expect(calls.some((s) => /DELETE FROM label\.reconcile_queue/.test(s))).toBe(true); // cleared on success
  });

  it("seals to unverified_permanent + clears the queue row after max attempts (DH-7/NEW-2/NEW-4)", async () => {
    const calls: string[] = [];
    const runSql: RunSql = (async (sql: string) => {
      calls.push(sql);
      if (/ON CONFLICT \(label_id\) DO UPDATE/.test(sql)) return { result: [["attempts", "max_attempts"], ["8", "8"]] } as never;
      return (oneUnverified(sql) ?? {}) as never;
    }) as RunSql;
    const res = await reconcileQueueWorker({ runSql, reconcile: async () => ({ available: true, ok: false }) });
    expect(res.permanent).toBe(1);
    expect(calls.some((s) => /SET status = 'unverified_permanent'/.test(s))).toBe(true);
    expect(calls.some((s) => /DELETE FROM label\.reconcile_queue/.test(s))).toBe(true);
  });

  it("leaves still-unverified (no seal) when below the attempt bound", async () => {
    const runSql: RunSql = (async (sql: string) => {
      if (/ON CONFLICT \(label_id\) DO UPDATE/.test(sql)) return { result: [["attempts", "max_attempts"], ["2", "8"]] } as never;
      return (oneUnverified(sql) ?? {}) as never;
    }) as RunSql;
    const res = await reconcileQueueWorker({ runSql, reconcile: async () => ({ available: true, ok: false }) });
    expect(res.stillUnverified).toBe(1);
    expect(res.permanent).toBe(0);
  });
});
