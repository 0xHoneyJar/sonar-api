import { Schema } from "effect";

/** Capability evidence body emitted on the public capability stream. */
export const CapabilityEvidenceBody = Schema.Struct({
  schema_version: Schema.Literal(1),
  registry_epoch: Schema.String,
  registry_sequence: Schema.String,
  deployment_id: Schema.optional(Schema.String),
  capability_state: Schema.String,
}).annotations({ identifier: "CapabilityEvidenceBody" });
export type CapabilityEvidenceBody = Schema.Schema.Type<typeof CapabilityEvidenceBody>;

/** Ownership evidence body emitted on the public ownership stream. */
export const OwnershipEvidenceBody = Schema.Struct({
  schema_version: Schema.Literal(1),
  deployment_id: Schema.String,
  holder_digest: Schema.String.pipe(
    Schema.pattern(/^[0-9a-f]{64}$/),
  ),
  observation_kind: Schema.Literal("token_balance", "contract_owner"),
}).annotations({ identifier: "OwnershipEvidenceBody" });
export type OwnershipEvidenceBody = Schema.Schema.Type<typeof OwnershipEvidenceBody>;
