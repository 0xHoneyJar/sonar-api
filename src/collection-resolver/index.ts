export {
  classifyCollectionIdentifier,
  InvalidCollectionIdentifierError,
  selectRecognizeCapabilities,
  type CapabilitySnapshot,
  type RecognizeCapability,
} from "./identifier.js";
export {
  assertSolanaKeyCaseRetained,
  normalizeDasCollectionProbe,
  projectDasObservationToLog,
  DasCaseRetentionError,
  type DasCollectionProbeObservation,
  type DasNormalizedSurfaces,
} from "./das-normalize.js";
export {
  CandidateBuildError,
  ProbeAddressMismatchError,
  assertProbeAddressMatchesRequested,
  buildCandidateFromHit,
} from "./candidate.js";
export {
  collectionProtocolFixturesRoot,
  EXPECTED_COLLECTION_PROTOCOL_TARBALL_SHA256,
  verifyVendoredCollectionProtocolDigest,
  VendoredProtocolDigestError,
  decodeCollectionCandidate,
  decodeCollectionDeploymentRef,
  makeCollectionDeploymentRef,
  normalizeSolanaAddress,
  type CollectionCandidate,
  type NetworkRef,
} from "./protocol.js";
export {
  NoCompatibleCapabilityError,
  resolveProbe,
  type ResolveProbeRequest,
  type ResolveProbeResponse,
} from "./resolve.js";

/** CR-101: versioned resolver capability registry + Ordering projection. */
export * from "./capability-registry/index.js";

/** CR-102: bounded resolver orchestration core + ports/reference impls. */
export * from "./bounded-core/index.js";

/** CR-004: resolver workers fetch remote metadata only through this port. */
export {
  createResolverMetadataPort,
  type ResolverMetadataPort,
} from "../metadata-egress/resolver-port.js";
