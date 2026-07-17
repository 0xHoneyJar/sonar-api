/**
 * Injected EVM RPC + index-status ports for the CR-103 NFT probe adapter.
 *
 * Production wires a provider-set/quorum client that never accepts user RPC URLs
 * or chain definitions. Hermetic tests inject recorded fixtures.
 */
import type { Effect } from "effect";
import type { NetworkRef } from "../../protocol.js";
import type { EvmFinalityPolicy } from "../../capability-registry/schemas.js";
import type { CollectionCandidate } from "../../protocol.js";
import type { EvmRpcSafeErrorCode } from "./constants.js";

export interface EvmObservationBlock {
  readonly block_number: bigint;
  readonly block_hash: `0x${string}`;
  /** Finality tag or policy label observed for this pin (e.g. "finalized"). */
  readonly finality: string;
}

export interface EvmRpcFailure {
  readonly _tag: "EvmRpcFailure";
  readonly safe_code: EvmRpcSafeErrorCode;
  /**
   * Dependency-local note only — the adapter maps `safe_code` to canonical
   * SAFE_MESSAGES and never emits this string on ProbeUnavailable.
   */
  readonly safe_message: string;
}

export const evmRpcFailure = (
  safe_code: EvmRpcSafeErrorCode,
  safe_message: string,
): EvmRpcFailure => ({
  _tag: "EvmRpcFailure",
  safe_code,
  safe_message,
});

export type EthCallResult =
  | { readonly kind: "success"; readonly data: `0x${string}` }
  | { readonly kind: "revert" };

/**
 * Abort-aware EVM read port. All reads MUST pin to one accepted
 * finality-qualified observation block under the capability quorum policy.
 * Implementations must honor abort + deadline_at_ms on every call and never
 * surface credentials, provider URLs, or raw RPC bodies in failures.
 */
export interface EvmRpcPort {
  readonly resolveObservationBlock: (input: {
    readonly network: NetworkRef;
    readonly finality_policy: EvmFinalityPolicy;
    readonly abort: AbortSignal;
    readonly deadline_at_ms: number;
  }) => Effect.Effect<EvmObservationBlock, EvmRpcFailure>;

  readonly getCode: (input: {
    readonly network: NetworkRef;
    readonly address: `0x${string}`;
    readonly block: EvmObservationBlock;
    readonly abort: AbortSignal;
    readonly deadline_at_ms: number;
  }) => Effect.Effect<`0x${string}`, EvmRpcFailure>;

  readonly ethCall: (input: {
    readonly network: NetworkRef;
    readonly to: `0x${string}`;
    readonly data: `0x${string}`;
    readonly block: EvmObservationBlock;
    readonly abort: AbortSignal;
    readonly deadline_at_ms: number;
  }) => Effect.Effect<EthCallResult, EvmRpcFailure>;

  readonly getStorageAt: (input: {
    readonly network: NetworkRef;
    readonly address: `0x${string}`;
    readonly slot: `0x${string}`;
    readonly block: EvmObservationBlock;
    readonly abort: AbortSignal;
    readonly deadline_at_ms: number;
  }) => Effect.Effect<`0x${string}`, EvmRpcFailure>;
}

/**
 * Chain-qualified index status lookup (Kitchen status seam wrapper).
 * Capability `index_support` is applied by the adapter — this port reports
 * observed Kitchen status only.
 */
export interface ChainQualifiedIndexStatusPort {
  readonly lookup: (input: {
    readonly chain_id: number;
    readonly normalized_address: `0x${string}`;
    readonly abort: AbortSignal;
    readonly deadline_at_ms: number;
    /** Same monotonic clock domain as CR-102 / AdapterProbeRequest.clock. */
    readonly now_ms: () => number;
  }) => Effect.Effect<CollectionCandidate["index_status"], never>;
}

/** Narrow metadata enrich surface — CR-004 ResolverMetadataPort.enrich only. */
export interface EvmMetadataEnrichPort {
  readonly enrich: (input: {
    readonly uri: string;
    readonly purpose?: "collection_metadata";
    /** Adapter sub-deadline / parent abort propagated into CR-004 retrieval. */
    readonly abort: AbortSignal;
  }) => Promise<{
    readonly metadata_quality:
      | "onchain"
      | "registry_enriched"
      | "external_pointer"
      | "partial"
      | "unavailable";
    readonly name: string | undefined;
    readonly symbol: string | undefined;
    readonly image: undefined;
  }>;
}
