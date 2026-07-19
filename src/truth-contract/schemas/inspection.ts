import { Schema } from "effect";

import {
  DecimalUint64,
  PositiveDecimalUint64,
  Sha256Digest,
  TRUTH_CONTRACT_SCHEMA_VERSION,
  TruthEnvironmentId,
  TruthIdentifier,
  TruthIsoTimestamp,
} from "./common.js";
import { TruthEd25519Signature } from "./bundle.js";

export const SONAR_TRUTH_TARGET_STATES = [
  "produced",
  "reconciled_staged",
  "consumed",
  "live_proven",
  "graduated",
] as const;

export const SonarTruthTargetState = Schema.Literal(
  ...SONAR_TRUTH_TARGET_STATES,
);
export type SonarTruthTargetState = Schema.Schema.Type<
  typeof SonarTruthTargetState
>;

export class TruthInspectionArtifactV1 extends Schema.Class<TruthInspectionArtifactV1>(
  "TruthInspectionArtifactV1",
)({
  artifact_hash: Sha256Digest,
  artifact_kind: TruthIdentifier,
  effective_status: Schema.Literal(
    "READY",
    "DEGRADED",
    "EXPIRED",
    "UNKNOWN",
    "NOT_READY",
    "SUSPENDED",
  ),
  reason_codes: Schema.Array(TruthIdentifier).pipe(Schema.maxItems(128)),
  expires_at: Schema.NullOr(TruthIsoTimestamp),
  dependencies: Schema.Array(Sha256Digest).pipe(Schema.maxItems(128)),
  evidence_refs: Schema.Array(Sha256Digest).pipe(Schema.maxItems(128)),
}) {}

export class TruthInspectionSnapshotV1 extends Schema.Class<TruthInspectionSnapshotV1>(
  "TruthInspectionSnapshotV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  environment: TruthEnvironmentId,
  collection_id: TruthIdentifier,
  canonical_address: Schema.String.pipe(
    Schema.pattern(/^0x[0-9a-f]{40}$/),
  ),
  chain_id: Schema.Literal("80094"),
  event_signature: Schema.Literal("Transfer(address,address,uint256)"),
  validity_class: Schema.Literal("STAGED_CURRENT"),
  producer_root_hash: Sha256Digest,
  producer_generation: Schema.Literal("1"),
  invalidation_epoch: Schema.Literal("0"),
  identity_snapshot_hash: Sha256Digest,
  reconciliation_hash: Sha256Digest,
  score_receipt_hash: Sha256Digest,
  score_state: Schema.Literal(
    "NOT_CONSUMED",
    "NOT_CONSUMED_OVERDUE",
  ),
  score_owner: Schema.Literal("bd-v54z.1"),
  score_deadline: TruthIsoTimestamp,
  publisher_key_id: TruthIdentifier,
  trust_root_generation: PositiveDecimalUint64,
  revocation_sequence: DecimalUint64,
  cache_kind: Schema.Literal(
    "SIGNED_READ_ONLY_REGISTRY",
    "EXPLICIT_OFFLINE_CACHE",
  ),
  cached_at: TruthIsoTimestamp,
  authority_validity: Schema.Literal("STAGED_VALID"),
  production_authority: Schema.Literal(false),
  observed_at: TruthIsoTimestamp,
  expires_at: TruthIsoTimestamp,
  artifacts: Schema.Array(TruthInspectionArtifactV1).pipe(
    Schema.minItems(1),
    Schema.maxItems(10_000),
  ),
  served_projection_digest: Sha256Digest,
  rebuilt_projection_digest: Sha256Digest,
}) {}

export const TRUTH_INSPECTION_ENVELOPE_DOMAIN =
  "sonar.truth-inspection-envelope.v1" as const;

const ProjectionStatusV1 = Schema.Literal(
  "READY",
  "DEGRADED",
  "NOT_READY",
  "UNKNOWN",
  "EXPIRED",
  "SUSPENDED",
);

const ProjectionLifecycleV1 = Schema.Literal(
  "DRAFT",
  "PRODUCED",
  "RECONCILED",
  "SUPERSEDED",
  "ROLLED_BACK",
);

const ProjectionAuthorityV1 = Schema.Literal(
  "PRODUCER",
  "RECONCILER",
  "RECOVERY",
  "GOVERNANCE",
  "REVOCATION",
);

const ProjectionRecoveryKindV1 = Schema.Literal(
  "FRESH_READINESS_EVIDENCE",
  "REPLACEMENT_WATERMARK_AND_RECEIPTS",
  "COMPLETED_CENSUS_PASS",
  "CORRECTED_BUNDLE_AND_SCORE_RECEIPT",
  "IDENTITY_READMISSION_EVIDENCE",
  "RECOVERED_TRUST_ROOT",
  "COMPATIBLE_CONSUMER_RECEIPT",
);

class InspectionRecoveryEvidenceItemV1 extends Schema.Class<InspectionRecoveryEvidenceItemV1>(
  "InspectionRecoveryEvidenceItemV1",
)({
  kind: ProjectionRecoveryKindV1,
  artifact_hashes: Schema.Array(Sha256Digest).pipe(Schema.maxItems(128)),
  census_complete: Schema.NullOr(Schema.Boolean),
  reconciliation_decision: Schema.NullOr(
    Schema.Literal("RECONCILED_STAGED"),
  ),
}) {}

class InspectionRecoveryEvidenceV1 extends Schema.Class<InspectionRecoveryEvidenceV1>(
  "InspectionRecoveryEvidenceV1",
)({
  items: Schema.Array(InspectionRecoveryEvidenceItemV1).pipe(
    Schema.maxItems(128),
  ),
}) {}

export class TruthInspectionProjectionEventBodyV1 extends Schema.Class<TruthInspectionProjectionEventBodyV1>(
  "TruthInspectionProjectionEventBodyV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  event_id: TruthIdentifier,
  sequence: PositiveDecimalUint64,
  previous_event_hash: Schema.NullOr(Sha256Digest),
  kind: Schema.Literal(
    "ARTIFACT_ACTIVATED",
    "LIFECYCLE_TRANSITION",
    "RECOVERY",
    "INVALIDATION",
    "REVOCATION",
    "DELIVERY_DEAD_LETTER",
  ),
  environment: Schema.Literal("development", "staging"),
  artifact_hash: Sha256Digest,
  generation: PositiveDecimalUint64,
  invalidation_epoch: DecimalUint64,
  authority: ProjectionAuthorityV1,
  lifecycle_state: ProjectionLifecycleV1,
  local_status: ProjectionStatusV1,
  state_floor: ProjectionStatusV1,
  reason_code: TruthIdentifier,
  cause_event_id: Schema.NullOr(TruthIdentifier),
  resolves_cause_event_ids: Schema.Array(TruthIdentifier).pipe(
    Schema.maxItems(128),
  ),
  replacement_evidence_hash: Schema.NullOr(Sha256Digest),
  replacement_evidence_kinds: Schema.NullOr(
    Schema.Array(ProjectionRecoveryKindV1).pipe(Schema.maxItems(16)),
  ),
  replacement_evidence: Schema.NullOr(InspectionRecoveryEvidenceV1),
  depends_on: Schema.Array(Sha256Digest).pipe(Schema.maxItems(128)),
  occurred_at: TruthIsoTimestamp,
  production_authority: Schema.Literal(false),
}) {}

export class TruthInspectionProjectionEventV1 extends Schema.TaggedClass<TruthInspectionProjectionEventV1>()(
  "TruthProjectionEventV1",
  {
    body: TruthInspectionProjectionEventBodyV1,
    signer_key_id: TruthIdentifier,
    signature: TruthEd25519Signature,
  },
) {}

export class TruthInspectionProjectionAuthorityV1 extends Schema.Class<TruthInspectionProjectionAuthorityV1>(
  "TruthInspectionProjectionAuthorityV1",
)({
  key_id: TruthIdentifier,
  public_key_hex: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  authorities: Schema.Array(ProjectionAuthorityV1).pipe(
    Schema.minItems(1),
    Schema.maxItems(7),
  ),
}) {}

export class TruthInspectionEnvelopeUnsignedV1 extends Schema.Class<TruthInspectionEnvelopeUnsignedV1>(
  "TruthInspectionEnvelopeUnsignedV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  domain: Schema.Literal(TRUTH_INSPECTION_ENVELOPE_DOMAIN),
  snapshot: TruthInspectionSnapshotV1,
  projection_events: Schema.Array(TruthInspectionProjectionEventV1).pipe(
    Schema.minItems(1),
    Schema.maxItems(10_000),
  ),
  projection_authorities: Schema.Array(
    TruthInspectionProjectionAuthorityV1,
  ).pipe(Schema.minItems(1), Schema.maxItems(64)),
}) {}

export class TruthInspectionEnvelopeV1 extends Schema.Class<TruthInspectionEnvelopeV1>(
  "TruthInspectionEnvelopeV1",
)({
  unsigned_envelope: TruthInspectionEnvelopeUnsignedV1,
  envelope_hash: Sha256Digest,
  signature: TruthEd25519Signature,
}) {}
