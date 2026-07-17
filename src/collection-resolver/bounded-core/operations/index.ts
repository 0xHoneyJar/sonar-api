/**
 * CR-107 recognition observability + operator control surfaces.
 */
export {
  IdentifierFormatDimension,
  NetworkKeyDimension,
  NetworkOutcomeDimension,
  TerminalOutcomeDimension,
  CandidateCountBucket,
  CacheOutcomeDimension,
  CircuitStateDimension,
  ResolverRoleDimension,
  OPERATIONAL_EVENT_LABEL_ALLOWLIST,
  OPERATIONAL_EVENT_VALUE_ALLOWLIST,
  ResolverDemandEvent,
  NetworkOutcomeEvent,
  ResolverTerminalEvent,
  CircuitTransitionEvent,
  RecognitionOperationalEvent,
  bucketCandidateCount,
  classifyTerminalOutcome,
} from "./events.js";

export {
  createMemoryRecognitionObserver,
  assertOperationalEventAllowlist,
  assertNoIdentityLeakInEvent,
  networkKeysFromCapabilitySnapshot,
  allowedNetworkKeysFromSnapshot,
  liveAllowedNetworkKeys,
  type RecognitionObserverPort,
  type MemoryRecognitionObserver,
  type ObserverRecordResult,
  type ObserverDropReason,
  type AllowedNetworkKeySource,
} from "./observer.js";

export {
  createResolverTerminalFinalizer,
  unclassifiedRejectedTerminal,
  failedTerminal,
  type ResolverTerminalFinalizer,
  type ResolverTerminalFinalizeInput,
} from "./terminal-finalizer.js";

export {
  staticCapabilitySnapshotProvider,
  createMemoryCapabilitySnapshotStore,
  resolveRequestCapabilitySnapshot,
  CapabilitySnapshotStoreError,
  type CapabilitySnapshotProviderPort,
  type CapabilitySnapshotRuntimeStore,
  type CapabilitySnapshotApplyError,
} from "./capability-snapshot-store.js";

export {
  createMemoryAdmissionControl,
  alwaysOpenAdmissionControl,
  ResolverAdmissionFullStopError,
  type AdmissionState,
  type AdmissionControlPort,
  type MemoryAdmissionControl,
} from "./admission-control.js";
