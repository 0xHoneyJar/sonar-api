import { Schema } from "effect";

import {
  DecimalUint64,
  Sha256Digest,
  TRUTH_CONTRACT_SCHEMA_VERSION,
  TruthEnvironmentId,
  TruthIdentifier,
  TruthIsoTimestamp,
} from "./common.js";
import { TruthEd25519Signature } from "./bundle.js";

export class TruthEvidenceRef extends Schema.Class<TruthEvidenceRef>("TruthEvidenceRef")({
  evidence_id: TruthIdentifier,
  sha256: Sha256Digest,
}) {}

const StatusFields = {
  reasons: Schema.Array(TruthIdentifier).pipe(Schema.minItems(1), Schema.maxItems(64)),
  evidence: Schema.Array(TruthEvidenceRef).pipe(Schema.maxItems(128)),
  evaluated_at: TruthIsoTimestamp,
  expires_at: TruthIsoTimestamp,
  invalidation_epoch: DecimalUint64,
};

export class ReadyStatus extends Schema.TaggedClass<ReadyStatus>()("READY", StatusFields) {}

export class DegradedStatus extends Schema.TaggedClass<DegradedStatus>()(
  "DEGRADED",
  StatusFields,
) {}

export class NotReadyStatus extends Schema.TaggedClass<NotReadyStatus>()(
  "NOT_READY",
  StatusFields,
) {}

export class UnknownStatus extends Schema.TaggedClass<UnknownStatus>()(
  "UNKNOWN",
  StatusFields,
) {}

export class SuspendedStatus extends Schema.TaggedClass<SuspendedStatus>()(
  "SUSPENDED",
  StatusFields,
) {}

export class ExpiredStatus extends Schema.TaggedClass<ExpiredStatus>()(
  "EXPIRED",
  StatusFields,
) {}

export const TruthEffectiveStatus = Schema.Union(
  ReadyStatus,
  DegradedStatus,
  NotReadyStatus,
  UnknownStatus,
  SuspendedStatus,
  ExpiredStatus,
).pipe(
  Schema.filter(
    (status) =>
      new Date(status.expires_at).getTime() >
        new Date(status.evaluated_at).getTime() ||
      "effective status expiry must follow evaluation",
  ),
).annotations({ identifier: "TruthEffectiveStatus" });
export type TruthEffectiveStatus = Schema.Schema.Type<typeof TruthEffectiveStatus>;

export const TRUTH_READINESS_STATE_PRECEDENCE = [
  "READY",
  "DEGRADED",
  "EXPIRED",
  "UNKNOWN",
  "NOT_READY",
  "SUSPENDED",
] as const;

export const TruthReadinessState = Schema.Literal(
  ...TRUTH_READINESS_STATE_PRECEDENCE,
).annotations({ identifier: "TruthReadinessState" });
export type TruthReadinessState = Schema.Schema.Type<typeof TruthReadinessState>;

export const TruthValidityClass = Schema.Literal(
  "FIXTURE_VALID",
  "STAGED_CURRENT",
).annotations({ identifier: "TruthValidityClass" });

export class TruthFinalizedWatermarkV1 extends Schema.Class<TruthFinalizedWatermarkV1>(
  "TruthFinalizedWatermarkV1",
)({
  network: TruthIdentifier,
  chain_id: DecimalUint64,
  height: DecimalUint64,
  block_hash: Sha256Digest,
  observed_at: TruthIsoTimestamp,
  finality_policy_version: TruthIdentifier,
  finality_class: Schema.Literal("FINALIZED"),
}) {}

export class TruthProviderHeadObservationV1 extends Schema.Class<TruthProviderHeadObservationV1>(
  "TruthProviderHeadObservationV1",
)({
  provider_id: TruthIdentifier,
  operator: TruthIdentifier,
  legal_entity: TruthIdentifier,
  control_domain: TruthIdentifier,
  network_path: TruthIdentifier,
  asn: TruthIdentifier,
  client_family: TruthIdentifier,
  upstream_source: TruthIdentifier,
  finality_method: Schema.Literal("FINALIZED_TAG", "BLOCK_DEPTH", "UNSUPPORTED"),
  finalized_tag: Schema.NullOr(Schema.Literal("finalized")),
  height: Schema.NullOr(DecimalUint64),
  block_hash: Schema.NullOr(Sha256Digest),
  observed_at: TruthIsoTimestamp,
  evidence: TruthEvidenceRef,
  source_error: Schema.Boolean,
}) {}

export class TruthIdentityReadinessInputV1 extends Schema.Class<TruthIdentityReadinessInputV1>(
  "TruthIdentityReadinessInputV1",
)({
  snapshot_hash: Sha256Digest,
  canonical_collection_id: TruthIdentifier,
  chain_family: Schema.Literal("EVM", "SOLANA"),
  chain_id: TruthIdentifier,
  network: TruthIdentifier,
  canonical_address: TruthIdentifier,
  aliases: Schema.Array(TruthIdentifier).pipe(Schema.maxItems(128)),
  observed_height: DecimalUint64,
  observed_hash: Sha256Digest,
  observed_at: TruthIsoTimestamp,
  finality_policy_version: TruthIdentifier,
  network_listed: Schema.Boolean,
  admitted: Schema.Boolean,
  alias_ambiguous: Schema.Boolean,
  proxy_kind: Schema.Literal(
    "NONE",
    "EIP1967",
    "BEACON",
    "MINIMAL",
    "UNRESOLVABLE",
  ),
  proxy_evidence_complete: Schema.Boolean,
  contest_state: Schema.Literal("CLEAR", "CONTESTED", "UNSUPPORTED"),
  deployed_identity_hash: Sha256Digest,
  code_hash: Sha256Digest,
  implementation_address: Schema.NullOr(TruthIdentifier),
  implementation_code_hash: Schema.NullOr(Sha256Digest),
  upgrade_mechanism: Schema.Literal(
    "IMMUTABLE",
    "ADMIN",
    "BEACON",
    "METAMORPHIC",
    "UNRESOLVABLE",
  ),
  valid_from: TruthIsoTimestamp,
  valid_until: Schema.NullOr(TruthIsoTimestamp),
  effective_status: TruthEffectiveStatus,
  config_digest: Sha256Digest,
}) {}

export class TruthCoverageReadinessInputV1 extends Schema.Class<TruthCoverageReadinessInputV1>(
  "TruthCoverageReadinessInputV1",
)({
  marker_complete: Schema.Boolean,
  processed_through: DecimalUint64,
  required_horizon: DecimalUint64,
  bundle_hash: Sha256Digest,
  identity_snapshot_hash: Sha256Digest,
  source_digest: Sha256Digest,
  adapter_digest: Sha256Digest,
  config_digest: Sha256Digest,
  event_count: DecimalUint64,
  observed_at: TruthIsoTimestamp,
  expires_at: TruthIsoTimestamp,
  evidence: TruthEvidenceRef,
}) {}

export class TruthProgressionReadinessInputV1 extends Schema.Class<TruthProgressionReadinessInputV1>(
  "TruthProgressionReadinessInputV1",
)({
  source_head_advancing: Schema.Boolean,
  cursor_advancing: Schema.Boolean,
  heartbeat_present: Schema.Boolean,
  cross_source_available: Schema.Boolean,
  source_head_observed_at: TruthIsoTimestamp,
  cursor_observed_at: TruthIsoTimestamp,
  heartbeat_observed_at: TruthIsoTimestamp,
  source_failure: Schema.Boolean,
  bounded_last_good_allowed: Schema.Boolean,
  source_head_evidence: TruthEvidenceRef,
  cursor_evidence: TruthEvidenceRef,
  heartbeat_evidence: TruthEvidenceRef,
  cross_source_evidence: TruthEvidenceRef,
}) {}

export class TruthActivityReadinessInputV1 extends Schema.Class<TruthActivityReadinessInputV1>(
  "TruthActivityReadinessInputV1",
)({
  profile_version: TruthIdentifier,
  owner: TruthIdentifier,
  approval: TruthIdentifier,
  backtest_digest: Sha256Digest,
  profile_approved: Schema.Boolean,
  quiet_window_permitted: Schema.Boolean,
  expected_event_window_seconds: DecimalUint64,
  source_head_cadence_seconds: DecimalUint64,
  cursor_cadence_seconds: DecimalUint64,
  heartbeat_cadence_seconds: DecimalUint64,
  evidence_window_start: TruthIsoTimestamp,
  evidence_window_end: TruthIsoTimestamp,
  effective_from: TruthIsoTimestamp,
  effective_until: Schema.NullOr(TruthIsoTimestamp),
  observed_at: TruthIsoTimestamp,
  expires_at: TruthIsoTimestamp,
  evidence: TruthEvidenceRef,
}) {}

export class TruthReconciliationReadinessInputV1 extends Schema.Class<TruthReconciliationReadinessInputV1>(
  "TruthReconciliationReadinessInputV1",
)({
  passed: Schema.Boolean,
  bundle_hash: Sha256Digest,
  identity_snapshot_hash: Sha256Digest,
  watermark_hash: Sha256Digest,
  observed_at: TruthIsoTimestamp,
  expires_at: TruthIsoTimestamp,
  evidence: TruthEvidenceRef,
}) {}

export class TruthRequiredSourceInputV1 extends Schema.Class<TruthRequiredSourceInputV1>(
  "TruthRequiredSourceInputV1",
)({
  source_id: TruthIdentifier,
  state: TruthReadinessState,
  reasons: Schema.Array(TruthIdentifier).pipe(Schema.minItems(1), Schema.maxItems(64)),
  evidence: Schema.Array(TruthEvidenceRef).pipe(Schema.maxItems(128)),
}) {}

export class TruthInvalidationInputV1 extends Schema.Class<TruthInvalidationInputV1>(
  "TruthInvalidationInputV1",
)({
  invalidation_id: TruthIdentifier,
  state_floor: Schema.Literal("NOT_READY", "SUSPENDED"),
  affected_artifact_hash: Sha256Digest,
  active: Schema.Boolean,
  evidence: TruthEvidenceRef,
}) {}

export class TruthReadinessProviderPolicyV1 extends Schema.Class<TruthReadinessProviderPolicyV1>(
  "TruthReadinessProviderPolicyV1",
)({
  provider_id: TruthIdentifier,
  operator: TruthIdentifier,
  legal_entity: TruthIdentifier,
  control_domain: TruthIdentifier,
  network_path: TruthIdentifier,
  asn: TruthIdentifier,
  client_family: TruthIdentifier,
  upstream_source: TruthIdentifier,
}) {}

export class TruthReadinessPolicyInputV1 extends Schema.Class<TruthReadinessPolicyInputV1>(
  "TruthReadinessPolicyInputV1",
)({
  network: TruthIdentifier,
  chain_id: DecimalUint64,
  finality_policy_version: TruthIdentifier,
  finality_method: Schema.Literal("FINALIZED_TAG"),
  finalized_tag: Schema.Literal("finalized"),
  ethereum_depth_fallback_allowed: Schema.Literal(false),
  required_provider_quorum: DecimalUint64,
  require_distinct_asn: Schema.Boolean,
  require_distinct_client_family: Schema.Boolean,
  providers: Schema.Array(TruthReadinessProviderPolicyV1).pipe(
    Schema.minItems(2),
    Schema.maxItems(16),
  ),
  denominator_manifest_hash: Sha256Digest,
  observation_ttl_seconds: DecimalUint64,
  readiness_ttl_seconds: DecimalUint64,
  max_future_skew_seconds: Schema.Literal(60),
}) {}

export class TruthLiveObservationReceiptUnsignedV1 extends Schema.Class<TruthLiveObservationReceiptUnsignedV1>(
  "TruthLiveObservationReceiptUnsignedV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  environment: Schema.Literal("staging"),
  bundle_hash: Sha256Digest,
  identity_snapshot_hash: Sha256Digest,
  event_vocabulary_hash: Sha256Digest,
  network_policy_hash: Sha256Digest,
  activity_profile_hash: Sha256Digest,
  denominator_manifest_hash: Sha256Digest,
  source_digest: Sha256Digest,
  adapter_digest: Sha256Digest,
  observation_set_hash: Sha256Digest,
  observed_at: TruthIsoTimestamp,
  expires_at: TruthIsoTimestamp,
  issuer_key_id: TruthIdentifier,
}) {}

export class TruthLiveObservationReceiptV1 extends Schema.Class<TruthLiveObservationReceiptV1>(
  "TruthLiveObservationReceiptV1",
)({
  unsigned_receipt: TruthLiveObservationReceiptUnsignedV1,
  receipt_hash: Sha256Digest,
  signature: TruthEd25519Signature,
}) {}

export class TruthReadinessEvaluationInputV1 extends Schema.Class<TruthReadinessEvaluationInputV1>(
  "TruthReadinessEvaluationInputV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  environment: TruthEnvironmentId,
  validity_class: TruthValidityClass,
  evidence_origin: Schema.Literal("HERMETIC_FIXTURE", "READ_ONLY_LIVE"),
  live_observation_receipt: Schema.NullOr(TruthLiveObservationReceiptV1),
  now: TruthIsoTimestamp,
  bundle_hash: Sha256Digest,
  bundle_generation: DecimalUint64,
  event_vocabulary_hash: Sha256Digest,
  network_policy_hash: Sha256Digest,
  activity_profile_hash: Sha256Digest,
  root_verified: Schema.Boolean,
  root_current: Schema.Boolean,
  signing_key_active: Schema.Boolean,
  event_provenance_compatible: Schema.Boolean,
  denominator_manifest_hash: Sha256Digest,
  denominator_byte_verified: Schema.Boolean,
  source_digest: Sha256Digest,
  adapter_digest: Sha256Digest,
  invalidation_epoch: DecimalUint64,
  policy: TruthReadinessPolicyInputV1,
  identity: TruthIdentityReadinessInputV1,
  providers: Schema.Array(TruthProviderHeadObservationV1).pipe(
    Schema.minItems(1),
    Schema.maxItems(16),
  ),
  coverage: TruthCoverageReadinessInputV1,
  progression: TruthProgressionReadinessInputV1,
  activity: TruthActivityReadinessInputV1,
  reconciliation: TruthReconciliationReadinessInputV1,
  required_sources: Schema.Array(TruthRequiredSourceInputV1).pipe(
    Schema.maxItems(128),
  ),
  invalidations: Schema.Array(TruthInvalidationInputV1).pipe(Schema.maxItems(128)),
}) {}

export class TruthReadinessDecisionV1 extends Schema.Class<TruthReadinessDecisionV1>(
  "TruthReadinessDecisionV1",
)({
  state: TruthReadinessState,
  reasons: Schema.Array(TruthIdentifier).pipe(Schema.minItems(1), Schema.maxItems(128)),
  evidence: Schema.Array(TruthEvidenceRef).pipe(Schema.maxItems(256)),
}) {}

export class TruthReadinessEnvelopeUnsignedV1 extends Schema.Class<TruthReadinessEnvelopeUnsignedV1>(
  "TruthReadinessEnvelopeUnsignedV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  environment: TruthEnvironmentId,
  validity_class: TruthValidityClass,
  evidence_origin: Schema.Literal("HERMETIC_FIXTURE", "READ_ONLY_LIVE"),
  live_observation_receipt_hash: Schema.NullOr(Sha256Digest),
  target_lifecycle: Schema.Literal("PRODUCED"),
  bundle_hash: Sha256Digest,
  bundle_generation: DecimalUint64,
  identity_snapshot_hash: Sha256Digest,
  event_vocabulary_hash: Sha256Digest,
  network_policy_hash: Sha256Digest,
  activity_profile_hash: Sha256Digest,
  denominator_manifest_hash: Sha256Digest,
  canonical_collection_id: TruthIdentifier,
  evaluated_at: TruthIsoTimestamp,
  expires_at: TruthIsoTimestamp,
  finalized_watermark: Schema.NullOr(TruthFinalizedWatermarkV1),
  source_digest: Sha256Digest,
  adapter_digest: Sha256Digest,
  invalidation_epoch: DecimalUint64,
  required_source_decisions: Schema.Array(TruthRequiredSourceInputV1).pipe(
    Schema.maxItems(128),
  ),
  decision: TruthReadinessDecisionV1,
  issuer_key_id: TruthIdentifier,
}) {}

export class TruthReadinessEnvelopeV1 extends Schema.Class<TruthReadinessEnvelopeV1>(
  "TruthReadinessEnvelopeV1",
)({
  unsigned_envelope: TruthReadinessEnvelopeUnsignedV1,
  envelope_hash: Sha256Digest,
  signature: TruthEd25519Signature,
}) {}
