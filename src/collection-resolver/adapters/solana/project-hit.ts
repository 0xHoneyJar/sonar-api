/**
 * Project bounded DAS sample + optional exact-registry enrichment into
 * ProbeHitEvidence. Omits binding_evidence — Solana DAS recognition cannot
 * truthfully supply a code_digest / finality observation for the CR-102
 * PositiveCacheBinding schema without fabrication.
 *
 * Member NFT name/image are provenance-only — never projected onto
 * CollectionCandidate identity. Collection identity comes from exact registry
 * metadata and/or an explicit bounded `getAsset(collection mint)` observation.
 */
import { parseAsset, type DasAsset } from "../../../svm/nft-collection-source.js";
import type { CollectionConfig } from "../../../svm/collection-registry.js";
import type { NetworkCapability } from "../../capability-registry/schemas.js";
import type { ProbeHitEvidence } from "../../candidate.js";
import { COLLECTION_PROTOCOL_SCHEMA_VERSION } from "../../protocol.js";
import type { DasCollectionAssetObservation } from "./das-port.js";
import type { DasSampleClassification } from "./sample-classifier.js";

export const SOLANA_DAS_ADAPTER_POLICY_VERSION = "solana-das-adapter-policy.v1";
export const SOLANA_DAS_ADAPTER_VERSION = "solana-das.v1";

/** Observed collection-specific index/readiness — never inferred from coverage alone. */
export interface CollectionReadinessObservation {
  readonly index_status: ProbeHitEvidence["index_status"];
  readonly report_readiness: ProbeHitEvidence["report_readiness"];
}

export interface ProjectSolanaDasHitInput {
  readonly collection_mint: string;
  readonly items: ReadonlyArray<DasAsset>;
  /** Requested DAS page limit, retained even when the returned page is short. */
  readonly sample_limit: number;
  readonly classification: DasSampleClassification;
  readonly capability: NetworkCapability;
  readonly registry: CollectionConfig | undefined;
  /** Collection-level metadata from bounded getAsset(collection mint), if any. */
  readonly collection_asset?: DasCollectionAssetObservation;
  /**
   * Distinct injected readiness/index observation. Absent → always
   * missing / preparation_required. Capability is only a ceiling.
   */
  readonly readiness?: CollectionReadinessObservation;
  readonly observed_at: string;
}

/**
 * Capability support is a ceiling only — never auto-upgrade recognized
 * collections (programmable or otherwise) to indexed/ready. CR-402 must
 * supply a distinct collection-specific observation.
 */
export const deriveIndexAndReadiness = (
  capability: NetworkCapability,
  readiness: CollectionReadinessObservation | undefined,
): Pick<ProbeHitEvidence, "index_status" | "report_readiness"> => {
  const ceilingAllows =
    capability.index_support &&
    capability.operations.prepare.enabled &&
    capability.operations.prepare.state === "available";

  if (!ceilingAllows || readiness === undefined) {
    return {
      index_status: "missing",
      report_readiness: "preparation_required",
    };
  }

  return {
    index_status: readiness.index_status,
    report_readiness: readiness.report_readiness,
  };
};

export const projectSolanaDasHit = (
  input: ProjectSolanaDasHitInput,
): ProbeHitEvidence => {
  const {
    collection_mint,
    items,
    sample_limit,
    classification,
    capability,
    registry,
    collection_asset,
    readiness,
    observed_at,
  } = input;

  const sample = items.map(parseAsset).find((m) => m !== null) ?? null;
  // Member NFT metadata is provenance-only — never identity.
  const memberName = sample?.name ?? undefined;
  const memberImage = sample?.image ?? undefined;

  // Identity: exact registry first, else explicit collection-mint getAsset, else omit.
  // Empty registry displayName is missing (?? does not treat "" as absent).
  const name =
    registry !== undefined && registry.displayName !== ""
      ? registry.displayName
      : collection_asset?.name !== undefined && collection_asset.name !== ""
        ? collection_asset.name
        : undefined;
  const symbol =
    registry !== undefined && registry.symbol !== ""
      ? registry.symbol
      : collection_asset?.symbol !== undefined && collection_asset.symbol !== ""
        ? collection_asset.symbol
        : undefined;
  const image =
    collection_asset?.image !== undefined && collection_asset.image !== ""
      ? collection_asset.image
      : undefined;
  const collection_key = registry?.collectionKey;

  const ranking_reasons: string[] = [];
  if (classification.token_standard !== "unknown") {
    ranking_reasons.push("supported_standard");
  }
  if (
    collection_asset?.name !== undefined ||
    collection_asset?.image !== undefined ||
    collection_asset?.symbol !== undefined
  ) {
    ranking_reasons.push("onchain_metadata");
  }
  if (registry !== undefined) {
    ranking_reasons.push("exact_registry_match");
  }

  let metadata_quality: ProbeHitEvidence["metadata_quality"] = "unavailable";
  if (image !== undefined) {
    metadata_quality = "external_pointer";
  } else if (name !== undefined && registry === undefined) {
    metadata_quality = "onchain";
  } else if (registry !== undefined) {
    metadata_quality = "registry_enriched";
  }

  const recognition: ProbeHitEvidence["recognition"] =
    classification.coverage === "unknown" || classification.coverage === "mixed"
      ? "ambiguous"
      : "recognized";

  const { index_status, report_readiness } = deriveIndexAndReadiness(
    capability,
    readiness,
  );

  const hit: ProbeHitEvidence = {
    kind: "hit",
    address: collection_mint,
    token_standard: classification.token_standard,
    ...(name !== undefined ? { name } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    ...(image !== undefined ? { image } : {}),
    ...(collection_key !== undefined ? { collection_key } : {}),
    recognition,
    index_status,
    report_readiness,
    metadata_quality,
    observed_at,
    ranking_reasons,
    evidence_material: {
      schema_version: COLLECTION_PROTOCOL_SCHEMA_VERSION,
      adapter: "solana_das",
      adapter_policy_version: SOLANA_DAS_ADAPTER_POLICY_VERSION,
      adapter_version:
        capability.probe_adapter.adapter_version || SOLANA_DAS_ADAPTER_VERSION,
      collection_mint,
      coverage: classification.coverage,
      token_standard: classification.token_standard,
      dominant_interface: classification.dominant_interface,
      interfaces: classification.interfaces,
      compressed_count: classification.compressed_count,
      sample_size: classification.sample_size,
      sample_page: 1,
      sample_limit,
      index_support: capability.index_support,
      ...(sample !== undefined && sample !== null
        ? {
            sample_nft_mint: sample.nftMint,
            sample_owner: sample.owner,
            sample_delegate: sample.delegate,
            sample_compressed: sample.compressed,
            // Provenance-only — not CollectionCandidate.identity fields.
            ...(memberName !== undefined ? { sample_member_name: memberName } : {}),
            ...(memberImage !== undefined
              ? { sample_member_image: memberImage }
              : {}),
          }
        : {}),
      ...(collection_key !== undefined ? { collection_key } : {}),
      ...(collection_asset !== undefined
        ? {
            collection_asset_observed: true,
            // Observed getAsset result.id — never a request-stamped substitute.
            collection_asset_id: collection_asset.collection_mint,
            ...(collection_asset.name !== undefined
              ? { collection_asset_name: collection_asset.name }
              : {}),
          }
        : { collection_asset_observed: false }),
      readiness_observed: readiness !== undefined,
    },
    // Intentionally omitted: CR-102 PositiveCacheBinding requires code_digest,
    // observed slot/blockhash/finality, etc. DAS sample recognition cannot
    // truthfully supply a Solana code_digest or matching finality observation
    // without fabrication — omit binding so the core refuses positive/readiness
    // cache writes.
  };

  return hit;
};
