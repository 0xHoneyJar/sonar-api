/*
 * contract.test.ts — the Sonar→Score serving contract for the L2 registry (FR-7, NFR-5, DH-3).
 *
 * Conformance over scripts/svm-contract.json (the contract-guard antibody source): the registry surfaces
 * are LIVE and carry the agreed consumer fields, so a schema/field drop hard-fails CI the same way the
 * belt-gateway seams do. (Live-gateway shape is asserted by the contract-guard run against prod;
 * this unit test pins the contract definition itself.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync(new URL("../../scripts/svm-contract.json", import.meta.url), "utf8"));

describe("label serving contract", () => {
  it("exposes label_entity_label + label_entity_primary as LIVE", () => {
    expect(contract.types.label_entity_label.status).toBe("live");
    expect(contract.types.label_entity_primary.status).toBe("live");
  });

  it("entity_primary carries the Score-facing fields (label, type, method, confidence, status, evidence)", () => {
    const f = contract.types.label_entity_primary.requiredFields;
    for (const k of ["address", "chain", "collection_scope", "label", "entity_type", "method", "confidence", "effective_confidence", "status", "evidence_ref", "signature_valid"]) {
      expect(f, `missing contract field ${k}`).toHaveProperty(k);
    }
  });

  it("entity_label requires provenance fields (method + evidence_ref) — FR-2 at the contract", () => {
    const f = contract.types.label_entity_label.requiredFields;
    expect(f).toHaveProperty("method");
    expect(f).toHaveProperty("evidence_ref");
    expect(f).toHaveProperty("signature_valid");
  });
});
