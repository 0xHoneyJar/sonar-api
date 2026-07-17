/**
 * CR-107 typed low-cardinality recognition operational events.
 *
 * Events are the sole observability contract for new acceptance. Aggregate
 * MetricsPort counters remain for load-harness compatibility only.
 *
 * NEVER include: raw identifier/address, caller bucket, auth/community/user/
 * order identity, cache/coalesce keys, deployment/collection digests, provider
 * URL/body, or arbitrary exception text.
 */
import { Schema } from "effect";

/**
 * Identifier format dimension. `unclassified` is reserved for terminals that
 * exit before structural preflight classifies the identifier (config / request
 * decode / preflight rejection). Demand events never use `unclassified`.
 */
export const IdentifierFormatDimension = Schema.Literal(
  "evm_address",
  "solana_public_key",
  "unclassified",
).annotations({ identifier: "IdentifierFormatDimension" });
export type IdentifierFormatDimension = Schema.Schema.Type<
  typeof IdentifierFormatDimension
>;

/**
 * Structural shape for a network key string. Runtime emission MUST still pass
 * a registry-derived allowlist — this pattern alone is not authority.
 */
export const NetworkKeyDimension = Schema.String.pipe(
  Schema.minLength(3),
  Schema.maxLength(96),
  Schema.pattern(/^[a-z0-9][a-z0-9_.:-]*$/i),
).annotations({ identifier: "NetworkKeyDimension" });
export type NetworkKeyDimension = Schema.Schema.Type<typeof NetworkKeyDimension>;

export const NetworkOutcomeDimension = Schema.Literal(
  "hit",
  "conclusive_miss",
  "unavailable",
  "timeout",
  "circuit_open",
  "disabled",
).annotations({ identifier: "NetworkOutcomeDimension" });
export type NetworkOutcomeDimension = Schema.Schema.Type<
  typeof NetworkOutcomeDimension
>;

/**
 * Terminal outcome. `rejected` = pre-classification refusal (config / request /
 * structural preflight). `failed` = classified demand that still terminated
 * without a complete/partial/zero/rate/full_stop outcome (e.g. no healthy
 * capability, post-fanout typed/defect failure).
 */
export const TerminalOutcomeDimension = Schema.Literal(
  "complete",
  "partial",
  "zero_result",
  "rate_limited",
  "full_stop",
  "rejected",
  "failed",
).annotations({ identifier: "TerminalOutcomeDimension" });
export type TerminalOutcomeDimension = Schema.Schema.Type<
  typeof TerminalOutcomeDimension
>;

export const CandidateCountBucket = Schema.Literal(
  "0",
  "1",
  "2_to_4",
  "5_to_8",
).annotations({ identifier: "CandidateCountBucket" });
export type CandidateCountBucket = Schema.Schema.Type<typeof CandidateCountBucket>;

/**
 * Cache outcome dimensions. Positive/readiness hit/miss are typed for the
 * matrix but MUST remain honest — current resolve path has no positive/readiness
 * read, so those values are never claimed by the orchestrator today.
 */
export const CacheOutcomeDimension = Schema.Literal(
  "positive_hit",
  "positive_miss",
  "readiness_hit",
  "readiness_miss",
  "negative_hit",
  "negative_miss",
  "none",
).annotations({ identifier: "CacheOutcomeDimension" });
export type CacheOutcomeDimension = Schema.Schema.Type<typeof CacheOutcomeDimension>;

export const CircuitStateDimension = Schema.Literal(
  "closed",
  "open",
  "half_open",
).annotations({ identifier: "CircuitStateDimension" });
export type CircuitStateDimension = Schema.Schema.Type<
  typeof CircuitStateDimension
>;

export const ResolverRoleDimension = Schema.Literal(
  "leader",
  "follower",
  "negative_cache",
  "capability",
  "admission",
  "rate_limited",
  "failed",
).annotations({ identifier: "ResolverRoleDimension" });
export type ResolverRoleDimension = Schema.Schema.Type<typeof ResolverRoleDimension>;

/** Allowlisted label / dimension keys that may appear on operational events. */
export const OPERATIONAL_EVENT_LABEL_ALLOWLIST = [
  "kind",
  "identifier_format",
  "network_key",
  "network_outcome",
  "terminal_outcome",
  "candidate_count_bucket",
  "cache_outcome",
  "circuit_from",
  "circuit_to",
  "ambiguous",
  "role",
  "adapter_attempted",
] as const;

/** Numeric observation fields — not high-cardinality label keys. */
export const OPERATIONAL_EVENT_VALUE_ALLOWLIST = [
  "latency_ms",
  "adapter_attempts",
] as const;

export const ResolverDemandEvent = Schema.Struct({
  kind: Schema.Literal("resolver_demand"),
  identifier_format: IdentifierFormatDimension,
}).annotations({ identifier: "ResolverDemandEvent" });
export type ResolverDemandEvent = Schema.Schema.Type<typeof ResolverDemandEvent>;

export const NetworkOutcomeEvent = Schema.Struct({
  kind: Schema.Literal("network_outcome"),
  identifier_format: IdentifierFormatDimension,
  network_key: NetworkKeyDimension,
  network_outcome: NetworkOutcomeDimension,
  /** True only when an external adapter probe was started for this network. */
  adapter_attempted: Schema.Boolean,
}).annotations({ identifier: "NetworkOutcomeEvent" });
export type NetworkOutcomeEvent = Schema.Schema.Type<typeof NetworkOutcomeEvent>;

export const ResolverTerminalEvent = Schema.Struct({
  kind: Schema.Literal("resolver_terminal"),
  identifier_format: IdentifierFormatDimension,
  terminal_outcome: TerminalOutcomeDimension,
  candidate_count_bucket: CandidateCountBucket,
  cache_outcome: CacheOutcomeDimension,
  ambiguous: Schema.Boolean,
  role: ResolverRoleDimension,
  /** Wall/monotonic latency observation — not a label. */
  latency_ms: Schema.Number.pipe(Schema.nonNegative(), Schema.lessThanOrEqualTo(60_000)),
  /** Bounded work units (adapter starts). Followers must report 0. */
  adapter_attempts: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
    Schema.lessThanOrEqualTo(8),
  ),
}).annotations({ identifier: "ResolverTerminalEvent" });
export type ResolverTerminalEvent = Schema.Schema.Type<typeof ResolverTerminalEvent>;

export const CircuitTransitionEvent = Schema.Struct({
  kind: Schema.Literal("circuit_transition"),
  network_key: NetworkKeyDimension,
  circuit_from: CircuitStateDimension,
  circuit_to: CircuitStateDimension,
}).annotations({ identifier: "CircuitTransitionEvent" });
export type CircuitTransitionEvent = Schema.Schema.Type<
  typeof CircuitTransitionEvent
>;

export const RecognitionOperationalEvent = Schema.Union(
  ResolverDemandEvent,
  NetworkOutcomeEvent,
  ResolverTerminalEvent,
  CircuitTransitionEvent,
).annotations({ identifier: "RecognitionOperationalEvent" });
export type RecognitionOperationalEvent = Schema.Schema.Type<
  typeof RecognitionOperationalEvent
>;

export const bucketCandidateCount = (count: number): CandidateCountBucket => {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 4) return "2_to_4";
  return "5_to_8";
};

export const classifyTerminalOutcome = (input: {
  readonly candidate_count: number;
  readonly partial: boolean;
}): Exclude<
  TerminalOutcomeDimension,
  "rate_limited" | "full_stop" | "rejected" | "failed"
> => {
  if (input.partial) return "partial";
  if (input.candidate_count === 0) return "zero_result";
  return "complete";
};
