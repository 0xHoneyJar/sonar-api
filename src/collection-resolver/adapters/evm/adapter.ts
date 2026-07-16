/**
 * CR-103 — production-shaped EVM NFT probe adapter behind NetworkAdapterPort.
 *
 * - Configured EVM mainnets only (capability registry selects targets).
 * - One address normalization at the boundary.
 * - Injected abort-aware EVM RPC port pins all reads to one observation block.
 * - Bytecode first; EOA = miss; transport/quorum = unavailable/timeout.
 * - Healthy call reverts are absent evidence, not transport outages.
 * - Metadata via CR-004 ResolverMetadataPort only (contractURI — never tokenURI(0)).
 * - Deadline comparisons use the same MonotonicClock domain as CR-102 (no wall clock).
 */
import { Effect } from "effect";
import { networkIdentityKey } from "../../capability-registry/keys.js";
import type { EvmFinalityPolicy } from "../../capability-registry/schemas.js";
import type { ProbeOutcome } from "../../candidate.js";
import type {
  DeadlineTimerPort,
  MonotonicClock,
} from "../../bounded-core/clock.js";
import type { AdapterProbeRequest, NetworkAdapterPort } from "../../bounded-core/ports.js";
import { BOUNDED_RESOLVER_ADAPTER_POLICY_VERSION } from "../../bounded-core/schemas.js";
import {
  decodeAbiBool,
  decodeBoundedContractUri,
  decodeBoundedName,
  decodeBoundedSymbol,
  addressFromStorageWord,
  encodeContractUriCall,
  encodeNameCall,
  encodeSymbolCall,
  ERC1155_SUPPORTS_CALLDATA,
  ERC721_SUPPORTS_CALLDATA,
  isEmptyBytecode,
  isValidStorageWord,
  isZeroStorageWord,
} from "./abi.js";
import { abortOrDeadline } from "./abort.js";
import {
  EVM_NFT_PROBE_ADAPTER_ID,
  EVM_NFT_PROBE_ADAPTER_POLICY_VERSION,
  EIP1967_IMPLEMENTATION_SLOT,
} from "./constants.js";
import { canonicalUnavailable, mapRpcFailure, timeoutOutcome } from "./diagnostics.js";
import { isValidBytecodeHex } from "./digests.js";
import { projectProbeHit, type ProxyObservation } from "./evidence.js";
import { applyIndexSupportBound } from "./index-status.js";
import {
  metadataSubDeadlineAtMs,
  resolveMetadataBudgetConfig,
  type EvmMetadataBudgetConfig,
} from "./metadata-budget.js";
import { normalizeAddressOnce } from "./normalize.js";
import type {
  ChainQualifiedIndexStatusPort,
  EthCallResult,
  EvmMetadataEnrichPort,
  EvmObservationBlock,
  EvmRpcPort,
} from "./ports.js";

export interface EvmNftProbeAdapterDeps {
  readonly rpc: EvmRpcPort;
  readonly indexStatus: ChainQualifiedIndexStatusPort;
  /** CR-004 metadata port (enrich only). Optional — missing remote metadata degrades quality. */
  readonly metadata?: EvmMetadataEnrichPort;
  /**
   * Same monotonic clock domain as CR-102 (`deadline_at_ms` origin).
   * Required — never fall back to Date.now() for deadline comparison.
   */
  readonly clock: MonotonicClock & DeadlineTimerPort;
  /**
   * Optional remote-metadata sub-budget (cap + fraction + post-metadata reserve).
   * Defaults keep enrich ending materially before `request.deadline_at_ms`.
   * `post_metadata_reserve_ms` may raise the reserve; the immutable safety floor
   * prevents lowering it (including `0`).
   */
  readonly metadata_budget?: EvmMetadataBudgetConfig;
  /** Optional ISO observed_at override (defaults to clock.nowIso). */
  readonly observedAt?: () => string;
}

const callBool = (result: EthCallResult): boolean | undefined => {
  if (result.kind === "revert") return undefined;
  return decodeAbiBool(result.data);
};

const callString = (
  result: EthCallResult,
  decode: (data: `0x${string}`) => string | undefined,
): string | undefined => {
  if (result.kind === "revert") return undefined;
  return decode(result.data);
};

type MetadataEnrichResult = Awaited<ReturnType<EvmMetadataEnrichPort["enrich"]>>;

const degradedMetadata = (): MetadataEnrichResult => ({
  metadata_quality: "partial",
  name: undefined,
  symbol: undefined,
  image: undefined,
});

/**
 * Race remote metadata enrich against a strict sub-deadline that ends before the
 * outer adapter deadline (reserve left for projection / return under CR-102 race).
 * Rejection / timeout / malformed → degrade quality; never defect the probe fiber.
 * Abort is observed by the caller after settlement (do not cancel-and-ignore the enrich
 * Promise — post-abort late results must still not mutate recognition).
 */
const enrichMetadataBounded = (input: {
  readonly enrich: EvmMetadataEnrichPort["enrich"];
  readonly uri: string;
  readonly metadata_deadline_at_ms: number;
  readonly clock: MonotonicClock & DeadlineTimerPort;
}): Effect.Effect<MetadataEnrichResult, never> => {
  if (input.metadata_deadline_at_ms <= input.clock.nowMs()) {
    return Effect.succeed(degradedMetadata());
  }

  return Effect.tryPromise({
    try: () =>
      new Promise<MetadataEnrichResult>((resolve) => {
        let settled = false;
        let cancelDeadline = (): void => undefined;
        const finish = (value: MetadataEnrichResult): void => {
          if (settled) return;
          settled = true;
          cancelDeadline();
          resolve(value);
        };
        cancelDeadline = input.clock.scheduleAt(input.metadata_deadline_at_ms, () =>
          finish(degradedMetadata()),
        );
        void input
          .enrich({ uri: input.uri, purpose: "collection_metadata" })
          .then(
            (value) => finish(value),
            () => finish(degradedMetadata()),
          );
      }),
    catch: () => degradedMetadata(),
  }).pipe(Effect.catchAll(() => Effect.succeed(degradedMetadata())));
};

/**
 * Create the EVM NFT NetworkAdapterPort.
 *
 * Does not accept RPC URLs or chain definitions — only the injected ports and
 * the capability row already selected by CR-102 / CR-101.
 */
export const createEvmNftProbeAdapter = (
  deps: EvmNftProbeAdapterDeps,
): NetworkAdapterPort & {
  /** Test seam: count of normalizeAddressOnce invocations. */
  readonly normalizationCount: () => number;
} => {
  let normalizationCount = 0;
  const clock = deps.clock;
  const observedAt = deps.observedAt ?? (() => clock.nowIso());
  const metadataBudget = resolveMetadataBudgetConfig(deps.metadata_budget);

  // Policy version must stay aligned with CR-102 cache binding.
  if (EVM_NFT_PROBE_ADAPTER_POLICY_VERSION !== BOUNDED_RESOLVER_ADAPTER_POLICY_VERSION) {
    throw new Error("EVM adapter policy version drift vs bounded resolver");
  }

  const probeOne = (request: AdapterProbeRequest): Effect.Effect<ProbeOutcome, never> =>
    Effect.gen(function* () {
      const gate = abortOrDeadline({
        abort: request.abort.signal,
        deadline_at_ms: request.deadline_at_ms,
        now_ms: clock.nowMs(),
      });
      if (gate === "aborted") return canonicalUnavailable("rpc_aborted");
      if (gate === "deadline") return timeoutOutcome();

      if (request.network.network_namespace !== "eip155") {
        return canonicalUnavailable("rpc_unsupported_network");
      }
      if (request.network_capability.probe_adapter.adapter_id !== EVM_NFT_PROBE_ADAPTER_ID) {
        return canonicalUnavailable("rpc_capability_mismatch");
      }
      if (request.network_capability.finality_policy.family !== "evm") {
        return canonicalUnavailable("rpc_capability_mismatch");
      }

      // Exactly one normalization at the adapter boundary.
      let normalized: `0x${string}`;
      try {
        const once = normalizeAddressOnce(request.address);
        normalizationCount += once.normalization_count;
        normalized = once.normalized;
      } catch {
        return { kind: "miss" } as const;
      }

      const finalityPolicy = request.network_capability.finality_policy as EvmFinalityPolicy;
      const networkKey = networkIdentityKey(request.network);

      const blockExit = yield* deps.rpc
        .resolveObservationBlock({
          network: request.network,
          finality_policy: finalityPolicy,
          abort: request.abort.signal,
          deadline_at_ms: request.deadline_at_ms,
        })
        .pipe(Effect.either);

      if (blockExit._tag === "Left") {
        return mapRpcFailure(blockExit.left);
      }
      const block: EvmObservationBlock = blockExit.right;

      const postBlockGate = abortOrDeadline({
        abort: request.abort.signal,
        deadline_at_ms: request.deadline_at_ms,
        now_ms: clock.nowMs(),
      });
      if (postBlockGate === "aborted") return canonicalUnavailable("rpc_aborted");
      if (postBlockGate === "deadline") return timeoutOutcome();

      const codeExit = yield* deps.rpc
        .getCode({
          network: request.network,
          address: normalized,
          block,
          abort: request.abort.signal,
          deadline_at_ms: request.deadline_at_ms,
        })
        .pipe(Effect.either);

      if (codeExit._tag === "Left") {
        return mapRpcFailure(codeExit.left);
      }
      const bytecode = codeExit.right;
      if (!isValidBytecodeHex(bytecode)) {
        return canonicalUnavailable("rpc_invalid_response");
      }
      if (isEmptyBytecode(bytecode)) {
        return { kind: "miss" } as const;
      }

      // Interface probes — healthy reverts → absent (undefined), not unavailable.
      const erc721Exit = yield* deps.rpc
        .ethCall({
          network: request.network,
          to: normalized,
          data: ERC721_SUPPORTS_CALLDATA,
          block,
          abort: request.abort.signal,
          deadline_at_ms: request.deadline_at_ms,
        })
        .pipe(Effect.either);
      if (erc721Exit._tag === "Left") return mapRpcFailure(erc721Exit.left);

      const erc1155Exit = yield* deps.rpc
        .ethCall({
          network: request.network,
          to: normalized,
          data: ERC1155_SUPPORTS_CALLDATA,
          block,
          abort: request.abort.signal,
          deadline_at_ms: request.deadline_at_ms,
        })
        .pipe(Effect.either);
      if (erc1155Exit._tag === "Left") return mapRpcFailure(erc1155Exit.left);

      const interfaces = {
        erc721: callBool(erc721Exit.right),
        erc1155: callBool(erc1155Exit.right),
      };

      // Proxy evidence (EIP-1967) — complete binding or none.
      let proxy: ProxyObservation = { is_proxy: false };
      /** False when slot is nonzero but address/code/digest incomplete. */
      let proxy_binding_complete = true;
      const storageExit = yield* deps.rpc
        .getStorageAt({
          network: request.network,
          address: normalized,
          slot: EIP1967_IMPLEMENTATION_SLOT,
          block,
          abort: request.abort.signal,
          deadline_at_ms: request.deadline_at_ms,
        })
        .pipe(Effect.either);

      if (storageExit._tag === "Left") {
        return mapRpcFailure(storageExit.left);
      }
      const storageWord = storageExit.right;
      if (!isValidStorageWord(storageWord)) {
        return canonicalUnavailable("rpc_invalid_response");
      }
      if (!isZeroStorageWord(storageWord)) {
        const implAddr = addressFromStorageWord(storageWord);
        if (implAddr === undefined) {
          proxy = { is_proxy: true, proxy_kind: "eip1967" };
          proxy_binding_complete = false;
        } else {
          const implCodeExit = yield* deps.rpc
            .getCode({
              network: request.network,
              address: implAddr,
              block,
              abort: request.abort.signal,
              deadline_at_ms: request.deadline_at_ms,
            })
            .pipe(Effect.either);
          if (implCodeExit._tag === "Left") {
            // Transport failure reading implementation code is a typed network outage.
            return mapRpcFailure(implCodeExit.left);
          }
          const implCode = implCodeExit.right;
          if (!isValidBytecodeHex(implCode)) {
            return canonicalUnavailable("rpc_invalid_response");
          }
          if (isEmptyBytecode(implCode)) {
            proxy = {
              is_proxy: true,
              proxy_kind: "eip1967",
              implementation_address: implAddr,
            };
            proxy_binding_complete = false;
          } else {
            proxy = {
              is_proxy: true,
              proxy_kind: "eip1967",
              implementation_address: implAddr,
              implementation_bytecode: implCode,
            };
            proxy_binding_complete = true;
          }
        }
      }

      const midGate = abortOrDeadline({
        abort: request.abort.signal,
        deadline_at_ms: request.deadline_at_ms,
        now_ms: clock.nowMs(),
      });
      if (midGate === "aborted") return canonicalUnavailable("rpc_aborted");
      if (midGate === "deadline") return timeoutOutcome();

      // Name / symbol / contractURI only after contract + interface probe steps.
      let onchainName: string | undefined;
      let onchainSymbol: string | undefined;
      let metadataQuality: "onchain" | "external_pointer" | "partial" | "unavailable" =
        "unavailable";

      const nameExit = yield* deps.rpc
        .ethCall({
          network: request.network,
          to: normalized,
          data: encodeNameCall(),
          block,
          abort: request.abort.signal,
          deadline_at_ms: request.deadline_at_ms,
        })
        .pipe(Effect.either);
      if (nameExit._tag === "Left") return mapRpcFailure(nameExit.left);
      onchainName = callString(nameExit.right, decodeBoundedName);

      const symbolExit = yield* deps.rpc
        .ethCall({
          network: request.network,
          to: normalized,
          data: encodeSymbolCall(),
          block,
          abort: request.abort.signal,
          deadline_at_ms: request.deadline_at_ms,
        })
        .pipe(Effect.either);
      if (symbolExit._tag === "Left") return mapRpcFailure(symbolExit.left);
      onchainSymbol = callString(symbolExit.right, decodeBoundedSymbol);

      if (onchainName !== undefined || onchainSymbol !== undefined) {
        metadataQuality = "onchain";
      }

      // contractURI — never tokenURI(0). Remote fetch via CR-004 only.
      const uriExit = yield* deps.rpc
        .ethCall({
          network: request.network,
          to: normalized,
          data: encodeContractUriCall(),
          block,
          abort: request.abort.signal,
          deadline_at_ms: request.deadline_at_ms,
        })
        .pipe(Effect.either);
      if (uriExit._tag === "Left") return mapRpcFailure(uriExit.left);

      const contractUri = callString(uriExit.right, decodeBoundedContractUri);
      let metaName: string | undefined;
      let metaSymbol: string | undefined;

      // Index evidence before optional remote metadata — recognition must not wait on enrich.
      const chainId = Number(request.network.network_reference);
      if (!Number.isSafeInteger(chainId) || chainId <= 0) {
        return canonicalUnavailable("rpc_unsupported_network");
      }

      const observedIndex = yield* deps.indexStatus.lookup({
        chain_id: chainId,
        normalized_address: normalized,
        abort: request.abort.signal,
        deadline_at_ms: request.deadline_at_ms,
      });

      // A dependency may complete at the boundary; never project a late success.
      const postIndexGate = abortOrDeadline({
        abort: request.abort.signal,
        deadline_at_ms: request.deadline_at_ms,
        now_ms: clock.nowMs(),
      });
      if (postIndexGate === "aborted") return canonicalUnavailable("rpc_aborted");
      if (postIndexGate === "deadline") return timeoutOutcome();

      const index_status = applyIndexSupportBound(
        observedIndex,
        request.network_capability.index_support,
      );

      if (contractUri !== undefined && deps.metadata !== undefined) {
        const metaGate = abortOrDeadline({
          abort: request.abort.signal,
          deadline_at_ms: request.deadline_at_ms,
          now_ms: clock.nowMs(),
        });
        if (metaGate === "aborted") return canonicalUnavailable("rpc_aborted");
        if (metaGate === "deadline") {
          // Outer budget exhausted — degrade quality; keep recognition.
          metadataQuality = "partial";
        } else {
          const metadataDeadline = metadataSubDeadlineAtMs({
            now_ms: clock.nowMs(),
            request_deadline_at_ms: request.deadline_at_ms,
            config: metadataBudget,
          });
          if (metadataDeadline === undefined) {
            // Insufficient reserve for post-metadata return — skip enrich immediately.
            metadataQuality = "partial";
          } else {
            const enrichment = yield* enrichMetadataBounded({
              enrich: deps.metadata.enrich.bind(deps.metadata),
              uri: contractUri,
              metadata_deadline_at_ms: metadataDeadline,
              clock,
            });

            // Post-abort: do not apply late metadata mutation.
            if (request.abort.signal.aborted) {
              return canonicalUnavailable("rpc_aborted");
            }

            // Sub-budget / reject / timeout during enrich: skip remote fields; keep hit.
            const pastOuterDeadline = clock.nowMs() >= request.deadline_at_ms;
            const enrichDegraded =
              pastOuterDeadline ||
              enrichment.metadata_quality === "partial" ||
              enrichment.metadata_quality === "unavailable";

            if (!enrichDegraded) {
              metaName = enrichment.name;
              metaSymbol = enrichment.symbol;
              if (enrichment.metadata_quality === "external_pointer") {
                metadataQuality =
                  onchainName !== undefined || onchainSymbol !== undefined
                    ? "onchain"
                    : "external_pointer";
              } else if (
                onchainName === undefined &&
                onchainSymbol === undefined &&
                (enrichment.metadata_quality === "onchain" ||
                  enrichment.metadata_quality === "registry_enriched")
              ) {
                // registry_enriched is CR-004-only; probe surface keeps onchain/external/partial/unavailable.
                metadataQuality = "onchain";
              }
            } else {
              // Degrade metadata quality without erasing recognition / on-chain name.
              metadataQuality = "partial";
            }
          }
        }
      } else if (contractUri === undefined) {
        if (onchainName === undefined && onchainSymbol === undefined) {
          metadataQuality = "unavailable";
        }
      }

      // Binding requires complete source-derived proof fields + complete proxy or none.
      const include_binding =
        proxy_binding_complete &&
        block.block_hash.length >= 66 &&
        Number.isFinite(Number(block.block_number)) &&
        block.finality.length > 0;

      return projectProbeHit({
        normalized_address: normalized,
        network_key: networkKey,
        bytecode,
        block,
        interfaces,
        proxy,
        onchain_name: onchainName,
        onchain_symbol: onchainSymbol,
        metadata: {
          quality: metadataQuality,
          ...(metaName !== undefined ? { name: metaName } : {}),
          ...(metaSymbol !== undefined ? { symbol: metaSymbol } : {}),
        },
        index_status,
        observed_at: observedAt(),
        include_binding,
      });
    }).pipe(
      Effect.catchAllDefect(() =>
        Effect.succeed(canonicalUnavailable("rpc_transport_failed")),
      ),
    );

  return {
    normalizationCount: () => normalizationCount,
    probe: (request) => probeOne(request),
  };
};
