/**
 * CR-102 — Bounded resolver core.
 *
 * Pure, deterministic orchestration over a strict CR-101 capability snapshot.
 * Live EVM/Solana adapters and production metrics remain CR-103 / CR-104 / CR-107.
 *
 * See PROTOCOL.md for budgets, cache binding, invalidation, and port contracts.
 * See ../OPERATIONS.md for CR-107 degraded / full-stop runbooks.
 */
export {
  BoundedResolverDecodeError,
  BoundedResolverConfigError,
  StructuralPreflightError,
  NoHealthyCapabilityError,
  ResolverRateLimitedError,
  CircuitOpenError,
  BoundedResolverInternalError,
  InvalidationEdgeStoreError,
  type BoundedResolverError,
} from "./errors.js";

export { ResolverAdmissionFullStopError } from "./operations/admission-control.js";

export {
  BOUNDED_RESOLVER_SCHEMA_VERSION,
  BOUNDED_RESOLVER_ADAPTER_POLICY_VERSION,
  DEFAULT_BOUNDED_RESOLVER_CONFIG,
  BoundedResolverConfig,
  CacheNamespace,
  CacheInvalidationCause,
  EquivalenceRevocationImpact,
  AuthorizationScope,
  PositiveCacheBinding,
  ReadinessCacheBinding,
  NegativeCacheBinding,
  BoundedResolveDiagnostics,
  BoundedResolveRequest,
  CallerIdentity,
  ObservedPosition,
  StandardEvidence,
  ProxyEvidence,
} from "./schemas.js";

export {
  decodeBoundedResolverConfig,
  defaultBoundedResolverConfig,
} from "./config.js";

export {
  createVirtualClock,
  createProcessMonotonicClock,
  asDeadlineTimer,
  type MonotonicClock,
  type VirtualClock,
  type DeadlineTimerPort,
} from "./clock.js";

export { structuralPreflight } from "./preflight.js";

export {
  createMemoryCircuitBreaker,
} from "./circuit-breaker.js";

export { createMemoryRateLimiter } from "./rate-limit.js";

export { createMemoryCoalesce } from "./coalesce.js";

export { createMemoryMetrics, percentile } from "./metrics.js";

export {
  createMemoryRecognitionObserver,
  assertOperationalEventAllowlist,
  assertNoIdentityLeakInEvent,
  networkKeysFromCapabilitySnapshot,
  allowedNetworkKeysFromSnapshot,
  liveAllowedNetworkKeys,
  createMemoryAdmissionControl,
  alwaysOpenAdmissionControl,
  staticCapabilitySnapshotProvider,
  createMemoryCapabilitySnapshotStore,
  resolveRequestCapabilitySnapshot,
  CapabilitySnapshotStoreError,
  bucketCandidateCount,
  classifyTerminalOutcome,
  OPERATIONAL_EVENT_LABEL_ALLOWLIST,
  OPERATIONAL_EVENT_VALUE_ALLOWLIST,
  IdentifierFormatDimension,
  NetworkOutcomeDimension,
  TerminalOutcomeDimension,
  CandidateCountBucket,
  CacheOutcomeDimension,
  CircuitStateDimension,
  RecognitionOperationalEvent,
  type MemoryRecognitionObserver,
  type MemoryAdmissionControl,
  type CapabilitySnapshotRuntimeStore,
  type CapabilitySnapshotApplyError,
  type ObserverRecordResult,
  type ObserverDropReason,
  type AllowedNetworkKeySource,
} from "./operations/index.js";

export {
  createMemoryResolverCache,
} from "./caching/store.js";

export {
  createMemoryInvalidationEdgePort,
  applyInvalidation,
  invalidateNegativeOnCoverageGrowth,
} from "./caching/invalidation.js";

export {
  digestPositiveBinding,
  digestReadinessBinding,
  digestNegativeBinding,
  structuralIdentifierDigest,
  sha256Canonical,
} from "./caching/keys.js";

export {
  aggregateAndRank,
  dedupByDeploymentIdentity,
  rankCandidatesDeterministic,
  applyInventoryEnrichment,
  evidenceQuality,
} from "./aggregate.js";

export {
  createDeadlineController,
  linkAbort,
  isPastDeadline,
  armDeadlineRace,
  classifyDeadlineBreach,
  raceSettlementAgainstDeadlines,
  raceSharedAgainstDeadline,
} from "./deadlines.js";

export {
  redactSafeMessage,
  safeErrorLabel,
  assertNoSecretLeak,
  assertSafeDiagnosticPayload,
} from "./redaction.js";

export {
  resolveBounded,
  type BoundedResolveResponse,
  type BoundedResolveFailure,
} from "./resolve-bounded.js";

export {
  createHermeticBoundedDeps,
  loadHermeticCapabilitySnapshot,
  hermeticResolveRequest,
  MULTI_CHAIN_EVM_ADDRESS,
  PYTHIANS_COLLECTION_MINT,
  SCRIPT_EVM_ERC721,
  SCRIPT_HIT_WITHOUT_BINDING,
  SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
  SCRIPT_PARTIAL_TIMEOUT,
  SCRIPT_SOLANA_COLLECTION,
  SCRIPT_ZERO_CANDIDATES,
} from "./fixtures.js";

export { createScriptedNetworkAdapter } from "./reference/scripted-adapter.js";
export { createScriptedInventoryPort } from "./reference/scripted-inventory.js";

export {
  runDeterministicLoadHarness,
  runColdRateLimitDenialHarness,
  LOAD_HARNESS_EXPECTED_HEALTHY_TARGETS,
  LOAD_HARNESS_SUCCESS_RATIO_FLOOR,
  type LoadHarnessReport,
} from "./load-harness.js";

export type {
  NetworkAdapterPort,
  InventoryEnrichmentPort,
  ResolverCachePort,
  InvalidationEdgePort,
  CircuitBreakerPort,
  RateLimiterPort,
  CoalescePort,
  CoalesceSealedResult,
  MetricsPort,
  BoundedResolverDeps,
  BoundedResolverMetrics,
  PositiveCacheEntry,
  ReadinessCacheEntry,
  NegativeCacheEntry,
  InventoryEnrichmentHit,
  InventoryEnrichmentResult,
  AdapterProbeRequest,
  CapabilitySnapshotProviderPort,
  AdmissionControlPort,
  AdmissionState,
  RecognitionObserverPort,
} from "./ports.js";

export type { CircuitBreakerOptions } from "./circuit-breaker.js";
