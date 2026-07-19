import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

import type { TrustEnvelopeSigner } from "../collection-resolver/trust-protocol.js";
import {
  jcsCanonicalize,
  sha256Hex,
  verifyEd25519Signature,
} from "../collection-resolver/trust-protocol.js";

const encoder = new TextEncoder();
const PLAN_DOMAIN = "sonar-reconcile-seed-v1";
const PLAN_SIGNATURE_DOMAIN = "sonar.reconciliation.plan-signature.v1";
const RECEIPT_SIGNATURE_DOMAIN = "sonar.reconciliation.receipt.v1";
const REVIEW_SIGNATURE_DOMAIN = "sonar.reconciliation.independent-review.v1";
const ATTEMPT_EVENT_SIGNATURE_DOMAIN = "sonar.reconciliation.attempt-event.v1";
const RANDOMNESS_BEACON_SIGNATURE_DOMAIN =
  "sonar.reconciliation.randomness-beacon.v1";
const RANDOMNESS_VRF_DOMAIN = "sonar.reconciliation.randomness-vrf.v1";
const RANDOMNESS_DERIVATION_DOMAIN = "sonar.reconciliation.nonce-derivation.v1";

export type ReconciliationEnvironment = "development" | "staging" | "production";

export interface ReconciliationPrincipalV1 {
  readonly service_id: string;
  readonly key_id: string;
  readonly process_id: string;
  readonly artifact_directory: string;
  readonly network_boundary: string;
}

export interface StatisticalPolicyV1 {
  readonly policy_version: "statistical-policy.v1";
  readonly population_version: string;
  readonly estimand: "SEMANTIC_DEFECT_PREVALENCE";
  readonly tolerable_defect_rate_ppm: "10000";
  readonly adverse_defect_rate_ppm: "50000";
  readonly family_wise_alpha_ppm: "50000";
  readonly multiple_testing_correction: "BONFERRONI";
  readonly minimum_power_ppm: "800000";
  readonly one_sided_test: true;
  readonly finite_population_correction: "EXACT_HYPERGEOMETRIC";
  readonly selection: "DETERMINISTIC_HYPERGEOMETRIC_WITHOUT_REPLACEMENT";
  readonly sample_size_algorithm_version: "hypergeometric-sha256-order.v1";
  readonly golden_vectors_sha256: "cc4ad7a72660885c82ad6105c944602a625b17623054d27f5a2f0129cd065418";
  readonly missing_observation_treatment: "DEFECT";
  readonly integer_rounding: "CEILING";
  readonly defect_rate_prior: null;
}

export const FROZEN_STATISTICAL_POLICY_V1: StatisticalPolicyV1 = Object.freeze({
  policy_version: "statistical-policy.v1",
  population_version: "mibera-transfer-population.v1",
  estimand: "SEMANTIC_DEFECT_PREVALENCE",
  tolerable_defect_rate_ppm: "10000",
  adverse_defect_rate_ppm: "50000",
  family_wise_alpha_ppm: "50000",
  multiple_testing_correction: "BONFERRONI",
  minimum_power_ppm: "800000",
  one_sided_test: true,
  finite_population_correction: "EXACT_HYPERGEOMETRIC",
  selection: "DETERMINISTIC_HYPERGEOMETRIC_WITHOUT_REPLACEMENT",
  sample_size_algorithm_version: "hypergeometric-sha256-order.v1",
  golden_vectors_sha256:
    "cc4ad7a72660885c82ad6105c944602a625b17623054d27f5a2f0129cd065418",
  missing_observation_treatment: "DEFECT",
  integer_rounding: "CEILING",
  defect_rate_prior: null,
});

export const verifyStatisticalPolicyObjectV1 = (
  value: unknown,
  expectedHash: string,
): boolean => {
  try {
    assert(
      typeof value === "object" && value !== null && !Array.isArray(value),
      "statistical policy is not an object",
    );
    const authorizedSamplingScopeDigest = Reflect.get(
      value,
      "authorized_sampling_scope_digest",
    );
    assertDigest(
      authorizedSamplingScopeDigest,
      "authorized_sampling_scope_digest",
    );
    const expected = {
      kind: "statistical_policy",
      schema_version: 1,
      version: FROZEN_STATISTICAL_POLICY_V1.policy_version,
      population_version: FROZEN_STATISTICAL_POLICY_V1.population_version,
      strata_dimensions: ["contract", "event_kind", "semantic_leg"],
      estimand: FROZEN_STATISTICAL_POLICY_V1.estimand,
      tolerable_defect_rate_ppm:
        FROZEN_STATISTICAL_POLICY_V1.tolerable_defect_rate_ppm,
      adverse_defect_rate_ppm:
        FROZEN_STATISTICAL_POLICY_V1.adverse_defect_rate_ppm,
      family_wise_alpha_ppm:
        FROZEN_STATISTICAL_POLICY_V1.family_wise_alpha_ppm,
      multiple_testing_correction:
        FROZEN_STATISTICAL_POLICY_V1.multiple_testing_correction,
      minimum_power_ppm: FROZEN_STATISTICAL_POLICY_V1.minimum_power_ppm,
      one_sided_test: FROZEN_STATISTICAL_POLICY_V1.one_sided_test,
      finite_population_correction:
        FROZEN_STATISTICAL_POLICY_V1.finite_population_correction,
      selection: FROZEN_STATISTICAL_POLICY_V1.selection,
      sample_size_algorithm_version:
        FROZEN_STATISTICAL_POLICY_V1.sample_size_algorithm_version,
      golden_vectors_sha256:
        FROZEN_STATISTICAL_POLICY_V1.golden_vectors_sha256,
      authorized_sampling_scope_digest: authorizedSamplingScopeDigest,
      missing_observation_treatment:
        FROZEN_STATISTICAL_POLICY_V1.missing_observation_treatment,
      integer_rounding: FROZEN_STATISTICAL_POLICY_V1.integer_rounding,
      defect_rate_prior: FROZEN_STATISTICAL_POLICY_V1.defect_rate_prior,
      historical_n_300_is_acceptance_threshold: false,
      high_risk_classes: [
        "CUSTODY_STAKING",
        "PROXY_UPGRADE",
        "SALE",
        "MINT_BURN",
      ],
    };
    return (
      jcsCanonicalize(value) === jcsCanonicalize(expected) &&
      sha256Hex(jcsCanonicalize(value)) === expectedHash
    );
  } catch {
    return false;
  }
};

export interface SamplingStratumV1 {
  readonly stratum_id: string;
  readonly contract: string;
  readonly event_kind: string;
  readonly semantic_leg: string;
  readonly population: string;
  readonly universe_members_digest: string;
  readonly high_risk: boolean;
  readonly empty_proof_hash: string | null;
}

export interface ProducerAuthorizedSamplingScopeV1 {
  readonly producer_snapshot_id: string;
  readonly universe_digest: string;
  readonly universe_size: string;
  readonly mandatory_stratum_count: string;
  readonly strata: readonly SamplingStratumV1[];
}

/**
 * Exact population material the producer authorizes for one signed policy.
 * Reconciler-controlled timestamps, query labels, and principals are excluded.
 */
export const samplingUniverseAuthorizationDigestV1 = (
  scope: ProducerAuthorizedSamplingScopeV1,
): string =>
  sha256Hex(
    jcsCanonicalize({
      producer_snapshot_id: scope.producer_snapshot_id,
      universe_digest: scope.universe_digest,
      universe_size: scope.universe_size,
      mandatory_stratum_count: scope.mandatory_stratum_count,
      strata: scope.strata,
    }),
  );

export interface SamplingTargetV1 {
  readonly stratum_id: string;
  readonly population: string;
  readonly target: string;
  readonly mode: "SAMPLE" | "CENSUS";
  readonly alpha_ppm: string;
  readonly achieved_power_ppm: string;
  readonly reason:
    | "POWERED_SAMPLE"
    | "HIGH_RISK_CENSUS"
    | "UNDERSIZED_CENSUS"
    | "EMPTY_STRATUM_PROVEN";
}

export interface SamplingPlanBodyV1 {
  readonly schema_version: 1;
  readonly environment: ReconciliationEnvironment;
  readonly generation: string;
  readonly invalidation_epoch: string;
  readonly bundle_root_hash: string;
  readonly identity_snapshot_hash: string;
  readonly producer_snapshot_id: string;
  readonly universe_digest: string;
  readonly universe_size: string;
  readonly mandatory_stratum_count: string;
  readonly universe_partition: readonly {
    readonly member_id: string;
    readonly stratum_id: string;
  }[];
  readonly strata: readonly SamplingStratumV1[];
  readonly query_digest: string;
  readonly parameter_digest: string;
  readonly adapter_digest: string;
  readonly statistical_policy_hash: string;
  readonly randomness_round_digest: string;
  readonly randomness_scope_digest: string;
  readonly randomness_beacon_hash: string;
  readonly randomness_witness: ReconciliationPrincipalV1;
  readonly selection_algorithm_version: "hypergeometric-sha256-order.v1";
  readonly policy: StatisticalPolicyV1;
  readonly targets: readonly SamplingTargetV1[];
  readonly reconciler: ReconciliationPrincipalV1;
  readonly producer: ReconciliationPrincipalV1;
  readonly separation_attestation_hash: string;
  readonly committed_at: string;
}

export interface SignedSamplingRandomnessBeaconV1 {
  readonly _tag: "SamplingRandomnessBeaconV1";
  readonly environment: ReconciliationEnvironment;
  readonly generation: string;
  readonly round_digest: string;
  readonly scope_digest: string;
  readonly beacon_value: string;
  readonly vrf_proof: string;
  readonly issued_at: string;
  readonly witness: ReconciliationPrincipalV1;
  readonly signer_key_id: string;
  readonly signature: string;
}

export interface SignedSamplingPlanV1 {
  readonly _tag: "SamplingPlanV1";
  readonly body: SamplingPlanBodyV1;
  readonly nonce_commitment: string;
  readonly signer_key_id: string;
  readonly signature: string;
}

export type SamplingAttemptEventKind =
  | "PLAN_COMMITTED"
  | "QUERY_FINALIZED"
  | "NONCE_REVEALED"
  | "RECEIPT_PUBLISHED";

export interface SamplingAttemptEventV1 {
  readonly attempt_id: string;
  readonly sequence: string;
  readonly kind: SamplingAttemptEventKind;
  readonly plan_hash: string;
  readonly previous_event_hash: string | null;
  readonly actor_service_id: string;
  readonly occurred_at: string;
  readonly payload_digest: string;
  readonly signer_key_id: string;
  readonly signature: string;
}

export interface SamplingAttemptStateV1 {
  readonly plan: SignedSamplingPlanV1;
  readonly plan_hash: string;
  readonly events: readonly SamplingAttemptEventV1[];
  readonly query_finalization: QueryFinalizationV1 | null;
  readonly revealed_nonce: string | null;
  readonly invalidated: boolean;
  readonly invalidation_reason: string | null;
}

export interface QueryFinalizationV1 {
  readonly plan_hash: string;
  readonly environment: ReconciliationEnvironment;
  readonly generation: string;
  readonly invalidation_epoch: string;
  readonly bundle_root_hash: string;
  readonly identity_snapshot_hash: string;
  readonly producer_snapshot_id: string;
  readonly universe_digest: string;
  readonly query_digest: string;
  readonly parameter_digest: string;
  readonly adapter_digest: string;
  readonly statistical_policy_hash: string;
  readonly source_snapshot_hash: string;
  readonly projection_snapshot_hash: string;
  readonly finalized_at: string;
}

export interface ReconciliationObservationV1 {
  readonly stratum_id: string;
  readonly member_id: string;
  readonly observed: boolean;
  readonly semantic_match: boolean;
  readonly identity_match: boolean;
  readonly provenance_complete: boolean;
}

export interface StratumReconciliationResultV1 {
  readonly stratum_id: string;
  readonly mode: "SAMPLE" | "CENSUS";
  readonly population: string;
  readonly expected_observations: string;
  readonly observed: string;
  readonly defects: string;
  readonly membership_digest: string;
  readonly census_complete: boolean;
  readonly decision:
    | "PASS"
    | "CENSUS_REQUIRED"
    | "NOT_READY_INCOMPLETE_CENSUS"
    | "NOT_READY_DEFECTIVE_CENSUS"
    | "UNKNOWN_INCOMPLETE_CENSUS";
}

export interface FootprintCountInputV1 {
  readonly entity: string;
  readonly source_count: string;
  readonly projection_count: string;
  readonly low_cardinality: boolean;
  readonly absolute_floor: string;
}

export interface FootprintCountResultV1 extends FootprintCountInputV1 {
  readonly relative_tolerance_ppm: "1000";
  readonly tolerance_count: string;
  readonly passed: boolean;
}

export const FROZEN_FOOTPRINT_POLICY_V1 = Object.freeze([
  {
    entity: "MiberaTransfer",
    low_cardinality: false,
    absolute_floor: "50",
  },
  {
    entity: "MintActivity",
    low_cardinality: false,
    absolute_floor: "25",
  },
  {
    entity: "NftBurn",
    low_cardinality: true,
    absolute_floor: "0",
  },
  {
    entity: "BgtBoostEvent",
    low_cardinality: false,
    absolute_floor: "500",
  },
  {
    entity: "Erc1155MintEvent",
    low_cardinality: false,
    absolute_floor: "25",
  },
  {
    entity: "FriendtechTrade",
    low_cardinality: true,
    absolute_floor: "0",
  },
  {
    entity: "PaddleSupply",
    low_cardinality: true,
    absolute_floor: "0",
  },
  {
    entity: "MintEvent",
    low_cardinality: true,
    absolute_floor: "0",
  },
  {
    entity: "TreasuryActivity",
    low_cardinality: false,
    absolute_floor: "25",
  },
  {
    entity: "Action",
    low_cardinality: false,
    absolute_floor: "500",
  },
  {
    entity: "MiberaLoan",
    low_cardinality: true,
    absolute_floor: "0",
  },
  {
    entity: "MiberaStakedToken",
    low_cardinality: true,
    absolute_floor: "0",
  },
] as const);

export interface ReconciliationReceiptBodyV1 {
  readonly schema_version: 1;
  readonly environment: ReconciliationEnvironment;
  readonly generation: string;
  readonly invalidation_epoch: string;
  readonly bundle_root_hash: string;
  readonly identity_snapshot_hash: string;
  readonly producer_snapshot_id: string;
  readonly plan_hash: string;
  readonly attempt_events_digest: string;
  readonly query_finalization_digest: string;
  readonly nonce_commitment: string;
  readonly universe_digest: string;
  readonly source_snapshot_hash: string;
  readonly projection_snapshot_hash: string;
  readonly query_digest: string;
  readonly adapter_digest: string;
  readonly statistical_policy_hash: string;
  readonly nonce: string;
  readonly strata: readonly StratumReconciliationResultV1[];
  readonly mismatch_examples: readonly ReconciliationObservationV1[];
  readonly footprint_counts: readonly FootprintCountResultV1[];
  readonly limitations: readonly string[];
  readonly decision:
    | "RECONCILED_STAGED"
    | "CENSUS_REQUIRED"
    | "NOT_READY"
    | "UNKNOWN";
  readonly retry_owner: string | null;
  readonly retry_deadline: string | null;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly authority_valid: false;
}

export interface SignedReconciliationReceiptV1 {
  readonly _tag: "ReconciliationReceiptV1";
  readonly body: ReconciliationReceiptBodyV1;
  readonly signer_key_id: string;
  readonly signature: string;
}

export interface PublishedReconciliationReceiptV1 {
  readonly receipt: SignedReconciliationReceiptV1;
  readonly completed_attempt: SamplingAttemptStateV1;
}

export interface IndependentReviewReceiptV1 {
  readonly _tag: "IndependentReconciliationReviewV1";
  readonly reconciliation_receipt_hash: string;
  readonly reviewer_principal: ReconciliationPrincipalV1;
  readonly producer_principal: ReconciliationPrincipalV1;
  readonly reviewed_at: string;
  readonly verdict: "APPROVED" | "REJECTED";
  readonly signer_key_id: string;
  readonly signature: string;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

const assert: (condition: unknown, reason: string) => asserts condition = (
  condition,
  reason,
) => {
  if (!condition) throw new Error(reason);
};

const assertDigest = (value: string, field: string): void =>
  assert(HEX_64.test(value), `${field} must be a lowercase SHA-256 digest`);

const parseCount = (value: string, field: string): number => {
  assert(UINT.test(value), `${field} must be a canonical unsigned integer`);
  const count = Number(value);
  assert(Number.isSafeInteger(count) && count >= 0, `${field} exceeds safe statistical range`);
  return count;
};

const parseInstant = (value: string, field: string): number => {
  const instant = Date.parse(value);
  assert(Number.isFinite(instant), `${field} must be an ISO timestamp`);
  return instant;
};

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

const assertExactKeys = (
  value: object,
  expected: readonly string[],
  boundary: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]),
    `${boundary} contains missing or unknown fields`,
  );
};

const assertDistinctPrincipals = (
  reconciler: ReconciliationPrincipalV1,
  producer: ReconciliationPrincipalV1,
): void => {
  for (const field of [
    "service_id",
    "key_id",
    "process_id",
    "artifact_directory",
    "network_boundary",
  ] as const) {
    assert(
      reconciler[field] !== producer[field],
      `reconciler ${field} must be distinct from producer`,
    );
  }
};

interface ExactRational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const probabilityOfZeroDefects = (
  population: number,
  defects: number,
  sample: number,
): ExactRational => {
  if (sample > population || sample > population - defects) {
    return { numerator: 0n, denominator: 1n };
  }
  if (defects <= 0) return { numerator: 1n, denominator: 1n };
  let numerator = 1n;
  let denominator = 1n;
  for (let index = 0; index < sample; index += 1) {
    numerator *= BigInt(population - defects - index);
    denominator *= BigInt(population - index);
  }
  return { numerator, denominator };
};

const semanticLegIsHighRisk = (semanticLeg: string): boolean => {
  const normalized = semanticLeg.toUpperCase();
  return ["CUSTODY", "STAKING", "PROXY", "SALE", "MINT", "BURN"].some(
    (marker) => normalized.includes(marker),
  );
};

/**
 * Deterministic finite-population design. A sample must both reject prevalence
 * above 1% at the Bonferroni-adjusted one-sided alpha and detect the frozen 5%
 * adverse alternative with at least 80% power. Otherwise the stratum is census.
 */
export const calculateSamplingTargetV1 = (
  stratum: SamplingStratumV1,
  stratumCount: number,
): SamplingTargetV1 => {
  assert(Number.isSafeInteger(stratumCount) && stratumCount > 0, "stratum count is invalid");
  const population = parseCount(stratum.population, "stratum.population");
  if (population === 0) {
    assert(
      stratum.empty_proof_hash !== null && HEX_64.test(stratum.empty_proof_hash),
      "empty stratum requires a signed proof digest",
    );
    return {
      stratum_id: stratum.stratum_id,
      population: "0",
      target: "0",
      mode: "CENSUS",
      alpha_ppm: String(Math.ceil(50_000 / stratumCount)),
      achieved_power_ppm: "1000000",
      reason: "EMPTY_STRATUM_PROVEN",
    };
  }
  const tolerableDefects = Math.min(population, Math.floor(population / 100) + 1);
  const adverseDefects = Math.min(population, Math.floor((population + 19) / 20));
  const alphaDenominator = BigInt(20 * stratumCount);
  const alphaPpm = String(Math.ceil(50_000 / stratumCount));

  if (stratum.high_risk) {
    return {
      stratum_id: stratum.stratum_id,
      population: stratum.population,
      target: stratum.population,
      mode: "CENSUS",
      alpha_ppm: alphaPpm,
      achieved_power_ppm: "1000000",
      reason: "HIGH_RISK_CENSUS",
    };
  }

  for (let sample = 1; sample < population; sample += 1) {
    const falseClean = probabilityOfZeroDefects(
      population,
      tolerableDefects,
      sample,
    );
    const adverseClean = probabilityOfZeroDefects(population, adverseDefects, sample);
    const satisfiesAlpha =
      falseClean.numerator * alphaDenominator <= falseClean.denominator;
    const satisfiesPower = adverseClean.numerator * 5n <= adverseClean.denominator;
    if (satisfiesAlpha && satisfiesPower) {
      const achievedPowerPpm =
        ((adverseClean.denominator - adverseClean.numerator) * 1_000_000n) /
        adverseClean.denominator;
      return {
        stratum_id: stratum.stratum_id,
        population: stratum.population,
        target: String(sample),
        mode: "SAMPLE",
        alpha_ppm: alphaPpm,
        achieved_power_ppm: String(achievedPowerPpm),
        reason: "POWERED_SAMPLE",
      };
    }
  }

  return {
    stratum_id: stratum.stratum_id,
    population: stratum.population,
    target: stratum.population,
    mode: "CENSUS",
    alpha_ppm: alphaPpm,
    achieved_power_ppm: "1000000",
    reason: "UNDERSIZED_CENSUS",
  };
};

const validateSamplingPlanBodyV1 = (body: SamplingPlanBodyV1): void => {
  assertExactKeys(
    body,
    [
      "schema_version",
      "environment",
      "generation",
      "invalidation_epoch",
      "bundle_root_hash",
      "identity_snapshot_hash",
      "producer_snapshot_id",
      "universe_digest",
      "universe_size",
      "mandatory_stratum_count",
      "universe_partition",
      "strata",
      "query_digest",
      "parameter_digest",
      "adapter_digest",
      "statistical_policy_hash",
      "randomness_round_digest",
      "randomness_scope_digest",
      "randomness_beacon_hash",
      "randomness_witness",
      "selection_algorithm_version",
      "policy",
      "targets",
      "reconciler",
      "producer",
      "separation_attestation_hash",
      "committed_at",
    ],
    "sampling plan body",
  );
  assert(body.schema_version === 1, "unsupported sampling plan schema");
  assert(
    body.environment === "development" ||
      body.environment === "staging" ||
      body.environment === "production",
    "invalid plan environment",
  );
  parseCount(body.generation, "generation");
  parseCount(body.invalidation_epoch, "invalidation_epoch");
  assert(body.selection_algorithm_version === "hypergeometric-sha256-order.v1", "algorithm drift");
  assert(
    jcsCanonicalize(body.policy) === jcsCanonicalize(FROZEN_STATISTICAL_POLICY_V1),
    "statistical policy drift",
  );
  assertExactKeys(
    body.policy,
    [
      "policy_version",
      "population_version",
      "estimand",
      "tolerable_defect_rate_ppm",
      "adverse_defect_rate_ppm",
      "family_wise_alpha_ppm",
      "multiple_testing_correction",
      "minimum_power_ppm",
      "one_sided_test",
      "finite_population_correction",
      "selection",
      "sample_size_algorithm_version",
      "golden_vectors_sha256",
      "missing_observation_treatment",
      "integer_rounding",
      "defect_rate_prior",
    ],
    "statistical policy",
  );
  for (const [label, principal] of [
    ["reconciler", body.reconciler],
    ["producer", body.producer],
  ] as const) {
    assertExactKeys(
      principal,
      ["service_id", "key_id", "process_id", "artifact_directory", "network_boundary"],
      `${label} principal`,
    );
  }
  assertDistinctPrincipals(body.reconciler, body.producer);
  assertDistinctPrincipals(body.randomness_witness, body.reconciler);
  assertDistinctPrincipals(body.randomness_witness, body.producer);
  assert(body.strata.length > 0, "sampling plan requires at least one stratum");
  assert(
    body.mandatory_stratum_count === String(body.strata.length),
    "mandatory stratum count mismatch",
  );
  assert(unique(body.strata.map((stratum) => stratum.stratum_id)), "duplicate stratum id");
  assert(
    unique(
      body.strata.map(
        (stratum) => `${stratum.contract}\0${stratum.event_kind}\0${stratum.semantic_leg}`,
      ),
    ),
    "duplicate contract-event-semantic-leg tuple",
  );
  for (const stratum of body.strata) {
    assertExactKeys(
      stratum,
      [
        "stratum_id",
        "contract",
        "event_kind",
        "semantic_leg",
        "population",
        "universe_members_digest",
        "high_risk",
        "empty_proof_hash",
      ],
      "sampling stratum",
    );
    assert(
      stratum.high_risk === semanticLegIsHighRisk(stratum.semantic_leg),
      `high-risk classification mismatch: ${stratum.stratum_id}`,
    );
  }
  assert(
    [...body.strata.map((stratum) => stratum.stratum_id)].sort().join("\0") ===
      body.strata.map((stratum) => stratum.stratum_id).join("\0"),
    "strata must be ordered by stratum id",
  );
  for (const digest of [
    body.bundle_root_hash,
    body.identity_snapshot_hash,
    body.universe_digest,
    body.query_digest,
    body.parameter_digest,
    body.adapter_digest,
    body.statistical_policy_hash,
    body.randomness_round_digest,
    body.randomness_scope_digest,
    body.randomness_beacon_hash,
    body.separation_attestation_hash,
    ...body.strata.map((stratum) => stratum.universe_members_digest),
  ]) {
    assertDigest(digest, "sampling plan digest");
  }
  const universeSize = parseCount(body.universe_size, "universe_size");
  assert(body.universe_partition.length === universeSize, "universe size mismatch");
  assert(
    unique(body.universe_partition.map((member) => member.member_id)),
    "universe member overlap or duplicate",
  );
  for (const member of body.universe_partition) {
    assertExactKeys(member, ["member_id", "stratum_id"], "universe partition member");
  }
  assert(
    [...body.universe_partition]
      .sort(
        (left, right) =>
          left.stratum_id.localeCompare(right.stratum_id) ||
          left.member_id.localeCompare(right.member_id),
      )
      .map((member) => `${member.stratum_id}:${member.member_id}`)
      .join("\0") ===
      body.universe_partition.map((member) => `${member.stratum_id}:${member.member_id}`).join("\0"),
    "universe partition must be canonically ordered",
  );
  assert(
    sha256Hex(jcsCanonicalize(body.universe_partition)) === body.universe_digest,
    "universe digest does not bind partition",
  );
  for (const stratum of body.strata) {
    const members = body.universe_partition.filter(
      (member) => member.stratum_id === stratum.stratum_id,
    );
    assert(
      members.length === parseCount(stratum.population, "stratum.population"),
      `stratum population mismatch: ${stratum.stratum_id}`,
    );
    if (members.length > 0) {
      assert(stratum.empty_proof_hash === null, "non-empty stratum has empty proof");
    }
    assert(
      sha256Hex(jcsCanonicalize(members.map((member) => member.member_id))) ===
        stratum.universe_members_digest,
      `stratum member digest mismatch: ${stratum.stratum_id}`,
    );
  }
  assert(
    body.universe_partition.every((member) =>
      body.strata.some((stratum) => stratum.stratum_id === member.stratum_id),
    ),
    "universe contains an unrecognized stratum",
  );
  const expectedTargets = body.strata.map((stratum) =>
    calculateSamplingTargetV1(stratum, body.strata.length),
  );
  for (const target of body.targets) {
    assertExactKeys(
      target,
      [
        "stratum_id",
        "population",
        "target",
        "mode",
        "alpha_ppm",
        "achieved_power_ppm",
        "reason",
      ],
      "sampling target",
    );
  }
  assert(
    jcsCanonicalize(body.targets) === jcsCanonicalize(expectedTargets),
    "sampling targets do not match frozen policy",
  );
  parseInstant(body.committed_at, "committed_at");
};

type SamplingPlanInputV1 = Omit<
  SamplingPlanBodyV1,
  | "targets"
  | "policy"
  | "randomness_round_digest"
  | "randomness_scope_digest"
  | "randomness_beacon_hash"
  | "randomness_witness"
>;

export const samplingPlanScopeDigestV1 = (
  input: SamplingPlanInputV1,
): string => samplingRandomnessRoundDigestV1(input);

export const samplingRandomnessRoundDigestV1 = (
  input: SamplingPlanInputV1,
): string =>
  sha256Hex(
    jcsCanonicalize({
      environment: input.environment,
      generation: input.generation,
      invalidation_epoch: input.invalidation_epoch,
      bundle_root_hash: input.bundle_root_hash,
      identity_snapshot_hash: input.identity_snapshot_hash,
      statistical_policy_hash: input.statistical_policy_hash,
    }),
  );

const samplingPlanInputFromBodyV1 = (
  body: SamplingPlanBodyV1,
): SamplingPlanInputV1 => {
  const {
    targets: _targets,
    policy: _policy,
    randomness_round_digest: _randomnessRoundDigest,
    randomness_scope_digest: _randomnessScopeDigest,
    randomness_beacon_hash: _randomnessBeaconHash,
    randomness_witness: _randomnessWitness,
    ...input
  } = body;
  return input;
};

const randomnessBeaconSigningBytes = (
  beacon: Omit<SignedSamplingRandomnessBeaconV1, "signature" | "signer_key_id">,
): Uint8Array =>
  encoder.encode(
    `${RANDOMNESS_BEACON_SIGNATURE_DOMAIN}\0${beacon.environment}\0${beacon.generation}\0${beacon.round_digest}\0${beacon.scope_digest}\0${sha256Hex(jcsCanonicalize(beacon))}`,
  );

const randomnessVrfSigningBytes = (roundDigest: string): Uint8Array =>
  encoder.encode(`${RANDOMNESS_VRF_DOMAIN}\0${roundDigest}`);

type SamplingRandomnessBeaconIssueInputV1 = Omit<
  SignedSamplingRandomnessBeaconV1,
  | "_tag"
  | "beacon_value"
  | "vrf_proof"
  | "signer_key_id"
  | "signature"
>;

const compileSamplingRandomnessBeaconV1 = (
  input: SamplingRandomnessBeaconIssueInputV1,
  signer: TrustEnvelopeSigner,
): SignedSamplingRandomnessBeaconV1 => {
  assert(input.witness.key_id === signer.keyId, "randomness witness signer mismatch");
  assertDigest(input.round_digest, "randomness round_digest");
  assertDigest(input.scope_digest, "randomness scope_digest");
  parseInstant(input.issued_at, "randomness issued_at");
  const vrfProof = signer.sign(randomnessVrfSigningBytes(input.round_digest));
  const unsigned = {
    _tag: "SamplingRandomnessBeaconV1" as const,
    ...input,
    beacon_value: sha256Hex(vrfProof),
    vrf_proof: vrfProof,
  };
  return {
    ...unsigned,
    signer_key_id: signer.keyId,
    signature: signer.sign(randomnessBeaconSigningBytes(unsigned)),
  };
};

/**
 * Witness-owned, fsynced one-beacon-per-generation-round journal. Callers never
 * supply entropy. The Ed25519 proof deterministically fixes one unpredictable
 * value per round. Scope is exactly the immutable round, so even journal
 * rollback cannot substitute a caller-selected scope or sample.
 */
export class SamplingRandomnessBeaconLedgerV1 {
  readonly #directory: string;
  readonly #witness: ReconciliationPrincipalV1;

  constructor(witness: ReconciliationPrincipalV1) {
    assert(
      isAbsolute(witness.artifact_directory),
      "randomness witness artifact directory must be absolute",
    );
    mkdirSync(witness.artifact_directory, { recursive: true, mode: 0o700 });
    const link = lstatSync(witness.artifact_directory);
    assert(
      link.isDirectory() && !link.isSymbolicLink(),
      "randomness witness artifact directory is not a real directory",
    );
    const witnessRealpath = realpathSync(witness.artifact_directory);
    const witnessStat = statSync(witnessRealpath);
    assert(
      (witnessStat.mode & 0o022) === 0,
      "randomness witness artifact directory is group/world writable",
    );
    if (typeof process.getuid === "function") {
      assert(
        witnessStat.uid === process.getuid(),
        "randomness witness artifact directory owner mismatch",
      );
    }
    this.#directory = join(witnessRealpath, "beacons-v1");
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const journalLink = lstatSync(this.#directory);
    assert(
      journalLink.isDirectory() && !journalLink.isSymbolicLink(),
      "randomness beacon journal is not a real directory",
    );
    const journalRealpath = realpathSync(this.#directory);
    const journalStat = statSync(journalRealpath);
    assert(
      (journalStat.mode & 0o022) === 0,
      "randomness beacon journal is group/world writable",
    );
    if (typeof process.getuid === "function") {
      assert(
        journalStat.uid === process.getuid(),
        "randomness beacon journal owner mismatch",
      );
    }
    assert(
      journalRealpath === this.#directory,
      "randomness beacon journal realpath mismatch",
    );
    this.#witness = witness;
  }

  #path(roundDigest: string): string {
    assertDigest(roundDigest, "randomness round_digest");
    return join(this.#directory, `${roundDigest}.json`);
  }

  #syncDirectory(): void {
    const descriptor = openSync(this.#directory, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  issue(
    input: SamplingRandomnessBeaconIssueInputV1,
    signer: TrustEnvelopeSigner,
  ): SignedSamplingRandomnessBeaconV1 {
    assert(
      jcsCanonicalize(input.witness) === jcsCanonicalize(this.#witness),
      "randomness beacon ledger witness mismatch",
    );
    assert(
      input.scope_digest === input.round_digest,
      "randomness scope must equal the producer-authorized round",
    );
    const beacon = compileSamplingRandomnessBeaconV1(input, signer);
    const path = this.#path(input.round_digest);
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx", 0o600);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new Error("randomness round already has an issued beacon");
      }
      throw error;
    }
    try {
      writeSync(descriptor, `${jcsCanonicalize(beacon)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.#syncDirectory();
    return beacon;
  }

  read(roundDigest: string): SignedSamplingRandomnessBeaconV1 | undefined {
    const path = this.#path(roundDigest);
    if (!existsSync(path)) return undefined;
    return JSON.parse(
      readFileSync(path, "utf8"),
    ) as SignedSamplingRandomnessBeaconV1;
  }
}

export const verifySamplingRandomnessBeaconV1 = (
  beacon: SignedSamplingRandomnessBeaconV1,
  expectedRoundDigest: string,
  expectedScopeDigest: string,
  expectedWitness: ReconciliationPrincipalV1,
  publicKeyHex: string,
): boolean => {
  try {
    assertExactKeys(
      beacon,
      [
        "_tag",
        "environment",
        "generation",
        "round_digest",
        "scope_digest",
        "beacon_value",
        "vrf_proof",
        "issued_at",
        "witness",
        "signer_key_id",
        "signature",
      ],
      "sampling randomness beacon",
    );
    assert(beacon._tag === "SamplingRandomnessBeaconV1", "wrong randomness beacon tag");
    assert(beacon.round_digest === expectedRoundDigest, "randomness round mismatch");
    assert(beacon.scope_digest === expectedScopeDigest, "randomness scope mismatch");
    assert(
      jcsCanonicalize(beacon.witness) === jcsCanonicalize(expectedWitness),
      "unexpected randomness witness",
    );
    assert(beacon.signer_key_id === expectedWitness.key_id, "unexpected witness key");
    assertDigest(beacon.beacon_value, "randomness beacon_value");
    assert(
      beacon.beacon_value === sha256Hex(beacon.vrf_proof) &&
        verifyEd25519Signature(
          publicKeyHex,
          randomnessVrfSigningBytes(beacon.round_digest),
          beacon.vrf_proof,
        ),
      "randomness VRF proof is invalid",
    );
    const { signature, signer_key_id: _key, ...unsigned } = beacon;
    return verifyEd25519Signature(
      publicKeyHex,
      randomnessBeaconSigningBytes(unsigned),
      signature,
    );
  } catch {
    return false;
  }
};

export const deriveSamplingNonceV1 = (
  scopeDigest: string,
  beaconValue: string,
): string => {
  assertDigest(scopeDigest, "randomness scope_digest");
  assertDigest(beaconValue, "randomness beacon_value");
  return sha256Hex(`${RANDOMNESS_DERIVATION_DOMAIN}\0${scopeDigest}\0${beaconValue}`);
};

const samplingCommitment = (body: SamplingPlanBodyV1, nonce: string): string =>
  sha256Hex(`${PLAN_DOMAIN}${jcsCanonicalize(body)}${nonce}`);

const planSigningBytes = (
  body: SamplingPlanBodyV1,
  commitment: string,
): Uint8Array =>
  encoder.encode(
    `${PLAN_SIGNATURE_DOMAIN}\0${body.environment}\0${body.generation}\0${commitment}\0${sha256Hex(jcsCanonicalize(body))}`,
  );

export const compileSignedSamplingPlanV1 = (
  input: SamplingPlanInputV1,
  beacon: SignedSamplingRandomnessBeaconV1,
  witnessPublicKeyHex: string,
  signer: TrustEnvelopeSigner,
): SignedSamplingPlanV1 => {
  assert(input.reconciler.key_id === signer.keyId, "reconciler signer key mismatch");
  assertDistinctPrincipals(input.reconciler, input.producer);
  assertDistinctPrincipals(beacon.witness, input.reconciler);
  assertDistinctPrincipals(beacon.witness, input.producer);
  const randomnessScopeDigest = samplingPlanScopeDigestV1(input);
  const randomnessRoundDigest = samplingRandomnessRoundDigestV1(input);
  assert(
    verifySamplingRandomnessBeaconV1(
      beacon,
      randomnessRoundDigest,
      randomnessScopeDigest,
      beacon.witness,
      witnessPublicKeyHex,
    ),
    "randomness beacon is untrusted",
  );
  assert(
    beacon.environment === input.environment &&
      beacon.generation === input.generation,
    "randomness beacon context mismatch",
  );
  assert(
    Date.parse(beacon.issued_at) <= Date.parse(input.committed_at),
    "randomness beacon postdates plan commitment",
  );
  const nonce = deriveSamplingNonceV1(randomnessScopeDigest, beacon.beacon_value);
  assert(input.strata.length > 0, "sampling plan requires at least one stratum");
  assert(
    input.mandatory_stratum_count === String(input.strata.length),
    "mandatory stratum count mismatch",
  );
  assert(unique(input.strata.map((stratum) => stratum.stratum_id)), "duplicate stratum id");
  assert(
    [...input.strata.map((stratum) => stratum.stratum_id)].sort().join("\0") ===
      input.strata.map((stratum) => stratum.stratum_id).join("\0"),
    "strata must be ordered by stratum id",
  );
  for (const digest of [
    input.bundle_root_hash,
    input.identity_snapshot_hash,
    input.universe_digest,
    input.query_digest,
    input.parameter_digest,
    input.adapter_digest,
    input.statistical_policy_hash,
    input.separation_attestation_hash,
    ...input.strata.map((stratum) => stratum.universe_members_digest),
  ]) {
    assertDigest(digest, "sampling plan digest");
  }
  const universeSize = parseCount(input.universe_size, "universe_size");
  assert(input.universe_partition.length === universeSize, "universe size mismatch");
  assert(
    unique(input.universe_partition.map((member) => member.member_id)),
    "universe member overlap or duplicate",
  );
  assert(
    [...input.universe_partition]
      .sort(
        (left, right) =>
          left.stratum_id.localeCompare(right.stratum_id) ||
          left.member_id.localeCompare(right.member_id),
      )
      .map((member) => `${member.stratum_id}:${member.member_id}`)
      .join("\0") ===
      input.universe_partition.map((member) => `${member.stratum_id}:${member.member_id}`).join("\0"),
    "universe partition must be canonically ordered",
  );
  assert(
    sha256Hex(jcsCanonicalize(input.universe_partition)) === input.universe_digest,
    "universe digest does not bind partition",
  );
  for (const stratum of input.strata) {
    const members = input.universe_partition.filter(
      (member) => member.stratum_id === stratum.stratum_id,
    );
    assert(
      members.length === parseCount(stratum.population, "stratum.population"),
      `stratum population mismatch: ${stratum.stratum_id}`,
    );
    assert(
      sha256Hex(jcsCanonicalize(members.map((member) => member.member_id))) ===
        stratum.universe_members_digest,
      `stratum member digest mismatch: ${stratum.stratum_id}`,
    );
  }
  assert(
    input.universe_partition.every((member) =>
      input.strata.some((stratum) => stratum.stratum_id === member.stratum_id),
    ),
    "universe contains an unrecognized stratum",
  );
  parseInstant(input.committed_at, "committed_at");
  const targets = input.strata.map((stratum) =>
    calculateSamplingTargetV1(stratum, input.strata.length),
  );
  const body: SamplingPlanBodyV1 = {
    ...input,
    randomness_round_digest: randomnessRoundDigest,
    randomness_scope_digest: randomnessScopeDigest,
    randomness_beacon_hash: sha256Hex(jcsCanonicalize(beacon)),
    randomness_witness: beacon.witness,
    policy: FROZEN_STATISTICAL_POLICY_V1,
    targets,
  };
  validateSamplingPlanBodyV1(body);
  const nonceCommitment = samplingCommitment(body, nonce);
  return {
    _tag: "SamplingPlanV1",
    body,
    nonce_commitment: nonceCommitment,
    signer_key_id: signer.keyId,
    signature: signer.sign(planSigningBytes(body, nonceCommitment)),
  };
};

export const verifySignedSamplingPlanV1 = (
  plan: SignedSamplingPlanV1,
  publicKeyHex: string,
  expectedReconciler: ReconciliationPrincipalV1,
  beacon: SignedSamplingRandomnessBeaconV1,
  expectedWitness: ReconciliationPrincipalV1,
  witnessPublicKeyHex: string,
): boolean => {
  try {
    assertExactKeys(
      plan,
      ["_tag", "body", "nonce_commitment", "signer_key_id", "signature"],
      "sampling plan",
    );
    assert(plan._tag === "SamplingPlanV1", "wrong plan tag");
    validateSamplingPlanBodyV1(plan.body);
    assert(plan.signer_key_id === plan.body.reconciler.key_id, "plan signer mismatch");
    assert(plan.signer_key_id === expectedReconciler.key_id, "unexpected reconciler key");
    assert(
      jcsCanonicalize(plan.body.reconciler) === jcsCanonicalize(expectedReconciler),
      "unexpected reconciler principal",
    );
    assertDistinctPrincipals(plan.body.reconciler, plan.body.producer);
    assertDistinctPrincipals(plan.body.randomness_witness, plan.body.reconciler);
    assertDistinctPrincipals(plan.body.randomness_witness, plan.body.producer);
    assert(
      jcsCanonicalize(plan.body.randomness_witness) ===
        jcsCanonicalize(expectedWitness),
      "unexpected plan randomness witness",
    );
    assert(
      plan.body.randomness_round_digest ===
        samplingRandomnessRoundDigestV1(samplingPlanInputFromBodyV1(plan.body)),
      "randomness round does not bind immutable generation scope",
    );
    assert(
      plan.body.randomness_beacon_hash === sha256Hex(jcsCanonicalize(beacon)),
      "randomness beacon hash mismatch",
    );
    assert(
      verifySamplingRandomnessBeaconV1(
        beacon,
        plan.body.randomness_round_digest,
        plan.body.randomness_scope_digest,
        expectedWitness,
        witnessPublicKeyHex,
      ),
      "randomness beacon is untrusted",
    );
    assert(
      beacon.environment === plan.body.environment &&
        beacon.generation === plan.body.generation,
      "randomness beacon context mismatch",
    );
    assert(
      Date.parse(beacon.issued_at) <= Date.parse(plan.body.committed_at),
      "randomness beacon postdates plan commitment",
    );
    assert(
      plan.body.randomness_scope_digest ===
        samplingPlanScopeDigestV1(samplingPlanInputFromBodyV1(plan.body)),
      "randomness scope does not bind plan input",
    );
    assertDigest(plan.nonce_commitment, "nonce_commitment");
    return verifyEd25519Signature(
      publicKeyHex,
      planSigningBytes(plan.body, plan.nonce_commitment),
      plan.signature,
    );
  } catch {
    return false;
  }
};

export const revealSamplingNonceV1 = (
  plan: SignedSamplingPlanV1,
  nonce: string,
): boolean =>
  HEX_64.test(nonce) && samplingCommitment(plan.body, nonce) === plan.nonce_commitment;

export const deterministicSampleMembersV1 = (
  members: readonly string[],
  target: number,
  nonce: string,
  stratumId: string,
): readonly string[] => {
  assert(unique(members), "sampling universe contains duplicate members");
  assert(target >= 0 && target <= members.length, "sample target exceeds universe");
  return [...members]
    .sort((left, right) => {
      const leftHash = sha256Hex(`${nonce}\0${stratumId}\0${left}`);
      const rightHash = sha256Hex(`${nonce}\0${stratumId}\0${right}`);
      return leftHash === rightHash ? left.localeCompare(right) : leftHash.localeCompare(rightHash);
    })
    .slice(0, target);
};

const eventOrder: readonly SamplingAttemptEventKind[] = [
  "PLAN_COMMITTED",
  "QUERY_FINALIZED",
  "NONCE_REVEALED",
  "RECEIPT_PUBLISHED",
];

const attemptEventSigningBytes = (
  event: Omit<SamplingAttemptEventV1, "signature">,
): Uint8Array =>
  encoder.encode(
    `${ATTEMPT_EVENT_SIGNATURE_DOMAIN}\0${event.attempt_id}\0${event.sequence}\0${sha256Hex(jcsCanonicalize(event))}`,
  );

const compileSamplingAttemptEventV1 = (
  event: Omit<SamplingAttemptEventV1, "signer_key_id" | "signature">,
  signer: TrustEnvelopeSigner,
): SamplingAttemptEventV1 => {
  const unsigned = { ...event, signer_key_id: signer.keyId };
  return {
    ...unsigned,
    signature: signer.sign(attemptEventSigningBytes(unsigned)),
  };
};

export const createSamplingAttemptV1 = (
  plan: SignedSamplingPlanV1,
  occurredAt: string,
  signer: TrustEnvelopeSigner,
): SamplingAttemptStateV1 => {
  const planHash = sha256Hex(jcsCanonicalize(plan));
  assert(signer.keyId === plan.body.reconciler.key_id, "attempt signer is not reconciler");
  parseInstant(occurredAt, "attempt occurred_at");
  return {
    plan,
    plan_hash: planHash,
    events: [
      compileSamplingAttemptEventV1({
        attempt_id: `attempt:${planHash}`,
        sequence: "1",
        kind: "PLAN_COMMITTED",
        plan_hash: planHash,
        previous_event_hash: null,
        actor_service_id: plan.body.reconciler.service_id,
        occurred_at: occurredAt,
        payload_digest: planHash,
      }, signer),
    ],
    query_finalization: null,
    revealed_nonce: null,
    invalidated: false,
    invalidation_reason: null,
  };
};

const planScope = (plan: SignedSamplingPlanV1): string =>
  [
    plan.body.environment,
    plan.body.generation,
    plan.body.invalidation_epoch,
    plan.body.bundle_root_hash,
    plan.body.identity_snapshot_hash,
    plan.body.universe_digest,
  ].join("\0");

/**
 * An attempt ledger prevents nonce grinding by refusing a second plan for one
 * immutable scope. The staged fixture still remains non-authoritative.
 */
export class SamplingAttemptLedgerV1 {
  readonly #directory: string;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#directory = directory;
  }

  #path(plan: SignedSamplingPlanV1): string {
    return join(this.#directory, `${sha256Hex(planScope(plan))}.json`);
  }

  #syncDirectory(): void {
    const descriptor = openSync(this.#directory, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  #writeExclusive(path: string, state: SamplingAttemptStateV1): void {
    const descriptor = openSync(path, "wx", 0o600);
    try {
      writeSync(descriptor, `${jcsCanonicalize(state)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.#syncDirectory();
  }

  commit(
    plan: SignedSamplingPlanV1,
    occurredAt: string,
    signer: TrustEnvelopeSigner,
  ): SamplingAttemptStateV1 {
    const attempt = createSamplingAttemptV1(plan, occurredAt, signer);
    try {
      this.#writeExclusive(this.#path(plan), attempt);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new Error("sampling scope already has a committed plan");
      }
      throw error;
    }
    return attempt;
  }

  replace(state: SamplingAttemptStateV1): void {
    const path = this.#path(state.plan);
    const lockPath = `${path}.lock`;
    let lockDescriptor: number | undefined;
    try {
      lockDescriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new Error("sampling ledger CAS conflict");
      }
      throw error;
    }
    const current = this.read(state.plan);
    assert(current !== undefined, "sampling attempt is not committed");
    assert(current.plan_hash === state.plan_hash, "sampling plan conflict");
    assert(state.events.length === current.events.length + 1, "sampling append is not atomic");
    assert(
      jcsCanonicalize(state.events.slice(0, current.events.length)) ===
        jcsCanonicalize(current.events),
      "sampling event history was rewritten",
    );
    const temporaryPath = `${path}.${process.pid}.${state.events.length}.tmp`;
    try {
      writeFileSync(temporaryPath, `${jcsCanonicalize(state)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const descriptor = openSync(temporaryPath, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, path);
      this.#syncDirectory();
    } finally {
      if (existsSync(temporaryPath)) rmSync(temporaryPath);
      if (lockDescriptor !== undefined) closeSync(lockDescriptor);
      if (existsSync(lockPath)) rmSync(lockPath);
      this.#syncDirectory();
    }
  }

  read(plan: SignedSamplingPlanV1): SamplingAttemptStateV1 | undefined {
    const path = this.#path(plan);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as SamplingAttemptStateV1;
  }
}

export const finalizeSamplingQueryV1 = (
  state: SamplingAttemptStateV1,
  finalization: Omit<QueryFinalizationV1, "plan_hash">,
  actor: ReconciliationPrincipalV1,
  signer: TrustEnvelopeSigner,
): SamplingAttemptStateV1 => {
  const plan = state.plan;
  const expected: Omit<QueryFinalizationV1, "plan_hash" | "source_snapshot_hash" | "projection_snapshot_hash" | "finalized_at"> =
    {
      environment: plan.body.environment,
      generation: plan.body.generation,
      invalidation_epoch: plan.body.invalidation_epoch,
      bundle_root_hash: plan.body.bundle_root_hash,
      identity_snapshot_hash: plan.body.identity_snapshot_hash,
      producer_snapshot_id: plan.body.producer_snapshot_id,
      universe_digest: plan.body.universe_digest,
      query_digest: plan.body.query_digest,
      parameter_digest: plan.body.parameter_digest,
      adapter_digest: plan.body.adapter_digest,
      statistical_policy_hash: plan.body.statistical_policy_hash,
    };
  for (const [field, value] of Object.entries(expected)) {
    assert(
      finalization[field as keyof typeof finalization] === value,
      `query finalization ${field} differs from committed plan`,
    );
  }
  const bound: QueryFinalizationV1 = { plan_hash: state.plan_hash, ...finalization };
  const advanced = advanceSamplingAttemptV1(
    state,
    "QUERY_FINALIZED",
    sha256Hex(jcsCanonicalize(bound)),
    finalization.finalized_at,
    actor,
    signer,
  );
  return { ...advanced, query_finalization: bound };
};

export const advanceSamplingAttemptV1 = (
  state: SamplingAttemptStateV1,
  kind: Exclude<SamplingAttemptEventKind, "PLAN_COMMITTED">,
  payloadDigest: string,
  occurredAt: string,
  actor: ReconciliationPrincipalV1,
  signer: TrustEnvelopeSigner,
  revealedNonce: string | null = null,
): SamplingAttemptStateV1 => {
  if (state.invalidated) throw new Error("sampling attempt is invalidated");
  assert(actor.service_id === state.plan.body.reconciler.service_id, "producer cannot advance plan");
  assert(actor.key_id === state.plan.body.reconciler.key_id, "wrong reconciler key");
  assert(signer.keyId === actor.key_id, "attempt event signer key mismatch");
  assertDigest(payloadDigest, "payload_digest");
  parseInstant(occurredAt, "attempt occurred_at");
  assert(
    parseInstant(occurredAt, "attempt occurred_at") >=
      parseInstant(state.events.at(-1)!.occurred_at, "prior attempt occurred_at"),
    "attempt event time moved backwards",
  );
  const expected = eventOrder[state.events.length];
  assert(kind === expected, `expected ${String(expected)}, received ${kind}`);
  if (kind === "NONCE_REVEALED") {
    assert(revealedNonce !== null, "nonce reveal missing");
    assert(revealSamplingNonceV1(state.plan, revealedNonce), "nonce commitment mismatch");
    assert(
      payloadDigest === sha256Hex(revealedNonce),
      "nonce reveal payload does not bind revealed nonce",
    );
  } else {
    assert(revealedNonce === null, "nonce may only be supplied at NONCE_REVEALED");
  }
  return {
    ...state,
    events: [
      ...state.events,
      compileSamplingAttemptEventV1({
        attempt_id: state.events[0]!.attempt_id,
        sequence: String(state.events.length + 1),
        kind,
        plan_hash: state.plan_hash,
        previous_event_hash: sha256Hex(jcsCanonicalize(state.events.at(-1)!)),
        actor_service_id: actor.service_id,
        occurred_at: occurredAt,
        payload_digest: payloadDigest,
      }, signer),
    ],
    revealed_nonce: kind === "NONCE_REVEALED" ? revealedNonce : state.revealed_nonce,
  };
};

export const verifySamplingAttemptStateV1 = (
  state: SamplingAttemptStateV1,
  publicKeyHex: string,
): boolean => {
  try {
    const planHash = sha256Hex(jcsCanonicalize(state.plan));
    assert(state.plan_hash === planHash, "attempt plan hash mismatch");
    assert(state.invalidated === false, "attempt is invalidated");
    assert(
      state.invalidation_reason === null,
      "valid attempt unexpectedly has invalidation reason",
    );
    assert(
      state.events.length >= 1 && state.events.length <= eventOrder.length,
      "attempt event count is invalid",
    );
    let priorHash: string | null = null;
    let priorTime = -Infinity;
    for (const [index, event] of state.events.entries()) {
      assertExactKeys(
        event,
        [
          "attempt_id",
          "sequence",
          "kind",
          "plan_hash",
          "previous_event_hash",
          "actor_service_id",
          "occurred_at",
          "payload_digest",
          "signer_key_id",
          "signature",
        ],
        "sampling attempt event",
      );
      assert(event.attempt_id === `attempt:${planHash}`, "attempt id mismatch");
      assert(event.sequence === String(index + 1), "attempt sequence gap");
      assert(event.kind === eventOrder[index], "attempt event order mismatch");
      assert(event.plan_hash === planHash, "attempt event plan mismatch");
      assert(event.previous_event_hash === priorHash, "attempt hash chain mismatch");
      assert(
        event.actor_service_id === state.plan.body.reconciler.service_id,
        "attempt actor is not reconciler",
      );
      assert(
        event.signer_key_id === state.plan.body.reconciler.key_id,
        "attempt signer is not reconciler",
      );
      assertDigest(event.payload_digest, "attempt payload_digest");
      const occurredAt = parseInstant(event.occurred_at, "attempt occurred_at");
      assert(occurredAt >= priorTime, "attempt event time moved backwards");
      priorTime = occurredAt;
      const { signature, ...unsigned } = event;
      assert(
        verifyEd25519Signature(
          publicKeyHex,
          attemptEventSigningBytes(unsigned),
          signature,
        ),
        "invalid attempt event signature",
      );
      priorHash = sha256Hex(jcsCanonicalize(event));
    }
    assert(state.events[0]!.payload_digest === planHash, "plan event payload mismatch");
    if (state.events.length >= 2) {
      assert(state.query_finalization !== null, "query finalization is absent");
      assert(
        state.query_finalization.plan_hash === planHash,
        "query finalization plan mismatch",
      );
      assert(
        state.events[1]!.payload_digest ===
          sha256Hex(jcsCanonicalize(state.query_finalization)),
        "query event payload mismatch",
      );
    } else {
      assert(state.query_finalization === null, "query finalized before event");
    }
    if (state.events.length >= 3) {
      assert(state.revealed_nonce !== null, "nonce reveal is absent");
      assert(
        revealSamplingNonceV1(state.plan, state.revealed_nonce),
        "revealed nonce does not open plan commitment",
      );
      assert(
        state.events[2]!.payload_digest === sha256Hex(state.revealed_nonce),
        "nonce event payload mismatch",
      );
    } else {
      assert(state.revealed_nonce === null, "nonce revealed before event");
    }
    return true;
  } catch {
    return false;
  }
};

export const detectSamplingPlanMutationV1 = (
  state: SamplingAttemptStateV1,
  candidate: SignedSamplingPlanV1,
): SamplingAttemptStateV1 =>
  sha256Hex(jcsCanonicalize(candidate)) === state.plan_hash
    ? state
    : {
        ...state,
        invalidated: true,
        invalidation_reason: "POST_COMMIT_PLAN_MUTATION",
      };

const receiptSigningBytes = (body: ReconciliationReceiptBodyV1): Uint8Array =>
  encoder.encode(
    `${RECEIPT_SIGNATURE_DOMAIN}\0${body.environment}\0${body.generation}\0${sha256Hex(jcsCanonicalize(body))}`,
  );

export interface CompileReconciliationReceiptInputV1 {
  readonly plan: SignedSamplingPlanV1;
  readonly attempt: SamplingAttemptStateV1;
  readonly nonce: string;
  readonly source_snapshot_hash: string;
  readonly projection_snapshot_hash: string;
  readonly selected_members: Readonly<Record<string, readonly string[]>>;
  readonly observations: readonly ReconciliationObservationV1[];
  readonly census_members: Readonly<Record<string, readonly string[]>>;
  readonly footprint_counts: readonly FootprintCountInputV1[];
  readonly retry_owner: string;
  readonly retry_deadline: string;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly limitations?: readonly string[];
}

export const compileReconciliationReceiptV1 = (
  input: CompileReconciliationReceiptInputV1,
  signer: TrustEnvelopeSigner,
): PublishedReconciliationReceiptV1 => {
  const { plan } = input;
  assert(input.attempt.plan_hash === sha256Hex(jcsCanonicalize(plan)), "attempt plan mismatch");
  assert(
    verifySamplingAttemptStateV1(input.attempt, signer.publicKeyHex()),
    "sampling attempt signatures or hash chain are invalid",
  );
  assert(
    input.attempt.events.map((event) => event.kind).join("\0") ===
      ["PLAN_COMMITTED", "QUERY_FINALIZED", "NONCE_REVEALED"].join("\0"),
    "sampling attempt has not completed commit-query-reveal",
  );
  assert(input.attempt.revealed_nonce === input.nonce, "attempt nonce mismatch");
  assert(input.attempt.query_finalization !== null, "query finalization is absent");
  assert(
    input.attempt.query_finalization.source_snapshot_hash === input.source_snapshot_hash &&
      input.attempt.query_finalization.projection_snapshot_hash ===
        input.projection_snapshot_hash,
    "receipt snapshots do not match query finalization",
  );
  assert(signer.keyId === plan.body.reconciler.key_id, "receipt signer is not reconciler");
  assert(revealSamplingNonceV1(plan, input.nonce), "receipt nonce does not open commitment");
  assertDigest(input.source_snapshot_hash, "source_snapshot_hash");
  assertDigest(input.projection_snapshot_hash, "projection_snapshot_hash");
  assert(
    parseInstant(input.expires_at, "expires_at") > parseInstant(input.observed_at, "observed_at"),
    "receipt expiry must follow observation",
  );
  const results: StratumReconciliationResultV1[] = [];
  const mismatchExamples: ReconciliationObservationV1[] = [];
  for (const target of plan.body.targets) {
    const stratum = plan.body.strata.find((candidate) => candidate.stratum_id === target.stratum_id)!;
    const universe = plan.body.universe_partition
      .filter((member) => member.stratum_id === target.stratum_id)
      .map((member) => member.member_id);
    const selected = [...(input.selected_members[target.stratum_id] ?? [])];
    const census = [...(input.census_members[target.stratum_id] ?? [])];
    const deterministicSelection = deterministicSampleMembersV1(
      universe,
      Number(target.target),
      input.nonce,
      target.stratum_id,
    );
    assert(
      jcsCanonicalize(selected) === jcsCanonicalize(deterministicSelection),
      `selected membership does not match committed deterministic sample: ${target.stratum_id}`,
    );
    assert(unique(census), `census contains duplicate members: ${target.stratum_id}`);
    assert(
      census.every((member) => universe.includes(member)),
      `census contains out-of-universe member: ${target.stratum_id}`,
    );
    const censusComplete =
      census.length === universe.length &&
      [...census].sort().join("\0") === [...universe].sort().join("\0");
    const relevant = input.observations.filter(
      (observation) => observation.stratum_id === target.stratum_id,
    );
    const byMember = new Map(relevant.map((observation) => [observation.member_id, observation]));
    assert(
      byMember.size === relevant.length,
      `duplicate reconciliation observations: ${target.stratum_id}`,
    );
    assert(
      relevant.every((observation) => universe.includes(observation.member_id)),
      `observation contains out-of-universe member: ${target.stratum_id}`,
    );
    const sampleDefects = selected.filter((member) => {
      const observation = byMember.get(member);
      return (
        observation === undefined ||
        !observation.observed ||
        !observation.semantic_match ||
        !observation.identity_match ||
        !observation.provenance_complete
      );
    });
    const confirmedObservedDefect = relevant.some((observation) => {
      return (
        observation.observed &&
        (!observation.semantic_match ||
          !observation.identity_match ||
          !observation.provenance_complete)
      );
    });
    const censusRequired =
      target.mode === "CENSUS" ||
      sampleDefects.length > 0 ||
      confirmedObservedDefect;
    const evaluatedMembers = censusRequired && censusComplete ? census : selected;
    const defects = evaluatedMembers.filter((member) => {
      const observation = byMember.get(member);
      return (
        observation === undefined ||
        !observation.observed ||
        !observation.semantic_match ||
        !observation.identity_match ||
        !observation.provenance_complete
      );
    });
    for (const member of defects.slice(0, 16)) {
      const observation = byMember.get(member);
      mismatchExamples.push(
        observation ?? {
          stratum_id: target.stratum_id,
          member_id: member,
          observed: false,
          semantic_match: false,
          identity_match: false,
          provenance_complete: false,
        },
      );
    }
    let decision: StratumReconciliationResultV1["decision"];
    if (censusRequired) {
      if (!censusComplete) {
        decision = confirmedObservedDefect
          ? "NOT_READY_INCOMPLETE_CENSUS"
          : "UNKNOWN_INCOMPLETE_CENSUS";
      } else {
        decision = defects.length === 0 ? "PASS" : "NOT_READY_DEFECTIVE_CENSUS";
      }
    } else {
      decision = "PASS";
    }
    results.push({
      stratum_id: target.stratum_id,
      mode: target.mode,
      population: target.population,
      expected_observations: String(evaluatedMembers.length),
      observed: String(
        evaluatedMembers.filter((member) => byMember.get(member)?.observed).length,
      ),
      defects: String(defects.length),
      membership_digest: sha256Hex(jcsCanonicalize([...evaluatedMembers].sort())),
      census_complete: censusComplete,
      decision,
    });
  }
  assert(input.footprint_counts.length > 0, "footprint count evidence is required");
  assert(
    input.footprint_counts.length === FROZEN_FOOTPRINT_POLICY_V1.length &&
      unique(input.footprint_counts.map((count) => count.entity)),
    "footprint evidence does not cover the frozen entity set",
  );
  for (const expected of FROZEN_FOOTPRINT_POLICY_V1) {
    const actual = input.footprint_counts.find(
      (count) => count.entity === expected.entity,
    );
    assert(actual !== undefined, `missing footprint entity ${expected.entity}`);
    assert(
      actual.low_cardinality === expected.low_cardinality &&
        actual.absolute_floor === expected.absolute_floor,
      `footprint policy drift for ${expected.entity}`,
    );
  }
  const footprintCounts: FootprintCountResultV1[] = input.footprint_counts.map(
    (count) => {
      const source = parseCount(count.source_count, "source_count");
      const projection = parseCount(count.projection_count, "projection_count");
      const absoluteFloor = parseCount(count.absolute_floor, "absolute_floor");
      const tolerance = count.low_cardinality
        ? 0
        : Math.max(absoluteFloor, Math.ceil(source / 1_000));
      return {
        ...count,
        relative_tolerance_ppm: "1000",
        tolerance_count: String(tolerance),
        passed: Math.abs(source - projection) <= tolerance,
      };
    },
  );
  const decisions = results.map((result) => result.decision);
  const stratumDecision: ReconciliationReceiptBodyV1["decision"] =
    decisions.includes("NOT_READY_INCOMPLETE_CENSUS") ||
    decisions.includes("NOT_READY_DEFECTIVE_CENSUS")
    ? "NOT_READY"
    : decisions.includes("UNKNOWN_INCOMPLETE_CENSUS")
      ? "UNKNOWN"
      : decisions.includes("CENSUS_REQUIRED")
        ? "CENSUS_REQUIRED"
        : "RECONCILED_STAGED";
  const decision: ReconciliationReceiptBodyV1["decision"] =
    stratumDecision === "RECONCILED_STAGED" &&
    footprintCounts.some((count) => !count.passed)
      ? "CENSUS_REQUIRED"
      : stratumDecision;
  const body: ReconciliationReceiptBodyV1 = {
    schema_version: 1,
    environment: plan.body.environment,
    generation: plan.body.generation,
    invalidation_epoch: plan.body.invalidation_epoch,
    bundle_root_hash: plan.body.bundle_root_hash,
    identity_snapshot_hash: plan.body.identity_snapshot_hash,
    producer_snapshot_id: plan.body.producer_snapshot_id,
    plan_hash: sha256Hex(jcsCanonicalize(plan)),
    attempt_events_digest: sha256Hex(jcsCanonicalize(input.attempt.events)),
    query_finalization_digest: sha256Hex(
      jcsCanonicalize(input.attempt.query_finalization),
    ),
    nonce_commitment: plan.nonce_commitment,
    universe_digest: plan.body.universe_digest,
    source_snapshot_hash: input.source_snapshot_hash,
    projection_snapshot_hash: input.projection_snapshot_hash,
    query_digest: plan.body.query_digest,
    adapter_digest: plan.body.adapter_digest,
    statistical_policy_hash: plan.body.statistical_policy_hash,
    nonce: input.nonce,
    strata: results,
    mismatch_examples: mismatchExamples.slice(0, 32),
    footprint_counts: footprintCounts,
    limitations: input.limitations ?? ["STAGED_FIXTURE_ONLY", "NO_PRODUCTION_AUTHORITY"],
    decision,
    retry_owner: decision === "RECONCILED_STAGED" ? null : input.retry_owner,
    retry_deadline: decision === "RECONCILED_STAGED" ? null : input.retry_deadline,
    observed_at: input.observed_at,
    expires_at: input.expires_at,
    authority_valid: false,
  };
  const receipt: SignedReconciliationReceiptV1 = {
    _tag: "ReconciliationReceiptV1",
    body,
    signer_key_id: signer.keyId,
    signature: signer.sign(receiptSigningBytes(body)),
  };
  const completedAttempt = advanceSamplingAttemptV1(
    input.attempt,
    "RECEIPT_PUBLISHED",
    sha256Hex(jcsCanonicalize(receipt)),
    input.observed_at,
    plan.body.reconciler,
    signer,
  );
  return { receipt, completed_attempt: completedAttempt };
};

export const verifyReconciliationReceiptV1 = (
  receipt: SignedReconciliationReceiptV1,
  plan: SignedSamplingPlanV1,
  attempt: SamplingAttemptStateV1,
  publicKeyHex: string,
  now: string,
): boolean => {
  try {
    assertExactKeys(
      receipt,
      ["_tag", "body", "signer_key_id", "signature"],
      "reconciliation receipt",
    );
    assertExactKeys(
      receipt.body,
      [
        "schema_version",
        "environment",
        "generation",
        "invalidation_epoch",
        "bundle_root_hash",
        "identity_snapshot_hash",
        "producer_snapshot_id",
        "plan_hash",
        "attempt_events_digest",
        "query_finalization_digest",
        "nonce_commitment",
        "universe_digest",
        "source_snapshot_hash",
        "projection_snapshot_hash",
        "query_digest",
        "adapter_digest",
        "statistical_policy_hash",
        "nonce",
        "strata",
        "mismatch_examples",
        "footprint_counts",
        "limitations",
        "decision",
        "retry_owner",
        "retry_deadline",
        "observed_at",
        "expires_at",
        "authority_valid",
      ],
      "reconciliation receipt body",
    );
    assert(receipt._tag === "ReconciliationReceiptV1", "wrong receipt tag");
    assert(receipt.body.schema_version === 1, "unsupported receipt schema");
    assert(receipt.signer_key_id === plan.body.reconciler.key_id, "receipt signer mismatch");
    assert(receipt.body.plan_hash === sha256Hex(jcsCanonicalize(plan)), "plan hash mismatch");
    assert(receipt.body.environment === plan.body.environment, "environment mismatch");
    assert(receipt.body.generation === plan.body.generation, "generation mismatch");
    assert(
      receipt.body.producer_snapshot_id === plan.body.producer_snapshot_id,
      "producer snapshot mismatch",
    );
    assert(receipt.body.universe_digest === plan.body.universe_digest, "universe mismatch");
    assert(receipt.body.query_digest === plan.body.query_digest, "query mismatch");
    assert(receipt.body.adapter_digest === plan.body.adapter_digest, "adapter mismatch");
    assert(attempt.plan_hash === receipt.body.plan_hash, "attempt plan mismatch");
    assert(
      verifySamplingAttemptStateV1(attempt, publicKeyHex),
      "attempt signatures or hash chain are invalid",
    );
    assert(
      attempt.events.map((event) => event.kind).join("\0") ===
        [
          "PLAN_COMMITTED",
          "QUERY_FINALIZED",
          "NONCE_REVEALED",
          "RECEIPT_PUBLISHED",
        ].join("\0"),
      "attempt order is incomplete",
    );
    assert(attempt.query_finalization !== null, "query finalization is absent");
    assert(attempt.revealed_nonce === receipt.body.nonce, "attempt reveal mismatch");
    assert(
      receipt.body.attempt_events_digest ===
        sha256Hex(jcsCanonicalize(attempt.events.slice(0, 3))),
      "attempt event digest mismatch",
    );
    assert(
      attempt.events[3]!.payload_digest === sha256Hex(jcsCanonicalize(receipt)),
      "receipt publication event mismatch",
    );
    assert(
      receipt.body.query_finalization_digest ===
        sha256Hex(jcsCanonicalize(attempt.query_finalization)),
      "query finalization digest mismatch",
    );
    assert(
      attempt.query_finalization.source_snapshot_hash ===
        receipt.body.source_snapshot_hash &&
        attempt.query_finalization.projection_snapshot_hash ===
          receipt.body.projection_snapshot_hash,
      "receipt snapshots differ from finalized query",
    );
    assert(
      receipt.body.invalidation_epoch === plan.body.invalidation_epoch,
      "invalidation epoch mismatch",
    );
    assert(receipt.body.nonce_commitment === plan.nonce_commitment, "commitment mismatch");
    assert(
      receipt.body.statistical_policy_hash === plan.body.statistical_policy_hash,
      "statistical policy hash mismatch",
    );
    assert(receipt.body.bundle_root_hash === plan.body.bundle_root_hash, "bundle mismatch");
    assert(
      receipt.body.identity_snapshot_hash === plan.body.identity_snapshot_hash,
      "identity mismatch",
    );
    assertDigest(receipt.body.source_snapshot_hash, "source_snapshot_hash");
    assertDigest(receipt.body.projection_snapshot_hash, "projection_snapshot_hash");
    assert(revealSamplingNonceV1(plan, receipt.body.nonce), "nonce mismatch");
    assert(receipt.body.authority_valid === false, "staged receipt claimed authority");
    assert(receipt.body.strata.length === plan.body.targets.length, "receipt omitted stratum");
    assert(
      unique(receipt.body.strata.map((result) => result.stratum_id)),
      "receipt contains duplicate strata",
    );
    for (const target of plan.body.targets) {
      const result = receipt.body.strata.find(
        (candidate) => candidate.stratum_id === target.stratum_id,
      );
      assert(result !== undefined, "receipt omitted mandatory stratum");
      assert(
        result.mode === target.mode && result.population === target.population,
        "receipt stratum target mismatch",
      );
      parseCount(result.expected_observations, "expected_observations");
      parseCount(result.observed, "observed");
      parseCount(result.defects, "defects");
      assertDigest(result.membership_digest, "membership_digest");
      const expected = parseCount(
        result.expected_observations,
        "expected_observations",
      );
      const observed = parseCount(result.observed, "observed");
      const defects = parseCount(result.defects, "defects");
      const population = parseCount(result.population, "population");
      assert(observed <= expected, "observed count exceeds expected membership");
      assert(defects <= expected, "defect count exceeds expected membership");
      assert(
        [
          "PASS",
          "CENSUS_REQUIRED",
          "NOT_READY_INCOMPLETE_CENSUS",
          "NOT_READY_DEFECTIVE_CENSUS",
          "UNKNOWN_INCOMPLETE_CENSUS",
        ].includes(result.decision),
        "unknown stratum decision",
      );
      if (result.decision === "PASS") {
        assert(defects === 0 && observed === expected, "passing stratum is incomplete");
      }
      if (result.census_complete) {
        assert(expected === population, "completed census does not cover population");
      }
      if (result.decision === "NOT_READY_DEFECTIVE_CENSUS") {
        assert(
          result.census_complete && defects > 0,
          "defective-census decision is inconsistent",
        );
      }
      if (
        result.decision === "NOT_READY_INCOMPLETE_CENSUS" ||
        result.decision === "UNKNOWN_INCOMPLETE_CENSUS"
      ) {
        assert(!result.census_complete, "incomplete-census decision claims completion");
      }
      assertExactKeys(
        result,
        [
          "stratum_id",
          "mode",
          "population",
          "expected_observations",
          "observed",
          "defects",
          "membership_digest",
          "census_complete",
          "decision",
        ],
        "reconciliation stratum result",
      );
    }
    const decisions = receipt.body.strata.map((result) => result.decision);
    const expectedStratumDecision: ReconciliationReceiptBodyV1["decision"] =
      decisions.includes("NOT_READY_INCOMPLETE_CENSUS") ||
      decisions.includes("NOT_READY_DEFECTIVE_CENSUS")
      ? "NOT_READY"
      : decisions.includes("UNKNOWN_INCOMPLETE_CENSUS")
        ? "UNKNOWN"
        : decisions.includes("CENSUS_REQUIRED")
          ? "CENSUS_REQUIRED"
          : "RECONCILED_STAGED";
    assert(receipt.body.footprint_counts.length > 0, "receipt omitted footprint counts");
    assert(
      receipt.body.footprint_counts.length === FROZEN_FOOTPRINT_POLICY_V1.length &&
        unique(receipt.body.footprint_counts.map((count) => count.entity)),
      "receipt footprint set differs from frozen policy",
    );
    for (const count of receipt.body.footprint_counts) {
      assertExactKeys(
        count,
        [
          "entity",
          "source_count",
          "projection_count",
          "low_cardinality",
          "absolute_floor",
          "relative_tolerance_ppm",
          "tolerance_count",
          "passed",
        ],
        "footprint count",
      );
      const source = parseCount(count.source_count, "source_count");
      const projection = parseCount(count.projection_count, "projection_count");
      const absoluteFloor = parseCount(count.absolute_floor, "absolute_floor");
      const tolerance = count.low_cardinality
        ? 0
        : Math.max(absoluteFloor, Math.ceil(source / 1_000));
      assert(count.relative_tolerance_ppm === "1000", "footprint tolerance drift");
      const expectedPolicy = FROZEN_FOOTPRINT_POLICY_V1.find(
        (expected) => expected.entity === count.entity,
      );
      assert(
        expectedPolicy !== undefined &&
          expectedPolicy.low_cardinality === count.low_cardinality &&
          expectedPolicy.absolute_floor === count.absolute_floor,
        "receipt footprint policy drift",
      );
      assert(count.tolerance_count === String(tolerance), "footprint tolerance mismatch");
      assert(
        count.passed === (Math.abs(source - projection) <= tolerance),
        "footprint decision mismatch",
      );
    }
    const expectedDecision: ReconciliationReceiptBodyV1["decision"] =
      expectedStratumDecision === "RECONCILED_STAGED" &&
      receipt.body.footprint_counts.some((count) => !count.passed)
        ? "CENSUS_REQUIRED"
        : expectedStratumDecision;
    assert(receipt.body.decision === expectedDecision, "receipt decision is inconsistent");
    assert(
      receipt.body.decision === "RECONCILED_STAGED"
        ? receipt.body.retry_owner === null && receipt.body.retry_deadline === null
        : receipt.body.retry_owner !== null && receipt.body.retry_deadline !== null,
      "receipt retry ownership is inconsistent",
    );
    assert(parseInstant(receipt.body.expires_at, "expires_at") > parseInstant(now, "now"), "expired");
    assert(
      parseInstant(receipt.body.observed_at, "observed_at") >=
        parseInstant(attempt.events[2]!.occurred_at, "nonce reveal occurred_at"),
      "receipt predates nonce reveal",
    );
    if (receipt.body.retry_deadline !== null) {
      assert(
        parseInstant(receipt.body.retry_deadline, "retry_deadline") >=
          parseInstant(receipt.body.observed_at, "observed_at") &&
          parseInstant(receipt.body.retry_deadline, "retry_deadline") <=
            parseInstant(receipt.body.expires_at, "expires_at"),
        "retry deadline is outside receipt validity",
      );
    }
    return verifyEd25519Signature(
      publicKeyHex,
      receiptSigningBytes(receipt.body),
      receipt.signature,
    );
  } catch {
    return false;
  }
};

const reviewSigningBytes = (
  receiptHash: string,
  producer: ReconciliationPrincipalV1,
  reviewer: ReconciliationPrincipalV1,
  verdict: IndependentReviewReceiptV1["verdict"],
  reviewedAt: string,
): Uint8Array =>
  encoder.encode(
    `${REVIEW_SIGNATURE_DOMAIN}\0${receiptHash}\0${sha256Hex(jcsCanonicalize(producer))}\0${sha256Hex(jcsCanonicalize(reviewer))}\0${verdict}\0${reviewedAt}`,
  );

export const compileIndependentReviewReceiptV1 = (
  receipt: SignedReconciliationReceiptV1,
  reviewer: ReconciliationPrincipalV1,
  reconciler: ReconciliationPrincipalV1,
  producer: ReconciliationPrincipalV1,
  reviewedAt: string,
  verdict: IndependentReviewReceiptV1["verdict"],
  signer: TrustEnvelopeSigner,
): IndependentReviewReceiptV1 => {
  assert(reviewer.key_id === signer.keyId, "review signer key mismatch");
  assertDistinctPrincipals(reviewer, reconciler);
  assertDistinctPrincipals(reviewer, producer);
  assertDistinctPrincipals(reconciler, producer);
  assert(
    parseInstant(reviewedAt, "reviewed_at") >=
      parseInstant(receipt.body.observed_at, "receipt observed_at"),
    "review predates the receipt",
  );
  assert(
    parseInstant(reviewedAt, "reviewed_at") <=
      parseInstant(receipt.body.expires_at, "receipt expires_at"),
    "review postdates receipt expiry",
  );
  const receiptHash = sha256Hex(jcsCanonicalize(receipt));
  return {
    _tag: "IndependentReconciliationReviewV1",
    reconciliation_receipt_hash: receiptHash,
    reviewer_principal: reviewer,
    producer_principal: producer,
    reviewed_at: reviewedAt,
    verdict,
    signer_key_id: signer.keyId,
    signature: signer.sign(
      reviewSigningBytes(receiptHash, producer, reviewer, verdict, reviewedAt),
    ),
  };
};

export const verifyIndependentReviewReceiptV1 = (
  review: IndependentReviewReceiptV1,
  receipt: SignedReconciliationReceiptV1,
  reconciler: ReconciliationPrincipalV1,
  producer: ReconciliationPrincipalV1,
  expectedReviewer: ReconciliationPrincipalV1,
  publicKeyHex: string,
  now: string,
): boolean => {
  try {
    assert(review.signer_key_id === review.reviewer_principal.key_id, "review key mismatch");
    assertDistinctPrincipals(review.reviewer_principal, reconciler);
    assertDistinctPrincipals(review.reviewer_principal, producer);
    assertDistinctPrincipals(reconciler, producer);
    assert(
      jcsCanonicalize(review.reviewer_principal) ===
        jcsCanonicalize(expectedReviewer),
      "unexpected reviewer principal",
    );
    assert(
      jcsCanonicalize(review.producer_principal) === jcsCanonicalize(producer),
      "review producer mismatch",
    );
    assert(
      review.reconciliation_receipt_hash === sha256Hex(jcsCanonicalize(receipt)),
      "reviewed receipt mismatch",
    );
    assert(
      parseInstant(review.reviewed_at, "reviewed_at") >=
        parseInstant(receipt.body.observed_at, "receipt observed_at"),
      "review predates the receipt",
    );
    assert(
      parseInstant(review.reviewed_at, "reviewed_at") <=
        parseInstant(receipt.body.expires_at, "receipt expires_at"),
      "review postdates receipt expiry",
    );
    assert(
      parseInstant(review.reviewed_at, "reviewed_at") <= parseInstant(now, "now"),
      "review is future-dated",
    );
    return verifyEd25519Signature(
      publicKeyHex,
      reviewSigningBytes(
        review.reconciliation_receipt_hash,
        review.producer_principal,
        review.reviewer_principal,
        review.verdict,
        review.reviewed_at,
      ),
      review.signature,
    );
  } catch {
    return false;
  }
};
