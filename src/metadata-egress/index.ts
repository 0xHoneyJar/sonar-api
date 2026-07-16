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

export {
  createHermeticPorts,
  createScriptedDnsPort,
  createScriptedTransportPort,
  gzipBomb,
  FIXTURE_PNG,
  FIXTURE_JPEG,
  FIXTURE_JPEG_DENIED,
  FIXTURE_GIF,
  FIXTURE_GIF_DENIED,
  FIXTURE_WEBP,
  FIXTURE_WEBP_FRAMING_ONLY,
  FIXTURE_AVIF,
  FIXTURE_AVIF_FRAMING_ONLY,
  PUBLIC_V4,
  PUBLIC_V4_B,
  PUBLIC_V6,
  PUBLIC_V6_LITERAL,
  PRIVATE_V4,
  LOOPBACK_V4,
  LINK_LOCAL_V4,
  CGNAT_V4,
  MAPPED_LOOPBACK,
  RELAY_ANYCAST_V4,
  RELAY_ANYCAST_V4_6A44,
  type ScriptedDns,
  type ScriptedHop,
  type ScriptedTransport,
} from "./hermetic-fixtures.js";

export { createNodeDnsPort, createNodePinnedTransport } from "./node-ports.js";
