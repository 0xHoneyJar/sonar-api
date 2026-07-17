/**
 * CR-102 ports — adapters, Inventory enrichment, cache, rate limit, circuit breaker.
 *
 * Live EVM/Solana adapters are CR-103/CR-104. This core proves orchestration
 * against injectable reference implementations only.
 */
import type { Effect } from "effect";
import type { CollectionCandidate, NetworkRef } from "../protocol.js";
import type { CapabilityRegistrySnapshot } from "../capability-registry/snapshot.js";
import type { NetworkCapability } from "../capability-registry/schemas.js";
import type { DeadlineTimerPort, MonotonicClock } from "./clock.js";
import type {
  AuthorizationScope,
  BoundedResolveDiagnostics,
  CacheInvalidationCause,
  EquivalenceRevocationImpact,
  NegativeCacheBinding,
  ObservedPosition,
  PositiveCacheBinding,
  ProxyEvidence,
  ReadinessCacheBinding,
  StandardEvidence,
} from "./schemas.js";
import type { BoundedResolverDecodeError, InvalidationEdgeStoreError } from "./errors.js";
import type { ProbeHitEvidence, ProbeOutcome } from "../candidate.js";

export interface AdapterAbortHandle {
  readonly signal: AbortSignal;
  readonly aborted: boolean;
}

export interface AdapterProbeRequest {
  readonly network: NetworkRef;
  readonly network_capability: NetworkCapability;
  readonly address: string;
  readonly abort: AdapterAbortHandle;
  /** Resolver clock sharing the absolute coordinate of deadline_at_ms. */
  readonly clock: Pick<MonotonicClock, "nowMs">;
  /** Per-network deadline in monotonic ms (absolute). */
  readonly deadline_at_ms: number;
}

/**
 * Network probe adapter port (CR-103/CR-104 implement this).
 * MUST honor abort.signal — late work after abort must not mutate shared state.
 */
export interface NetworkAdapterPort {
  readonly probe: (
    request: AdapterProbeRequest,
  ) => Effect.Effect<ProbeOutcome, never>;
}

export interface InventoryEnrichmentRequest {
  readonly deployment_ids: ReadonlyArray<string>;
  readonly candidates: ReadonlyArray<CollectionCandidate>;
  readonly abort: AdapterAbortHandle;
  readonly deadline_at_ms: number;
}

export interface InventoryEnrichmentHit {
  readonly kind: "enriched";
  readonly deployment_id: string;
  readonly curated_name?: string;
  readonly curated_image_host?: string;
  readonly collection_key?: string;
  readonly equivalence_basis_kind: "single_deployment" | "explicit_inventory_equivalence";
  readonly enrichment_version: string;
  readonly equivalence_version?: string;
  readonly ranking_reason: "exact_inventory_match";
}

export interface InventoryEnrichmentMiss {
  readonly kind: "miss";
}

export interface InventoryEnrichmentFailure {
  readonly kind: "error" | "timeout";
  readonly safe_message: string;
}

export type InventoryEnrichmentResult =
  | InventoryEnrichmentHit
  | InventoryEnrichmentMiss
  | InventoryEnrichmentFailure;

/**
 * Optional bounded Inventory enrichment (CR-105 contract).
 * Failure yields typed partial diagnostics — never corrupts adapter evidence.
 */
export interface InventoryEnrichmentPort {
  readonly enrich: (
    request: InventoryEnrichmentRequest,
  ) => Effect.Effect<ReadonlyArray<InventoryEnrichmentResult>, never>;
}

export interface PositiveCacheEntry {
  readonly binding: PositiveCacheBinding;
  readonly candidate: CollectionCandidate;
  readonly stored_at_ms: number;
  readonly expires_at_ms: number;
}

export interface ReadinessCacheEntry {
  readonly binding: ReadinessCacheBinding;
  readonly stored_at_ms: number;
  readonly expires_at_ms: number;
}

export interface NegativeCacheEntry {
  readonly binding: NegativeCacheBinding;
  readonly stored_at_ms: number;
  readonly expires_at_ms: number;
}

export interface ResolverCachePort {
  readonly findPositive: (input: {
    readonly normalized_address: string;
    readonly identifier_format: PositiveCacheBinding["identifier_format"];
    readonly identifier_structural_digest: PositiveCacheBinding["identifier_structural_digest"];
    readonly capability_snapshot_version: PositiveCacheBinding["capability_snapshot_version"];
    readonly authorization_scope: PositiveCacheBinding["authorization_scope"];
    readonly adapter_policy_version: PositiveCacheBinding["adapter_policy_version"];
    readonly allowed_network_keys: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<PositiveCacheEntry>, never>;
  readonly getPositive: (
    keyDigest: string,
  ) => Effect.Effect<PositiveCacheEntry | undefined, never>;
  readonly setPositive: (
    keyDigest: string,
    entry: PositiveCacheEntry,
  ) => Effect.Effect<void, never>;
  readonly getReadiness: (
    keyDigest: string,
  ) => Effect.Effect<ReadinessCacheEntry | undefined, never>;
  readonly setReadiness: (
    keyDigest: string,
    entry: ReadinessCacheEntry,
  ) => Effect.Effect<void, never>;
  readonly getNegative: (
    keyDigest: string,
  ) => Effect.Effect<NegativeCacheEntry | undefined, never>;
  readonly setNegative: (
    keyDigest: string,
    entry: NegativeCacheEntry,
  ) => Effect.Effect<void, never>;
  readonly invalidate: (input: {
    readonly cause: CacheInvalidationCause;
    readonly namespace?: "positive_recognition" | "report_readiness" | "negative_probe";
    readonly keyDigest?: string;
    readonly deployment_id?: string;
    readonly predicate?: (entry: {
      readonly namespace: string;
      readonly binding: unknown;
    }) => boolean;
  }) => Effect.Effect<{ readonly evicted: number }, never>;
}

export interface InvalidationEdgePort {
  /**
   * Persist/acknowledge the canonical equivalence-revocation impact for CR-012A.
   * Must fail closed on decode/store errors — callers evict only after ack.
   * Eviction alone must not be treated as remediation by consumers.
   */
  readonly emitEquivalenceRevocation: (
    impact: EquivalenceRevocationImpact | unknown,
  ) => Effect.Effect<
    { readonly acknowledged: true },
    BoundedResolverDecodeError | InvalidationEdgeStoreError
  >;
  readonly listEmitted: () => ReadonlyArray<EquivalenceRevocationImpact>;
}

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerPort {
  readonly beforeCall: (input: {
    readonly network_key: string;
    readonly operation: "recognize";
    readonly now_ms: number;
  }) => Effect.Effect<
    { readonly allow: true; readonly state: CircuitState } | { readonly allow: false; readonly state: CircuitState; readonly retry_after_ms: number },
    never
  >;
  readonly recordSuccess: (input: {
    readonly network_key: string;
    readonly operation: "recognize";
    readonly now_ms: number;
  }) => Effect.Effect<void, never>;
  readonly recordFailure: (input: {
    readonly network_key: string;
    readonly operation: "recognize";
    readonly now_ms: number;
  }) => Effect.Effect<void, never>;
  readonly getState: (input: {
    readonly network_key: string;
    readonly operation: "recognize";
    readonly now_ms: number;
  }) => CircuitState;
}

export interface RateLimitDecision {
  readonly allowed: true;
}

export interface RateLimitDenied {
  readonly allowed: false;
  readonly scope: "caller" | "global";
  readonly retry_after_ms: number;
  readonly limit: number;
  readonly window_ms: number;
}

export interface RateLimiterPort {
  /**
   * Debit caller + global budgets. MUST NOT be called before structural preflight.
   */
  readonly tryAcquire: (input: {
    readonly caller_bucket_id: string;
    readonly now_ms: number;
  }) => Effect.Effect<RateLimitDecision | RateLimitDenied, never>;
}

/**
 * Immutable sealed coalesce payload shared from leader to followers.
 * Errors are typed/safe — never raw causes.
 */
export type CoalesceSealedResult =
  | {
      readonly kind: "response";
      readonly response: unknown;
    }
  | {
      readonly kind: "error";
      readonly safe_code: string;
      readonly safe_message: string;
    };

export interface CoalescePort {
  /**
   * Coalesce identical in-flight demand so it cannot amplify fanout.
   * Leaders own the shared promise; followers await it (bounded by their deadline).
   */
  readonly begin: (coalesceKey: string) => Effect.Effect<
    | { readonly kind: "leader" }
    | {
        readonly kind: "follower";
        readonly wait_for_leader: true;
        readonly shared: Promise<CoalesceSealedResult>;
      }
    | { readonly kind: "negative_cached" },
    never
  >;
  readonly complete: (
    coalesceKey: string,
    result: CoalesceSealedResult,
  ) => Effect.Effect<void, never>;
}

export interface BoundedResolverMetrics {
  adapter_calls: number;
  peak_concurrency: number;
  cache_positive_hit: number;
  cache_positive_miss: number;
  cache_readiness_hit: number;
  cache_readiness_miss: number;
  cache_negative_hit: number;
  cache_negative_miss: number;
  coalesced: number;
  timeouts: number;
  partials: number;
  rate_limited: number;
  latencies_ms: number[];
}

export interface MetricsPort {
  readonly snapshot: () => BoundedResolverMetrics;
  readonly recordLatency: (ms: number) => void;
  readonly incr: (field: keyof Omit<BoundedResolverMetrics, "latencies_ms" | "peak_concurrency">, by?: number) => void;
  readonly observeConcurrency: (current: number) => void;
}

export interface BoundedResolverDeps {
  readonly clock: MonotonicClock;
  /** Injected deadline timer (usually the same virtual/process clock). */
  readonly timer: DeadlineTimerPort;
  readonly adapter: NetworkAdapterPort;
  readonly inventory?: InventoryEnrichmentPort;
  readonly cache: ResolverCachePort;
  readonly invalidationEdges: InvalidationEdgePort;
  readonly circuitBreaker: CircuitBreakerPort;
  readonly rateLimiter: RateLimiterPort;
  readonly coalesce: CoalescePort;
  readonly metrics: MetricsPort;
  readonly capabilitySnapshot: CapabilityRegistrySnapshot;
}

export type {
  ProbeHitEvidence,
  ProbeOutcome,
  AuthorizationScope,
  BoundedResolveDiagnostics,
  ObservedPosition,
  StandardEvidence,
  ProxyEvidence,
};
