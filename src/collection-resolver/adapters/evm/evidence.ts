/**
 * Project probe observations into ProbeHitEvidence / ProbeBindingEvidence.
 * Never includes credentials, provider URLs, raw RPC bodies, or bytecode.
 */
import type { CollectionCandidate } from "../../protocol.js";
import type { ProbeBindingEvidence, ProbeHitEvidence } from "../../candidate.js";
import {
  EVM_NFT_PROBE_ADAPTER_POLICY_VERSION,
  EVM_NFT_PROBE_ADAPTER_VERSION,
  INTERFACE_ID_ERC1155,
  INTERFACE_ID_ERC721,
} from "./constants.js";
import type { EvmObservationBlock } from "./ports.js";
import {
  accountDigestFromAddressAndCode,
  codeDigestFromBytecode,
  digest32FromHex,
} from "./digests.js";

export type DetectedStandard = "erc721" | "erc1155" | "unknown";

export interface InterfaceProbeBits {
  readonly erc721: boolean | undefined;
  readonly erc1155: boolean | undefined;
}

export interface ProxyObservation {
  readonly is_proxy: boolean;
  readonly proxy_kind?: "eip1967" | "unknown";
  readonly implementation_address?: `0x${string}`;
  readonly implementation_bytecode?: `0x${string}`;
}

export interface MetadataObservation {
  readonly quality: CollectionCandidate["metadata_quality"];
  readonly name?: string;
  readonly symbol?: string;
}

export interface ProjectHitInput {
  readonly normalized_address: `0x${string}`;
  readonly network_key: string;
  readonly bytecode: `0x${string}`;
  readonly block: EvmObservationBlock;
  readonly interfaces: InterfaceProbeBits;
  readonly proxy: ProxyObservation;
  readonly onchain_name?: string;
  readonly onchain_symbol?: string;
  readonly metadata: MetadataObservation;
  readonly index_status: CollectionCandidate["index_status"];
  readonly observed_at: string;
  /** When false, omit binding_evidence so CR-102 refuses cache writes. */
  readonly include_binding: boolean;
}

const classifyStandard = (
  interfaces: InterfaceProbeBits,
): { standard: DetectedStandard; recognition: "recognized" | "ambiguous"; quality: "confirmed" | "unknown" } => {
  const erc721 = interfaces.erc721 === true;
  const erc1155 = interfaces.erc1155 === true;
  if (erc721 && erc1155) {
    return { standard: "unknown", recognition: "ambiguous", quality: "unknown" };
  }
  if (erc721) {
    return { standard: "erc721", recognition: "recognized", quality: "confirmed" };
  }
  if (erc1155) {
    return { standard: "erc1155", recognition: "recognized", quality: "confirmed" };
  }
  return { standard: "unknown", recognition: "ambiguous", quality: "unknown" };
};

const interfaceBits = (interfaces: InterfaceProbeBits): string[] => {
  const bits: string[] = [];
  if (interfaces.erc721 === true) bits.push(`erc165:${INTERFACE_ID_ERC721}`);
  if (interfaces.erc1155 === true) bits.push(`erc165:${INTERFACE_ID_ERC1155}`);
  if (interfaces.erc721 === false && interfaces.erc1155 === false) {
    bits.push("erc165:no_nft_interface");
  }
  return bits;
};

const reportReadiness = (input: {
  readonly recognition: "recognized" | "ambiguous";
  readonly index_status: CollectionCandidate["index_status"];
}): CollectionCandidate["report_readiness"] => {
  if (input.recognition === "ambiguous") return "unknown";
  switch (input.index_status) {
    case "indexed":
      return "ready";
    case "indexing":
    case "missing":
      return "preparation_required";
    case "unsupported":
      return "unsupported";
    case "failed":
      return "blocked";
    case "unknown":
      return "unknown";
    default: {
      const _exhaustive: never = input.index_status;
      return _exhaustive;
    }
  }
};

const rankingReasons = (input: {
  readonly standard: DetectedStandard;
  readonly recognition: "recognized" | "ambiguous";
  readonly index_status: CollectionCandidate["index_status"];
  readonly metadata_quality: CollectionCandidate["metadata_quality"];
}): string[] => {
  const reasons: string[] = [];
  if (input.standard !== "unknown") reasons.push("supported_standard");
  if (input.recognition === "ambiguous") reasons.push("ambiguous_standard");
  if (input.index_status === "indexed") reasons.push("indexed");
  if (
    input.metadata_quality === "onchain" ||
    input.metadata_quality === "external_pointer"
  ) {
    reasons.push("onchain_metadata");
  }
  return reasons;
};

export const projectProbeHit = (input: ProjectHitInput): ProbeHitEvidence => {
  const classified = classifyStandard(input.interfaces);
  // On-chain name/symbol win; remote metadata only fills gaps.
  const name = input.onchain_name ?? input.metadata.name;
  const symbol = input.onchain_symbol ?? input.metadata.symbol;
  const readiness = reportReadiness({
    recognition: classified.recognition,
    index_status: input.index_status,
  });

  const codeDigest = codeDigestFromBytecode(input.bytecode);
  const accountDigest = accountDigestFromAddressAndCode(
    input.normalized_address,
    codeDigest,
  );
  const blockHashDigest = digest32FromHex(input.block.block_hash);

  let proxy_evidence: ProbeBindingEvidence["proxy_evidence"] = {
    is_proxy: input.proxy.is_proxy,
  };
  if (input.proxy.is_proxy) {
    proxy_evidence = {
      is_proxy: true,
      proxy_kind: input.proxy.proxy_kind ?? "unknown",
      ...(input.proxy.implementation_bytecode !== undefined
        ? {
            implementation_digest: codeDigestFromBytecode(
              input.proxy.implementation_bytecode,
            ),
          }
        : {}),
    };
  }

  const standard_evidence: ProbeBindingEvidence["standard_evidence"] = {
    token_standard: classified.standard,
    evidence_quality: classified.quality,
    interface_bits: interfaceBits(input.interfaces),
  };

  const evidence_material = {
    adapter: "evm_rpc" as const,
    adapter_version: EVM_NFT_PROBE_ADAPTER_VERSION,
    network_key: input.network_key,
    code_present: true,
    interface_bits: interfaceBits(input.interfaces),
    proxy: {
      is_proxy: input.proxy.is_proxy,
      ...(input.proxy.proxy_kind !== undefined ? { proxy_kind: input.proxy.proxy_kind } : {}),
      has_implementation_digest:
        input.proxy.implementation_bytecode !== undefined,
    },
    // Digests only — never bytecode / RPC bodies / provider URLs.
    code_digest: codeDigest,
    observed_block_number: input.block.block_number.toString(10),
  };

  const hit: ProbeHitEvidence = {
    kind: "hit",
    address: input.normalized_address,
    token_standard: classified.standard,
    ...(name !== undefined ? { name } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    recognition: classified.recognition,
    index_status: input.index_status,
    report_readiness: readiness,
    metadata_quality: input.metadata.quality,
    observed_at: input.observed_at,
    ranking_reasons: rankingReasons({
      standard: classified.standard,
      recognition: classified.recognition,
      index_status: input.index_status,
      metadata_quality: input.metadata.quality,
    }),
    evidence_material,
  };

  // Complete proxy binding or none: nonzero EIP-1967 without implementation
  // digest must not emit positive cache binding.
  const proxyBindingComplete =
    !input.proxy.is_proxy || input.proxy.implementation_bytecode !== undefined;

  if (
    input.include_binding &&
    proxyBindingComplete &&
    blockHashDigest !== undefined &&
    codeDigest.length === 64 &&
    accountDigest.length === 64
  ) {
    const binding: ProbeBindingEvidence = {
      code_digest: codeDigest,
      account_digest: accountDigest,
      observed_position: {
        family: "evm",
        block_number: input.block.block_number.toString(10),
        block_hash: blockHashDigest,
        finality: input.block.finality,
      },
      standard_evidence,
      proxy_evidence,
      adapter_policy_version: EVM_NFT_PROBE_ADAPTER_POLICY_VERSION,
      adapter_version: EVM_NFT_PROBE_ADAPTER_VERSION,
    };
    return { ...hit, binding_evidence: binding };
  }

  return hit;
};
