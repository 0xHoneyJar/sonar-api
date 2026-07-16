/**
 * CR-102 Effect Schema surface for the bounded resolver core.
 *
 * Strict decode: excess properties refused. Budgets and ceilings are bounded.
 */
import { Schema } from "effect";
import {
  CapabilityRegistryVersion,
  COLLECTION_PROTOCOL_SCHEMA_VERSION,
  NetworkRef,
} from "../protocol.js";
import { DecimalUint64 } from "../capability-registry/schemas.js";

export const BOUNDED_RESOLVER_SCHEMA_VERSION = 1 as const;
export const BOUNDED_RESOLVER_ADAPTER_POLICY_VERSION = "resolver-adapter-policy.v1" as const;

const SchemaVersion = Schema.Literal(BOUNDED_RESOLVER_SCHEMA_VERSION);
const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const IsoTimestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
).annotations({ identifier: "BoundedResolverIsoTimestamp" });

/** Hex sha-256 digest (64 lowercase hex chars). */
export const Sha256Hex = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{64}$/),
).annotations({ identifier: "Sha256Hex" });
export type Sha256Hex = Schema.Schema.Type<typeof Sha256Hex>;

export const ObservedPosition = Schema.Union(
  Schema.Struct({
    family: Schema.Literal("evm"),
    block_number: DecimalUint64,
    block_hash: Sha256Hex,
    finality: Schema.optional(NonEmptyString.pipe(Schema.maxLength(64))),
  }),
  Schema.Struct({
    family: Schema.Literal("solana"),
    slot: DecimalUint64,
    blockhash: NonEmptyString.pipe(Schema.maxLength(128)),
    finality: Schema.optional(NonEmptyString.pipe(Schema.maxLength(64))),
  }),
).annotations({ identifier: "ObservedPosition" });
export type ObservedPosition = Schema.Schema.Type<typeof ObservedPosition>;

export const StandardEvidence = Schema.Struct({
  token_standard: NonEmptyString.pipe(Schema.maxLength(64)),
  evidence_quality: Schema.Literal("confirmed", "heuristic", "unknown"),
  interface_bits: Schema.optional(
    Schema.Array(NonEmptyString.pipe(Schema.maxLength(64))).pipe(Schema.maxItems(16)),
  ),
}).annotations({ identifier: "StandardEvidence" });
export type StandardEvidence = Schema.Schema.Type<typeof StandardEvidence>;

export const ProxyEvidence = Schema.Struct({
  is_proxy: Schema.Boolean,
  implementation_digest: Schema.optional(Sha256Hex),
  proxy_kind: Schema.optional(
    Schema.Literal("eip1967", "eip1822", "transparent", "metaplex", "unknown"),
  ),
}).annotations({ identifier: "ProxyEvidence" });
export type ProxyEvidence = Schema.Schema.Type<typeof ProxyEvidence>;

/**
 * Operational budgets — SDD §5.3 defaults encoded as upper bounds.
 * Raising ceilings requires a contract-version update.
 */
export const BoundedResolverConfig = Schema.Struct({
  schema_version: SchemaVersion,
  global_deadline_ms: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThan(0),
    Schema.lessThanOrEqualTo(4_000),
  ),
  per_network_deadline_ms: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThan(0),
    Schema.lessThanOrEqualTo(1_500),
  ),
  max_concurrent_probes: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThan(0),
    Schema.lessThanOrEqualTo(6),
  ),
  max_searched_networks: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThan(0),
    Schema.lessThanOrEqualTo(8),
  ),
  positive_recognition_ttl_ms: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThan(0),
    Schema.lessThanOrEqualTo(3_600_000),
  ),
  report_readiness_ttl_ms: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThan(0),
    Schema.lessThanOrEqualTo(600_000),
  ),
  negative_cache_ttl_ms: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThan(0),
    Schema.lessThanOrEqualTo(60_000),
  ),
  caller_rate_limit: Schema.Struct({
    limit: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0), Schema.lessThanOrEqualTo(120)),
    window_ms: Schema.Number.pipe(
      Schema.int(),
      Schema.greaterThan(0),
      Schema.lessThanOrEqualTo(60_000),
    ),
    max_cardinality: Schema.Number.pipe(
      Schema.int(),
      Schema.greaterThan(0),
      Schema.lessThanOrEqualTo(10_000),
    ),
  }),
  global_rate_limit: Schema.Struct({
    limit: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0), Schema.lessThanOrEqualTo(2_000)),
    window_ms: Schema.Number.pipe(
      Schema.int(),
      Schema.greaterThan(0),
      Schema.lessThanOrEqualTo(60_000),
    ),
  }),
  circuit_breaker: Schema.Struct({
    failure_threshold: Schema.Number.pipe(
      Schema.int(),
      Schema.greaterThan(0),
      Schema.lessThanOrEqualTo(20),
    ),
    open_ms: Schema.Number.pipe(
      Schema.int(),
      Schema.greaterThan(0),
      Schema.lessThanOrEqualTo(300_000),
    ),
    half_open_max_probes: Schema.Number.pipe(
      Schema.int(),
      Schema.greaterThan(0),
      Schema.lessThanOrEqualTo(3),
    ),
  }),
  inventory_enrichment_budget_ms: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(0),
    Schema.lessThanOrEqualTo(1_000),
  ),
  adapter_policy_version: NonEmptyString.pipe(Schema.maxLength(128)),
}).annotations({ identifier: "BoundedResolverConfig" });
export interface BoundedResolverConfig extends Schema.Schema.Type<typeof BoundedResolverConfig> {}

export const DEFAULT_BOUNDED_RESOLVER_CONFIG: BoundedResolverConfig = {
  schema_version: 1,
  global_deadline_ms: 4_000,
  per_network_deadline_ms: 1_500,
  max_concurrent_probes: 6,
  max_searched_networks: 8,
  positive_recognition_ttl_ms: 300_000,
  report_readiness_ttl_ms: 60_000,
  negative_cache_ttl_ms: 15_000,
  caller_rate_limit: {
    limit: 30,
    window_ms: 60_000,
    max_cardinality: 5_000,
  },
  global_rate_limit: {
    limit: 500,
    window_ms: 1_000,
  },
  circuit_breaker: {
    failure_threshold: 5,
    open_ms: 30_000,
    half_open_max_probes: 1,
  },
  inventory_enrichment_budget_ms: 500,
  adapter_policy_version: BOUNDED_RESOLVER_ADAPTER_POLICY_VERSION,
};

export const CacheNamespace = Schema.Literal(
  "positive_recognition",
  "report_readiness",
  "negative_probe",
).annotations({ identifier: "CacheNamespace" });
export type CacheNamespace = Schema.Schema.Type<typeof CacheNamespace>;

export const CacheInvalidationCause = Schema.Literal(
  "network_disable",
  "network_security",
  "code_digest_drift",
  "account_digest_drift",
  "identity_drift",
  "reorg_below_finality",
  "capability_change",
  "finality_policy_change",
  "adapter_policy_change",
  "equivalence_revocation",
  "capability_coverage_growth",
  "transient_recovery",
  "ttl_expiry",
).annotations({ identifier: "CacheInvalidationCause" });
export type CacheInvalidationCause = Schema.Schema.Type<typeof CacheInvalidationCause>;

/**
 * Canonical invalidation edge for CR-012A consumers.
 * Eviction alone is NOT accepted remediation — Ordering must quarantine.
 */
export const EquivalenceRevocationImpact = Schema.Struct({
  schema_version: SchemaVersion,
  kind: Schema.Literal("collection_equivalence_revocation"),
  equivalence_digest: Sha256Hex,
  previous_collection_identity_digest: Sha256Hex,
  affected_deployment_ids: Schema.Array(Sha256Hex).pipe(Schema.minItems(1), Schema.maxItems(64)),
  capability_snapshot_version: CapabilityRegistryVersion,
  emitted_at: IsoTimestamp,
  impact: Schema.Struct({
    cache_namespaces: Schema.Array(CacheNamespace).pipe(Schema.minItems(1)),
    requires_quarantine: Schema.Literal(true),
    remediation: Schema.Literal("new_identity_version_required"),
    eviction_alone_insufficient: Schema.Literal(true),
  }),
}).annotations({ identifier: "EquivalenceRevocationImpact" });
export interface EquivalenceRevocationImpact
  extends Schema.Schema.Type<typeof EquivalenceRevocationImpact> {}

export const AuthorizationScope = Schema.Struct({
  /** Opaque, low-cardinality community/scope class — never raw user identity. */
  scope_class: Schema.Literal("anonymous", "authenticated", "community"),
  community_ref_digest: Schema.optional(Sha256Hex),
}).annotations({ identifier: "AuthorizationScope" });
export type AuthorizationScope = Schema.Schema.Type<typeof AuthorizationScope>;

export const PositiveCacheBinding = Schema.Struct({
  schema_version: SchemaVersion,
  namespace: Schema.Literal("positive_recognition"),
  capability_snapshot_version: CapabilityRegistryVersion,
  capability_source_sequence: DecimalUint64,
  deployment_id: Sha256Hex,
  account_digest: Sha256Hex,
  code_digest: Sha256Hex,
  observed_position: ObservedPosition,
  standard_evidence: StandardEvidence,
  proxy_evidence: ProxyEvidence,
  inventory_enrichment_version: Schema.optional(NonEmptyString.pipe(Schema.maxLength(128))),
  inventory_equivalence_version: Schema.optional(NonEmptyString.pipe(Schema.maxLength(128))),
  authorization_scope: AuthorizationScope,
  adapter_policy_version: NonEmptyString.pipe(Schema.maxLength(128)),
  finality_policy_version: NonEmptyString.pipe(Schema.maxLength(128)),
}).annotations({ identifier: "PositiveCacheBinding" });
export interface PositiveCacheBinding extends Schema.Schema.Type<typeof PositiveCacheBinding> {}

export const ReadinessCacheBinding = Schema.Struct({
  schema_version: SchemaVersion,
  namespace: Schema.Literal("report_readiness"),
  capability_snapshot_version: CapabilityRegistryVersion,
  deployment_id: Sha256Hex,
  report_readiness: Schema.Literal(
    "ready",
    "preparation_required",
    "blocked",
    "unsupported",
    "unknown",
  ),
  index_status: Schema.Literal(
    "indexed",
    "indexing",
    "missing",
    "stale",
    "unsupported",
    "failed",
    "unknown",
  ),
  adapter_policy_version: NonEmptyString.pipe(Schema.maxLength(128)),
  authorization_scope: AuthorizationScope,
}).annotations({ identifier: "ReadinessCacheBinding" });
export interface ReadinessCacheBinding extends Schema.Schema.Type<typeof ReadinessCacheBinding> {}

export const NegativeCacheBinding = Schema.Struct({
  schema_version: SchemaVersion,
  namespace: Schema.Literal("negative_probe"),
  identifier_format: Schema.Literal("evm_address", "solana_public_key"),
  identifier_structural_digest: Sha256Hex,
  capability_snapshot_version: CapabilityRegistryVersion,
  /** Sorted network keys actually searched while healthy. */
  searched_coverage: Schema.Array(NonEmptyString.pipe(Schema.maxLength(128))).pipe(
    Schema.maxItems(8),
  ),
  /** Never claims nonexistence beyond this coverage set. */
  claims_beyond_coverage: Schema.Literal(false),
}).annotations({ identifier: "NegativeCacheBinding" });
export interface NegativeCacheBinding extends Schema.Schema.Type<typeof NegativeCacheBinding> {}

export const ProbeAdapterOutcomeKind = Schema.Literal(
  "hit",
  "miss",
  "timeout",
  "unavailable",
  "cancelled",
  "circuit_open",
).annotations({ identifier: "ProbeAdapterOutcomeKind" });
export type ProbeAdapterOutcomeKind = Schema.Schema.Type<typeof ProbeAdapterOutcomeKind>;

export const SafeDiagnosticEntry = Schema.Struct({
  code: NonEmptyString.pipe(Schema.maxLength(64)),
  network: Schema.optional(NetworkRef),
  safe_message: NonEmptyString.pipe(Schema.maxLength(256)),
}).annotations({ identifier: "SafeDiagnosticEntry" });
export type SafeDiagnosticEntry = Schema.Schema.Type<typeof SafeDiagnosticEntry>;

export const BoundedResolveDiagnostics = Schema.Struct({
  schema_version: SchemaVersion,
  searched: Schema.Array(NetworkRef).pipe(Schema.maxItems(8)),
  timed_out: Schema.Array(NetworkRef).pipe(Schema.maxItems(8)),
  unavailable: Schema.Array(NetworkRef).pipe(Schema.maxItems(8)),
  cancelled: Schema.Array(NetworkRef).pipe(Schema.maxItems(8)),
  circuit_open: Schema.Array(NetworkRef).pipe(Schema.maxItems(8)),
  partial: Schema.Boolean,
  global_deadline_exceeded: Schema.Boolean,
  inventory: Schema.optional(
    Schema.Struct({
      attempted: Schema.Boolean,
      outcome: Schema.Literal("enriched", "miss", "timeout", "error", "skipped"),
      safe_message: Schema.optional(NonEmptyString.pipe(Schema.maxLength(256))),
    }),
  ),
  entries: Schema.Array(SafeDiagnosticEntry).pipe(Schema.maxItems(32)),
  cache: Schema.Struct({
    positive_hit: Schema.Boolean,
    readiness_hit: Schema.Boolean,
    negative_hit: Schema.Boolean,
    coalesced: Schema.Boolean,
  }),
}).annotations({ identifier: "BoundedResolveDiagnostics" });
export interface BoundedResolveDiagnostics
  extends Schema.Schema.Type<typeof BoundedResolveDiagnostics> {}

export const CallerIdentity = Schema.Struct({
  /**
   * Bounded opaque caller bucket for rate limiting.
   * MUST NOT be a raw user id / email / wallet in high-cardinality labels.
   */
  bucket_id: NonEmptyString.pipe(
    Schema.maxLength(128),
    Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  ),
  authorization_scope: AuthorizationScope,
}).annotations({ identifier: "CallerIdentity" });
export type CallerIdentity = Schema.Schema.Type<typeof CallerIdentity>;

export const BoundedResolveRequest = Schema.Struct({
  schema_version: SchemaVersion,
  identifier: NonEmptyString.pipe(Schema.maxLength(128)),
  environment: Schema.Literal("mainnet"),
  caller: CallerIdentity,
}).annotations({ identifier: "BoundedResolveRequest" });
export interface BoundedResolveRequest extends Schema.Schema.Type<typeof BoundedResolveRequest> {}

export { COLLECTION_PROTOCOL_SCHEMA_VERSION, IsoTimestamp };
