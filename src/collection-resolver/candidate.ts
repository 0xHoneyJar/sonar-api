import { Data, Effect } from "effect";
import {
  COLLECTION_PROTOCOL_SCHEMA_VERSION,
  DIGEST_DOMAINS,
  digestVersioned,
  makeCollectionDeploymentRef,
  makeCollectionIdentity,
  normalizeEvmAddress,
  normalizeSolanaAddress,
  type CollectionCandidate,
  type NetworkRef,
  type VersionedDigest,
} from "./protocol.js";
import { networkKey, type RecognizeCapability } from "./identifier.js";

export type ProbeOutcomeKind = "hit" | "miss" | "timeout" | "unavailable";

/**
 * Observed binding evidence returned by the adapter from the actual source.
 * Optional on ProbeHitEvidence so CR-003 hermetic probes remain valid; CR-102
 * positive/readiness cache writes REQUIRE this and refuse fabrication.
 */
export interface ProbeBindingEvidence {
  readonly code_digest: string;
  readonly account_digest: string;
  readonly observed_position:
    | {
        readonly family: "evm";
        readonly block_number: string;
        readonly block_hash: string;
        readonly finality?: string;
      }
    | {
        readonly family: "solana";
        readonly slot: string;
        readonly blockhash: string;
        readonly finality?: string;
      };
  readonly standard_evidence: {
    readonly token_standard: string;
    readonly evidence_quality: "confirmed" | "heuristic" | "unknown";
    readonly interface_bits?: ReadonlyArray<string>;
  };
  readonly proxy_evidence: {
    readonly is_proxy: boolean;
    readonly implementation_digest?: string;
    readonly proxy_kind?: "eip1967" | "eip1822" | "transparent" | "metaplex" | "unknown";
  };
  readonly adapter_policy_version: string;
  readonly adapter_version?: string;
}

export interface ProbeHitEvidence {
  readonly kind: "hit";
  readonly address: string;
  readonly token_standard: string;
  readonly name?: string;
  readonly symbol?: string;
  readonly image?: string;
  /**
   * Stable local registry key (e.g. SVM collection-registry) on exact mint match.
   * Display enrichment only — never invents cross-deployment equivalence.
   */
  readonly collection_key?: string;
  readonly recognition: "recognized" | "ambiguous";
  readonly index_status: CollectionCandidate["index_status"];
  readonly report_readiness: CollectionCandidate["report_readiness"];
  readonly metadata_quality: CollectionCandidate["metadata_quality"];
  readonly observed_at: string;
  readonly ranking_reasons: ReadonlyArray<string>;
  /** Opaque evidence bytes for provenance digest — never a network call. */
  readonly evidence_material: unknown;
  /** Observed source binding for positive cache — never fabricated by the core. */
  readonly binding_evidence?: ProbeBindingEvidence;
}

export interface ProbeMiss {
  readonly kind: "miss";
}

export interface ProbeTimeout {
  readonly kind: "timeout";
}

/**
 * Per-network transport/quorum outage. Optional safe_code / safe_message are
 * stable, redacted labels for CR-102 diagnostics — never a raw RPC cause,
 * provider URL, credential, or response body.
 */
export interface ProbeUnavailable {
  readonly kind: "unavailable";
  readonly safe_code?: string;
  readonly safe_message?: string;
}

export type ProbeOutcome = ProbeHitEvidence | ProbeMiss | ProbeTimeout | ProbeUnavailable;

export interface NetworkProbePort {
  readonly probe: (input: {
    readonly network: NetworkRef;
    readonly address: string;
  }) => Effect.Effect<ProbeOutcome, never>;
}

export class CandidateBuildError extends Data.TaggedError("CandidateBuildError")<{
  readonly reason: string;
  readonly cause: unknown;
}> {}

/**
 * Probe hit address does not match the requested collection identifier under
 * CR-001 normalization (EVM lowercase compare form / Solana exact case).
 */
export class ProbeAddressMismatchError extends Data.TaggedError(
  "ProbeAddressMismatchError",
)<{
  readonly requested: string;
  readonly probed: string;
  readonly network: NetworkRef;
  readonly reason: string;
}> {}

const sortByNetworkKey = <T extends { readonly network: NetworkRef }>(
  items: ReadonlyArray<T>,
): T[] =>
  Array.from(items).sort((left, right) => {
    const leftKey = networkKey(left.network);
    const rightKey = networkKey(right.network);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return 0;
  });

/**
 * Validate probe evidence address against the requested identifier using
 * CR-001 normalization. Never bind a hit to a different deployment address.
 */
export const assertProbeAddressMatchesRequested = (input: {
  readonly network: NetworkRef;
  readonly requested: string;
  readonly probed: string;
}): Effect.Effect<void, ProbeAddressMismatchError> => {
  const { network, requested, probed } = input;

  if (network.network_namespace === "eip155") {
    if (normalizeEvmAddress(requested) === normalizeEvmAddress(probed)) {
      return Effect.void;
    }
    return Effect.fail(
      new ProbeAddressMismatchError({
        requested,
        probed,
        network,
        reason:
          "EVM probe hit address does not match requested identifier under CR-001 lowercase normalization",
      }),
    );
  }

  if (network.network_namespace === "solana") {
    if (normalizeSolanaAddress(requested) === normalizeSolanaAddress(probed)) {
      return Effect.void;
    }
    return Effect.fail(
      new ProbeAddressMismatchError({
        requested,
        probed,
        network,
        reason:
          "Solana probe hit address does not match requested identifier under CR-001 exact-case normalization",
      }),
    );
  }

  const _exhaustive: never = network;
  return _exhaustive;
};

/**
 * Build one chain-qualified candidate from a successful probe.
 *
 * Metadata fields may influence ranking_reasons but NEVER create multi-deployment
 * equivalence — each hit is `single_deployment` until Inventory asserts otherwise.
 *
 * The probe hit address MUST match `address` under CR-001 normalization.
 */
export const buildCandidateFromHit = (input: {
  readonly capability: RecognizeCapability;
  readonly address: string;
  readonly hit: ProbeHitEvidence;
}): Effect.Effect<CollectionCandidate, CandidateBuildError | ProbeAddressMismatchError> => {
  const { capability, address, hit } = input;

  return assertProbeAddressMatchesRequested({
    network: capability.network,
    requested: address,
    probed: hit.address,
  }).pipe(
    Effect.flatMap(() =>
      makeCollectionDeploymentRef({
        schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
        network: capability.network,
        address,
      }).pipe(
        Effect.flatMap((deployment) =>
          makeCollectionIdentity({
            schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
            ...(hit.name !== undefined ? { name: hit.name } : {}),
            ...(hit.symbol !== undefined ? { symbol: hit.symbol } : {}),
            ...(hit.image !== undefined ? { image: hit.image } : {}),
            ...(hit.collection_key !== undefined
              ? { collection_key: hit.collection_key }
              : {}),
            deployments: [deployment],
            equivalence_basis: {
              schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
              kind: "single_deployment",
            },
          }).pipe(Effect.map((identity) => ({ identity, deployment }))),
        ),
        Effect.flatMap(({ identity, deployment }) =>
          digestVersioned(DIGEST_DOMAINS.provenance, 1, hit.evidence_material).pipe(
            Effect.map((evidenceDigest: VersionedDigest) => {
              const candidate: CollectionCandidate = {
                schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
                identity,
                token_standard: {
                  schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
                  value: hit.token_standard,
                },
                recognition: hit.recognition,
                index_status: hit.index_status,
                report_readiness: hit.report_readiness,
                metadata_quality: hit.metadata_quality,
                provenance: [
                  {
                    schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
                    source: "sonar_probe",
                    observed_at: hit.observed_at,
                    evidence_digest: evidenceDigest,
                  },
                ],
                finality_policies: [
                  {
                    schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
                    network: deployment.network,
                    finality_policy_version: capability.finality_policy_version,
                  },
                ],
                ranking_reasons: Array.from(hit.ranking_reasons),
              };
              return candidate;
            }),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new CandidateBuildError({
              reason: `failed to build candidate for ${networkKey(capability.network)}`,
              cause,
            }),
        ),
      ),
    ),
  );
};

/** Deterministic ranking: inventory match → supported standard → indexed → readiness → network key. */
export const rankCandidates = (
  candidates: ReadonlyArray<CollectionCandidate>,
): CollectionCandidate[] => {
  const score = (candidate: CollectionCandidate): number => {
    let value = 0;
    if (candidate.ranking_reasons.includes("exact_inventory_match")) value += 1_000;
    if (candidate.token_standard.value !== "unknown") value += 100;
    if (candidate.index_status === "indexed") value += 50;
    if (candidate.report_readiness === "ready") value += 10;
    return value;
  };

  return Array.from(candidates).sort((left, right) => {
    const scoreDelta = score(right) - score(left);
    if (scoreDelta !== 0) return scoreDelta;
    const leftNetwork = left.identity.deployments[0]?.network;
    const rightNetwork = right.identity.deployments[0]?.network;
    if (leftNetwork === undefined || rightNetwork === undefined) return 0;
    const leftKey = networkKey(leftNetwork);
    const rightKey = networkKey(rightNetwork);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return 0;
  });
};

export const sortNetworkRefs = (networks: ReadonlyArray<NetworkRef>): NetworkRef[] =>
  sortByNetworkKey(networks.map((network) => ({ network }))).map((item) => item.network);
