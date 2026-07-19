import { Schema } from "effect";

import {
  DecimalUint64,
  PositiveDecimalUint64,
  Sha256Digest,
  TRUTH_CONTRACT_PROTOCOL,
  TRUTH_CONTRACT_SCHEMA_VERSION,
  TruthEnvironmentId,
  TruthFreeText,
  TruthIdentifier,
  TruthIsoTimestamp,
} from "./common.js";
import { TRUTH_NORMATIVE_OBJECT_KINDS } from "./bundle.js";
import { TruthEffectiveStatus, TruthEvidenceRef } from "./readiness.js";

const Version = TruthIdentifier;
const IdentifierList = Schema.Array(TruthIdentifier).pipe(Schema.maxItems(128));

export const TRUTH_COMPATIBILITY_CHANGE_KINDS = [
  "OPTIONAL_FIELD_ADDED",
  "EVENT_KIND_ADDED",
  "REQUIRED_FIELD_REMOVED",
  "MEANING_CHANGED",
  "PROVENANCE_CHANGED",
  "IDENTITY_REINTERPRETED",
] as const;

export const TRUTH_AUTHORITY_ACTIONS = [
  "publish_contract",
  "admit_identity",
  "contest_identity",
  "issue_receipt",
  "revoke_receipt",
  "change_compatibility",
  "approve_rollback",
  "approve_supersession",
  "promote_live_proven",
  "graduate",
  "change_activity_profile",
  "change_reconciliation_strata",
  "change_trust_root",
  "approve_serving_exception",
  "retire_not_consumed_stub",
] as const;

export const TRUTH_SERVING_FAILURE_CLASSES = [
  "temporary_source_transport_loss",
  "stale_projection_or_evidence",
  "source_cursor_not_advancing",
  "reorg_behind_watermark",
  "reconciliation_count_breach",
  "semantic_provenance_mismatch",
  "identity_revoked_or_contested",
  "signer_root_compromise",
  "incompatible_producer_consumer",
] as const;

export class BundleSchemaObjectV1 extends Schema.Class<BundleSchemaObjectV1>(
  "BundleSchemaObjectV1",
)({
  kind: Schema.Literal("bundle_schema"),
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  protocol: Schema.Literal(TRUTH_CONTRACT_PROTOCOL),
  object_kinds: Schema.Tuple(...TRUTH_NORMATIVE_OBJECT_KINDS.map(Schema.Literal)),
}) {}

export class IdentityBindingV1 extends Schema.Class<IdentityBindingV1>(
  "IdentityBindingV1",
)({
  canonical_collection_id: TruthIdentifier,
  chain_family: Schema.Literal("EVM", "SOLANA"),
  chain_id: TruthIdentifier,
  canonical_address: TruthIdentifier,
  aliases: IdentifierList,
  config_digest: Sha256Digest,
  config_source: TruthIdentifier,
  observed_height: DecimalUint64,
  observed_hash: Sha256Digest,
  observed_at: TruthIsoTimestamp,
  finality_policy_version: Version,
  deployed_identity_hash: Sha256Digest,
  deployed_code_hash: Sha256Digest,
  proxy_kind: Schema.Literal(
    "NONE",
    "EIP1967",
    "BEACON",
    "MINIMAL",
    "UNRESOLVABLE",
  ),
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
  supersedes_snapshot: Schema.NullOr(Version),
  contest_state: Schema.Literal("CLEAR", "CONTESTED", "UNSUPPORTED"),
  evidence: Schema.Array(TruthEvidenceRef).pipe(Schema.minItems(1), Schema.maxItems(128)),
  effective_status: TruthEffectiveStatus,
}) {}

export class IdentitySnapshotObjectV1 extends Schema.Class<IdentitySnapshotObjectV1>(
  "IdentitySnapshotObjectV1",
)({
  kind: Schema.Literal("identity_snapshot"),
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  version: Version,
  bindings: Schema.Array(IdentityBindingV1).pipe(Schema.maxItems(10_000)),
}) {}

export class EventKindContractV1 extends Schema.Class<EventKindContractV1>(
  "EventKindContractV1",
)({
  event_kind: TruthIdentifier,
  semantic_version: Version,
  source_entities: IdentifierList,
  identity_fields: IdentifierList,
  required_provenance: IdentifierList.pipe(Schema.minItems(1)),
  user_meaning: TruthFreeText,
  non_user_legs: IdentifierList,
  semantic_legs: Schema.Array(
    Schema.Struct({
      leg_kind: Schema.Literal(
        "MINT",
        "BURN",
        "STAKING_INGRESS",
        "STAKING_EGRESS",
        "DIRECT_TRANSFER",
        "UNCLASSIFIED_INTERMEDIARY",
      ),
      precedence: DecimalUint64,
      user_meaning: Schema.Boolean,
      ownership_effect: Schema.Literal(
        "ACQUIRE",
        "RELEASE",
        "PRESERVE_EFFECTIVE_OWNER",
        "TRANSFER",
        "UNKNOWN",
      ),
      required_provenance: IdentifierList.pipe(Schema.minItems(1)),
      denominator_member: Schema.Boolean,
    }),
  ).pipe(Schema.minItems(1), Schema.maxItems(32)),
  denominator_membership: TruthIdentifier,
  breaking_change_rules: IdentifierList.pipe(Schema.minItems(1)),
}) {}

export class EventDenominatorMemberV1 extends Schema.Class<EventDenominatorMemberV1>(
  "EventDenominatorMemberV1",
)({
  canonical_collection_id: TruthIdentifier,
  chain_id: DecimalUint64,
  contract_name: TruthIdentifier,
  canonical_address: TruthIdentifier,
  event_name: TruthIdentifier,
  event_signature: TruthFreeText,
  topic0: Sha256Digest,
  start_height: DecimalUint64,
  handler_reference: TruthIdentifier,
}) {}

export class EventVocabularyObjectV1 extends Schema.Class<EventVocabularyObjectV1>(
  "EventVocabularyObjectV1",
)({
  kind: Schema.Literal("event_vocabulary"),
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  version: Version,
  denominator_scope: Schema.Literal("CLOSED"),
  denominator_manifest_hash: Sha256Digest,
  denominator_members: Schema.Array(EventDenominatorMemberV1).pipe(
    Schema.minItems(1),
    Schema.maxItems(10_000),
  ),
  events: Schema.Array(EventKindContractV1).pipe(Schema.minItems(1), Schema.maxItems(512)),
}) {}

export class ProvenanceRequirementV1 extends Schema.Class<ProvenanceRequirementV1>(
  "ProvenanceRequirementV1",
)({
  event_kind: TruthIdentifier,
  required_fields: IdentifierList.pipe(Schema.minItems(1)),
  address_classes: IdentifierList,
  symmetric_ingress_egress: Schema.Boolean,
  score_rpc_recovery_allowed: Schema.Literal(false),
}) {}

export class ProvenanceRulesObjectV1 extends Schema.Class<ProvenanceRulesObjectV1>(
  "ProvenanceRulesObjectV1",
)({
  kind: Schema.Literal("provenance_rules"),
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  version: Version,
  requirements: Schema.Array(ProvenanceRequirementV1).pipe(
    Schema.minItems(1),
    Schema.maxItems(512),
  ),
}) {}

export class BehavioralInvariantV1 extends Schema.Class<BehavioralInvariantV1>(
  "BehavioralInvariantV1",
)({
  invariant_id: TruthIdentifier,
  statement: TruthFreeText,
  severity: Schema.Literal("MUST", "MUST_NOT"),
  assertion_fixture: TruthIdentifier,
}) {}

export class BehavioralInvariantsObjectV1 extends Schema.Class<BehavioralInvariantsObjectV1>(
  "BehavioralInvariantsObjectV1",
)({
  kind: Schema.Literal("behavioral_invariants"),
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  version: Version,
  invariants: Schema.Array(BehavioralInvariantV1).pipe(
    Schema.minItems(1),
    Schema.maxItems(512),
  ),
}) {}

export class CompatibilityRuleV1 extends Schema.Class<CompatibilityRuleV1>(
  "CompatibilityRuleV1",
)({
  change_kind: Schema.Literal(...TRUTH_COMPATIBILITY_CHANGE_KINDS),
  result: Schema.Literal("COMPATIBLE", "CONDITIONAL", "BREAKING"),
  consumer_support_required: Schema.Boolean,
}) {}

export class CompatibilityMatrixObjectV1 extends Schema.Class<CompatibilityMatrixObjectV1>(
  "CompatibilityMatrixObjectV1",
)({
  kind: Schema.Literal("compatibility_matrix"),
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  version: Version,
  producer_protocol: Schema.Literal(TRUTH_CONTRACT_PROTOCOL),
  rules: Schema.Array(CompatibilityRuleV1).pipe(Schema.minItems(6), Schema.maxItems(64)),
  trust_namespaces: Schema.Tuple(
    Schema.Literal("development"),
    Schema.Literal("staging"),
    Schema.Literal("production"),
  ),
}) {}

export class AuthorityGrantV1 extends Schema.Class<AuthorityGrantV1>(
  "AuthorityGrantV1",
)({
  action: Schema.Literal(...TRUTH_AUTHORITY_ACTIONS),
  role: TruthIdentifier,
  approval_rule: TruthIdentifier,
  owner: TruthIdentifier,
}) {}

export class AuthorityMatrixObjectV1 extends Schema.Class<AuthorityMatrixObjectV1>(
  "AuthorityMatrixObjectV1",
)({
  kind: Schema.Literal("authority_matrix"),
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  version: Version,
  grants: Schema.Array(AuthorityGrantV1).pipe(
    Schema.minItems(TRUTH_AUTHORITY_ACTIONS.length),
    Schema.maxItems(256),
  ),
  planning_agent_can_graduate: Schema.Literal(false),
}) {}

export class SecurityProfileObjectV1 extends Schema.Class<SecurityProfileObjectV1>(
  "SecurityProfileObjectV1",
)({
  kind: Schema.Literal("security_profile"),
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  version: Version,
  signature_algorithm: Schema.Literal("Ed25519"),
  digest_algorithm: Schema.Literal("SHA-256"),
  canonicalization: Schema.Literal("RFC8785-JCS"),
  production_key_custody: Schema.Literal("KMS_OR_HSM_NON_EXPORTABLE"),
  revocation_cache_seconds: Schema.Literal(300),
  max_future_skew_seconds: Schema.Literal(60),
}) {}

export class ProviderIndependenceV1 extends Schema.Class<ProviderIndependenceV1>(
  "ProviderIndependenceV1",
)({
  provider_id: TruthIdentifier,
  operator: TruthIdentifier,
  legal_entity: TruthIdentifier,
  control_domain: TruthIdentifier,
  network_path: TruthIdentifier,
  asn: TruthIdentifier,
  client_family: TruthIdentifier,
  upstream_source: TruthIdentifier,
  key_id: TruthIdentifier,
  public_key_hex: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
}) {}

export class NetworkPolicyV1 extends Schema.Class<NetworkPolicyV1>("NetworkPolicyV1")({
  network: TruthIdentifier,
  chain_family: Schema.Literal("EVM"),
  chain_id: DecimalUint64,
  finality_policy_version: Version,
  finality_method: Schema.Literal("FINALIZED_TAG", "BLOCK_DEPTH"),
  finalized_tag: Schema.NullOr(Schema.Literal("finalized")),
  minimum_block_depth: Schema.NullOr(DecimalUint64),
  ethereum_depth_fallback_allowed: Schema.Literal(false),
  poll_interval_seconds: Schema.Literal(60),
  required_provider_quorum: DecimalUint64,
  require_distinct_asn: Schema.Boolean,
  require_distinct_client_family: Schema.Boolean,
  observation_ttl_seconds: PositiveDecimalUint64,
  readiness_ttl_seconds: PositiveDecimalUint64,
  max_future_skew_seconds: Schema.Literal(60),
  providers: Schema.Array(ProviderIndependenceV1).pipe(
    Schema.minItems(1),
    Schema.maxItems(16),
  ),
}) {}

export class NetworkFinalityPolicyObjectV1 extends Schema.Class<NetworkFinalityPolicyObjectV1>(
  "NetworkFinalityPolicyObjectV1",
)({
  kind: Schema.Literal("network_finality_policy"),
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  version: Version,
  runtime_scope: Schema.Literal("EVM_ONLY"),
  networks: Schema.Array(NetworkPolicyV1).pipe(Schema.minItems(1), Schema.maxItems(64)),
}) {}

export class ActivityProfileV1 extends Schema.Class<ActivityProfileV1>(
  "ActivityProfileV1",
)({
  collection_id: TruthIdentifier,
  owner: TruthIdentifier,
  expected_event_window_seconds: PositiveDecimalUint64,
  collection_launch_interval_seconds: PositiveDecimalUint64,
  source_head_cadence_seconds: PositiveDecimalUint64,
  cursor_cadence_seconds: PositiveDecimalUint64,
  provider_heartbeat_cadence_seconds: PositiveDecimalUint64,
  cross_source_availability_required: Schema.Boolean,
  quiet_window_permitted: Schema.Boolean,
  expected_event_distribution: TruthIdentifier,
  evidence_window_start: TruthIsoTimestamp,
  evidence_window_end: TruthIsoTimestamp,
  denominator: PositiveDecimalUint64,
  backtest_digest: Sha256Digest,
  confidence_basis: TruthIdentifier,
  approval: TruthIdentifier,
  effective_from: TruthIsoTimestamp,
  effective_until: Schema.NullOr(TruthIsoTimestamp),
  supersedes_version: Schema.NullOr(Version),
}) {}

export class ActivityProfilesObjectV1 extends Schema.Class<ActivityProfilesObjectV1>(
  "ActivityProfilesObjectV1",
)({
  kind: Schema.Literal("activity_profiles"),
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  version: Version,
  profiles: Schema.Array(ActivityProfileV1).pipe(Schema.maxItems(10_000)),
}) {}

export const TRUTH_HIGH_RISK_RECONCILIATION_CLASSES = [
  "CUSTODY_STAKING",
  "PROXY_UPGRADE",
  "SALE",
  "MINT_BURN",
] as const;

export class StatisticalPolicyObjectV1 extends Schema.Class<StatisticalPolicyObjectV1>(
  "StatisticalPolicyObjectV1",
)({
  kind: Schema.Literal("statistical_policy"),
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  version: Schema.Literal("statistical-policy.v1"),
  population_version: TruthIdentifier,
  strata_dimensions: Schema.Tuple(
    Schema.Literal("contract"),
    Schema.Literal("event_kind"),
    Schema.Literal("semantic_leg"),
  ),
  estimand: Schema.Literal("SEMANTIC_DEFECT_PREVALENCE"),
  tolerable_defect_rate_ppm: Schema.Literal("10000"),
  adverse_defect_rate_ppm: Schema.Literal("50000"),
  family_wise_alpha_ppm: Schema.Literal("50000"),
  multiple_testing_correction: Schema.Literal("BONFERRONI"),
  minimum_power_ppm: Schema.Literal("800000"),
  one_sided_test: Schema.Literal(true),
  finite_population_correction: Schema.Literal("EXACT_HYPERGEOMETRIC"),
  selection: Schema.Literal("DETERMINISTIC_HYPERGEOMETRIC_WITHOUT_REPLACEMENT"),
  sample_size_algorithm_version: Schema.Literal("hypergeometric-sha256-order.v1"),
  golden_vectors_sha256: Sha256Digest,
  authorized_sampling_scope_digest: Sha256Digest,
  missing_observation_treatment: Schema.Literal("DEFECT"),
  integer_rounding: Schema.Literal("CEILING"),
  defect_rate_prior: Schema.Null,
  historical_n_300_is_acceptance_threshold: Schema.Literal(false),
  high_risk_classes: Schema.Tuple(
    ...TRUTH_HIGH_RISK_RECONCILIATION_CLASSES.map(Schema.Literal),
  ),
}) {}

export class ServingFailureRuleV1 extends Schema.Class<ServingFailureRuleV1>(
  "ServingFailureRuleV1",
)({
  failure_class: Schema.Literal(...TRUTH_SERVING_FAILURE_CLASSES),
  effective_status: Schema.Literal(
    "DEGRADED",
    "NOT_READY",
    "UNKNOWN",
    "SUSPENDED",
    "EXPIRED",
  ),
  last_good_allowed: Schema.Boolean,
  last_good_policy: Schema.Literal(
    "SAME_VERSION_WITHIN_TTL",
    "SAME_VERSION_ONE_EXTRA_TTL",
    "PRIOR_PROJECTION_ONLY",
    "PRIOR_GENERATION_ONLY",
    "FORBIDDEN",
  ),
  maximum_last_good_seconds: DecimalUint64,
  graduation_eligible: Schema.Literal(false),
  user_label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  escalation_seconds: DecimalUint64,
  recovery_evidence: IdentifierList.pipe(Schema.minItems(1)),
}) {}

export class ServingPolicyObjectV1 extends Schema.Class<ServingPolicyObjectV1>(
  "ServingPolicyObjectV1",
)({
  kind: Schema.Literal("serving_policy"),
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  version: Version,
  environment: TruthEnvironmentId,
  rules: Schema.Array(ServingFailureRuleV1).pipe(
    Schema.minItems(TRUTH_SERVING_FAILURE_CLASSES.length),
    Schema.maxItems(64),
  ),
}) {}

export class IssuerMetadataObjectV1 extends Schema.Class<IssuerMetadataObjectV1>(
  "IssuerMetadataObjectV1",
)({
  kind: Schema.Literal("issuer_metadata"),
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  version: Version,
  service_id: TruthIdentifier,
  key_id: TruthIdentifier,
  build_id: TruthIdentifier,
  repository: TruthIdentifier,
  source_commit: Sha256Digest,
  issued_at: TruthIsoTimestamp,
}) {}

export const TruthNormativeObjectV1 = Schema.Union(
  BundleSchemaObjectV1,
  IdentitySnapshotObjectV1,
  EventVocabularyObjectV1,
  ProvenanceRulesObjectV1,
  BehavioralInvariantsObjectV1,
  CompatibilityMatrixObjectV1,
  AuthorityMatrixObjectV1,
  SecurityProfileObjectV1,
  NetworkFinalityPolicyObjectV1,
  ActivityProfilesObjectV1,
  StatisticalPolicyObjectV1,
  ServingPolicyObjectV1,
  IssuerMetadataObjectV1,
).annotations({ identifier: "TruthNormativeObjectV1" });
export type TruthNormativeObjectV1 = Schema.Schema.Type<typeof TruthNormativeObjectV1>;
