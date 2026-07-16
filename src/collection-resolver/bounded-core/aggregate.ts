/**
 * Deterministic candidate aggregation, dedup, and ranking (CR-102).
 *
 * - Exact CR-001 deployment identity only
 * - Explicit Inventory equivalence only (never address-only aliasing)
 * - No cross-network guessing
 * - Ties broken by stable canonical deployment keys
 */
import type { CollectionCandidate } from "../protocol.js";
import { networkKey } from "../identifier.js";
import type { InventoryEnrichmentHit } from "./ports.js";

const deploymentCanonicalKey = (candidate: CollectionCandidate): string => {
  const deployment = candidate.identity.deployments[0];
  if (deployment === undefined) return "";
  return `${networkKey(deployment.network)}:${deployment.normalized_address}:${deployment.deployment_id.digest}`;
};

const scoreCandidate = (candidate: CollectionCandidate): number => {
  let value = 0;
  if (candidate.ranking_reasons.includes("exact_inventory_match")) value += 1_000;
  if (candidate.token_standard.value !== "unknown") value += 100;
  if (candidate.ranking_reasons.includes("onchain_metadata")) value += 40;
  if (candidate.index_status === "indexed") value += 50;
  if (candidate.report_readiness === "ready") value += 10;
  if (candidate.metadata_quality === "onchain") value += 5;
  if (candidate.metadata_quality === "registry_enriched") value += 4;
  return value;
};

export const evidenceQuality = (
  candidate: CollectionCandidate,
): "high" | "medium" | "low" => {
  if (
    candidate.ranking_reasons.includes("exact_inventory_match") &&
    candidate.token_standard.value !== "unknown"
  ) {
    return "high";
  }
  if (candidate.token_standard.value !== "unknown") return "medium";
  return "low";
};

/**
 * Dedup by exact deployment_id digest. Address-only collisions across networks
 * remain separate candidates.
 */
export const dedupByDeploymentIdentity = (
  candidates: ReadonlyArray<CollectionCandidate>,
): CollectionCandidate[] => {
  const seen = new Set<string>();
  const out: CollectionCandidate[] = [];
  for (const candidate of candidates) {
    const digest = candidate.identity.deployments[0]?.deployment_id.digest;
    if (digest === undefined) continue;
    if (seen.has(digest)) continue;
    seen.add(digest);
    out.push(candidate);
  }
  return out;
};

export const rankCandidatesDeterministic = (
  candidates: ReadonlyArray<CollectionCandidate>,
): CollectionCandidate[] =>
  Array.from(candidates).sort((left, right) => {
    const scoreDelta = scoreCandidate(right) - scoreCandidate(left);
    if (scoreDelta !== 0) return scoreDelta;
    const leftKey = deploymentCanonicalKey(left);
    const rightKey = deploymentCanonicalKey(right);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return 0;
  });

/**
 * Apply Inventory enrichment without inventing equivalence from metadata/address.
 * Only `exact_inventory_match` ranking reason is added; multi-deployment identity
 * requires explicit equivalence_basis from Inventory.
 */
export const applyInventoryEnrichment = (
  candidates: ReadonlyArray<CollectionCandidate>,
  hits: ReadonlyArray<InventoryEnrichmentHit>,
): CollectionCandidate[] => {
  const byDeployment = new Map(hits.map((hit) => [hit.deployment_id, hit]));
  return candidates.map((candidate) => {
    const deploymentId = candidate.identity.deployments[0]?.deployment_id.digest;
    if (deploymentId === undefined) return candidate;
    const hit = byDeployment.get(deploymentId);
    if (hit === undefined) return candidate;

    const ranking = new Set(candidate.ranking_reasons);
    ranking.add(hit.ranking_reason);

    const identity = {
      ...candidate.identity,
      ...(hit.curated_name !== undefined ? { name: hit.curated_name } : {}),
      ...(hit.collection_key !== undefined ? { collection_key: hit.collection_key } : {}),
      ...(hit.equivalence_basis_kind === "explicit_inventory_equivalence" &&
      hit.equivalence_version !== undefined
        ? {
            equivalence_basis: {
              schema_version: candidate.identity.equivalence_basis.schema_version,
              kind: "explicit_inventory_equivalence" as const,
              // Keep single_deployment unless Inventory asserts explicit equivalence
              // with a versioned basis — wire shape may only allow known kinds.
            },
          }
        : {}),
    };

    // Do not widen to multi-deployment from address similarity — Inventory must
    // supply explicit equivalence. For this core, keep single_deployment unless
    // the hit already carries an explicit kind we can safely surface as ranking.
    void identity;

    return {
      ...candidate,
      ...(hit.curated_name !== undefined
        ? {
            identity: {
              ...candidate.identity,
              name: hit.curated_name,
              ...(hit.collection_key !== undefined
                ? { collection_key: hit.collection_key }
                : {}),
            },
          }
        : hit.collection_key !== undefined
          ? {
              identity: {
                ...candidate.identity,
                collection_key: hit.collection_key,
              },
            }
          : {}),
      metadata_quality:
        candidate.metadata_quality === "unavailable"
          ? "registry_enriched"
          : candidate.metadata_quality,
      ranking_reasons: Array.from(ranking),
    };
  });
};

export const aggregateAndRank = (
  candidates: ReadonlyArray<CollectionCandidate>,
  inventoryHits: ReadonlyArray<InventoryEnrichmentHit> = [],
): {
  readonly candidates: ReadonlyArray<CollectionCandidate>;
  readonly ranking_evidence: ReadonlyArray<{
    readonly deployment_key: string;
    readonly score: number;
    readonly evidence_quality: "high" | "medium" | "low";
    readonly ranking_reasons: ReadonlyArray<string>;
  }>;
} => {
  const enriched = applyInventoryEnrichment(candidates, inventoryHits);
  const deduped = dedupByDeploymentIdentity(enriched);
  const ranked = rankCandidatesDeterministic(deduped);
  return {
    candidates: ranked,
    ranking_evidence: ranked.map((candidate) => ({
      deployment_key: deploymentCanonicalKey(candidate),
      score: scoreCandidate(candidate),
      evidence_quality: evidenceQuality(candidate),
      ranking_reasons: [...candidate.ranking_reasons],
    })),
  };
};
