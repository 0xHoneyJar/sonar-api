/**
 * CR-101 mainnet capability fixtures.
 *
 * Only networks with current Sonar adapter/indexer evidence are marked live.
 * Robinhood Chain (EIP-155 4663) ships disabled in the default catalog; CR-401
 * proven fixtures (`robinhoodMainnetCapability`) exercise enable/disable paths.
 * Testnets are omitted from the default catalog.
 */
import {
  COLLECTION_PROTOCOL_SCHEMA_VERSION,
  type NetworkRef,
} from "../protocol.js";
import type {
  NetworkCapability,
  NormativeEffects,
  OperationCapability,
} from "./schemas.js";
import { CAPABILITY_REGISTRY_SCHEMA_VERSION } from "./schemas.js";

const FIXTURE_EFFECTIVE_AT = "2026-07-16T00:00:00Z";

const eip155 = (chainId: string): NetworkRef => ({
  schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
  network_namespace: "eip155",
  network_reference: chainId,
});

const solanaMainnet: NetworkRef = {
  schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
  network_namespace: "solana",
  network_reference: "mainnet-beta",
};

const effectsAvailable: NormativeEffects = {
  new_work: "admit",
  queued_in_flight: "continue",
  existing_evidence: "reuse_if_fresh",
};

const effectsDegradedRecognize: NormativeEffects = {
  new_work: "partial_diagnostics",
  queued_in_flight: "follow_drain",
  existing_evidence: "reuse_if_availability_degradation",
};

const effectsDegradedNonRecognize: NormativeEffects = {
  new_work: "reject",
  queued_in_flight: "follow_drain",
  existing_evidence: "reuse_if_availability_degradation",
};

const effectsDisabledRecognize: NormativeEffects = {
  new_work: "exclude",
  queued_in_flight: "finish_or_capability_disabled",
  existing_evidence: "freshness_policy",
};

const effectsDisabledNonRecognize: NormativeEffects = {
  new_work: "reject",
  queued_in_flight: "finish_or_capability_disabled",
  existing_evidence: "freshness_policy",
};

const effectsDisabledRevokeRecognize: NormativeEffects = {
  new_work: "exclude",
  queued_in_flight: "finish_or_capability_disabled",
  existing_evidence: "revoke",
};

const effectsDisabledRevokeNonRecognize: NormativeEffects = {
  new_work: "reject",
  queued_in_flight: "finish_or_capability_disabled",
  existing_evidence: "revoke",
};

const availableOp = (
  sourceSequence: string,
  deadlineMs = 1500,
): OperationCapability => ({
  enabled: true,
  state: "available",
  reason_class: "healthy",
  reason: "healthy",
  effective_at: FIXTURE_EFFECTIVE_AT,
  source_sequence: sourceSequence,
  drain_policy: "finish",
  prior_evidence_revocation_policy: "none",
  normative_effects: effectsAvailable,
  deadline: { deadline_ms: deadlineMs, concurrency_class: "interactive" },
});

/** Non-integrity disabled (unsupported / policy). */
const disabledOp = (
  sourceSequence: string,
  reason: string,
): OperationCapability => ({
  enabled: false,
  state: "disabled",
  reason_class: "capability_unsupported",
  reason,
  effective_at: FIXTURE_EFFECTIVE_AT,
  source_sequence: sourceSequence,
  drain_policy: "capability_disabled",
  prior_evidence_revocation_policy: "freshness_only",
  normative_effects: effectsDisabledRecognize,
  deadline: { deadline_ms: 1500, concurrency_class: "interactive" },
});

/** Integrity / kill-switch disabled — revoke evidence + cancel_and_reject. */
const integrityDisabledRecognizeOp = (
  sourceSequence: string,
  reason: string,
): OperationCapability => ({
  enabled: false,
  state: "disabled",
  reason_class: "kill_switch",
  reason,
  effective_at: FIXTURE_EFFECTIVE_AT,
  source_sequence: sourceSequence,
  drain_policy: "cancel_and_reject",
  prior_evidence_revocation_policy: "revoke_integrity",
  normative_effects: effectsDisabledRevokeRecognize,
  deadline: { deadline_ms: 1500, concurrency_class: "interactive" },
});

const integrityDisabledPrepareOp = (
  sourceSequence: string,
  reason: string,
): OperationCapability => ({
  enabled: false,
  state: "disabled",
  reason_class: "kill_switch",
  reason,
  effective_at: FIXTURE_EFFECTIVE_AT,
  source_sequence: sourceSequence,
  drain_policy: "cancel_and_reject",
  prior_evidence_revocation_policy: "revoke_integrity",
  normative_effects: effectsDisabledRevokeNonRecognize,
  deadline: { deadline_ms: 1500, concurrency_class: "interactive" },
});

const disabledPrepareOp = (sourceSequence: string, reason: string): OperationCapability => ({
  enabled: false,
  state: "disabled",
  reason_class: "capability_unsupported",
  reason,
  effective_at: FIXTURE_EFFECTIVE_AT,
  source_sequence: sourceSequence,
  drain_policy: "capability_disabled",
  prior_evidence_revocation_policy: "freshness_only",
  normative_effects: effectsDisabledNonRecognize,
  deadline: { deadline_ms: 1500, concurrency_class: "interactive" },
});

const degradedRecognizeOp = (
  sourceSequence: string,
  reason: string,
): OperationCapability => ({
  enabled: true,
  state: "degraded",
  reason_class: "availability_degradation",
  reason,
  effective_at: FIXTURE_EFFECTIVE_AT,
  source_sequence: sourceSequence,
  drain_policy: "finish",
  prior_evidence_revocation_policy: "none",
  normative_effects: effectsDegradedRecognize,
  deadline: { deadline_ms: 1500, concurrency_class: "interactive" },
});

const degradedPrepareOp = (
  sourceSequence: string,
  reason: string,
): OperationCapability => ({
  enabled: true,
  state: "degraded",
  reason_class: "availability_degradation",
  reason,
  effective_at: FIXTURE_EFFECTIVE_AT,
  source_sequence: sourceSequence,
  drain_policy: "finish",
  prior_evidence_revocation_policy: "none",
  normative_effects: effectsDegradedNonRecognize,
  deadline: { deadline_ms: 1500, concurrency_class: "interactive" },
});

const evmFinality = (input: {
  policyVersion: string;
  providerSetId: string;
  confirmation:
    | { kind: "finalized_tag"; finalized_tag: "finalized" | "safe" }
    | { kind: "block_depth"; min_depth: number };
  invalidationDepth: number;
}) => ({
  family: "evm" as const,
  policy_version: input.policyVersion,
  source_head_quorum: {
    min_agreeing_sources: 2,
    accepted_provider_set_id: input.providerSetId,
  },
  confirmation:
    input.confirmation.kind === "finalized_tag"
      ? {
          kind: "finalized_tag" as const,
          finalized_tag: input.confirmation.finalized_tag,
        }
      : {
          kind: "block_depth" as const,
          min_depth: input.confirmation.min_depth,
        },
  reorg: { invalidation_depth: input.invalidationDepth },
  degradation: {
    on_quorum_loss: "degrade" as const,
    on_freshness_breach: "partial_diagnostics" as const,
  },
  freshness: { max_age_ms: 30_000, clock: "block_time" as const },
});

/** Robinhood Chain mainnet — Arbitrum L2; block-depth confirmation, not Ethereum defaults. */
const robinhoodFinality = (input: {
  policyVersion: string;
  providerSetId: string;
  minDepth: number;
  invalidationDepth: number;
}) =>
  evmFinality({
    policyVersion: input.policyVersion,
    providerSetId: input.providerSetId,
    confirmation: { kind: "block_depth", min_depth: input.minDepth },
    invalidationDepth: input.invalidationDepth,
  });

export const ROBINHOOD_MAINNET_CHAIN_ID = "4663" as const;
export const ROBINHOOD_CHAIN_EVIDENCE_REFERENCE =
  "grimoires/loa/coordination/collection-report/robinhood-chain-evidence.json";

const solanaFinality = {
  family: "solana" as const,
  policy_version: "solana-finalized.v2",
  source_head_quorum: {
    min_agreeing_sources: 1,
    accepted_provider_set_id: "solana-das-mainnet.v1",
  },
  commitment: "finalized" as const,
  fork: {
    compare: "root_slot" as const,
    invalidate_on_fork_divergence: true,
  },
  degradation: {
    on_quorum_loss: "degrade" as const,
    on_freshness_breach: "partial_diagnostics" as const,
  },
  freshness: { max_age_ms: 15_000, clock: "slot_time" as const },
};

/** Ethereum mainnet — indexer + sense evidence in config.yaml / sense live. */
export const ethereumMainnetCapability = (): NetworkCapability => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  network: eip155("1"),
  environment: "mainnet",
  display: { display_name: "Ethereum", icon_identity: "network-mark.ethereum.v1" },
  probe_adapter: { adapter_id: "evm_rpc", adapter_version: "evm-nft-probe.v0" },
  supported_standards: ["erc721", "erc1155"],
  operations: {
    recognize: availableOp("1"),
    prepare: availableOp("2"),
    read_evidence: availableOp("3"),
  },
  index_support: true,
  finality_policy: evmFinality({
    policyVersion: "ethereum-finalized.v1",
    providerSetId: "ethereum-source-head.v1",
    confirmation: { kind: "finalized_tag", finalized_tag: "finalized" },
    invalidationDepth: 64,
  }),
  kill_switch: false,
  network_priority: 10,
  source_provenance: {
    kind: "indexer_config_evidence",
    reference: "config.yaml#networks.id=1",
    attested_at: FIXTURE_EFFECTIVE_AT,
  },
});

/** Base — tracked ERC-721 batch evidence. */
export const baseMainnetCapability = (): NetworkCapability => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  network: eip155("8453"),
  environment: "mainnet",
  display: { display_name: "Base", icon_identity: "network-mark.base.v1" },
  probe_adapter: { adapter_id: "evm_rpc", adapter_version: "evm-nft-probe.v0" },
  supported_standards: ["erc721"],
  operations: {
    recognize: availableOp("10"),
    prepare: availableOp("11"),
    read_evidence: availableOp("12"),
  },
  index_support: true,
  finality_policy: evmFinality({
    policyVersion: "base-finalized.v1",
    providerSetId: "base-source-head.v1",
    confirmation: { kind: "finalized_tag", finalized_tag: "finalized" },
    invalidationDepth: 32,
  }),
  kill_switch: false,
  network_priority: 20,
  source_provenance: {
    kind: "indexer_config_evidence",
    reference: "config.yaml#networks.id=8453",
    attested_at: FIXTURE_EFFECTIVE_AT,
  },
});

/** Optimism — Mibera / tracked contracts in config. */
export const optimismMainnetCapability = (): NetworkCapability => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  network: eip155("10"),
  environment: "mainnet",
  display: { display_name: "Optimism", icon_identity: "network-mark.optimism.v1" },
  probe_adapter: { adapter_id: "evm_rpc", adapter_version: "evm-nft-probe.v0" },
  supported_standards: ["erc721", "erc1155"],
  operations: {
    recognize: availableOp("20"),
    prepare: availableOp("21"),
    read_evidence: availableOp("22"),
  },
  index_support: true,
  finality_policy: evmFinality({
    policyVersion: "optimism-finalized.v1",
    providerSetId: "optimism-source-head.v1",
    confirmation: { kind: "finalized_tag", finalized_tag: "finalized" },
    invalidationDepth: 32,
  }),
  kill_switch: false,
  network_priority: 30,
  source_provenance: {
    kind: "indexer_config_evidence",
    reference: "config.yaml#networks.id=10",
    attested_at: FIXTURE_EFFECTIVE_AT,
  },
});

/** Arbitrum One — config network id 42161. */
export const arbitrumMainnetCapability = (): NetworkCapability => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  network: eip155("42161"),
  environment: "mainnet",
  display: { display_name: "Arbitrum One", icon_identity: "network-mark.arbitrum.v1" },
  probe_adapter: { adapter_id: "evm_rpc", adapter_version: "evm-nft-probe.v0" },
  supported_standards: ["erc721"],
  operations: {
    recognize: availableOp("30"),
    prepare: availableOp("31"),
    read_evidence: availableOp("32"),
  },
  index_support: true,
  finality_policy: evmFinality({
    policyVersion: "arbitrum-finalized.v1",
    providerSetId: "arbitrum-source-head.v1",
    confirmation: { kind: "block_depth", min_depth: 64 },
    invalidationDepth: 64,
  }),
  kill_switch: false,
  network_priority: 40,
  source_provenance: {
    kind: "indexer_config_evidence",
    reference: "config.yaml#networks.id=42161",
    attested_at: FIXTURE_EFFECTIVE_AT,
  },
});

/** Berachain — primary THJ belt network. */
export const berachainMainnetCapability = (): NetworkCapability => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  network: eip155("80094"),
  environment: "mainnet",
  display: { display_name: "Berachain", icon_identity: "network-mark.berachain.v1" },
  probe_adapter: { adapter_id: "evm_rpc", adapter_version: "evm-nft-probe.v0" },
  supported_standards: ["erc721", "erc1155"],
  operations: {
    recognize: availableOp("40"),
    prepare: availableOp("41"),
    read_evidence: availableOp("42"),
  },
  index_support: true,
  finality_policy: evmFinality({
    policyVersion: "berachain-finalized.v1",
    providerSetId: "berachain-source-head.v1",
    confirmation: { kind: "block_depth", min_depth: 16 },
    invalidationDepth: 32,
  }),
  kill_switch: false,
  network_priority: 5,
  source_provenance: {
    kind: "indexer_config_evidence",
    reference: "config.yaml#networks.id=80094",
    attested_at: FIXTURE_EFFECTIVE_AT,
  },
});

/** Zora — config network id 7777777. */
export const zoraMainnetCapability = (): NetworkCapability => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  network: eip155("7777777"),
  environment: "mainnet",
  display: { display_name: "Zora", icon_identity: "network-mark.zora.v1" },
  probe_adapter: { adapter_id: "evm_rpc", adapter_version: "evm-nft-probe.v0" },
  supported_standards: ["erc721", "erc1155"],
  operations: {
    recognize: availableOp("50"),
    prepare: availableOp("51"),
    read_evidence: availableOp("52"),
  },
  index_support: true,
  finality_policy: evmFinality({
    policyVersion: "zora-finalized.v1",
    providerSetId: "zora-source-head.v1",
    confirmation: { kind: "finalized_tag", finalized_tag: "finalized" },
    invalidationDepth: 32,
  }),
  kill_switch: false,
  network_priority: 50,
  source_provenance: {
    kind: "indexer_config_evidence",
    reference: "config.yaml#networks.id=7777777",
    attested_at: FIXTURE_EFFECTIVE_AT,
  },
});

/**
 * Solana mainnet-beta — DAS recognize supported; prepare/index honestly unsupported
 * until CR-402 ownership_index parity.
 */
export const solanaMainnetCapability = (): NetworkCapability => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  network: solanaMainnet,
  environment: "mainnet",
  display: { display_name: "Solana", icon_identity: "network-mark.solana.v1" },
  probe_adapter: { adapter_id: "solana_das", adapter_version: "solana-das-probe.v0" },
  supported_standards: ["metaplex_collection", "programmable_nft", "compressed_nft"],
  operations: {
    recognize: availableOp("100", 1500),
    prepare: disabledPrepareOp(
      "101",
      "Solana ownership_index prepare unsupported until CR-402",
    ),
    read_evidence: disabledPrepareOp(
      "102",
      "Solana read_evidence unsupported until prepare parity (CR-402)",
    ),
  },
  index_support: false,
  finality_policy: solanaFinality,
  kill_switch: false,
  network_priority: 15,
  source_provenance: {
    kind: "das_adapter_evidence",
    reference: "src/svm/nft-collection-source.ts + collection-registry.ts",
    attested_at: FIXTURE_EFFECTIVE_AT,
  },
});

/**
 * CR-401 proven Robinhood mainnet capability — hermetic enable-path fixture.
 *
 * Not in the default live catalog until operator registry transition + config.yaml
 * index wiring; proves recognize/index/finality/probe paths without faking Gate Leak.
 */
export const robinhoodMainnetCapability = (): NetworkCapability => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  network: eip155(ROBINHOOD_MAINNET_CHAIN_ID),
  environment: "mainnet",
  display: {
    display_name: "Robinhood Chain",
    icon_identity: "network-mark.robinhood.v1",
  },
  probe_adapter: { adapter_id: "evm_rpc", adapter_version: "evm-nft-probe.v0" },
  supported_standards: ["erc721"],
  operations: {
    recognize: availableOp("220"),
    prepare: availableOp("221"),
    read_evidence: availableOp("222"),
  },
  index_support: true,
  finality_policy: robinhoodFinality({
    policyVersion: "robinhood-finalized.v1",
    providerSetId: "robinhood-source-head.v1",
    minDepth: 32,
    invalidationDepth: 32,
  }),
  kill_switch: false,
  network_priority: 55,
  source_provenance: {
    kind: "operator_ratified",
    reference: `${ROBINHOOD_CHAIN_EVIDENCE_REFERENCE}#CR-401-capability-proof`,
    attested_at: FIXTURE_EFFECTIVE_AT,
  },
});

/**
 * Robinhood Chain mainnet (EIP-155 4663) — default-catalog disabled placeholder.
 * Operator registry transition can flip to `robinhoodMainnetCapability` without deploy.
 */
export const robinhoodDisabledCapability = (): NetworkCapability => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  network: eip155(ROBINHOOD_MAINNET_CHAIN_ID),
  environment: "mainnet",
  display: {
    display_name: "Robinhood Chain",
    icon_identity: "network-mark.robinhood.v0",
  },
  probe_adapter: { adapter_id: "evm_rpc", adapter_version: "evm-nft-probe.v0" },
  supported_standards: ["erc721"],
  operations: {
    recognize: integrityDisabledRecognizeOp(
      "200",
      "Robinhood Chain mainnet disabled until CR-401 capability proof",
    ),
    prepare: integrityDisabledPrepareOp(
      "201",
      "Robinhood prepare unsupported until CR-401",
    ),
    read_evidence: integrityDisabledPrepareOp(
      "202",
      "Robinhood read_evidence unsupported until CR-401",
    ),
  },
  index_support: false,
  finality_policy: robinhoodFinality({
    policyVersion: "robinhood-placeholder.v0",
    providerSetId: "robinhood-source-head.unproven.v0",
    minDepth: 0,
    invalidationDepth: 0,
  }),
  kill_switch: true,
  network_priority: 900,
  source_provenance: {
    kind: "placeholder_until_capability",
    reference: "CR-401 Robinhood Chain mainnet capability",
    attested_at: FIXTURE_EFFECTIVE_AT,
  },
});

/**
 * Alternate honest shape: recognize-only (kill_switch false) with prepare/index off.
 * Useful for CR-401 staging fixtures; not in the default live catalog.
 */
export const robinhoodRecognizeOnlyCapability = (): NetworkCapability => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  network: eip155(ROBINHOOD_MAINNET_CHAIN_ID),
  environment: "mainnet",
  display: {
    display_name: "Robinhood Chain",
    icon_identity: "network-mark.robinhood.v0",
  },
  probe_adapter: { adapter_id: "evm_rpc", adapter_version: "evm-nft-probe.v0" },
  supported_standards: ["erc721"],
  operations: {
    recognize: availableOp("210"),
    prepare: disabledPrepareOp(
      "211",
      "Robinhood index/prepare unsupported until CR-401 production fixtures",
    ),
    read_evidence: disabledPrepareOp(
      "212",
      "Robinhood read_evidence unsupported until CR-401",
    ),
  },
  index_support: false,
  finality_policy: robinhoodFinality({
    policyVersion: "robinhood-recognize-only.v0",
    providerSetId: "robinhood-source-head.unproven.v0",
    minDepth: 12,
    invalidationDepth: 12,
  }),
  kill_switch: false,
  network_priority: 900,
  source_provenance: {
    kind: "placeholder_until_capability",
    reference: "CR-401 recognize-only staging",
    attested_at: FIXTURE_EFFECTIVE_AT,
  },
});

/** Default mainnet catalog: live evidence networks + Robinhood disabled placeholder. */
export const defaultMainnetNetworkCapabilities = (): NetworkCapability[] => [
  berachainMainnetCapability(),
  ethereumMainnetCapability(),
  solanaMainnetCapability(),
  baseMainnetCapability(),
  optimismMainnetCapability(),
  arbitrumMainnetCapability(),
  zoraMainnetCapability(),
  robinhoodDisabledCapability(),
];

export const DEFAULT_REGISTRY_EPOCH = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const DEFAULT_REGISTRY_SEQUENCE = "1";

export const defaultMainnetRegistryInput = () => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  version: {
    registry_epoch: DEFAULT_REGISTRY_EPOCH,
    registry_sequence: DEFAULT_REGISTRY_SEQUENCE,
  },
  networks: defaultMainnetNetworkCapabilities(),
});

/** Smaller fixture aligned with CR-003 hermetic resolveProbe (eth/base/solana). */
export const hermeticResolverNetworkCapabilities = (): NetworkCapability[] => [
  ethereumMainnetCapability(),
  baseMainnetCapability(),
  solanaMainnetCapability(),
];

export const hermeticResolverRegistryInput = () => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  version: {
    registry_epoch: DEFAULT_REGISTRY_EPOCH,
    registry_sequence: "3",
  },
  networks: hermeticResolverNetworkCapabilities(),
});

export {
  availableOp,
  disabledOp,
  disabledPrepareOp,
  degradedRecognizeOp,
  degradedPrepareOp,
  integrityDisabledRecognizeOp,
  integrityDisabledPrepareOp,
  effectsAvailable,
  effectsDegradedRecognize,
  effectsDisabledRecognize,
  eip155,
  solanaMainnet,
  FIXTURE_EFFECTIVE_AT,
};
