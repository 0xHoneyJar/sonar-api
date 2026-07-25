/**
 * CR-RECOG-ENRICH — Kitchen collection-index enrichment for resolve-probe.
 *
 * A collection the belt already indexes for a community (e.g. Mibera main on
 * Berachain) still returned zero candidates whenever the on-chain probe missed
 * or its RPC was unavailable. This wraps a `NetworkAdapterPort` and, ONLY when
 * the wrapped probe produced no hit, consults the Kitchen collection-index for
 * the same chain-qualified address.
 *
 * Honesty bounds:
 * - Additive, never a replacement: an on-chain hit is returned untouched.
 * - No `binding_evidence`. The index observes indexing, not chain position —
 *   there is no code/account digest or block coordinate Ordering could confirm,
 *   so none is emitted (CR-102 then refuses positive/readiness cache writes and
 *   marks the response partial). Absent evidence stays absent.
 * - Provenance is `inventory_registry`, never `sonar_probe`.
 * - No registry coverage (or an unreachable/late reader) returns the wrapped
 *   outcome unchanged — miss stays miss, unavailable stays unavailable.
 */
import { Effect } from "effect";
import {
  isIndexedSnapshotReady,
  type CollectionStatusReader,
} from "../../../kitchen/status.js";
import type { CollectionKey } from "../../../kitchen/types.js";
import type { ProbeHitEvidence, ProbeOutcome } from "../../candidate.js";
import type {
  DeadlineTimerPort,
  MonotonicClock,
} from "../../bounded-core/clock.js";
import type { AdapterProbeRequest, NetworkAdapterPort } from "../../bounded-core/ports.js";
import { normalizeAddressOnce, type NormalizedEvmAddress } from "./normalize.js";

export const INDEX_REGISTRY_ADAPTER_ID = "kitchen_collection_index";
export const INDEX_REGISTRY_ADAPTER_VERSION = "index-registry.v1";

/** Ranking reason for a candidate whose only evidence is index coverage. */
export const INDEX_REGISTRY_RANKING_REASON = "index_registry_indexed";

/** Observed index coverage for one chain-qualified address. */
export interface IndexRegistryObservation {
  readonly holder_count: number;
  readonly indexed_at_ms: number | null;
  /** Kitchen readiness evidence kind, when the snapshot carried one. */
  readonly readiness_kind?: string;
}

/**
 * Chain-qualified index-coverage lookup.
 *
 * `undefined` is the explicit absent state — no coverage, abort, deadline, or
 * an unavailable reader. Callers MUST NOT treat it as a negative assertion and
 * MUST NOT synthesize a candidate from it.
 */
export interface ChainQualifiedIndexRegistryPort {
  readonly lookup: (input: {
    readonly chain_id: number;
    readonly normalized_address: NormalizedEvmAddress;
    readonly abort: AbortSignal;
    readonly deadline_at_ms: number;
    /** Same monotonic clock domain as CR-102 / AdapterProbeRequest.clock. */
    readonly now_ms: () => number;
  }) => Effect.Effect<IndexRegistryObservation | undefined, never>;
}

/** Wrap the Kitchen collection-index reader as an abort-aware Effect port. */
export const createKitchenIndexRegistryPort = (deps: {
  readonly reader: CollectionStatusReader;
  readonly clock: MonotonicClock & DeadlineTimerPort;
}): ChainQualifiedIndexRegistryPort => ({
  lookup: (input) =>
    Effect.promise(async () => {
      if (input.abort.aborted || input.now_ms() >= input.deadline_at_ms) {
        return undefined;
      }
      const key: CollectionKey = {
        chainId: input.chain_id,
        contract: input.normalized_address,
      };
      return new Promise<IndexRegistryObservation | undefined>((resolve) => {
        let settled = false;
        let cancelDeadline = (): void => undefined;
        const finish = (observed: IndexRegistryObservation | undefined): void => {
          if (settled) return;
          settled = true;
          cancelDeadline();
          input.abort.removeEventListener("abort", onAbort);
          resolve(observed);
        };
        const onAbort = (): void => finish(undefined);

        input.abort.addEventListener("abort", onAbort, { once: true });
        cancelDeadline = deps.clock.scheduleAt(input.deadline_at_ms, () =>
          finish(undefined),
        );

        void (async () => {
          try {
            const snapshot = await deps.reader.readIndexedSnapshot(key);
            if (input.abort.aborted || input.now_ms() >= input.deadline_at_ms) {
              finish(undefined);
              return;
            }
            // Only ratified index readiness is evidence. "indexing" / "missing"
            // is absent coverage, not a candidate.
            if (!isIndexedSnapshotReady(snapshot)) {
              finish(undefined);
              return;
            }
            finish({
              holder_count: snapshot.holderCount,
              indexed_at_ms: snapshot.indexedAtMs,
              ...(snapshot.readiness !== undefined
                ? { readiness_kind: snapshot.readiness.kind }
                : {}),
            });
          } catch {
            finish(undefined);
          }
        })();
      });
    }),
});

/** Hermetic scripted index coverage by `chainId:normalizedAddress`. */
export const createScriptedIndexRegistryPort = (
  script: Readonly<Record<string, IndexRegistryObservation>>,
): ChainQualifiedIndexRegistryPort => ({
  lookup: (input) =>
    Effect.sync(() => {
      if (input.abort.aborted || input.now_ms() >= input.deadline_at_ms) {
        return undefined;
      }
      return script[`${input.chain_id}:${input.normalized_address}`];
    }),
});

const registryHit = (input: {
  readonly normalized: NormalizedEvmAddress;
  readonly chain_id: number;
  readonly observed: IndexRegistryObservation;
}): ProbeHitEvidence => ({
  kind: "hit",
  address: input.normalized,
  // The index knows the address is covered; it does not observe the interface.
  token_standard: "unknown",
  recognition: "recognized",
  index_status: "indexed",
  report_readiness: "ready",
  // No name / symbol / image was observed — absence, not a placeholder.
  metadata_quality: "unavailable",
  observed_at: new Date().toISOString(),
  provenance_source: "inventory_registry",
  ranking_reasons: [INDEX_REGISTRY_RANKING_REASON],
  evidence_material: {
    adapter: INDEX_REGISTRY_ADAPTER_ID,
    adapter_version: INDEX_REGISTRY_ADAPTER_VERSION,
    chain_id: input.chain_id,
    address: input.normalized,
    holder_count: input.observed.holder_count,
    indexed_at_ms: input.observed.indexed_at_ms,
    ...(input.observed.readiness_kind !== undefined
      ? { readiness_kind: input.observed.readiness_kind }
      : {}),
  },
  // binding_evidence deliberately omitted — see file header.
});

const normalizedOrUndefined = (raw: string): NormalizedEvmAddress | undefined => {
  try {
    return normalizeAddressOnce(raw).normalized;
  } catch {
    return undefined;
  }
};

/**
 * Compose an on-chain probe adapter with Kitchen collection-index enrichment.
 *
 * The wrapped adapter runs first and always wins on a hit. Enrichment shares
 * the caller's abort handle and per-network deadline — it never extends them.
 */
export const createIndexRegistryEnrichedAdapter = (deps: {
  readonly base: NetworkAdapterPort;
  readonly registry: ChainQualifiedIndexRegistryPort;
}): NetworkAdapterPort => ({
  probe: (request: AdapterProbeRequest): Effect.Effect<ProbeOutcome, never> =>
    deps.base.probe(request).pipe(
      Effect.flatMap((outcome) => {
        // Additive only: never override observed on-chain evidence.
        if (outcome.kind === "hit") return Effect.succeed(outcome);
        if (request.network.network_namespace !== "eip155") {
          return Effect.succeed(outcome);
        }
        // Without index support the capability registry forbids an indexed
        // claim — enrichment has nothing honest to say.
        if (!request.network_capability.index_support) {
          return Effect.succeed(outcome);
        }
        const chainId = Number(request.network.network_reference);
        if (!Number.isSafeInteger(chainId) || chainId <= 0) {
          return Effect.succeed(outcome);
        }
        const normalized = normalizedOrUndefined(request.address);
        if (normalized === undefined) return Effect.succeed(outcome);

        return deps.registry
          .lookup({
            chain_id: chainId,
            normalized_address: normalized,
            abort: request.abort.signal,
            deadline_at_ms: request.deadline_at_ms,
            now_ms: () => request.clock.nowMs(),
          })
          .pipe(
            Effect.map((observed) => {
              if (observed === undefined) return outcome;
              // A settlement that lands past the boundary is a late success.
              if (
                request.abort.aborted ||
                request.clock.nowMs() >= request.deadline_at_ms
              ) {
                return outcome;
              }
              return registryHit({ normalized, chain_id: chainId, observed });
            }),
          );
      }),
    ),
});
