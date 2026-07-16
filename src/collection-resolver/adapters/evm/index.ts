/**
 * CR-103 — EVM NFT probe adapter.
 *
 * Production-shaped NetworkAdapterPort implementation. Hermetic under test via
 * injected EvmRpcPort / index-status / metadata ports. Never accepts user RPC
 * URLs or chain definitions.
 *
 * See PROTOCOL.md.
 */
export {
  createEvmNftProbeAdapter,
  type EvmNftProbeAdapterDeps,
} from "./adapter.js";

export {
  EVM_NFT_PROBE_ADAPTER_ID,
  EVM_NFT_PROBE_ADAPTER_VERSION,
  EVM_NFT_PROBE_ADAPTER_POLICY_VERSION,
  INTERFACE_ID_ERC721,
  INTERFACE_ID_ERC1155,
  SAFE_MESSAGES,
  type EvmRpcSafeErrorCode,
} from "./constants.js";

export {
  DEFAULT_METADATA_BUDGET_FRACTION,
  DEFAULT_METADATA_BUDGET_MAX_MS,
  DEFAULT_POST_METADATA_RESERVE_MS,
  POST_METADATA_RESERVE_SAFETY_FLOOR_MS,
  metadataSubDeadlineAtMs,
  resolveMetadataBudgetConfig,
  type EvmMetadataBudgetConfig,
  type ResolvedMetadataBudget,
} from "./metadata-budget.js";

export type {
  EvmRpcPort,
  EvmRpcFailure,
  EvmObservationBlock,
  EthCallResult,
  ChainQualifiedIndexStatusPort,
  EvmMetadataEnrichPort,
} from "./ports.js";
export { evmRpcFailure } from "./ports.js";

export {
  createKitchenIndexStatusPort,
  createScriptedIndexStatusPort,
  applyIndexSupportBound,
} from "./index-status.js";

export {
  createFixtureEvmRpcPort,
  scriptErc721,
  scriptErc1155,
  scriptBothInterfaces,
  scriptUnknownInterface,
  scriptEip1967Proxy,
  scriptIncompleteEip1967Proxy,
  scriptHealthyRevert,
  scriptEoa,
  scriptTransportFailure,
  scriptQuorumFailure,
  scriptWithContractUri,
  multiNetworkScripts,
  FIXTURE_ADDRESS,
  FIXTURE_ADDRESS_NORMALIZED,
  FIXTURE_BLOCK,
  FIXTURE_BYTECODE,
  FIXTURE_IMPL_ADDRESS,
  secretLeakSentinel,
} from "./fixtures.js";

export { mapRpcFailure, canonicalUnavailable } from "./diagnostics.js";

export { normalizeAddressOnce } from "./normalize.js";
export { projectProbeHit } from "./evidence.js";
