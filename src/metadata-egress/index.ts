export type {
  AddressFamily,
  EgressRequestHeaders,
  MetadataFailureReason,
  MetadataOk,
  MetadataPartial,
  MetadataRetrievalProvenance,
  MetadataRetrievalPurpose,
  MetadataRetrievalRequest,
  MetadataRetrievalResult,
  TransportRequest,
  TransportResponse,
  ValidatedTarget,
} from "./types.js";

export type {
  AddressDenialReason,
  AddressClassification,
  TerminalAddressClass,
} from "./address-policy.js";

export {
  DEFAULT_METADATA_EGRESS_LIMITS,
  DEFAULT_ALLOWED_PORTS,
  EGRESS_USER_AGENT,
  type MetadataEgressLimits,
} from "./limits.js";

export {
  classifyIpAddress,
  classifyIpv4,
  classifyIpv6,
  expandIpv6,
  formatHostAuthority,
  isCloudMetadataHostname,
  parseCanonicalIpv4,
  terminalAddressClassOf,
  CLOUD_METADATA_HOSTNAMES,
} from "./address-policy.js";

export { parseMetadataUrl, isUrlPolicyError } from "./url-policy.js";

export {
  FORBIDDEN_REQUEST_HEADER_NAMES,
  buildEgressRequestHeaders,
  sanitizeCallerHeaders,
} from "./headers.js";

export {
  detectImageKind,
  evaluateContentType,
  evaluateRetrievedContent,
  normalizeContentType,
  sniffEmbeddedHostileInImageBody,
  sniffHostilePayload,
  validateImagePayload,
} from "./content-policy.js";

export {
  peekImageMagic,
  TRUSTED_IMAGE_KINDS,
  validateImageStructure,
  validatePngStructure,
  type ImageKind,
  type ImageStructureFailure,
  type ImageStructureResult,
} from "./image-structure.js";

export {
  assertNoInjectedSecrets,
  buildRequestedProvenance,
  isPublicSafePathSegment,
  isSafeTerminalFilename,
  isStructuralPathSegment,
  redactUri,
  sha256Hex,
} from "./provenance.js";

export type {
  DnsAnswer,
  DnsPort,
  MetadataEgressClock,
  MetadataEgressDeadlineScheduler,
  MetadataEgressPorts,
  PinnedTransportPort,
} from "./ports.js";

export { retrieveMetadata, type RetrieveMetadataDeps } from "./retrieve.js";

export {
  classifyUntrustedImageRef,
  enrichCandidateFromRemoteMetadata,
  type CandidateMetadataQuality,
  type RemoteMetadataEnrichment,
  type UntrustedImageRef,
} from "./enrich.js";

export {
  createMetadataEgressClient,
  createProductionMetadataEgressPorts,
  type MetadataEgressClient,
} from "./client.js";

export {
  createResolverMetadataPort,
  type ResolverMetadataPort,
} from "./resolver-port.js";

export {
  createReportMetadataWorkerPort,
  type ReportMetadataWorkerPort,
} from "./report-worker-port.js";

export {
  assertServerOnlyMetadataEgress,
  METADATA_EGRESS_RUNTIME,
} from "./browser-boundary.js";

export { createNodeDnsPort, createNodePinnedTransport } from "./node-ports.js";
