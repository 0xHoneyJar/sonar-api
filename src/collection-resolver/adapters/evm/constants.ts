/**
 * Stable EVM NFT probe constants. Interface IDs and storage slots are
 * Ethereum standards — not network-specific finality inheritance.
 */

export const EVM_NFT_PROBE_ADAPTER_ID = "evm_rpc" as const;
/** Matches CR-101 fixture probe_adapter.adapter_version until a version bump. */
export const EVM_NFT_PROBE_ADAPTER_VERSION = "evm-nft-probe.v0" as const;
/** Shared with CR-102 positive-cache binding policy. */
export const EVM_NFT_PROBE_ADAPTER_POLICY_VERSION = "resolver-adapter-policy.v1" as const;

/** ERC-165 / ERC-721 / ERC-1155 interface ids (bytes4). */
export const INTERFACE_ID_ERC165 = "0x01ffc9a7" as const;
export const INTERFACE_ID_INVALID = "0xffffffff" as const;
export const INTERFACE_ID_ERC721 = "0x80ac58cd" as const;
export const INTERFACE_ID_ERC1155 = "0xd9b67a26" as const;

/** Function selectors. */
export const SELECTOR_SUPPORTS_INTERFACE = "0x01ffc9a7" as const;
export const SELECTOR_NAME = "0x06fdde03" as const;
export const SELECTOR_SYMBOL = "0x95d89b41" as const;
export const SELECTOR_CONTRACT_URI = "0xe8a3d485" as const;

/**
 * EIP-1967 implementation slot:
 * bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
 */
export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/** Bounded on-chain string decode ceiling (chars after UTF-8 decode). */
export const MAX_ONCHAIN_STRING_CHARS = 128;

/** Bounded contractURI string ceiling before metadata egress. */
export const MAX_CONTRACT_URI_CHARS = 2_048;

export type EvmRpcSafeErrorCode =
  | "rpc_transport_failed"
  | "rpc_quorum_failed"
  | "rpc_timeout"
  | "rpc_aborted"
  | "rpc_finality_unavailable"
  | "rpc_unsupported_network"
  | "rpc_invalid_response"
  | "rpc_capability_mismatch";

export const SAFE_MESSAGES: Readonly<Record<EvmRpcSafeErrorCode, string>> = {
  rpc_transport_failed: "EVM RPC transport failed for configured network",
  rpc_quorum_failed: "EVM source-head quorum could not be established",
  rpc_timeout: "EVM RPC deadline exceeded for configured network",
  rpc_aborted: "EVM RPC probe aborted",
  rpc_finality_unavailable: "EVM finality-qualified observation block unavailable",
  rpc_unsupported_network: "network is not a configured EVM probe target",
  rpc_invalid_response: "EVM RPC returned an invalid response",
  rpc_capability_mismatch: "capability probe adapter is not the EVM NFT probe",
};
