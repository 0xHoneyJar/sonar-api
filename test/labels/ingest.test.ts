/*
 * ingest.test.ts — the L2 write seam (FR-2 validation, idempotency, SP-3 rejection audit, SP-1 steps).
 */
import { describe, it, expect, vi } from "vitest";
import { ingestLabels } from "../../src/labels/ingest";
import { LabelReject, type LabelInput, type LabelStep, type RunSql } from "../../src/labels/types";

const row = (over: Partial<LabelInput> = {}): LabelInput => ({
  address: "ADDR1", chain: "solana", collectionScope: "pythians",
  entity: "magic-eden", label: "Magic Eden escrow", entityType: "marketplace_escrow",
  method: "chain-mechanical", evidenceRef: "SIG1", ...over,
});

/** Mock run_sql that records every statement. */
function recorder(): { runSql: RunSql; sql: string[] } {
  const sql: string[] = [];
  const runSql: RunSql = async (s) => { sql.push(s); return {} as never; };
  return { runSql, sql };
}

describe("ingestLabels", () => {
  it("rejects a row missing evidence_ref (FR-2) and audits the rejection (SP-3)", async () => {
    const { runSql, sql } = recorder();
    const res = await ingestLabels([row({ evidenceRef: "" })], { writer: "test", runSql });
    expect(res.accepted).toBe(0);
    expect(res.rejected[0].reason).toBe("validation");
    expect(sql.some((s) => /ingest_audit/.test(s) && /rejected/.test(s))).toBe(true);
    expect(sql.some((s) => /INSERT INTO label\.entity_label/.test(s))).toBe(false); // never written
  });

  it("accepts a valid row: one entity_label insert + an accepted audit", async () => {
    const { runSql, sql } = recorder();
    const res = await ingestLabels([row()], { writer: "test", runSql });
    expect(res.accepted).toBe(1);
    expect(res.ids[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(sql.some((s) => /INSERT INTO label\.entity_label/.test(s) && /ON CONFLICT \(id\) DO UPDATE/.test(s))).toBe(true);
    expect(sql.some((s) => /ingest_audit/.test(s) && /accepted/.test(s))).toBe(true);
  });

  it("is idempotent — same key → same id (re-ingest upserts the same row)", async () => {
    const a = await ingestLabels([row({ validityFrom: "2026-06-25T00:00:00Z" })], { writer: "t", runSql: recorder().runSql });
    const b = await ingestLabels([row({ validityFrom: "2026-06-25T00:00:00Z" })], { writer: "t", runSql: recorder().runSql });
    expect(a.ids[0]).toBe(b.ids[0]);
  });

  it("upsert touches only mutable columns (DH-5) — no address/method/evidence_ref in the SET clause", async () => {
    const { runSql, sql } = recorder();
    await ingestLabels([row()], { writer: "test", runSql });
    const ins = sql.find((s) => /ON CONFLICT/.test(s))!;
    const setClause = ins.slice(ins.indexOf("DO UPDATE SET"));
    expect(setClause).not.toMatch(/address =|method =|evidence_ref =|chain =/);
    expect(setClause).toMatch(/label = EXCLUDED|confidence = EXCLUDED|status = EXCLUDED|validity_to = EXCLUDED/);
  });

  it("rejects operator-attested whose trust was preset but never verified by the signing step (NEW-1)", async () => {
    const { runSql, sql } = recorder();
    // attacker presets signature_valid=true + status=verified + garbage sig, with NO signing step in the pipeline
    const forged = row({ method: "operator-attested", entityType: "multisig", signatureValid: true, status: "verified", signature: "GARBAGE", signingKeyId: "ops-1" });
    const res = await ingestLabels([forged], { writer: "attacker", runSql }); // no steps → nothing verifies it
    expect(res.accepted).toBe(0);
    expect(res.rejected[0].reason).toBe("bad_signature");
    expect(sql.some((s) => /INSERT INTO label\.entity_label/.test(s))).toBe(false);
  });

  it("sqlNum self-defends: a non-numeric confidence at the JSON boundary emits NULL, not injection (M5)", async () => {
    const { runSql, sql } = recorder();
    const evil = row({ confidence: "0); DROP TABLE label.entity_label;--" as unknown as number });
    await ingestLabels([evil], { writer: "t", runSql });
    const ins = sql.find((s) => /INSERT INTO label\.entity_label/.test(s))!;
    expect(ins).not.toMatch(/DROP TABLE/);
  });

  it("runs injected steps in order (SP-1); a step LabelReject drops + audits the row", async () => {
    const seen: string[] = [];
    const tagStep: LabelStep = { name: "tag", apply: (r) => { seen.push("tag"); return { ...r, notes: "tagged" }; } };
    const rejectStep: LabelStep = { name: "rej", apply: () => { throw new LabelReject("bad_signature", "nope"); } };
    const { runSql, sql } = recorder();
    const ok = await ingestLabels([row()], { writer: "t", runSql, steps: [tagStep] });
    expect(seen).toContain("tag");
    expect(ok.accepted).toBe(1);
    const bad = await ingestLabels([row()], { writer: "t", runSql: recorder().runSql, steps: [rejectStep] });
    expect(bad.rejected[0].reason).toBe("bad_signature");
    void sql;
  });
});
