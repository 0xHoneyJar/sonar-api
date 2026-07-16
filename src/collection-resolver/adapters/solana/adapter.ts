/**
 * CR-104 Solana DAS recognition adapter behind CR-102 `NetworkAdapterPort`.
 *
 * Wraps the existing SVM DAS recognition path (bounded sample + classifier +
 * exact registry enrichment). Does not invent a second collection identity or
 * ownership model. Does not call full-paginating `DasNftCollectionSource.snapshot()`.
 */
import { Effect } from "effect";
import type {
  AdapterProbeRequest,
  NetworkAdapterPort,
} from "../../bounded-core/ports.js";
import type { ProbeOutcome } from "../../candidate.js";
import { normalizeSolanaAddress } from "../../protocol.js";
import type {
  DasCollectionAssetObservation,
  DasSamplePort,
} from "./das-port.js";
import type { CollectionReadinessObservation } from "./project-hit.js";
import { findCollectionByMintExact } from "./registry-lookup.js";
import { projectSolanaDasHit } from "./project-hit.js";
import {
  classifyDasSampleItems,
  DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT,
  filterVerifiedDasSampleMembers,
  normalizeDasSampleLimit,
} from "./sample-classifier.js";

export interface SolanaDasAdapterOptions {
  readonly dasPort: DasSamplePort;
  /** Sample page size — capped; never triggers multi-page pagination. */
  readonly sampleLimit?: number;
  /** Wall-clock source used only for observed_at (defaults to Date). */
  readonly wallNowMs?: () => number;
  /** ISO observed_at override for hermetic fixtures. */
  readonly observedAt?: string;
  /**
   * Optional mutation bag — when abort fires, the adapter must not write here
   * after sealing a timeout (hermetic late-work proof).
   */
  readonly sharedState?: { mutations: number };
  /**
   * Distinct collection-specific readiness/index observation port.
   * Absent → index_status=missing / report_readiness=preparation_required.
   * Capability support is only a ceiling — never auto-upgrade from coverage.
   */
  readonly readinessPort?: {
    readonly observe: (input: {
      readonly collection_mint: string;
      readonly abort: AbortSignal;
      readonly deadline_at_ms: number;
      readonly now_ms: () => number;
    }) => Effect.Effect<
      | { readonly kind: "observed"; readonly readiness: CollectionReadinessObservation }
      | { readonly kind: "omit" }
      | { readonly kind: "timeout" }
      | { readonly kind: "unavailable" },
      never
    >;
  };
}

const isoNow = (nowMs: () => number): string => new Date(nowMs()).toISOString();

const sealIfAborted = (
  request: AdapterProbeRequest,
): ProbeOutcome | undefined => {
  if (
    request.abort.aborted ||
    request.abort.signal.aborted ||
    request.clock.nowMs() >= request.deadline_at_ms
  ) {
    return { kind: "timeout" };
  }
  return undefined;
};

export const createSolanaDasNetworkAdapter = (
  options: SolanaDasAdapterOptions,
): NetworkAdapterPort => {
  const sampleLimit = normalizeDasSampleLimit(
    options.sampleLimit ?? DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT,
  );
  if (sampleLimit === undefined) {
    throw new RangeError("Solana DAS adapter sampleLimit must be finite");
  }
  const wallNowMs = options.wallNowMs ?? (() => Date.now());

  return {
    probe: (request: AdapterProbeRequest): Effect.Effect<ProbeOutcome, never> =>
      Effect.gen(function* () {
        const early = sealIfAborted(request);
        if (early !== undefined) return early;

        if (request.network.network_namespace !== "solana") {
          return { kind: "unavailable" } as const;
        }

        if (request.network_capability.probe_adapter.adapter_id !== "solana_das") {
          return { kind: "unavailable" } as const;
        }

        // CR-001 Solana normalization is identity (exact case). Refuse fold.
        const address = normalizeSolanaAddress(request.address);
        if (address !== request.address) {
          return { kind: "unavailable" } as const;
        }

        const outcome = yield* options.dasPort.sampleCollection({
          collection_mint: address,
          limit: sampleLimit,
          abort: request.abort.signal,
          deadline_at_ms: request.deadline_at_ms,
          now_ms: request.clock.nowMs,
        });

        // Honor abort/deadline after transport settlement — late success must
        // not mutate shared state or return a hit.
        const afterSample = sealIfAborted(request);
        if (afterSample !== undefined) return afterSample;

        if (outcome.kind === "timeout") {
          return { kind: "timeout" } as const;
        }

        if (outcome.kind === "unavailable") {
          return { kind: "unavailable" } as const;
        }

        // Exact-case mint echo — transport must not fold the key.
        if (outcome.collection_mint !== address) {
          return { kind: "unavailable" } as const;
        }

        // Only an explicit successfully decoded empty items page is a conclusive
        // miss. Non-empty raw pages where every asset fails shared parsing are
        // typed unavailable (never authoritative negative cache).
        if (outcome.items.length === 0) {
          return { kind: "miss" } as const;
        }

        const verified = filterVerifiedDasSampleMembers(outcome.items);
        if (verified.length === 0) {
          return { kind: "unavailable" } as const;
        }

        const classification = classifyDasSampleItems(verified);
        const registry = findCollectionByMintExact(address);
        const observed_at = options.observedAt ?? isoNow(wallNowMs);

        // Optional bounded getAsset(collection mint) — never member projection.
        let collection_asset: DasCollectionAssetObservation | undefined;
        if (options.dasPort.observeCollectionAsset !== undefined) {
          const assetOutcome = yield* options.dasPort.observeCollectionAsset({
            collection_mint: address,
            limit: sampleLimit,
            abort: request.abort.signal,
            deadline_at_ms: request.deadline_at_ms,
            now_ms: request.clock.nowMs,
          });
          const afterAsset = sealIfAborted(request);
          if (afterAsset !== undefined) return afterAsset;
          if (assetOutcome.kind === "timeout") {
            return { kind: "timeout" } as const;
          }
          // unavailable / omit → proceed without collection-level identity fields
          // (registry may still enrich name/symbol/key).
          if (assetOutcome.kind === "observed") {
            if (assetOutcome.observation.collection_mint !== address) {
              return { kind: "unavailable" } as const;
            }
            collection_asset = assetOutcome.observation;
          }
        }

        let readiness: CollectionReadinessObservation | undefined;
        if (options.readinessPort !== undefined) {
          const readinessOutcome = yield* options.readinessPort.observe({
            collection_mint: address,
            abort: request.abort.signal,
            deadline_at_ms: request.deadline_at_ms,
            now_ms: request.clock.nowMs,
          });
          const afterReady = sealIfAborted(request);
          if (afterReady !== undefined) return afterReady;
          if (readinessOutcome.kind === "timeout") {
            return { kind: "timeout" } as const;
          }
          // Readiness is optional enrichment after DAS has already recognized
          // the collection. An outage degrades to the honest default rather
          // than erasing the recognized candidate.
          if (readinessOutcome.kind === "observed") {
            readiness = readinessOutcome.readiness;
          }
        }

        if (options.sharedState !== undefined) {
          options.sharedState.mutations += 1;
        }

        return projectSolanaDasHit({
          collection_mint: address,
          items: verified,
          classification,
          capability: request.network_capability,
          registry,
          collection_asset,
          readiness,
          observed_at,
        });
      }),
  };
};
