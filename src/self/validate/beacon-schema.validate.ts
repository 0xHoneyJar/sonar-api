import type { BeaconV2Document } from "../domain/beacon-v2.domain.js";

export interface SchemaValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateBeaconV2(doc: BeaconV2Document): SchemaValidationResult {
  const errors: string[] = [];

  if (doc.schema_version !== "2") {
    errors.push('schema_version must be "2"');
  }

  if (!Array.isArray(doc._generated_sections) || doc._generated_sections.length === 0) {
    errors.push("_generated_sections must be a non-empty array");
  }

  if (!doc.identity?.name) {
    errors.push("identity.name is required");
  }

  const rs = doc.read_surface;
  if (rs && typeof rs === "object" && "graphql" in rs) {
    const gql = rs.graphql;
    if (!gql?.endpoint) errors.push("read_surface.graphql.endpoint is required");
    if (!Array.isArray(gql?.schema_hint)) {
      errors.push("read_surface.graphql.schema_hint must be an array");
    }
  } else {
    errors.push("read_surface block is required");
  }

  if (!Array.isArray(doc.consumers)) {
    errors.push("consumers must be an array");
  }

  if (!Array.isArray(doc.acvp_invariants)) {
    errors.push("acvp_invariants must be an array");
  }

  return { ok: errors.length === 0, errors };
}
