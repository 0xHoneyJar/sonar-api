import { Data, Effect } from "effect";
import {
  buildCandidateFromHit,
  rankCandidates,
  sortNetworkRefs,
  type NetworkProbePort,
  type ProbeOutcome,
  CandidateBuildError,
  ProbeAddressMismatchError,
} from "./candidate.js";
import {
  classifyCollectionIdentifier,
  selectRecognizeCapabilities,
  type CapabilitySnapshot,
  InvalidCollectionIdentifierError,
} from "./identifier.js";
import {
  decodeCollectionCandidate,
  type CollectionCandidate,
  type NetworkRef,
} from "./protocol.js";

export interface ResolveProbeRequest {
  readonly schema_version: 1;
  readonly identifier: string;
  readonly environment: "mainnet";
}

export interface ResolveProbeDiagnostics {
  readonly searched: ReadonlyArray<NetworkRef>;
  readonly timed_out: ReadonlyArray<NetworkRef>;
  readonly unavailable: ReadonlyArray<NetworkRef>;
}

/**
 * Sonar internal resolve-probe response (SDD §5.6).
 * Ordering wraps this with resolution_id / expires_at — Sonar does not own sessions.
 */
export interface ResolveProbeResponse {
  readonly schema_version: 1;
  readonly capability_snapshot_version: CapabilitySnapshot["version"];
  readonly candidates: ReadonlyArray<CollectionCandidate>;
  readonly diagnostics: ResolveProbeDiagnostics;
}

export class NoCompatibleCapabilityError extends Data.TaggedError(
  "NoCompatibleCapabilityError",
)<{
  readonly reason: string;
}> {}

export type ResolveProbeError =
  | InvalidCollectionIdentifierError
  | NoCompatibleCapabilityError
  | CandidateBuildError
  | ProbeAddressMismatchError;

const assertCandidatesDecode = (
  candidates: ReadonlyArray<CollectionCandidate>,
): Effect.Effect<ReadonlyArray<CollectionCandidate>, CandidateBuildError> =>
  Effect.forEach(candidates, (candidate) =>
    decodeCollectionCandidate(candidate).pipe(
      Effect.mapError(
        (cause) =>
          new CandidateBuildError({
            reason: "resolver candidate failed CR-001 strict decode",
            cause,
          }),
      ),
    ),
  );

/**
 * Hermetic / injectable collection resolve-probe.
 *
 * Callers supply a capability snapshot and a NetworkProbePort. Tests use
 * fixture-backed probes; production CR-102/103/104 will supply real adapters.
 * This function performs no RPC, DAS, or database I/O of its own.
 */
export const resolveProbe = (input: {
  readonly request: ResolveProbeRequest;
  readonly capabilitySnapshot: CapabilitySnapshot;
  readonly probePort: NetworkProbePort;
}): Effect.Effect<ResolveProbeResponse, ResolveProbeError> =>
  Effect.gen(function* () {
    const classified = yield* classifyCollectionIdentifier(input.request.identifier);
    const identifier = classified.identifier;
    const selected = selectRecognizeCapabilities(input.capabilitySnapshot, classified);

    if (selected.length === 0) {
      return yield* Effect.fail(
        new NoCompatibleCapabilityError({
          reason: "no healthy mainnet recognize capabilities for identifier format",
        }),
      );
    }

    const searched = sortNetworkRefs(selected.map((capability) => capability.network));
    const timedOut: NetworkRef[] = [];
    const unavailable: NetworkRef[] = [];
    const hits: Array<{
      readonly capability: (typeof selected)[number];
      readonly outcome: Extract<ProbeOutcome, { kind: "hit" }>;
    }> = [];

    const outcomes = yield* Effect.forEach(
      selected,
      (capability) =>
        capability.health === "degraded"
          ? Effect.succeed({ capability, outcome: { kind: "unavailable" } as ProbeOutcome })
          : input.probePort
              .probe({
                network: capability.network,
                address: identifier.raw,
              })
              .pipe(Effect.map((outcome) => ({ capability, outcome }))),
      { concurrency: "unbounded" },
    );

    // Effect.forEach preserves input order, so diagnostics remain deterministic
    // while independent network I/O is bounded by the slowest probe, not their sum.
    for (const { capability, outcome } of outcomes) {
      switch (outcome.kind) {
        case "hit":
          hits.push({ capability, outcome });
          break;
        case "miss":
          break;
        case "timeout":
          timedOut.push(capability.network);
          break;
        case "unavailable":
          unavailable.push(capability.network);
          break;
      }
    }

    const built = yield* Effect.forEach(hits, ({ capability, outcome }) =>
      buildCandidateFromHit({
        capability,
        address: identifier.raw,
        hit: outcome,
      }),
    );

    // Metadata similarity across hits must not collapse candidates — each hit
    // remains its own single_deployment candidate (Inventory owns equivalence).
    const ranked = rankCandidates(built);
    const candidates = yield* assertCandidatesDecode(ranked);

    const response: ResolveProbeResponse = {
      schema_version: 1,
      capability_snapshot_version: input.capabilitySnapshot.version,
      candidates,
      diagnostics: {
        searched,
        timed_out: sortNetworkRefs(timedOut),
        unavailable: sortNetworkRefs(unavailable),
      },
    };
    return response;
  });
