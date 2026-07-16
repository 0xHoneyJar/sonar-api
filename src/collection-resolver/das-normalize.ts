/**
 * Normalize an existing Sonar DAS ownership snapshot into a CR-001 candidate
 * and project storage / log / response surfaces without lowercasing Solana keys.
 *
 * Storage rows come from the shared `toRows` projector used by the Pythians
 * ownership indexer (`src/svm/collection-nft-rows.ts`) — not a parallel
 * invented observation or fake row shape. Snapshot members are
 * `CollectionMember` values (typically from `parseAsset`, which refuses
 * missing owner). Solana public keys remain case-sensitive.
 */
import { Data, Effect } from "effect";
import {
  buildCandidateFromHit,
  CandidateBuildError,
  ProbeAddressMismatchError,
  type ProbeHitEvidence,
} from "./candidate.js";
import type { RecognizeCapability } from "./identifier.js";
import {
  COLLECTION_PROTOCOL_SCHEMA_VERSION,
  type CollectionCandidate,
} from "./protocol.js";
import { toRows, type NftRow } from "../svm/collection-nft-rows.js";
import type { CollectionSnapshot } from "../svm/nft-collection-source.js";

/**
 * Probe observation built on the real Sonar DAS snapshot seam
 * (`CollectionSnapshot` / `CollectionMember` from nft-collection-source).
 *
 * Collection-level name/symbol/image/interface are optional probe metadata for
 * the CR-001 candidate; member ownership always comes from `snapshot.members`.
 */
export interface DasCollectionProbeObservation {
  readonly snapshot: CollectionSnapshot;
  readonly observedAt: string;
  readonly indexStatus: CollectionCandidate["index_status"];
  readonly reportReadiness: CollectionCandidate["report_readiness"];
  readonly interfaceName?: string;
  readonly name?: string;
  readonly symbol?: string;
  readonly image?: string;
}

/** Structured log sink for DAS normalization (production logging boundary). */
export interface DasNormalizeLogSink {
  readonly info: (message: string, fields?: Readonly<Record<string, string>>) => void;
}

/** Log projection for a normalized DAS observation. */
export interface DasNormalizedLogProjection {
  readonly event: "das_probe_normalized";
  readonly fields: Readonly<{
    collection_mint: string;
    network_namespace: string;
    network_reference: string;
    sample_member_mint?: string;
    sample_owner?: string;
    sample_delegate?: string;
    slot?: string;
  }>;
}

/**
 * Full boundary projection: shared NftRow storage rows + structured log + response candidate.
 * This is the production surface under test for Solana key case retention.
 */
export interface DasNormalizedSurfaces {
  readonly storage: ReadonlyArray<NftRow>;
  readonly log: DasNormalizedLogProjection;
  readonly response: CollectionCandidate;
}

export class DasCaseRetentionError extends Data.TaggedError("DasCaseRetentionError")<{
  readonly original: string;
  readonly surface: string;
  readonly reason: string;
}> {}

export type DasNormalizeError =
  | CandidateBuildError
  | ProbeAddressMismatchError
  | DasCaseRetentionError;

const mapTokenStandard = (observation: DasCollectionProbeObservation): string => {
  if (observation.snapshot.members.some((m) => m.compressed)) return "compressed_nft";
  const iface = observation.interfaceName ?? "";
  if (/programmable/i.test(iface)) return "programmable_nft";
  return "metaplex_collection";
};

export const projectDasObservationToLog = (input: {
  readonly capability: RecognizeCapability;
  readonly observation: DasCollectionProbeObservation;
}): DasNormalizedLogProjection => {
  const { capability, observation } = input;
  const sample = observation.snapshot.members[0];
  const fields: DasNormalizedLogProjection["fields"] = {
    collection_mint: observation.snapshot.collectionMint,
    network_namespace: capability.network.network_namespace,
    network_reference: capability.network.network_reference,
    slot: String(observation.snapshot.slot),
    ...(sample !== undefined ? { sample_member_mint: sample.nftMint } : {}),
    ...(sample !== undefined ? { sample_owner: sample.owner } : {}),
    ...(sample !== undefined && sample.delegate !== null
      ? { sample_delegate: sample.delegate }
      : {}),
  };
  return { event: "das_probe_normalized", fields };
};

/**
 * Assert a Solana key retains exact case across projected surfaces.
 * Returns a tagged Effect error — never throws.
 */
export const assertSolanaKeyCaseRetained = (input: {
  readonly original: string;
  readonly surfaces: ReadonlyArray<string>;
}): Effect.Effect<void, DasCaseRetentionError> => {
  const { original, surfaces } = input;
  const folded = original.toLowerCase();
  if (folded === original) return Effect.void;

  for (const surface of surfaces) {
    // A surface containing both the exact key and a lowercased copy is still
    // corrupt; exact presence must not mask a bad duplicate.
    if (surface.includes(folded)) {
      return Effect.fail(
        new DasCaseRetentionError({
          original,
          surface,
          reason: "Solana key was lowercased in projected surface output",
        }),
      );
    }
  }
  return Effect.void;
};

export const normalizeDasCollectionProbe = (input: {
  readonly capability: RecognizeCapability;
  readonly observation: DasCollectionProbeObservation;
  readonly log?: DasNormalizeLogSink;
  readonly collectionKey?: string;
}): Effect.Effect<DasNormalizedSurfaces, DasNormalizeError> => {
  const { capability, observation, log } = input;
  const collectionKey = input.collectionKey ?? "das-probe";
  const { snapshot } = observation;
  const collectionMint = snapshot.collectionMint;
  const sample = snapshot.members[0];

  const logProjection = projectDasObservationToLog({ capability, observation });
  log?.info(logProjection.event, logProjection.fields);

  // Real shared persistence projection (same function the indexer upserts with).
  const storage = toRows(snapshot, collectionKey, observation.observedAt);

  const name = observation.name ?? sample?.name ?? undefined;
  const image = observation.image ?? sample?.image ?? undefined;

  const hit: ProbeHitEvidence = {
    kind: "hit",
    address: collectionMint,
    token_standard: mapTokenStandard(observation),
    ...(name !== undefined ? { name } : {}),
    ...(observation.symbol !== undefined ? { symbol: observation.symbol } : {}),
    ...(image !== undefined ? { image } : {}),
    recognition: "recognized",
    index_status: observation.indexStatus,
    report_readiness: observation.reportReadiness,
    metadata_quality: image !== undefined ? "external_pointer" : "onchain",
    observed_at: observation.observedAt,
    ranking_reasons: ["supported_standard", "onchain_metadata"],
    evidence_material: {
      schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
      adapter: "solana_das",
      collection_mint: collectionMint,
      slot: snapshot.slot,
      source: snapshot.source,
      interface_name: observation.interfaceName ?? null,
      member_count: snapshot.members.length,
      ...(sample !== undefined
        ? {
            sample_nft_mint: sample.nftMint,
            sample_owner: sample.owner,
            sample_delegate: sample.delegate,
            sample_uri: sample.uri,
            sample_compressed: sample.compressed,
          }
        : {}),
    },
  };

  return buildCandidateFromHit({
    capability,
    address: collectionMint,
    hit,
  }).pipe(
    Effect.map((response) => ({
      storage,
      log: logProjection,
      response,
    })),
  );
};
