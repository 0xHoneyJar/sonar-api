/*
 * seed.test.ts — S6 seeding path (FR-8, H-7) + staleness close (H-8). Fixture-driven; the live Pythians
 * data is operator-fed (see NOTES accepted-deferred). Exercises the full composed pipeline end-to-end.
 */
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { toLabelInputs, seedFromExtraction, type ExtractionRow } from "../../src/labels/seed-from-extraction";
import { buildIngestSteps } from "../../src/labels/pipeline";
import { signPayload, signingPayload, type KeyResolver } from "../../src/labels/signing";
import { closeStaleLabels } from "../../src/labels/staleness";
import type { Reconciler } from "../../src/labels/reconcile";
import type { LabelInput, RunSql } from "../../src/labels/types";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const pubDerB64 = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
const keyResolver: KeyResolver = async () => ({ publicKeyDerB64: pubDerB64, revoked: false });
const reconciler: Reconciler = async () => ({ available: true, ok: true });

// Pythians anchors (the 3 confirmed) + a signed team multisig.
const meRow: ExtractionRow = {
  address: "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix", chain: "solana", collection: "pythians",
  label: "Magic Eden escrow", entity: "magic-eden", entity_type: "marketplace_escrow",
  method: "chain-mechanical", source: "program:ME", evidence_ref: "SIG_ME",
};
const distRow: ExtractionRow = {
  address: "pyThKEjG4qpwVLSXcm9qtokSDtKCJKxCD7Kf8HSFmH8", chain: "solana", collection: "pythians",
  label: "Pythians distributor", entity: "pythians-distributor", entity_type: "distributor",
  method: "own-indexed", source: "svm_collection_event", evidence_ref: "agg:fanout",
};

function signedTeamRow(): ExtractionRow {
  const claim = {
    chain: "solana", address: "TEAMMULTISIG1", collectionScope: "pythians",
    entity: "thj-team", label: "THJ team multisig", entityType: "multisig", evidenceRef: "operator-2026-06-25",
  };
  return {
    ...claim, address: claim.address, collection: "pythians", entity_type: "multisig",
    method: "operator-attested", evidence_ref: claim.evidenceRef,
    signature: signPayload(signingPayload(claim as LabelInput), privPem), signing_key_id: "ops-1",
  };
}

function recorder(): { runSql: RunSql; sql: string[] } {
  const sql: string[] = [];
  return { sql, runSql: (async (s: string) => { sql.push(s); return {}; }) as RunSql };
}

describe("toLabelInputs", () => {
  it("maps extraction fields → LabelInput (collection→scope, evidence_ref→evidenceRef)", () => {
    const [li] = toLabelInputs([meRow]);
    expect(li.collectionScope).toBe("pythians");
    expect(li.evidenceRef).toBe("SIG_ME");
    expect(li.entityType).toBe("marketplace_escrow");
    expect(li.entity).toBe("magic-eden");
  });
  it("null collection → global scope", () => {
    expect(toLabelInputs([{ ...meRow, collection: null }])[0].collectionScope).toBeNull();
  });
  it("non-ISO validity_window (slot descriptor) → validityFrom undefined, preserved in notes (seed bugfix)", () => {
    const [li] = toLabelInputs([{ ...meRow, validity_window: "from_slot:428954039 -> open" }]);
    expect(li.validityFrom).toBeUndefined();
    expect(li.notes).toContain("validity_window: from_slot:428954039");
  });
  it("ISO validity_window → used as validityFrom", () => {
    expect(toLabelInputs([{ ...meRow, validity_window: "2026-06-25T00:00:00Z" }])[0].validityFrom).toBe("2026-06-25T00:00:00.000Z");
  });
  it("collectionKey OVERRIDES the per-row collection name → infra key, not the name (no leak)", () => {
    // a row carrying the NAME 'Pythenians' must NOT become the collection_scope key
    const [li] = toLabelInputs([{ ...meRow, collection: "Pythenians" }], "pythians");
    expect(li.collectionScope).toBe("pythians");
  });
});

describe("seedFromExtraction (full pipeline)", () => {
  it("seeds chain-mechanical + own-indexed anchors → verified", async () => {
    const { runSql, sql } = recorder();
    const steps = buildIngestSteps({ keyResolver, reconciler });
    const res = await seedFromExtraction([meRow, distRow], { writer: "extraction:pythians", runSql, steps });
    expect(res.accepted).toBe(2);
    expect(sql.filter((s) => /INSERT INTO label\.entity_label/.test(s)).length).toBe(2);
    expect(sql.some((s) => /status.*'verified'|'verified'/.test(s))).toBe(true);
  });

  it("seeds a signed operator-attested team multisig → accepted (signature verifies)", async () => {
    const { runSql } = recorder();
    const steps = buildIngestSteps({ keyResolver, reconciler });
    const res = await seedFromExtraction([signedTeamRow()], { writer: "operator", runSql, steps });
    expect(res.accepted).toBe(1);
    expect(res.rejected).toHaveLength(0);
  });

  it("rejects an operator-attested row whose signature doesn't verify", async () => {
    const { runSql } = recorder();
    const steps = buildIngestSteps({ keyResolver, reconciler });
    const forged: ExtractionRow = { ...signedTeamRow(), signature: "AAAA" };
    const res = await seedFromExtraction([forged], { writer: "attacker", runSql, steps });
    expect(res.accepted).toBe(0);
    expect(res.rejected[0].reason).toBe("bad_signature");
  });
});

describe("closeStaleLabels (H-8)", () => {
  it("sets validity_to on active labels for the target (role change)", async () => {
    const { runSql, sql } = recorder();
    await closeStaleLabels(runSql, { address: "1BWutmTv", chain: "solana", collectionScope: "pythians", asOf: "2026-07-01T00:00:00Z" });
    expect(sql[0]).toMatch(/UPDATE label\.entity_label\s+SET validity_to = '2026-07-01/);
    expect(sql[0]).toMatch(/validity_to IS NULL/);
  });
  it("handles a global (null) scope close", async () => {
    const { runSql, sql } = recorder();
    await closeStaleLabels(runSql, { address: "CEXADDR", chain: "solana", collectionScope: null });
    expect(sql[0]).toMatch(/collection_scope IS NULL/);
  });
});
