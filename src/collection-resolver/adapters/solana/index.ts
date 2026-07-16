/**
 * CR-104 Solana DAS recognition adapter.
 *
 * Live NetworkAdapterPort wrapping the existing SVM DAS recognition path.
 * See PROTOCOL.md.
 */
export {
  createSolanaDasNetworkAdapter,
  type SolanaDasAdapterOptions,
} from "./adapter.js";
export {
  classifyHttpStatus,
  createFetchDasSamplePort,
  createScriptedDasSamplePort,
  type DasCollectionAssetObservation,
  type DasCollectionAssetOutcome,
  type DasSampleOutcome,
  type DasSamplePort,
  type DasSampleRequest,
  type DasTransportFailure,
  type FetchDasSamplePortConfig,
  type ScriptedDasSamplePortOptions,
} from "./das-port.js";
export {
  findCollectionByMintExact,
  listRegisteredCollectionMints,
} from "./registry-lookup.js";
export {
  deriveIndexAndReadiness,
  projectSolanaDasHit,
  SOLANA_DAS_ADAPTER_POLICY_VERSION,
  SOLANA_DAS_ADAPTER_VERSION,
  type CollectionReadinessObservation,
  type ProjectSolanaDasHitInput,
} from "./project-hit.js";
export {
  buildDasGetAssetRequestBody,
  buildDasSampleRequestBody,
  classifyDasSampleItems,
  DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT,
  filterVerifiedDasSampleMembers,
  parseDasGetAssetRpcResponse,
  parseDasSampleRpcResponse,
  type DasCoverageKind,
  type DasSampleClassification,
  type DasSampleParseResult,
  type ParsedDasSamplePage,
} from "./sample-classifier.js";
export {
  FIXTURE_CLASSIC_ITEMS,
  FIXTURE_COMPRESSED_ITEMS,
  FIXTURE_MIXED_ITEMS,
  FIXTURE_PROGRAMMABLE_ITEMS,
  FIXTURE_UNKNOWN_ITEMS,
  FIXTURE_UNVERIFIED_ITEMS,
  REGISTERED_COLLECTION_MINT,
  WRONG_CASE_PYTHIANS_MINT,
  sampleOutcome,
} from "./fixtures.js";
