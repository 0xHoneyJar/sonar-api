/**
 * CR-101 Effect Schema surface for the versioned resolver capability registry.
 *
 * Strict decode: excess properties and unknown schema majors are refused.
 * Uint64 wire values are decimal strings — never floating JS numbers.
 */
import { Schema } from "effect";
import {
  CapabilityRegistryBaseline,
  CapabilityRegistryVersion,
  COLLECTION_PROTOCOL_SCHEMA_VERSION,
  NetworkRef,
  VersionIdentifier,
} from "../protocol.js";

export const CAPABILITY_REGISTRY_SCHEMA_VERSION = 1 as const;
export const CAPABILITY_REGISTRY_DIGEST_DOMAIN = "capability.registry-snapshot";
export const CAPABILITY_REGISTRY_ORDERING_DIGEST_DOMAIN =
  "capability.registry-ordering-projection";
export const CAPABILITY_REGISTRY_BASELINE_BINDING_DIGEST_DOMAIN =
  "capability.registry-baseline-binding";
export const CAPABILITY_REGISTRY_TRANSITION_DIGEST_DOMAIN =
  "capability.registry-transition";

/** Genesis source_sequence for a newly introduced (network, operation) pair. */
export const INITIAL_SOURCE_SEQUENCE = "1" as const;

const SchemaVersion = Schema.Literal(CAPABILITY_REGISTRY_SCHEMA_VERSION);
const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const isRealIsoTimestamp = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(
    value,
  );
  if (match === null) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (second! > 59) return false;
  const instant = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month! - 1 &&
    instant.getUTCDate() === day &&
    instant.getUTCHours() === hour &&
    instant.getUTCMinutes() === minute &&
    instant.getUTCSeconds() === second
  );
};
const IsoTimestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
  Schema.filter((value) => isRealIsoTimestamp(value) || "invalid UTC calendar timestamp"),
).annotations({ identifier: "CapabilityRegistryIsoTimestamp" });

const DECIMAL_UINT64_MAX = 18_446_744_073_709_551_615n;

/** Decimal-string uint64 — mirrors CR-001 RegistrySequence rules. */
export const DecimalUint64 = Schema.String.pipe(
  Schema.pattern(/^(0|[1-9][0-9]*)$/),
  Schema.filter(
    (value) =>
      BigInt(value) <= DECIMAL_UINT64_MAX ||
      "value exceeds unsigned 64-bit range",
  ),
).annotations({ identifier: "DecimalUint64" });
export type DecimalUint64 = Schema.Schema.Type<typeof DecimalUint64>;

/** Per-operation sequence numbers are one-based; registry epochs may still begin at zero. */
export const SourceSequence = DecimalUint64.pipe(
  Schema.filter(
    (value) =>
      BigInt(value) >= BigInt(INITIAL_SOURCE_SEQUENCE) ||
      `source_sequence must be at least INITIAL_SOURCE_SEQUENCE=${INITIAL_SOURCE_SEQUENCE}`,
  ),
).annotations({ identifier: "CapabilitySourceSequence" });
export type SourceSequence = Schema.Schema.Type<typeof SourceSequence>;

export const NetworkEnvironment = Schema.Literal("mainnet", "testnet").annotations({
  identifier: "NetworkEnvironment",
});
export type NetworkEnvironment = Schema.Schema.Type<typeof NetworkEnvironment>;

export const ProbeAdapterId = Schema.Literal("evm_rpc", "solana_das").annotations({
  identifier: "ProbeAdapterId",
});
export type ProbeAdapterId = Schema.Schema.Type<typeof ProbeAdapterId>;

export const ConcurrencyClass = Schema.Literal(
  "interactive",
  "bulk",
  "background",
).annotations({ identifier: "ConcurrencyClass" });
export type ConcurrencyClass = Schema.Schema.Type<typeof ConcurrencyClass>;

export const OperationKind = Schema.Literal(
  "recognize",
  "prepare",
  "read_evidence",
).annotations({ identifier: "OperationKind" });
export type OperationKind = Schema.Schema.Type<typeof OperationKind>;

export const OperationHealthState = Schema.Literal(
  "available",
  "degraded",
  "disabled",
).annotations({ identifier: "OperationHealthState" });
export type OperationHealthState = Schema.Schema.Type<typeof OperationHealthState>;

/**
 * Strict reason class for capability transitions and operation health changes.
 * Bound into snapshot / transition / Ordering digests.
 */
export const CapabilityReasonClass = Schema.Literal(
  "healthy",
  "catalog_update",
  "operator_policy",
  "availability_degradation",
  "integrity_compromise",
  "capability_unsupported",
  "kill_switch",
  "epoch_reset",
).annotations({ identifier: "CapabilityReasonClass" });
export type CapabilityReasonClass = Schema.Schema.Type<typeof CapabilityReasonClass>;

export const DrainPolicy = Schema.Literal(
  "finish",
  "capability_disabled",
  "cancel_and_reject",
).annotations({ identifier: "DrainPolicy" });
export type DrainPolicy = Schema.Schema.Type<typeof DrainPolicy>;

export const PriorEvidenceRevocationPolicy = Schema.Literal(
  "none",
  "freshness_only",
  "revoke_integrity",
).annotations({ identifier: "PriorEvidenceRevocationPolicy" });
export type PriorEvidenceRevocationPolicy = Schema.Schema.Type<
  typeof PriorEvidenceRevocationPolicy
>;

export const NewWorkEffect = Schema.Literal(
  "admit",
  "partial_diagnostics",
  "exclude",
  "reject",
).annotations({ identifier: "NewWorkEffect" });
export type NewWorkEffect = Schema.Schema.Type<typeof NewWorkEffect>;

export const QueuedInFlightEffect = Schema.Literal(
  "continue",
  "follow_drain",
  "finish_or_capability_disabled",
).annotations({ identifier: "QueuedInFlightEffect" });
export type QueuedInFlightEffect = Schema.Schema.Type<typeof QueuedInFlightEffect>;

export const ExistingEvidenceEffect = Schema.Literal(
  "reuse_if_fresh",
  "reuse_if_availability_degradation",
  "freshness_policy",
  "revoke",
).annotations({ identifier: "ExistingEvidenceEffect" });
export type ExistingEvidenceEffect = Schema.Schema.Type<typeof ExistingEvidenceEffect>;

export const NormativeEffects = Schema.Struct({
  new_work: NewWorkEffect,
  queued_in_flight: QueuedInFlightEffect,
  existing_evidence: ExistingEvidenceEffect,
}).annotations({ identifier: "NormativeEffects" });
export interface NormativeEffects extends Schema.Schema.Type<typeof NormativeEffects> {}

export const OperationDeadline = Schema.Struct({
  deadline_ms: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0), Schema.lessThanOrEqualTo(60_000)),
  concurrency_class: ConcurrencyClass,
}).annotations({ identifier: "OperationDeadline" });
export interface OperationDeadline extends Schema.Schema.Type<typeof OperationDeadline> {}

/**
 * Bounded public actor identifier — refuses credentials/secrets and excess keys.
 * Digests must only ever see values that passed this schema.
 */
const SECRET_LIKE_ACTOR_ID =
  /(api[_-]?key|secret|password|passwd|token|bearer|private[_-]?key|credential|authorization)/i;

export const ActorPublicId = NonEmptyString.pipe(
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/),
  Schema.filter(
    (id) =>
      !SECRET_LIKE_ACTOR_ID.test(id) ||
      "actor id must be a public identifier, not a credential or secret",
  ),
).annotations({ identifier: "ActorPublicId" });
export type ActorPublicId = Schema.Schema.Type<typeof ActorPublicId>;

export const ActorIdentity = Schema.Struct({
  kind: Schema.Literal("operator", "system", "automation"),
  id: ActorPublicId,
}).annotations({ identifier: "ActorIdentity" });
export interface ActorIdentity extends Schema.Schema.Type<typeof ActorIdentity> {}

/**
 * Complete transition audit event. Strict-decoded before any digesting or
 * transition logic; excess properties are refused.
 *
 * Deterministic operation-binding rule: every materially changed or newly
 * introduced operation MUST have reason_class equal to this reason_class and
 * effective_at equal to this effective_at. Unchanged operations retain their
 * prior audit fields unchanged.
 */
export const CapabilityRegistryTransitionAudit = Schema.Struct({
  reason_class: CapabilityReasonClass,
  effective_at: IsoTimestamp,
  actor: ActorIdentity,
}).annotations({ identifier: "CapabilityRegistryTransitionAudit" });
export type CapabilityRegistryTransitionAudit = Schema.Schema.Type<
  typeof CapabilityRegistryTransitionAudit
>;

export const OperationCapability = Schema.Struct({
  enabled: Schema.Boolean,
  state: OperationHealthState,
  reason_class: CapabilityReasonClass,
  reason: NonEmptyString,
  effective_at: IsoTimestamp,
  source_sequence: SourceSequence,
  drain_policy: DrainPolicy,
  prior_evidence_revocation_policy: PriorEvidenceRevocationPolicy,
  normative_effects: NormativeEffects,
  deadline: OperationDeadline,
}).annotations({ identifier: "OperationCapability" });
export interface OperationCapability extends Schema.Schema.Type<typeof OperationCapability> {}

export const SourceHeadQuorum = Schema.Struct({
  min_agreeing_sources: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  accepted_provider_set_id: VersionIdentifier,
}).annotations({ identifier: "SourceHeadQuorum" });
export interface SourceHeadQuorum extends Schema.Schema.Type<typeof SourceHeadQuorum> {}

export const DegradationRule = Schema.Struct({
  on_quorum_loss: Schema.Literal("degrade", "disable"),
  on_freshness_breach: Schema.Literal("degrade", "disable", "partial_diagnostics"),
}).annotations({ identifier: "DegradationRule" });
export interface DegradationRule extends Schema.Schema.Type<typeof DegradationRule> {}

/** EVM confirmation — discriminated; no hybrid both-branch fields. */
export const EvmBlockDepthConfirmation = Schema.Struct({
  kind: Schema.Literal("block_depth"),
  min_depth: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
}).annotations({ identifier: "EvmBlockDepthConfirmation" });

export const EvmFinalizedTagConfirmation = Schema.Struct({
  kind: Schema.Literal("finalized_tag"),
  finalized_tag: Schema.Literal("finalized", "safe"),
}).annotations({ identifier: "EvmFinalizedTagConfirmation" });

export const EvmConfirmationPolicy = Schema.Union(
  EvmBlockDepthConfirmation,
  EvmFinalizedTagConfirmation,
).annotations({ identifier: "EvmConfirmationPolicy" });
export type EvmConfirmationPolicy = Schema.Schema.Type<typeof EvmConfirmationPolicy>;

/** EVM freshness — block_time only. */
export const EvmFreshnessRule = Schema.Struct({
  max_age_ms: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  clock: Schema.Literal("block_time"),
}).annotations({ identifier: "EvmFreshnessRule" });
export type EvmFreshnessRule = Schema.Schema.Type<typeof EvmFreshnessRule>;

/** Solana freshness — slot_time only. */
export const SolanaFreshnessRule = Schema.Struct({
  max_age_ms: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  clock: Schema.Literal("slot_time"),
}).annotations({ identifier: "SolanaFreshnessRule" });
export type SolanaFreshnessRule = Schema.Schema.Type<typeof SolanaFreshnessRule>;

/** EVM finality — network-specific; never an implicit Ethereum inheritance. */
export const EvmFinalityPolicy = Schema.Struct({
  family: Schema.Literal("evm"),
  policy_version: VersionIdentifier,
  source_head_quorum: SourceHeadQuorum,
  confirmation: EvmConfirmationPolicy,
  reorg: Schema.Struct({
    invalidation_depth: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  }),
  degradation: DegradationRule,
  freshness: EvmFreshnessRule,
}).annotations({ identifier: "EvmFinalityPolicy" });
export type EvmFinalityPolicy = Schema.Schema.Type<typeof EvmFinalityPolicy>;

/** Solana finality — commitment / fork semantics, not EVM block-depth. */
export const SolanaFinalityPolicy = Schema.Struct({
  family: Schema.Literal("solana"),
  policy_version: VersionIdentifier,
  source_head_quorum: SourceHeadQuorum,
  commitment: Schema.Literal("processed", "confirmed", "finalized"),
  fork: Schema.Struct({
    compare: Schema.Literal("root_slot", "confirmed_slot"),
    invalidate_on_fork_divergence: Schema.Boolean,
  }),
  degradation: DegradationRule,
  freshness: SolanaFreshnessRule,
}).annotations({ identifier: "SolanaFinalityPolicy" });
export type SolanaFinalityPolicy = Schema.Schema.Type<typeof SolanaFinalityPolicy>;

export const FinalityPolicy = Schema.Union(EvmFinalityPolicy, SolanaFinalityPolicy).annotations({
  identifier: "FinalityPolicy",
});
export type FinalityPolicy = Schema.Schema.Type<typeof FinalityPolicy>;

export const DisplayIdentity = Schema.Struct({
  display_name: NonEmptyString,
  icon_identity: VersionIdentifier,
}).annotations({ identifier: "DisplayIdentity" });
export interface DisplayIdentity extends Schema.Schema.Type<typeof DisplayIdentity> {}

export const ProbeAdapterBinding = Schema.Struct({
  adapter_id: ProbeAdapterId,
  adapter_version: VersionIdentifier,
}).annotations({ identifier: "ProbeAdapterBinding" });
export interface ProbeAdapterBinding extends Schema.Schema.Type<typeof ProbeAdapterBinding> {}

export const SourceProvenance = Schema.Struct({
  kind: Schema.Literal(
    "operator_ratified",
    "indexer_config_evidence",
    "das_adapter_evidence",
    "placeholder_until_capability",
  ),
  reference: NonEmptyString,
  attested_at: IsoTimestamp,
}).annotations({ identifier: "SourceProvenance" });
export interface SourceProvenance extends Schema.Schema.Type<typeof SourceProvenance> {}

export const NetworkOperations = Schema.Struct({
  recognize: OperationCapability,
  prepare: OperationCapability,
  read_evidence: OperationCapability,
}).annotations({ identifier: "NetworkOperations" });
export interface NetworkOperations extends Schema.Schema.Type<typeof NetworkOperations> {}

/**
 * One network capability row. Forbidden user-supplied RPC / endpoint / chain
 * definition / arbitrary adapter config fields are refused as excess properties.
 */
export const NetworkCapability = Schema.Struct({
  schema_version: SchemaVersion,
  network: NetworkRef,
  environment: NetworkEnvironment,
  display: DisplayIdentity,
  probe_adapter: ProbeAdapterBinding,
  supported_standards: Schema.Array(VersionIdentifier).pipe(
    Schema.filter(
      (standards) =>
        standards.length > 0 || "supported_standards must be non-empty",
    ),
  ),
  operations: NetworkOperations,
  /** True when Sonar can prepare ownership/index data for this network. */
  index_support: Schema.Boolean,
  finality_policy: FinalityPolicy,
  kill_switch: Schema.Boolean,
  network_priority: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  source_provenance: SourceProvenance,
}).annotations({ identifier: "NetworkCapability" });
export interface NetworkCapability extends Schema.Schema.Type<typeof NetworkCapability> {}

export const CapabilityRegistrySnapshotInput = Schema.Struct({
  schema_version: SchemaVersion,
  version: CapabilityRegistryVersion,
  networks: Schema.Array(NetworkCapability),
}).annotations({ identifier: "CapabilityRegistrySnapshotInput" });
export type CapabilityRegistrySnapshotInput = Schema.Schema.Type<
  typeof CapabilityRegistrySnapshotInput
>;

/**
 * Signature-ready baseline material for epoch resets.
 * Binds the complete predecessor→candidate transition identity plus snapshot digest.
 */
export const CapabilityRegistryBaselineMaterial = Schema.Struct({
  schema_version: SchemaVersion,
  previous_version: CapabilityRegistryVersion,
  version: CapabilityRegistryVersion,
  snapshot_digest: Schema.Struct({
    algorithm: Schema.Literal("sha-256"),
    domain: Schema.Literal(CAPABILITY_REGISTRY_DIGEST_DOMAIN),
    major_version: Schema.Literal(1),
    digest: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  }),
  binding_digest: Schema.Struct({
    algorithm: Schema.Literal("sha-256"),
    domain: Schema.Literal(CAPABILITY_REGISTRY_BASELINE_BINDING_DIGEST_DOMAIN),
    major_version: Schema.Literal(1),
    digest: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  }),
}).annotations({ identifier: "CapabilityRegistryBaselineMaterial" });
export type CapabilityRegistryBaselineMaterial = Schema.Schema.Type<
  typeof CapabilityRegistryBaselineMaterial
>;

/**
 * Epoch-reset signature envelope — algorithm + hex material only.
 * Excess credential/metadata keys are refused at decode.
 */
export const BaselineSignatureEnvelope = Schema.Struct({
  algorithm: Schema.Literal("ed25519"),
  signature_hex: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{128}$/)),
  public_key_hex: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
}).annotations({ identifier: "BaselineSignatureEnvelope" });
export type BaselineSignatureEnvelope = Schema.Schema.Type<
  typeof BaselineSignatureEnvelope
>;

/**
 * Contiguous same-epoch advance. Allowed top-level fields only — undeclared
 * keys (api_key, secret, rogue, baseline, signature, metadata, …) fail closed.
 */
export const CapabilityRegistrySequenceAdvanceTransition = Schema.Struct({
  kind: Schema.Literal("sequence_advance"),
  from: CapabilityRegistryVersion,
  to: CapabilityRegistryVersion,
  networks: Schema.Array(NetworkCapability),
  reason_class: CapabilityReasonClass,
  effective_at: IsoTimestamp,
  actor: ActorIdentity,
}).annotations({ identifier: "CapabilityRegistrySequenceAdvanceTransition" });
export type CapabilityRegistrySequenceAdvanceTransition = Schema.Schema.Type<
  typeof CapabilityRegistrySequenceAdvanceTransition
>;

/**
 * Epoch reset. Requires baseline + signature; refuses undeclared top-level keys.
 */
export const CapabilityRegistryEpochResetTransition = Schema.Struct({
  kind: Schema.Literal("epoch_reset"),
  from: CapabilityRegistryVersion,
  to: CapabilityRegistryVersion,
  networks: Schema.Array(NetworkCapability),
  reason_class: CapabilityReasonClass,
  effective_at: IsoTimestamp,
  actor: ActorIdentity,
  baseline: CapabilityRegistryBaseline,
  signature: BaselineSignatureEnvelope,
}).annotations({ identifier: "CapabilityRegistryEpochResetTransition" });
export type CapabilityRegistryEpochResetTransition = Schema.Schema.Type<
  typeof CapabilityRegistryEpochResetTransition
>;

/**
 * Complete discriminated transition envelope. Strict-decode this before any
 * projection, digest, sequence/signature verification, or transition logic.
 */
export const CapabilityRegistryTransition = Schema.Union(
  CapabilityRegistrySequenceAdvanceTransition,
  CapabilityRegistryEpochResetTransition,
).annotations({ identifier: "CapabilityRegistryTransition" });
export type CapabilityRegistryTransition = Schema.Schema.Type<
  typeof CapabilityRegistryTransition
>;

/**
 * Admission-relevant Ordering projection — least privilege.
 * Deliberately omits display/icon, RPC, adapter internals, and diagnostics.
 * Exposes effective_at, source_sequence, and reason_class for audit replay.
 */
export const OrderingCapabilityView = Schema.Struct({
  network: NetworkRef,
  environment: NetworkEnvironment,
  operation: OperationKind,
  enabled: Schema.Boolean,
  state: OperationHealthState,
  supported_standards: Schema.Array(VersionIdentifier),
  index_support: Schema.Boolean,
  finality_policy_version: VersionIdentifier,
  kill_switch: Schema.Boolean,
  drain_policy: DrainPolicy,
  prior_evidence_revocation_policy: PriorEvidenceRevocationPolicy,
  normative_effects: NormativeEffects,
  source_sequence: SourceSequence,
  effective_at: IsoTimestamp,
  reason_class: CapabilityReasonClass,
  network_priority: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
}).annotations({ identifier: "OrderingCapabilityView" });
export interface OrderingCapabilityView
  extends Schema.Schema.Type<typeof OrderingCapabilityView> {}

export const OrderingCapabilityProjection = Schema.Struct({
  schema_version: SchemaVersion,
  snapshot_identity: CapabilityRegistryVersion,
  views: Schema.Array(OrderingCapabilityView),
}).annotations({ identifier: "OrderingCapabilityProjection" });
export interface OrderingCapabilityProjection
  extends Schema.Schema.Type<typeof OrderingCapabilityProjection> {}

export { SchemaVersion, COLLECTION_PROTOCOL_SCHEMA_VERSION, IsoTimestamp };
