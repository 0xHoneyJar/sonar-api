/**
 * CR-101 — Versioned resolver capability registry.
 *
 * Strict, deterministic mainnet capability catalog with Ordering projection.
 * Does not accept user-provided RPC URLs, endpoints, chain definitions, or
 * arbitrary adapter config at the registry boundary.
 *
 * See PROTOCOL.md for contiguous sequence, source sequencing, baseline binding,
 * compatible health tuples, default vs diagnostic search, and audit fields.
 */
export {
  CapabilityRegistryDecodeError,
  CapabilityRegistryValidationError,
  CapabilityRegistryTransitionError,
  CapabilityRegistrySignatureError,
  CapabilityRegistryMutationError,
  type CapabilityRegistryError,
} from "./errors.js";

export {
  CAPABILITY_REGISTRY_SCHEMA_VERSION,
  CAPABILITY_REGISTRY_DIGEST_DOMAIN,
  CAPABILITY_REGISTRY_ORDERING_DIGEST_DOMAIN,
  CAPABILITY_REGISTRY_BASELINE_BINDING_DIGEST_DOMAIN,
  CAPABILITY_REGISTRY_TRANSITION_DIGEST_DOMAIN,
  INITIAL_SOURCE_SEQUENCE,
  DecimalUint64,
  NetworkEnvironment,
  ProbeAdapterId,
  ConcurrencyClass,
  OperationKind,
  OperationHealthState,
  CapabilityReasonClass,
  DrainPolicy,
  PriorEvidenceRevocationPolicy,
  NewWorkEffect,
  QueuedInFlightEffect,
  ExistingEvidenceEffect,
  NormativeEffects,
  OperationDeadline,
  ActorIdentity,
  ActorPublicId,
  OperationCapability,
  SourceHeadQuorum,
  DegradationRule,
  EvmBlockDepthConfirmation,
  EvmFinalizedTagConfirmation,
  EvmConfirmationPolicy,
  EvmFreshnessRule,
  SolanaFreshnessRule,
  EvmFinalityPolicy,
  SolanaFinalityPolicy,
  FinalityPolicy,
  DisplayIdentity,
  ProbeAdapterBinding,
  SourceProvenance,
  NetworkOperations,
  NetworkCapability,
  CapabilityRegistrySnapshotInput,
  CapabilityRegistryBaselineMaterial,
  CapabilityRegistryTransitionAudit,
  CapabilityRegistrySequenceAdvanceTransition,
  CapabilityRegistryEpochResetTransition,
  CapabilityRegistryTransition,
  BaselineSignatureEnvelope,
  OrderingCapabilityView,
  OrderingCapabilityProjection,
} from "./schemas.js";

export {
  networkIdentityKey,
  adapterOperationKey,
  UINT64_MAX,
  UINT64_ZERO,
  isOperationEnabledAndActive,
  isOperationEnabledAndHealthy,
  operationKinds,
  getOperation,
} from "./keys.js";

export { deepFreeze, cloneFreeze, assertFrozen } from "./immutable.js";

export { validateNetworkSet } from "./validation.js";

export {
  assertContiguousRegistrySequence,
  nextUint64Decimal,
  operationMaterialChanged,
  validateCrossSnapshotSourceSequences,
  validateEpochResetSourceSequences,
} from "./sequencing.js";

export {
  decodeCapabilityRegistrySnapshot,
  getSnapshotIdentity,
  lookupNetwork,
  type CapabilityRegistrySnapshot,
} from "./snapshot.js";

export { projectOrderingCapabilityViews } from "./projection.js";

export {
  selectDefaultRecognizeNetworks,
  selectDiagnosticRecognizeNetworks,
  toRecognizeCapabilitySnapshot,
  type DefaultSearchHit,
  type RecognizeSearchIdentifier,
} from "./search.js";

/**
 * Hermetic / test fixtures for CR-101 networks. Runtime Kitchen resolve-probe
 * also consumes `defaultLiveRecognizeNetworkCapabilities` from fixtures.ts
 * directly; re-export here so collection-resolver barrel hermetic suites can
 * import capability builders without a private path.
 */
export {
  defaultMainnetRegistryInput,
  defaultMainnetNetworkCapabilities,
  defaultLiveRecognizeNetworkCapabilities,
  hermeticResolverRegistryInput,
  hermeticResolverNetworkCapabilities,
  ethereumMainnetCapability,
  baseMainnetCapability,
  optimismMainnetCapability,
  arbitrumMainnetCapability,
  berachainMainnetCapability,
  zoraMainnetCapability,
  solanaMainnetCapability,
  robinhoodDisabledCapability,
  robinhoodMainnetCapability,
  robinhoodRecognizeOnlyCapability,
  ROBINHOOD_MAINNET_CHAIN_ID,
  ROBINHOOD_CHAIN_EVIDENCE_REFERENCE,
  DEFAULT_REGISTRY_EPOCH,
  DEFAULT_REGISTRY_SEQUENCE,
  FIXTURE_EFFECTIVE_AT,
} from "./fixtures.js";

export {
  applyCapabilityRegistryTransition,
  buildBaselineMaterial,
  compareSnapshotIdentities,
  isOperationReasonBoundToTransition,
  makeEpochResetBaseline,
  withInitialSourceSequences,
  type CapabilityRegistryTransitionResult,
} from "./transitions.js";

export {
  rejectAllBaselineSignatures,
  type CapabilityRegistrySignatureVerifier,
} from "./signature-port.js";
