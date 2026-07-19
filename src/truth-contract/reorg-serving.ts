import type { TrustEnvelopeSigner } from "../collection-resolver/trust-protocol.js";
import {
  jcsCanonicalize,
  sha256Hex,
  verifyEd25519Signature,
} from "../collection-resolver/trust-protocol.js";

import {
  compileProjectionEventV1,
  type ProjectionStatus,
  type SignedProjectionEventV1,
  type TruthStatusProjectionV1,
} from "./invalidation.js";
import { verifyTruthRootSignature } from "./crypto.js";

const encoder = new TextEncoder();
const REORG_DOMAIN = "sonar.truth-reorg-event.v1";
const EXCEPTION_DOMAIN = "sonar.truth-serving-exception.v1";

export const REORG_SERVICE_OBJECTIVES_V1 = Object.freeze({
  poll_interval_seconds: 60,
  detection_within_polls: 2,
  invalidation_publication_seconds: 60,
  dependent_projection_seconds: 60,
});

export type ServingFailureClass =
  | "TEMPORARY_TRANSPORT_LOSS"
  | "STALE_EVIDENCE"
  | "CURSOR_NOT_ADVANCING"
  | "REORG_BEHIND_WATERMARK"
  | "RECONCILIATION_COUNT_BREACH"
  | "SEMANTIC_OR_PROVENANCE_MISMATCH"
  | "IDENTITY_REVOKED_OR_CONTESTED"
  | "SIGNER_OR_ROOT_COMPROMISE"
  | "INCOMPATIBLE_PRODUCER_CONSUMER";

export type LastGoodPolicy =
  | "SAME_VERSION_WITHIN_TTL"
  | "SAME_VERSION_ONE_EXTRA_TTL"
  | "PRIOR_PROJECTION_ONLY"
  | "PRIOR_GENERATION_ONLY"
  | "FORBIDDEN";

export interface ServingRuleV1 {
  readonly failure_class: ServingFailureClass;
  readonly effective_status: ProjectionStatus;
  readonly last_good: LastGoodPolicy;
  readonly maximum_last_good_seconds: number;
  readonly escalation_seconds: number;
  readonly user_label: string;
  readonly recovery: string;
  readonly graduation_eligible: false;
}

export const SERVING_FAILURE_MATRIX_V1: readonly ServingRuleV1[] = Object.freeze([
  {
    failure_class: "TEMPORARY_TRANSPORT_LOSS",
    effective_status: "DEGRADED",
    last_good: "SAME_VERSION_WITHIN_TTL",
    maximum_last_good_seconds: 1_800,
    escalation_seconds: 0,
    user_label: "degraded/stale timestamp",
    recovery: "fresh source and readiness evidence",
    graduation_eligible: false,
  },
  {
    failure_class: "STALE_EVIDENCE",
    effective_status: "EXPIRED",
    last_good: "SAME_VERSION_ONE_EXTRA_TTL",
    maximum_last_good_seconds: 1_800,
    escalation_seconds: 0,
    user_label: "stale",
    recovery: "fresh reconciliation and serving observation",
    graduation_eligible: false,
  },
  {
    failure_class: "CURSOR_NOT_ADVANCING",
    effective_status: "UNKNOWN",
    last_good: "PRIOR_PROJECTION_ONLY",
    maximum_last_good_seconds: 1_800,
    escalation_seconds: 120,
    user_label: "delayed/unknown",
    recovery: "independent head, cursor, and coverage proof",
    graduation_eligible: false,
  },
  {
    failure_class: "REORG_BEHIND_WATERMARK",
    effective_status: "NOT_READY",
    last_good: "FORBIDDEN",
    maximum_last_good_seconds: 0,
    escalation_seconds: 0,
    user_label: "temporarily unavailable",
    recovery: "replacement watermark and all dependent receipts",
    graduation_eligible: false,
  },
  {
    failure_class: "RECONCILIATION_COUNT_BREACH",
    effective_status: "NOT_READY",
    last_good: "PRIOR_GENERATION_ONLY",
    maximum_last_good_seconds: 0,
    escalation_seconds: 0,
    user_label: "update held",
    recovery: "completed census pass",
    graduation_eligible: false,
  },
  {
    failure_class: "SEMANTIC_OR_PROVENANCE_MISMATCH",
    effective_status: "SUSPENDED",
    last_good: "FORBIDDEN",
    maximum_last_good_seconds: 0,
    escalation_seconds: 0,
    user_label: "unavailable",
    recovery: "corrected bundle and new Score receipt",
    graduation_eligible: false,
  },
  {
    failure_class: "IDENTITY_REVOKED_OR_CONTESTED",
    effective_status: "SUSPENDED",
    last_good: "FORBIDDEN",
    maximum_last_good_seconds: 0,
    escalation_seconds: 0,
    user_label: "unavailable",
    recovery: "identity re-admission and new evidence",
    graduation_eligible: false,
  },
  {
    failure_class: "SIGNER_OR_ROOT_COMPROMISE",
    effective_status: "SUSPENDED",
    last_good: "FORBIDDEN",
    maximum_last_good_seconds: 0,
    escalation_seconds: 0,
    user_label: "unavailable",
    recovery: "recovered root and fresh evidence",
    graduation_eligible: false,
  },
  {
    failure_class: "INCOMPATIBLE_PRODUCER_CONSUMER",
    effective_status: "SUSPENDED",
    last_good: "FORBIDDEN",
    maximum_last_good_seconds: 0,
    escalation_seconds: 0,
    user_label: "update required",
    recovery: "compatible build and receipt",
    graduation_eligible: false,
  },
]);

export interface ReorgWatermarkV1 {
  readonly network: string;
  readonly chain_id: string;
  readonly height: string;
  readonly block_hash: string;
  readonly observed_at: string;
  readonly finality_policy_version: string;
  readonly finality_class: "FINALIZED";
}

export interface ReorgProviderPolicyV1 {
  readonly provider_id: string;
  readonly operator: string;
  readonly legal_entity: string;
  readonly control_domain: string;
  readonly asn: string;
  readonly network_path: string;
  readonly client_family: string;
  readonly upstream_source: string;
  readonly key_id: string;
  readonly public_key_hex: string;
}

export interface ReorgDetectionPolicyV1 {
  readonly policy_hash: string;
  readonly network: string;
  readonly chain_id: string;
  readonly finality_policy_version: string;
  readonly finality_method: "FINALIZED_TAG";
  readonly finalized_tag: "finalized";
  readonly ethereum_depth_fallback_allowed: false;
  readonly required_quorum: 2;
  readonly require_distinct_asn: boolean;
  readonly require_distinct_client_family: boolean;
  readonly poll_interval_seconds: 60;
  readonly providers: readonly ReorgProviderPolicyV1[];
}

export interface ReorgProviderObservationV1 {
  readonly provider_id: string;
  readonly finalized_height: string | null;
  readonly finalized_hash: string | null;
  readonly watermark_height: string;
  readonly watermark_hash_at_height: string | null;
  readonly watermark_parent_hash: string | null;
  readonly observed_at: string;
  readonly finality_method: "FINALIZED_TAG" | "BLOCK_DEPTH" | "UNSUPPORTED";
  readonly finalized_tag: "finalized" | null;
  readonly transport_error: boolean;
  readonly provider_compromised: boolean;
  readonly evidence_hash: string;
  readonly signer_key_id: string;
  readonly signature: string;
}

export interface ReorgDetectionInputV1 {
  readonly environment: "development" | "staging" | "production";
  readonly generation: string;
  readonly invalidation_epoch: string;
  readonly bundle_root_hash: string;
  readonly active_watermark: ReorgWatermarkV1;
  readonly policy: ReorgDetectionPolicyV1;
  readonly observations: readonly ReorgProviderObservationV1[];
  readonly detected_at: string;
}

export interface ReorgTrustContextV1 {
  readonly expected_bundle_root_hash: string;
  readonly expected_normative_policy_hash: string;
  readonly expected_policy_hash: string;
  readonly expected_detector_key_id: string;
  readonly expected_policy: ReorgDetectionPolicyV1;
}

export const compileReorgTrustContextV1 = (input: {
  readonly verified_root: {
    readonly unsigned_root: {
      readonly environment: "development" | "staging" | "production";
      readonly generation: string;
      readonly issuer: { readonly key_id: string };
      readonly objects: readonly { readonly kind: string; readonly sha256: string }[];
      readonly [key: string]: unknown;
    };
    readonly root_hash: string;
    readonly signature: string;
  };
  readonly expected_producer_key_id: string;
  readonly producer_public_key_hex: string;
  readonly normative_policy_object: unknown;
  readonly network: string;
  readonly detector_key_id: string;
}): ReorgTrustContextV1 => {
  assert(HEX_64.test(input.verified_root.root_hash), "invalid verified bundle root");
  assert(
    sha256Hex(jcsCanonicalize(input.verified_root.unsigned_root)) ===
      input.verified_root.root_hash,
    "bundle root hash is not authentic",
  );
  assert(
    input.verified_root.unsigned_root.issuer.key_id ===
      input.expected_producer_key_id,
    "unexpected bundle producer key",
  );
  assert(
    verifyTruthRootSignature(
      input.producer_public_key_hex,
      input.verified_root.unsigned_root.environment as never,
      input.verified_root.unsigned_root.generation as never,
      input.verified_root.root_hash as never,
      input.verified_root.signature,
    ),
    "bundle root signature is invalid",
  );
  const ref = input.verified_root.unsigned_root.objects.find(
    (candidate) => candidate.kind === "network_finality_policy",
  );
  assert(ref !== undefined, "verified root omits network finality policy");
  assert(
    sha256Hex(jcsCanonicalize(input.normative_policy_object)) === ref.sha256,
    "network finality policy closure hash mismatch",
  );
  const object = input.normative_policy_object as {
    kind?: unknown;
    networks?: readonly {
      network?: unknown;
      chain_id?: unknown;
      finality_policy_version?: unknown;
      finality_method?: unknown;
      finalized_tag?: unknown;
      ethereum_depth_fallback_allowed?: unknown;
      required_provider_quorum?: unknown;
      require_distinct_asn?: unknown;
      require_distinct_client_family?: unknown;
      poll_interval_seconds?: unknown;
      providers?: readonly ReorgProviderPolicyV1[];
    }[];
  };
  assert(object.kind === "network_finality_policy", "wrong normative policy kind");
  const network = object.networks?.find(
    (candidate) => candidate.network === input.network,
  );
  assert(network !== undefined, "network is absent from normative finality policy");
  assert(network.finality_method === "FINALIZED_TAG", "unsupported normative finality");
  assert(network.finalized_tag === "finalized", "normative finalized tag is absent");
  assert(
    network.ethereum_depth_fallback_allowed === false,
    "normative depth fallback is forbidden",
  );
  assert(network.poll_interval_seconds === 60, "normative poll interval drift");
  assert(
    String(network.required_provider_quorum) === "2",
    "normative reorg quorum drift",
  );
  assert(Array.isArray(network.providers), "normative providers are absent");
  const unsigned = {
    network: String(network.network),
    chain_id: String(network.chain_id),
    finality_policy_version: String(network.finality_policy_version),
    finality_method: "FINALIZED_TAG" as const,
    finalized_tag: "finalized" as const,
    ethereum_depth_fallback_allowed: false as const,
    required_quorum: 2 as const,
    require_distinct_asn: network.require_distinct_asn === true,
    require_distinct_client_family:
      network.require_distinct_client_family === true,
    poll_interval_seconds: 60 as const,
    providers: network.providers,
  };
  const policy: ReorgDetectionPolicyV1 = {
    policy_hash: sha256Hex(jcsCanonicalize(unsigned)),
    ...unsigned,
  };
  return {
    expected_bundle_root_hash: input.verified_root.root_hash,
    expected_normative_policy_hash: ref.sha256,
    expected_policy_hash: policy.policy_hash,
    expected_detector_key_id: input.detector_key_id,
    expected_policy: policy,
  };
};

export interface ReorgDetectionResultV1 {
  readonly status: "READY" | "UNKNOWN" | "NOT_READY" | "SUSPENDED";
  readonly reason:
    | "WATERMARK_CONFIRMED"
    | "QUORUM_UNAVAILABLE"
    | "PROVIDER_INDEPENDENCE_UNPROVABLE"
    | "UNSUPPORTED_FINALITY_EVIDENCE"
    | "CONFLICTING_FINALIZED_HASHES"
    | "CONFIRMED_REORG_BEHIND_WATERMARK"
    | "PROVIDER_COMPROMISE";
  readonly invalidation_required: boolean;
  readonly replacement_watermark_hash: string | null;
  readonly evidence_digest: string;
}

export interface SignedReorgEventV1 {
  readonly _tag: "ReorgDetectedV1";
  readonly environment: ReorgDetectionInputV1["environment"];
  readonly generation: string;
  readonly invalidation_epoch: string;
  readonly bundle_root_hash: string;
  readonly policy_hash: string;
  readonly old_watermark: ReorgWatermarkV1;
  readonly replacement_watermark_hash: string | null;
  readonly divergence_height: string;
  readonly provider_evidence_digest: string;
  readonly reason: ReorgDetectionResultV1["reason"];
  readonly detected_at: string;
  readonly signer_key_id: string;
  readonly signature: string;
}

export interface SignedServingExceptionV1 {
  readonly _tag: "ServingExceptionV1";
  readonly environment: ReorgDetectionInputV1["environment"];
  readonly generation: string;
  readonly failure_class: ServingFailureClass;
  readonly impact_set_digest: string;
  readonly serving_policy_hash: string;
  readonly starts_at: string;
  readonly expires_at: string;
  readonly last_good_policy: LastGoodPolicy;
  readonly maximum_ttl_seconds: string;
  readonly graduation_eligible: false;
  readonly signer_key_id: string;
  readonly signature: string;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const assert: (condition: unknown, reason: string) => asserts condition = (
  condition,
  reason,
) => {
  if (!condition) throw new Error(reason);
};

type UnsignedReorgProviderObservationV1 = Omit<
  ReorgProviderObservationV1,
  "evidence_hash" | "signer_key_id" | "signature"
>;

const providerObservationEvidenceHash = (
  observation: UnsignedReorgProviderObservationV1,
): string => sha256Hex(jcsCanonicalize(observation));

const providerObservationSigningBytes = (
  observation: UnsignedReorgProviderObservationV1,
  evidenceHash: string,
): Uint8Array =>
  encoder.encode(
    `sonar.reorg-provider-observation.v1\0${observation.provider_id}\0${evidenceHash}`,
  );

export const compileSignedReorgProviderObservationV1 = (
  observation: UnsignedReorgProviderObservationV1,
  signer: TrustEnvelopeSigner,
): ReorgProviderObservationV1 => {
  const evidenceHash = providerObservationEvidenceHash(observation);
  return {
    ...observation,
    evidence_hash: evidenceHash,
    signer_key_id: signer.keyId,
    signature: signer.sign(providerObservationSigningBytes(observation, evidenceHash)),
  };
};

const verifyProviderObservation = (
  observation: ReorgProviderObservationV1,
  provider: ReorgProviderPolicyV1,
): boolean => {
  const {
    evidence_hash: evidenceHash,
    signer_key_id: signerKeyId,
    signature,
    ...unsigned
  } = observation;
  return (
    signerKeyId === provider.key_id &&
    evidenceHash === providerObservationEvidenceHash(unsigned) &&
    verifyEd25519Signature(
      provider.public_key_hex,
      providerObservationSigningBytes(unsigned, evidenceHash),
      signature,
    )
  );
};

const reorgPolicyHash = (
  policy: ReorgDetectionPolicyV1,
): string => {
  const { policy_hash: _policyHash, ...unsigned } = policy;
  return sha256Hex(jcsCanonicalize(unsigned));
};

const validateServingMatrix = (): void => {
  assert(SERVING_FAILURE_MATRIX_V1.length === 9, "serving matrix must have nine rules");
  assert(
    new Set(SERVING_FAILURE_MATRIX_V1.map((rule) => rule.failure_class)).size === 9,
    "serving matrix contains duplicate failure classes",
  );
  for (const rule of SERVING_FAILURE_MATRIX_V1) {
    if (
      [
        "REORG_BEHIND_WATERMARK",
        "SEMANTIC_OR_PROVENANCE_MISMATCH",
        "IDENTITY_REVOKED_OR_CONTESTED",
        "SIGNER_OR_ROOT_COMPROMISE",
        "INCOMPATIBLE_PRODUCER_CONSUMER",
      ].includes(rule.failure_class)
    ) {
      assert(rule.last_good === "FORBIDDEN", "hard failure permits last-good serving");
    }
    assert(rule.graduation_eligible === false, "failure rule permits graduation");
  }
};
validateServingMatrix();

const independent = (
  providers: readonly ReorgProviderPolicyV1[],
  policy: ReorgDetectionPolicyV1,
): boolean => {
  if (
    new Set(providers.map((provider) => provider.operator)).size !== providers.length ||
    new Set(providers.map((provider) => provider.legal_entity)).size !== providers.length ||
    new Set(providers.map((provider) => provider.control_domain)).size !== providers.length ||
    new Set(providers.map((provider) => provider.network_path)).size !== providers.length ||
    new Set(providers.map((provider) => provider.upstream_source)).size !== providers.length
  ) {
    return false;
  }
  if (
    policy.require_distinct_asn &&
    new Set(providers.map((provider) => provider.asn)).size !== providers.length
  ) {
    return false;
  }
  return !(
    policy.require_distinct_client_family &&
    new Set(providers.map((provider) => provider.client_family)).size !== providers.length
  );
};

export const detectReorgV1 = (
  input: ReorgDetectionInputV1,
  trust: ReorgTrustContextV1,
): ReorgDetectionResultV1 => {
  assert(HEX_64.test(input.bundle_root_hash), "invalid bundle root hash");
  assert(
    input.bundle_root_hash === trust.expected_bundle_root_hash,
    "bundle root is not trusted",
  );
  assert(HEX_64.test(input.policy.policy_hash), "invalid policy hash");
  assert(input.policy.policy_hash === reorgPolicyHash(input.policy), "policy hash mismatch");
  assert(input.policy.policy_hash === trust.expected_policy_hash, "policy is not trusted");
  assert(
    jcsCanonicalize(input.policy) === jcsCanonicalize(trust.expected_policy),
    "runtime policy differs from signed normative closure",
  );
  assert(input.policy.network === input.active_watermark.network, "network mismatch");
  assert(input.policy.chain_id === input.active_watermark.chain_id, "chain mismatch");
  assert(
    input.policy.finality_policy_version === input.active_watermark.finality_policy_version,
    "finality policy mismatch",
  );
  assert(input.policy.finality_method === "FINALIZED_TAG", "unsupported finality method");
  assert(input.policy.finalized_tag === "finalized", "finalized tag required");
  assert(!input.policy.ethereum_depth_fallback_allowed, "depth fallback forbidden");
  assert(
    new Set(input.policy.providers.map((provider) => provider.provider_id)).size ===
      input.policy.providers.length,
    "duplicate provider policy id",
  );
  assert(
    new Set(input.observations.map((observation) => observation.provider_id)).size ===
      input.observations.length,
    "duplicate provider observation",
  );
  for (const observation of input.observations) {
    const provider = input.policy.providers.find(
      (candidate) => candidate.provider_id === observation.provider_id,
    );
    assert(provider !== undefined, "observation provider is not in signed policy");
    assert(
      verifyProviderObservation(observation, provider),
      "provider observation signature or evidence hash is invalid",
    );
  }
  const evidenceDigest = sha256Hex(jcsCanonicalize([...input.observations]));
  const result = (
    status: ReorgDetectionResultV1["status"],
    reason: ReorgDetectionResultV1["reason"],
    invalidationRequired: boolean,
    replacement: string | null = null,
  ): ReorgDetectionResultV1 => ({
    status,
    reason,
    invalidation_required: invalidationRequired,
    replacement_watermark_hash: replacement,
    evidence_digest: evidenceDigest,
  });
  if (input.observations.some((observation) => observation.provider_compromised)) {
    return result("SUSPENDED", "PROVIDER_COMPROMISE", true);
  }
  const detectedAt = Date.parse(input.detected_at);
  const maximumObservationAge =
    REORG_SERVICE_OBJECTIVES_V1.poll_interval_seconds *
    REORG_SERVICE_OBJECTIVES_V1.detection_within_polls *
    1_000;
  const available = input.observations.filter(
    (observation) =>
      !observation.transport_error &&
      detectedAt - Date.parse(observation.observed_at) <= maximumObservationAge &&
      Date.parse(observation.observed_at) <= detectedAt + 60_000,
  );
  if (available.length < input.policy.required_quorum) {
    return result("UNKNOWN", "QUORUM_UNAVAILABLE", false);
  }
  if (
    available.some(
      (observation) =>
        observation.finality_method !== "FINALIZED_TAG" ||
        observation.finalized_tag !== "finalized" ||
        observation.watermark_height !== input.active_watermark.height,
    )
  ) {
    return result("UNKNOWN", "UNSUPPORTED_FINALITY_EVIDENCE", false);
  }
  if (
    available.some(
      (observation) =>
        observation.finalized_height === null ||
        !/^(0|[1-9][0-9]*)$/.test(observation.finalized_height) ||
        observation.finalized_hash === null ||
        !HEX_64.test(observation.finalized_hash),
    )
  ) {
    return result("UNKNOWN", "QUORUM_UNAVAILABLE", false);
  }
  if (
    available.some(
      (observation) =>
        BigInt(observation.finalized_height!) <
        BigInt(input.active_watermark.height),
    )
  ) {
    return result("UNKNOWN", "QUORUM_UNAVAILABLE", false);
  }
  const watermarkParentHashes = new Set(
    available.map((observation) => observation.watermark_parent_hash),
  );
  if (watermarkParentHashes.has(null)) {
    return result("UNKNOWN", "QUORUM_UNAVAILABLE", false);
  }
  if (
    watermarkParentHashes.size !== 1 ||
    !HEX_64.test(available[0]!.watermark_parent_hash!)
  ) {
    return result("NOT_READY", "CONFLICTING_FINALIZED_HASHES", true);
  }
  const orderedAvailable = [...available].sort((left, right) =>
    left.provider_id.localeCompare(right.provider_id),
  );
  let selected: readonly ReorgProviderObservationV1[] | undefined;
  for (let left = 0; left < orderedAvailable.length && selected === undefined; left += 1) {
    for (let right = left + 1; right < orderedAvailable.length; right += 1) {
      const candidate = [orderedAvailable[left]!, orderedAvailable[right]!];
      const policies = candidate.map((observation) => {
      const provider = input.policy.providers.find(
          (entry) => entry.provider_id === observation.provider_id,
        );
      assert(provider !== undefined, "observation provider is not in signed policy");
      return provider;
      });
      if (independent(policies, input.policy)) selected = candidate;
    }
  }
  if (selected === undefined) {
    return result("UNKNOWN", "PROVIDER_INDEPENDENCE_UNPROVABLE", false);
  }
  const hashesByHeight = new Map<string, Set<string | null>>();
  for (const observation of available) {
    const height = observation.finalized_height ?? "missing";
    hashesByHeight.set(height, new Set([...(hashesByHeight.get(height) ?? []), observation.finalized_hash]));
  }
  if ([...hashesByHeight.values()].some((hashes) => hashes.size > 1)) {
    return result("NOT_READY", "CONFLICTING_FINALIZED_HASHES", true);
  }
  const watermarkHashes = new Set(
    available.map((observation) => observation.watermark_hash_at_height),
  );
  if (watermarkHashes.has(null)) {
    return result("UNKNOWN", "QUORUM_UNAVAILABLE", false);
  }
  if (watermarkHashes.size !== 1) {
    return result("NOT_READY", "CONFLICTING_FINALIZED_HASHES", true);
  }
  const quorumWatermarkHash = available[0]!.watermark_hash_at_height!;
  assert(HEX_64.test(quorumWatermarkHash), "invalid observed watermark hash");
  if (quorumWatermarkHash !== input.active_watermark.block_hash) {
    return result(
      "NOT_READY",
      "CONFIRMED_REORG_BEHIND_WATERMARK",
      true,
      quorumWatermarkHash,
    );
  }
  return result("READY", "WATERMARK_CONFIRMED", false);
};

const unsignedReorgEvent = (
  event: SignedReorgEventV1,
): Omit<SignedReorgEventV1, "signature" | "signer_key_id"> => {
  const { signature: _signature, signer_key_id: _signer, ...unsigned } = event;
  return unsigned;
};

const reorgSigningBytes = (
  event: Omit<SignedReorgEventV1, "signature" | "signer_key_id">,
): Uint8Array =>
  encoder.encode(
    `${REORG_DOMAIN}\0${event.environment}\0${event.generation}\0${event.invalidation_epoch}\0${sha256Hex(jcsCanonicalize(event))}`,
  );

const compileUnsignedReorgEvent = (
  input: ReorgDetectionInputV1,
  result: ReorgDetectionResultV1,
): Omit<SignedReorgEventV1, "signature" | "signer_key_id"> => ({
  _tag: "ReorgDetectedV1",
  environment: input.environment,
  generation: input.generation,
  invalidation_epoch: input.invalidation_epoch,
  bundle_root_hash: input.bundle_root_hash,
  policy_hash: input.policy.policy_hash,
  old_watermark: input.active_watermark,
  replacement_watermark_hash: result.replacement_watermark_hash,
  divergence_height: input.active_watermark.height,
  provider_evidence_digest: result.evidence_digest,
  reason: result.reason,
  detected_at: input.detected_at,
});

export const compileSignedReorgEventV1 = (
  input: ReorgDetectionInputV1,
  result: ReorgDetectionResultV1,
  trust: ReorgTrustContextV1,
  signer: TrustEnvelopeSigner,
): SignedReorgEventV1 => {
  assert(signer.keyId === trust.expected_detector_key_id, "unexpected detector signer");
  const recomputed = detectReorgV1(input, trust);
  assert(
    jcsCanonicalize(recomputed) === jcsCanonicalize(result),
    "caller-supplied reorg result differs from verified detection",
  );
  assert(recomputed.invalidation_required, "non-invalidating detection cannot emit reorg event");
  const unsigned = compileUnsignedReorgEvent(input, result);
  return {
    ...unsigned,
    signer_key_id: signer.keyId,
    signature: signer.sign(reorgSigningBytes(unsigned)),
  };
};

export const verifySignedReorgEventV1 = (
  event: SignedReorgEventV1,
  input: ReorgDetectionInputV1,
  trust: ReorgTrustContextV1,
  publicKeyHex: string,
): boolean => {
  try {
    assert(event.signer_key_id === trust.expected_detector_key_id, "unexpected detector signer");
    const result = detectReorgV1(input, trust);
    assert(result.invalidation_required, "input does not prove invalidation");
    const expected = compileUnsignedReorgEvent(input, result);
    assert(
      jcsCanonicalize(unsignedReorgEvent(event)) === jcsCanonicalize(expected),
      "reorg event context mismatch",
    );
    return verifyEd25519Signature(
      publicKeyHex,
      reorgSigningBytes(expected),
      event.signature,
    );
  } catch {
    return false;
  }
};

/**
 * Staged detector-to-projection bridge. Only a verified, confirmed historical
 * reorg may create the monotonic REORG_BEHIND_WATERMARK invalidation cause.
 */
export const compileReorgProjectionInvalidationV1 = (
  event: SignedReorgEventV1,
  input: ReorgDetectionInputV1,
  trust: ReorgTrustContextV1,
  detectorPublicKeyHex: string,
  projection: TruthStatusProjectionV1,
  signer: TrustEnvelopeSigner,
): SignedProjectionEventV1 => {
  assert(
    input.environment === "development" || input.environment === "staging",
    "production reorg projection is outside staged authority",
  );
  assert(
    verifySignedReorgEventV1(event, input, trust, detectorPublicKeyHex),
    "reorg event is untrusted",
  );
  const projectionCause =
    event.reason === "CONFIRMED_REORG_BEHIND_WATERMARK"
      ? {
          status: "NOT_READY" as const,
          reason: "REORG_BEHIND_WATERMARK" as const,
        }
      : event.reason === "CONFLICTING_FINALIZED_HASHES"
        ? {
            status: "NOT_READY" as const,
            reason: "REORG_BEHIND_WATERMARK" as const,
          }
        : event.reason === "PROVIDER_COMPROMISE"
          ? {
              status: "SUSPENDED" as const,
              reason: "SIGNER_ROOT_COMPROMISE_REVOCATION" as const,
            }
          : undefined;
  assert(
    projectionCause !== undefined,
    "reorg event does not carry an invalidating detector state",
  );
  if (event.reason === "CONFIRMED_REORG_BEHIND_WATERMARK") {
    assert(
      event.replacement_watermark_hash !== null,
      "confirmed reorg omits replacement watermark",
    );
  }
  assert(
    signer.keyId === event.signer_key_id &&
      signer.keyId === trust.expected_detector_key_id,
    "reorg projection signer differs from detector",
  );
  assert(projection.environment === input.environment, "reorg projection environment mismatch");
  const node = projection.artifacts[event.bundle_root_hash];
  assert(node !== undefined, "reorg projection target is not active");
  assert(node.generation === event.generation, "reorg projection generation mismatch");
  assert(
    BigInt(event.invalidation_epoch) > BigInt(node.invalidation_epoch),
    "reorg invalidation epoch must advance",
  );
  const projectionEventId = sha256Hex(
    `reorg-projection\0${sha256Hex(jcsCanonicalize(event))}\0${event.bundle_root_hash}`,
  );
  return compileProjectionEventV1(
    {
      schema_version: 1,
      event_id: projectionEventId,
      sequence: String(BigInt(projection.last_sequence) + 1n),
      previous_event_hash: projection.tail_event_hash,
      kind: "INVALIDATION",
      environment: input.environment,
      artifact_hash: event.bundle_root_hash,
      generation: event.generation,
      invalidation_epoch: event.invalidation_epoch,
      authority: "SERVING",
      lifecycle_state: node.lifecycle_state,
      local_status: projectionCause.status,
      state_floor: projectionCause.status,
      reason_code: projectionCause.reason,
      cause_event_id: projectionEventId,
      resolves_cause_event_ids: [],
      replacement_evidence_hash: null,
      replacement_evidence_kinds: null,
      replacement_evidence: null,
      depends_on: [],
      occurred_at: event.detected_at,
      production_authority: false,
    },
    signer,
  );
};

export const servingRuleForV1 = (
  failureClass: ServingFailureClass,
  environment: ReorgDetectionInputV1["environment"] = "staging",
): ServingRuleV1 => {
  const rule = SERVING_FAILURE_MATRIX_V1.find(
    (candidate) => candidate.failure_class === failureClass,
  );
  assert(rule !== undefined, `unknown serving failure class ${String(failureClass)}`);
  return environment === "production" && rule.maximum_last_good_seconds > 0
    ? { ...rule, maximum_last_good_seconds: 900 }
    : rule;
};

const servingFailureWireName: Readonly<Record<ServingFailureClass, string>> = {
  TEMPORARY_TRANSPORT_LOSS: "temporary_source_transport_loss",
  STALE_EVIDENCE: "stale_projection_or_evidence",
  CURSOR_NOT_ADVANCING: "source_cursor_not_advancing",
  REORG_BEHIND_WATERMARK: "reorg_behind_watermark",
  RECONCILIATION_COUNT_BREACH: "reconciliation_count_breach",
  SEMANTIC_OR_PROVENANCE_MISMATCH: "semantic_provenance_mismatch",
  IDENTITY_REVOKED_OR_CONTESTED: "identity_revoked_or_contested",
  SIGNER_OR_ROOT_COMPROMISE: "signer_root_compromise",
  INCOMPATIBLE_PRODUCER_CONSUMER: "incompatible_producer_consumer",
};

export const verifyServingPolicyObjectV1 = (
  value: unknown,
  expectedHash: string,
  expectedEnvironment: "development" | "staging" | "production",
): boolean => {
  try {
    assert(
      typeof value === "object" && value !== null && !Array.isArray(value),
      "serving policy is not an object",
    );
    const policy = value as {
      kind?: unknown;
      environment?: unknown;
      rules?: unknown;
    };
    assert(policy.kind === "serving_policy", "wrong serving policy kind");
    assert(policy.environment === expectedEnvironment, "serving policy environment mismatch");
    assert(Array.isArray(policy.rules) && policy.rules.length === 9, "serving policy is not total");
    assert(sha256Hex(jcsCanonicalize(value)) === expectedHash, "serving policy hash mismatch");
    for (const expected of SERVING_FAILURE_MATRIX_V1) {
      const rule = policy.rules.find(
        (candidate) =>
          typeof candidate === "object" &&
          candidate !== null &&
          (candidate as { failure_class?: unknown }).failure_class ===
            servingFailureWireName[expected.failure_class],
      ) as
        | {
            effective_status?: unknown;
            last_good_policy?: unknown;
            maximum_last_good_seconds?: unknown;
            graduation_eligible?: unknown;
          }
        | undefined;
      assert(rule !== undefined, "serving policy rule missing");
      assert(rule.effective_status === expected.effective_status, "serving status drift");
      assert(rule.last_good_policy === expected.last_good, "last-good policy drift");
      const environmentRule = servingRuleForV1(
        expected.failure_class,
        expectedEnvironment,
      );
      assert(
        String(rule.maximum_last_good_seconds) ===
          String(environmentRule.maximum_last_good_seconds),
        "last-good TTL drift",
      );
      assert(
        String(
          (rule as typeof rule & { escalation_seconds?: unknown })
            .escalation_seconds,
        ) === String(expected.escalation_seconds),
        "serving escalation drift",
      );
      assert(
        (rule as typeof rule & { user_label?: unknown }).user_label ===
          expected.user_label,
        "serving user label drift",
      );
      assert(rule.graduation_eligible === false, "serving failure permits graduation");
    }
    return true;
  } catch {
    return false;
  }
};

const unsignedServingException = (
  exception: SignedServingExceptionV1,
): Omit<SignedServingExceptionV1, "signature" | "signer_key_id"> => {
  const { signature: _signature, signer_key_id: _key, ...unsigned } = exception;
  return unsigned;
};

const servingExceptionSigningBytes = (
  exception: Omit<SignedServingExceptionV1, "signature" | "signer_key_id">,
): Uint8Array =>
  encoder.encode(
    `${EXCEPTION_DOMAIN}\0${exception.environment}\0${exception.generation}\0${sha256Hex(jcsCanonicalize(exception))}`,
  );

export const compileServingExceptionV1 = (
  input: Omit<
    SignedServingExceptionV1,
    | "_tag"
    | "signature"
    | "signer_key_id"
    | "graduation_eligible"
    | "maximum_ttl_seconds"
  >,
  signer: TrustEnvelopeSigner,
): SignedServingExceptionV1 => {
  const rule = servingRuleForV1(input.failure_class, input.environment);
  assert(rule.last_good === input.last_good_policy, "exception weakens serving policy");
  assert(input.last_good_policy !== "FORBIDDEN", "hard failure cannot receive exception");
  assert(HEX_64.test(input.serving_policy_hash), "invalid serving-policy digest");
  const startsAt = Date.parse(input.starts_at);
  const expiresAt = Date.parse(input.expires_at);
  assert(expiresAt > startsAt, "invalid exception interval");
  assert(rule.maximum_last_good_seconds > 0, "serving rule does not permit a timed exception");
  assert(
    expiresAt - startsAt <= rule.maximum_last_good_seconds * 1_000,
    "exception exceeds serving-policy TTL",
  );
  assert(HEX_64.test(input.impact_set_digest), "invalid impact-set digest");
  const unsigned: Omit<SignedServingExceptionV1, "signature" | "signer_key_id"> = {
    _tag: "ServingExceptionV1",
    ...input,
    maximum_ttl_seconds: String(rule.maximum_last_good_seconds),
    graduation_eligible: false,
  };
  return {
    ...unsigned,
    signer_key_id: signer.keyId,
    signature: signer.sign(servingExceptionSigningBytes(unsigned)),
  };
};

export const verifyServingExceptionV1 = (
  exception: SignedServingExceptionV1,
  publicKeyHex: string,
  now: string,
  expected: {
    readonly environment: ReorgDetectionInputV1["environment"];
    readonly generation: string;
    readonly impactSetDigest: string;
    readonly servingPolicyHash: string;
    readonly governanceKeyId: string;
  },
): boolean => {
  try {
    const rule = servingRuleForV1(exception.failure_class, exception.environment);
    assert(rule.last_good === exception.last_good_policy, "policy mismatch");
    assert(rule.last_good !== "FORBIDDEN", "forbidden exception");
    assert(exception.graduation_eligible === false, "exception permits graduation");
    assert(exception.environment === expected.environment, "exception environment mismatch");
    assert(exception.generation === expected.generation, "exception generation mismatch");
    assert(exception.impact_set_digest === expected.impactSetDigest, "impact set mismatch");
    assert(exception.serving_policy_hash === expected.servingPolicyHash, "serving policy mismatch");
    assert(exception.signer_key_id === expected.governanceKeyId, "governance signer mismatch");
    assert(
      exception.maximum_ttl_seconds === String(rule.maximum_last_good_seconds),
      "maximum TTL mismatch",
    );
    const startsAt = Date.parse(exception.starts_at);
    const expiresAt = Date.parse(exception.expires_at);
    assert(startsAt <= Date.parse(now), "exception not active");
    assert(expiresAt > Date.parse(now), "exception expired");
    assert(
      expiresAt - startsAt <= rule.maximum_last_good_seconds * 1_000,
      "exception exceeds serving-policy TTL",
    );
    return verifyEd25519Signature(
      publicKeyHex,
      servingExceptionSigningBytes(unsignedServingException(exception)),
      exception.signature,
    );
  } catch {
    return false;
  }
};
