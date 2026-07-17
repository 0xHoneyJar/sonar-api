import { Effect } from "effect";
import type { NetworkProbePort, ProbeOutcome } from "./candidate.js";
import type { CapabilitySnapshot, RecognizeCapability } from "./identifier.js";
import { networkKey } from "./identifier.js";
import {
  COLLECTION_PROTOCOL_SCHEMA_VERSION,
  type NetworkRef,
} from "./protocol.js";

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

export const HERMETIC_CAPABILITY_SNAPSHOT: CapabilitySnapshot = {
  version: {
    registry_epoch: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    registry_sequence: "3",
  },
  capabilities: [
    {
      network: eip155("1"),
      display_name: "Ethereum",
      environment: "mainnet",
      probe_adapter: "evm_rpc",
      recognize: true,
      index: true,
      supported_standards: ["erc721", "erc1155"],
      finality_policy_version: "ethereum-finalized.v1",
      health: "available",
    },
    {
      network: eip155("8453"),
      display_name: "Base",
      environment: "mainnet",
      probe_adapter: "evm_rpc",
      recognize: true,
      index: true,
      supported_standards: ["erc721"],
      finality_policy_version: "base-finalized.v1",
      health: "available",
    },
    {
      network: solanaMainnet,
      display_name: "Solana",
      environment: "mainnet",
      probe_adapter: "solana_das",
      recognize: true,
      // Recognition without prepare: index false keeps readiness orthogonal.
      index: false,
      supported_standards: ["metaplex_collection", "programmable_nft", "compressed_nft"],
      finality_policy_version: "solana-finalized.v2",
      health: "available",
    },
  ],
};

export const solanaRecognizeCapability = (): RecognizeCapability => {
  const capability = HERMETIC_CAPABILITY_SNAPSHOT.capabilities.find(
    (entry) => entry.network.network_namespace === "solana",
  );
  if (capability === undefined) {
    throw new Error("hermetic solana capability missing");
  }
  return capability;
};

/** Shared EVM address used across multi-network hermetic fixtures. */
export const MULTI_CHAIN_EVM_ADDRESS = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

/** Pythenians collection mint — mixed-case SVM fixture parity. */
export const PYTHIANS_COLLECTION_MINT = "pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru";

/** Fixed digests for observed binding evidence (not deployment/address hashes). */
const EVM_CODE_DIGEST = "11".repeat(32);
const EVM_ACCOUNT_DIGEST = "22".repeat(32);
const EVM_BLOCK_HASH = "33".repeat(32);
const SOL_CODE_DIGEST = "44".repeat(32);
const SOL_ACCOUNT_DIGEST = "55".repeat(32);

const evmBinding = (networkRef: string) => ({
  code_digest: EVM_CODE_DIGEST,
  account_digest: EVM_ACCOUNT_DIGEST,
  observed_position: {
    family: "evm" as const,
    block_number: networkRef === "8453" ? "20000001" : "19000001",
    block_hash: EVM_BLOCK_HASH,
    finality: "finalized",
  },
  standard_evidence: {
    token_standard: "erc721",
    evidence_quality: "confirmed" as const,
    interface_bits: ["erc165", "erc721"],
  },
  proxy_evidence: {
    is_proxy: networkRef === "8453",
    ...(networkRef === "8453"
      ? {
          implementation_digest: "66".repeat(32),
          proxy_kind: "eip1967" as const,
        }
      : {}),
  },
  adapter_policy_version: "resolver-adapter-policy.v1",
  adapter_version: "scripted-evm.v1",
});

const solBinding = () => ({
  code_digest: SOL_CODE_DIGEST,
  account_digest: SOL_ACCOUNT_DIGEST,
  observed_position: {
    family: "solana" as const,
    slot: "250000001",
    blockhash: "SoLanaBlockhashFixture1111111111111111111",
    finality: "finalized",
  },
  standard_evidence: {
    token_standard: "metaplex_collection",
    evidence_quality: "confirmed" as const,
  },
  proxy_evidence: { is_proxy: false },
  adapter_policy_version: "resolver-adapter-policy.v1",
  adapter_version: "scripted-solana.v1",
});

const evmHit = (overrides: Partial<Extract<ProbeOutcome, { kind: "hit" }>> = {}): Extract<
  ProbeOutcome,
  { kind: "hit" }
> => ({
  kind: "hit",
  address: MULTI_CHAIN_EVM_ADDRESS,
  token_standard: "erc721",
  name: "Shared Metadata Name",
  symbol: "SAME",
  image: "https://images.example.test/shared.png",
  recognition: "recognized",
  index_status: "indexed",
  report_readiness: "ready",
  metadata_quality: "onchain",
  observed_at: "2026-07-16T08:00:00Z",
  ranking_reasons: ["supported_standard", "indexed"],
  evidence_material: {
    adapter: "evm_rpc",
    codehash: "0xabc",
  },
  binding_evidence: evmBinding("1"),
  ...overrides,
});

const solanaHit = (): Extract<ProbeOutcome, { kind: "hit" }> => ({
  kind: "hit",
  address: PYTHIANS_COLLECTION_MINT,
  token_standard: "metaplex_collection",
  name: "Pythenians",
  symbol: "$PTN",
  recognition: "recognized",
  index_status: "missing",
  report_readiness: "preparation_required",
  metadata_quality: "onchain",
  observed_at: "2026-07-16T08:00:00Z",
  ranking_reasons: ["supported_standard", "onchain_metadata"],
  evidence_material: {
    adapter: "solana_das",
    collection_mint: PYTHIANS_COLLECTION_MINT,
  },
  binding_evidence: solBinding(),
});

export type HermeticProbeScript = Readonly<Record<string, ProbeOutcome>>;

export const createHermeticProbePort = (script: HermeticProbeScript): NetworkProbePort => ({
  probe: ({ network }) => {
    const key = networkKey(network);
    const outcome = script[key];
    if (outcome === undefined) {
      return Effect.succeed({ kind: "miss" } as const);
    }
    return Effect.succeed(outcome);
  },
});

export const SCRIPT_EVM_ERC721: HermeticProbeScript = {
  "eip155:1": evmHit({
    name: "Mibera",
    symbol: "MIB",
    ranking_reasons: ["exact_inventory_match", "supported_standard", "indexed"],
    evidence_material: { adapter: "evm_rpc", fixture: "evm-erc721" },
    binding_evidence: evmBinding("1"),
  }),
};

export const SCRIPT_SOLANA_COLLECTION: HermeticProbeScript = {
  "solana:mainnet-beta": solanaHit(),
};

export const SCRIPT_MULTI_CHAIN_SAME_ADDRESS: HermeticProbeScript = {
  "eip155:1": evmHit({
    evidence_material: { adapter: "evm_rpc", network: "1" },
    binding_evidence: evmBinding("1"),
  }),
  "eip155:8453": evmHit({
    index_status: "missing",
    report_readiness: "preparation_required",
    ranking_reasons: ["supported_standard"],
    evidence_material: { adapter: "evm_rpc", network: "8453" },
    binding_evidence: evmBinding("8453"),
  }),
};

export const SCRIPT_PARTIAL_TIMEOUT: HermeticProbeScript = {
  "eip155:1": evmHit({
    evidence_material: { adapter: "evm_rpc", fixture: "partial-ok" },
    binding_evidence: evmBinding("1"),
  }),
  "eip155:8453": { kind: "timeout" },
};

export const SCRIPT_ZERO_CANDIDATES: HermeticProbeScript = {
  "eip155:1": { kind: "miss" },
  "eip155:8453": { kind: "miss" },
};

/** Hit without binding evidence — must not write positive/readiness cache. */
export const SCRIPT_HIT_WITHOUT_BINDING: HermeticProbeScript = {
  "eip155:1": evmHit({
    binding_evidence: undefined,
    evidence_material: { adapter: "evm_rpc", fixture: "no-binding" },
  }),
};
