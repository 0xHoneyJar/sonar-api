import { Effect } from "effect";

import type { TrustEnvelopeSigner } from "../collection-resolver/trust-protocol.js";
import {
  sha256Hex,
  verifyEd25519Signature,
} from "../collection-resolver/trust-protocol.js";
import { verifyTruthBundleRoot } from "./bundle-compiler.js";
import { canonicalizeTruthJson } from "./canonical.js";
import { TruthDecodeError, TruthIntegrityError, TruthTrustError } from "./errors.js";
import { compileNormativeClosure } from "./normative-compiler.js";
import {
  decodeStrict,
  TRUTH_MAX_FUTURE_SKEW_MILLISECONDS,
  type Sha256Digest,
  type DecimalUint64,
  type TruthEnvironmentId,
  type TruthIsoTimestamp,
} from "./schemas/common.js";
import {
  TRUTH_READINESS_STATE_PRECEDENCE,
  TruthLiveObservationReceiptUnsignedV1,
  TruthLiveObservationReceiptV1,
  TruthReadinessEnvelopeV1,
  TruthReadinessEvaluationInputV1,
  type TruthReadinessState,
} from "./schemas/readiness.js";

const encoder = new TextEncoder();
const READINESS_SIGNATURE_DOMAIN = "sonar.truth-readiness.v1";
const LIVE_OBSERVATION_SIGNATURE_DOMAIN = "sonar.truth-live-observation.v1";
const STAGED_CURRENT_MAX_AGE_MS = 60 * 60 * 1_000;

interface DecisionCandidate {
  readonly state: TruthReadinessState;
  readonly reason: string;
}

interface ProviderDecision {
  readonly candidates: ReadonlyArray<DecisionCandidate>;
  readonly watermark:
    | {
        readonly network: string;
        readonly chain_id: string;
        readonly height: string;
        readonly block_hash: string;
        readonly observed_at: string;
        readonly finality_policy_version: string;
        readonly finality_class: "FINALIZED";
      }
    | null;
}

const candidate = (
  state: TruthReadinessState,
  reason: string,
): DecisionCandidate => ({ state, reason });

const time = (value: string): number => new Date(value).getTime();

const uniqueSorted = <A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
): ReadonlyArray<A> => {
  const byKey = new Map<string, A>();
  for (const value of values) byKey.set(key(value), value);
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
};

export const evaluateEvidenceTime = Effect.fn(
  "truth.readiness.evaluateEvidenceTime",
)(function* (input: TruthReadinessEvaluationInputV1) {
  const now = time(input.now);
  const maximumFuture =
    now + Number(input.policy.max_future_skew_seconds) * 1_000;
  const oldestPermitted =
    now - Number(input.policy.observation_ttl_seconds) * 1_000;
  const observedTimes = [
    input.coverage.observed_at,
    input.activity.observed_at,
    input.reconciliation.observed_at,
    input.progression.source_head_observed_at,
    input.progression.cursor_observed_at,
    input.progression.heartbeat_observed_at,
    input.identity.effective_status.evaluated_at,
    ...input.providers.map((provider) => provider.observed_at),
  ];
  if (observedTimes.some((observedAt) => time(observedAt) > maximumFuture)) {
    return [candidate("UNKNOWN", "EVIDENCE_FROM_FUTURE")] as const;
  }
  if (observedTimes.some((observedAt) => time(observedAt) <= oldestPermitted)) {
    return [candidate("EXPIRED", "OBSERVATION_TTL_EXCEEDED")] as const;
  }
  if (
    [
      input.coverage.expires_at,
      input.activity.expires_at,
      input.reconciliation.expires_at,
      input.identity.effective_status.expires_at,
      ...(input.identity.valid_until === null ? [] : [input.identity.valid_until]),
    ]
      .some((expiresAt) => time(expiresAt) <= now)
  ) {
    return [candidate("EXPIRED", "REQUIRED_EVIDENCE_EXPIRED")] as const;
  }
  if (
    input.validity_class === "STAGED_CURRENT" &&
    observedTimes.some((observedAt) => now - time(observedAt) > STAGED_CURRENT_MAX_AGE_MS)
  ) {
    return [candidate("EXPIRED", "STAGED_OBSERVATION_OLDER_THAN_60_MINUTES")] as const;
  }
  return [] as const;
});

export const evaluateProviderQuorum = Effect.fn(
  "truth.readiness.evaluateProviderQuorum",
)(function* (
  input: TruthReadinessEvaluationInputV1,
): Generator<never, ProviderDecision> {
  const policy = input.policy;
  if (
    input.identity.chain_family !== "EVM" ||
    input.identity.network !== policy.network ||
    String(input.identity.chain_id) !== String(policy.chain_id) ||
    !input.identity.network_listed
  ) {
    return {
      candidates: [
        candidate(
          input.identity.chain_family === "SOLANA" ? "NOT_READY" : "UNKNOWN",
          input.identity.chain_family === "SOLANA"
            ? "SOLANA_ADAPTER_NOT_IN_INITIAL_SLICE"
            : "NETWORK_NOT_IN_SIGNED_POLICY",
        ),
      ],
      watermark: null,
    };
  }
  const policyProviders = new Map(
    policy.providers.map((provider) => [String(provider.provider_id), provider]),
  );
  const allowed = new Set(policyProviders.keys());
  const observations = input.providers.filter((observation) =>
    allowed.has(String(observation.provider_id)),
  );
  const quorum = Number(policy.required_provider_quorum);
  const allowedIds = policy.providers.map((provider) => String(provider.provider_id));
  const observedIds = input.providers.map((observation) =>
    String(observation.provider_id),
  );
  if (
    quorum < 2 ||
    new Set(allowedIds).size !== allowedIds.length ||
    new Set(observedIds).size !== observedIds.length ||
    observations.length < quorum ||
    input.providers.some((observation) => !allowed.has(String(observation.provider_id)))
  ) {
    return {
      candidates: [candidate("UNKNOWN", "FINALITY_PROVIDER_QUORUM_MISSING")],
      watermark: null,
    };
  }
  if (
    observations.some((observation) => {
      const expected = policyProviders.get(String(observation.provider_id));
      return (
        expected === undefined ||
        observation.operator !== expected.operator ||
        observation.legal_entity !== expected.legal_entity ||
        observation.control_domain !== expected.control_domain ||
        observation.network_path !== expected.network_path ||
        observation.asn !== expected.asn ||
        observation.client_family !== expected.client_family ||
        observation.upstream_source !== expected.upstream_source
      );
    })
  ) {
    return {
      candidates: [candidate("UNKNOWN", "FINALITY_PROVIDER_IDENTITY_MISMATCH")],
      watermark: null,
    };
  }
  if (
    observations.some(
      (observation) =>
        observation.source_error ||
        observation.finality_method !== "FINALIZED_TAG" ||
        observation.finalized_tag !== "finalized" ||
        observation.height === null ||
        observation.block_hash === null,
    )
  ) {
    return {
      candidates: [candidate("UNKNOWN", "FINALIZED_TAG_UNAVAILABLE")],
      watermark: null,
    };
  }
  const operators = new Set(observations.map((observation) => String(observation.operator)));
  const controlDomains = new Set(
    observations.map((observation) => String(observation.control_domain)),
  );
  const asns = new Set(observations.map((observation) => String(observation.asn)));
  const clients = new Set(
    observations.map((observation) => String(observation.client_family)),
  );
  if (
    operators.size < quorum ||
    controlDomains.size < quorum ||
    (policy.require_distinct_asn && asns.size < quorum) ||
    (policy.require_distinct_client_family && clients.size < quorum)
  ) {
    return {
      candidates: [candidate("UNKNOWN", "FINALITY_PROVIDERS_CORRELATED")],
      watermark: null,
    };
  }
  const positions = new Set(
    observations.map(
      (observation) => `${observation.height as string}\0${observation.block_hash as string}`,
    ),
  );
  if (positions.size !== 1) {
    return {
      candidates: [candidate("UNKNOWN", "FINALIZED_PROVIDER_DISAGREEMENT")],
      watermark: null,
    };
  }
  const first = observations[0]!;
  return {
    candidates: [],
    watermark: {
      network: String(policy.network),
      chain_id: String(policy.chain_id),
      height: String(first.height),
      block_hash: String(first.block_hash),
      observed_at: [...observations]
        .map((observation) => String(observation.observed_at))
        .sort()
        .at(0)!,
      finality_policy_version: String(policy.finality_policy_version),
      finality_class: "FINALIZED",
    },
  };
});

export const evaluateCoverageBinding = Effect.fn(
  "truth.readiness.evaluateCoverageBinding",
)(function* (input: TruthReadinessEvaluationInputV1) {
  const coverage = input.coverage;
  if (
    coverage.bundle_hash !== input.bundle_hash ||
    coverage.identity_snapshot_hash !== input.identity.snapshot_hash ||
    coverage.source_digest !== input.source_digest ||
    coverage.adapter_digest !== input.adapter_digest ||
    coverage.config_digest !== input.identity.config_digest
  ) {
    return [candidate("NOT_READY", "COVERAGE_BINDING_MISMATCH")] as const;
  }
  if (!coverage.marker_complete) {
    return [candidate("NOT_READY", "COVERAGE_MARKER_INCOMPLETE")] as const;
  }
  if (BigInt(coverage.processed_through) < BigInt(coverage.required_horizon)) {
    return [candidate("NOT_READY", "INDEX_BEHIND_REQUIRED_HORIZON")] as const;
  }
  if (!input.denominator_byte_verified) {
    return [candidate("NOT_READY", "DENOMINATOR_BYTES_NOT_VERIFIED")] as const;
  }
  if (input.denominator_manifest_hash !== input.policy.denominator_manifest_hash) {
    return [candidate("NOT_READY", "DENOMINATOR_POLICY_BINDING_MISMATCH")] as const;
  }
  return [] as const;
});

export const evaluateActivity = Effect.fn(
  "truth.readiness.evaluateActivity",
)(function* (input: TruthReadinessEvaluationInputV1) {
  if (!input.activity.profile_approved) {
    return [candidate("NOT_READY", "ACTIVITY_PROFILE_NOT_APPROVED")] as const;
  }
  if (time(input.activity.effective_from) > time(input.now)) {
    return [candidate("NOT_READY", "ACTIVITY_PROFILE_NOT_YET_EFFECTIVE")] as const;
  }
  if (
    input.activity.effective_until !== null &&
    time(input.activity.effective_until) <= time(input.now)
  ) {
    return [candidate("EXPIRED", "ACTIVITY_PROFILE_EXPIRED")] as const;
  }
  if (
    !input.progression.source_head_advancing ||
    !input.progression.cursor_advancing ||
    !input.progression.heartbeat_present ||
    !input.progression.cross_source_available
  ) {
    return [candidate("UNKNOWN", "INDEPENDENT_PROGRESSION_MISSING")] as const;
  }
  if (input.progression.source_failure) {
    return [
      candidate(
        input.progression.bounded_last_good_allowed ? "DEGRADED" : "UNKNOWN",
        input.progression.bounded_last_good_allowed
          ? "BOUNDED_SOURCE_TRANSPORT_LOSS"
          : "REQUIRED_SOURCE_FAILURE",
      ),
    ] as const;
  }
  const now = time(input.now);
  if (
    now - time(input.progression.source_head_observed_at) >=
      Number(input.activity.source_head_cadence_seconds) * 1_000 ||
    now - time(input.progression.cursor_observed_at) >=
      Number(input.activity.cursor_cadence_seconds) * 1_000 ||
    now - time(input.progression.heartbeat_observed_at) >=
      Number(input.activity.heartbeat_cadence_seconds) * 1_000
  ) {
    return [candidate("EXPIRED", "ACTIVITY_CADENCE_EXCEEDED")] as const;
  }
  if (
    BigInt(input.coverage.event_count) === 0n &&
    !input.activity.quiet_window_permitted
  ) {
    return [candidate("NOT_READY", "ZERO_EVENTS_NOT_EXPLAINED_BY_PROFILE")] as const;
  }
  return [] as const;
});

export const evaluateInvalidations = Effect.fn(
  "truth.readiness.evaluateInvalidations",
)(function* (input: TruthReadinessEvaluationInputV1) {
  return input.invalidations
    .filter((invalidation) => invalidation.active)
    .map((invalidation) =>
      candidate(
        invalidation.state_floor,
        invalidation.state_floor === "SUSPENDED"
          ? "ACTIVE_SEMANTIC_OR_TRUST_INVALIDATION"
          : "ACTIVE_READINESS_INVALIDATION",
      ),
    );
});

export const aggregateRequiredSources = Effect.fn(
  "truth.readiness.aggregateRequiredSources",
)(function* (
  candidates: ReadonlyArray<DecisionCandidate>,
): Generator<never, { readonly state: TruthReadinessState; readonly reasons: ReadonlyArray<string> }> {
  const state =
    TRUTH_READINESS_STATE_PRECEDENCE.reduce<TruthReadinessState>(
      (worst, next) =>
        candidates.some((entry) => entry.state === next) ? next : worst,
      "READY",
    );
  const reasons = uniqueSorted(
    candidates
      .filter((entry) => entry.state === state)
      .map((entry) => entry.reason),
    String,
  );
  return {
    state,
    reasons: reasons.length === 0 ? ["ALL_REQUIRED_EVIDENCE_VERIFIED"] : reasons,
  };
});

const readinessSigningBytes = (
  environment: TruthEnvironmentId,
  generation: string,
  envelopeHash: Sha256Digest,
): Uint8Array =>
  encoder.encode(
    `${READINESS_SIGNATURE_DOMAIN}\0${environment}\0${generation}\0${envelopeHash}`,
  );

const liveObservationSigningBytes = (receiptHash: Sha256Digest): Uint8Array =>
  encoder.encode(`${LIVE_OBSERVATION_SIGNATURE_DOMAIN}\0staging\0${receiptHash}`);

const observationSetValue = (input: TruthReadinessEvaluationInputV1) => ({
  bundle_hash: input.bundle_hash,
  bundle_generation: input.bundle_generation,
  identity: input.identity,
  providers: input.providers,
  coverage: input.coverage,
  progression: input.progression,
  activity: input.activity,
  reconciliation: input.reconciliation,
  required_sources: input.required_sources,
  invalidations: input.invalidations,
  invalidation_epoch: input.invalidation_epoch,
  source_digest: input.source_digest,
  adapter_digest: input.adapter_digest,
});

export const computeTruthReadinessObservationSetHash = (
  rawInput: unknown,
): Effect.Effect<Sha256Digest, TruthDecodeError | TruthIntegrityError> =>
  Effect.gen(function* () {
    const input = yield* decodeStrict(
      TruthReadinessEvaluationInputV1,
      "truth.readiness.input",
      rawInput,
    );
    const canonical = yield* canonicalizeTruthJson(
      observationSetValue(input),
      "truth.readiness.observation-set",
    );
    return sha256Hex(canonical) as Sha256Digest;
  });

export const compileTruthLiveObservationReceipt = (
  rawUnsignedReceipt: unknown,
  signer: TrustEnvelopeSigner,
): Effect.Effect<
  TruthLiveObservationReceiptV1,
  TruthDecodeError | TruthIntegrityError | TruthTrustError
> =>
  Effect.gen(function* () {
    const unsignedReceipt = yield* decodeStrict(
      TruthLiveObservationReceiptUnsignedV1,
      "truth.live-observation.unsigned",
      rawUnsignedReceipt,
    );
    if (
      unsignedReceipt.issuer_key_id !== signer.keyId ||
      time(unsignedReceipt.expires_at) <= time(unsignedReceipt.observed_at)
    ) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.live-observation.binding",
          reason: "live observation issuer or validity interval is invalid",
        }),
      );
    }
    const canonical = yield* canonicalizeTruthJson(
      unsignedReceipt,
      "truth.live-observation.unsigned",
    );
    const receiptHash = sha256Hex(canonical);
    const signature = yield* Effect.try({
      try: () =>
        signer.sign(liveObservationSigningBytes(receiptHash as Sha256Digest)),
      catch: () =>
        new TruthTrustError({
          boundary: "truth.live-observation.sign",
          reason: "Ed25519 signer failed",
        }),
    });
    return yield* decodeStrict(
      TruthLiveObservationReceiptV1,
      "truth.live-observation.receipt",
      { unsigned_receipt: unsignedReceipt, receipt_hash: receiptHash, signature },
    );
  });

export interface EvaluateTruthReadinessOptions {
  readonly normativeObjects: ReadonlyArray<unknown>;
  readonly bundleRoot: unknown;
  readonly bundleVerification: {
    readonly expectedEnvironment: TruthEnvironmentId;
    readonly expectedKeyId: string;
    readonly publicKeyHex: string;
    readonly trustedGenerationHighWater: DecimalUint64;
    readonly now: TruthIsoTimestamp;
  };
  readonly trustedLiveObservationKeys?: ReadonlyMap<string, string>;
}

const normativeBindingFailure = (reason: string): TruthIntegrityError =>
  new TruthIntegrityError({ boundary: "truth.readiness.normative-binding", reason });

export const validateReadinessNormativeBindings = Effect.fn(
  "truth.readiness.validateNormativeBindings",
)(function* (
  input: TruthReadinessEvaluationInputV1,
  normativeObjects: ReadonlyArray<unknown>,
) {
  const closure = yield* compileNormativeClosure(normativeObjects);
  const byKind = new Map(
    closure.map((object) => [String(object.ref.kind), object] as const),
  );
  const expectedHashes = [
    ["identity_snapshot", input.identity.snapshot_hash],
    ["event_vocabulary", input.event_vocabulary_hash],
    ["network_finality_policy", input.network_policy_hash],
    ["activity_profiles", input.activity_profile_hash],
  ] as const;
  if (
    expectedHashes.some(
      ([kind, expected]) => byKind.get(kind)?.ref.sha256 !== expected,
    )
  ) {
    return yield* Effect.fail(
      normativeBindingFailure("readiness object hash is not in the compiled closure"),
    );
  }
  const identityObject = byKind.get("identity_snapshot")?.value;
  const eventObject = byKind.get("event_vocabulary")?.value;
  const networkObject = byKind.get("network_finality_policy")?.value;
  const activityObject = byKind.get("activity_profiles")?.value;
  if (
    identityObject?.kind !== "identity_snapshot" ||
    eventObject?.kind !== "event_vocabulary" ||
    networkObject?.kind !== "network_finality_policy" ||
    activityObject?.kind !== "activity_profiles"
  ) {
    return yield* Effect.fail(
      normativeBindingFailure("required normative producer object is absent"),
    );
  }
  const binding = identityObject.bindings.find(
    (candidateBinding) =>
      candidateBinding.canonical_collection_id ===
      input.identity.canonical_collection_id,
  );
  const member = eventObject.denominator_members.find(
    (candidateMember) =>
      candidateMember.canonical_collection_id ===
      input.identity.canonical_collection_id,
  );
  const network = networkObject.networks.find(
    (candidateNetwork) =>
      candidateNetwork.network === input.policy.network &&
      String(candidateNetwork.chain_id) === String(input.policy.chain_id),
  );
  const activity = activityObject.profiles.find(
    (candidateActivity) =>
      candidateActivity.collection_id === input.identity.canonical_collection_id,
  );
  if (binding === undefined || member === undefined || network === undefined || activity === undefined) {
    return yield* Effect.fail(
      normativeBindingFailure("identity, denominator, network, or activity member is absent"),
    );
  }
  const [signedIdentityStatus, projectedIdentityStatus] = yield* Effect.all([
    canonicalizeTruthJson(
      binding.effective_status,
      "truth.readiness.identity.signed-status",
    ),
    canonicalizeTruthJson(
      input.identity.effective_status,
      "truth.readiness.identity.projected-status",
    ),
  ]);
  const policyProviders = [...input.policy.providers].sort((left, right) =>
    String(left.provider_id).localeCompare(String(right.provider_id)),
  );
  const signedProviders = [...network.providers].sort((left, right) =>
    String(left.provider_id).localeCompare(String(right.provider_id)),
  );
  const providerMismatch =
    policyProviders.length !== signedProviders.length ||
    policyProviders.some((provider, index) => {
      const signed = signedProviders[index]!;
      return (
        provider.provider_id !== signed.provider_id ||
        provider.operator !== signed.operator ||
        provider.legal_entity !== signed.legal_entity ||
        provider.control_domain !== signed.control_domain ||
        provider.network_path !== signed.network_path ||
        provider.asn !== signed.asn ||
        provider.client_family !== signed.client_family ||
        provider.upstream_source !== signed.upstream_source
      );
    });
  const mismatch =
    binding.chain_family !== input.identity.chain_family ||
    String(binding.chain_id) !== String(input.identity.chain_id) ||
    binding.canonical_address !== input.identity.canonical_address ||
    [...binding.aliases].map(String).sort().join("\0") !==
      [...input.identity.aliases].map(String).sort().join("\0") ||
    String(binding.observed_height) !== String(input.identity.observed_height) ||
    binding.observed_hash !== input.identity.observed_hash ||
    binding.observed_at !== input.identity.observed_at ||
    binding.finality_policy_version !== input.identity.finality_policy_version ||
    binding.config_digest !== input.identity.config_digest ||
    binding.deployed_identity_hash !== input.identity.deployed_identity_hash ||
    binding.deployed_code_hash !== input.identity.code_hash ||
    binding.proxy_kind !== input.identity.proxy_kind ||
    binding.implementation_address !== input.identity.implementation_address ||
    binding.implementation_code_hash !==
      input.identity.implementation_code_hash ||
    binding.upgrade_mechanism !== input.identity.upgrade_mechanism ||
    binding.valid_from !== input.identity.valid_from ||
    binding.valid_until !== input.identity.valid_until ||
    binding.contest_state !== input.identity.contest_state ||
    signedIdentityStatus !== projectedIdentityStatus ||
    input.identity.admitted !==
      (binding.contest_state === "CLEAR" &&
        binding.effective_status._tag === "READY") ||
    String(member.chain_id) !== String(input.identity.chain_id) ||
    member.canonical_address !== binding.canonical_address ||
    eventObject.denominator_manifest_hash !== input.denominator_manifest_hash ||
    input.policy.denominator_manifest_hash !== input.denominator_manifest_hash ||
    network.finality_policy_version !== input.policy.finality_policy_version ||
    network.finality_method !== input.policy.finality_method ||
    network.finalized_tag !== input.policy.finalized_tag ||
    network.ethereum_depth_fallback_allowed !==
      input.policy.ethereum_depth_fallback_allowed ||
    String(network.required_provider_quorum) !==
      String(input.policy.required_provider_quorum) ||
    network.require_distinct_asn !== input.policy.require_distinct_asn ||
    network.require_distinct_client_family !==
      input.policy.require_distinct_client_family ||
    String(network.observation_ttl_seconds) !==
      String(input.policy.observation_ttl_seconds) ||
    String(network.readiness_ttl_seconds) !==
      String(input.policy.readiness_ttl_seconds) ||
    network.max_future_skew_seconds !== input.policy.max_future_skew_seconds ||
    providerMismatch ||
    activityObject.version !== input.activity.profile_version ||
    activity.owner !== input.activity.owner ||
    activity.approval !== input.activity.approval ||
    activity.backtest_digest !== input.activity.backtest_digest ||
    activity.evidence_window_start !== input.activity.evidence_window_start ||
    activity.evidence_window_end !== input.activity.evidence_window_end ||
    activity.effective_from !== input.activity.effective_from ||
    activity.effective_until !== input.activity.effective_until ||
    input.activity.evidence.evidence_id !== input.activity.approval ||
    input.activity.evidence.sha256 !== input.activity.backtest_digest ||
    String(activity.expected_event_window_seconds) !==
      String(input.activity.expected_event_window_seconds) ||
    String(activity.source_head_cadence_seconds) !==
      String(input.activity.source_head_cadence_seconds) ||
    String(activity.cursor_cadence_seconds) !==
      String(input.activity.cursor_cadence_seconds) ||
    String(activity.provider_heartbeat_cadence_seconds) !==
      String(input.activity.heartbeat_cadence_seconds) ||
    activity.quiet_window_permitted !== input.activity.quiet_window_permitted;
  return mismatch
    ? yield* Effect.fail(
        normativeBindingFailure(
          "readiness projection does not equal the signed normative object",
        ),
      )
    : closure;
});

export const evaluateTruthReadiness = (
  rawInput: unknown,
  signer: TrustEnvelopeSigner,
  options: EvaluateTruthReadinessOptions,
): Effect.Effect<
  TruthReadinessEnvelopeV1,
  TruthDecodeError | TruthIntegrityError | TruthTrustError
> =>
  Effect.gen(function* () {
    const input = yield* decodeStrict(
      TruthReadinessEvaluationInputV1,
      "truth.readiness.input",
      rawInput,
    );
    const invalidValidityClass =
      (input.validity_class === "FIXTURE_VALID" &&
        (input.evidence_origin !== "HERMETIC_FIXTURE" ||
          input.live_observation_receipt !== null)) ||
      (input.validity_class === "STAGED_CURRENT" &&
        (input.environment !== "staging" ||
          input.evidence_origin !== "READ_ONLY_LIVE" ||
          input.live_observation_receipt === null));
    if (invalidValidityClass) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.readiness.validity-class",
          reason:
            "validity class is not supported by the evidence origin and environment",
        }),
      );
    }
    const closure = yield* validateReadinessNormativeBindings(
      input,
      options.normativeObjects,
    );
    const verifiedRoot = yield* verifyTruthBundleRoot(
      options.bundleRoot,
      options.bundleVerification,
    );
    const closureRefs = new Map(
      closure.map((object) => [String(object.ref.kind), String(object.ref.sha256)]),
    );
    const rootRefs = new Map(
      verifiedRoot.unsigned_root.objects.map((ref) => [
        String(ref.kind),
        String(ref.sha256),
      ]),
    );
    if (
      verifiedRoot.root_hash !== input.bundle_hash ||
      String(verifiedRoot.unsigned_root.generation) !==
        String(input.bundle_generation) ||
      verifiedRoot.unsigned_root.environment !== input.environment ||
      verifiedRoot.unsigned_root.issuer.key_id !== signer.keyId ||
      closureRefs.size !== rootRefs.size ||
      [...closureRefs].some(([kind, hash]) => rootRefs.get(kind) !== hash)
    ) {
      return yield* Effect.fail(
        new TruthTrustError({
          boundary: "truth.readiness.bundle-binding",
          reason: "verified bundle root does not exactly commit the evaluated closure",
        }),
      );
    }
    let liveObservationReceiptHash: Sha256Digest | null = null;
    if (input.live_observation_receipt !== null) {
      const receipt = input.live_observation_receipt;
      const publicKey = options.trustedLiveObservationKeys?.get(
        String(receipt.unsigned_receipt.issuer_key_id),
      );
      const canonicalReceipt = yield* canonicalizeTruthJson(
        receipt.unsigned_receipt,
        "truth.live-observation.unsigned",
      );
      const computedReceiptHash = sha256Hex(canonicalReceipt);
      const observationSetHash = yield* computeTruthReadinessObservationSetHash(input);
      const receiptBindingInvalid =
        publicKey === undefined ||
        computedReceiptHash !== receipt.receipt_hash ||
        receipt.unsigned_receipt.bundle_hash !== input.bundle_hash ||
        receipt.unsigned_receipt.identity_snapshot_hash !==
          input.identity.snapshot_hash ||
        receipt.unsigned_receipt.event_vocabulary_hash !==
          input.event_vocabulary_hash ||
        receipt.unsigned_receipt.network_policy_hash !==
          input.network_policy_hash ||
        receipt.unsigned_receipt.activity_profile_hash !==
          input.activity_profile_hash ||
        receipt.unsigned_receipt.denominator_manifest_hash !==
          input.denominator_manifest_hash ||
        receipt.unsigned_receipt.source_digest !== input.source_digest ||
        receipt.unsigned_receipt.adapter_digest !== input.adapter_digest ||
        receipt.unsigned_receipt.observation_set_hash !== observationSetHash ||
        time(receipt.unsigned_receipt.expires_at) <= time(input.now) ||
        time(receipt.unsigned_receipt.expires_at) <=
          time(receipt.unsigned_receipt.observed_at) ||
        time(receipt.unsigned_receipt.observed_at) >
          time(input.now) + TRUTH_MAX_FUTURE_SKEW_MILLISECONDS ||
        time(input.now) - time(receipt.unsigned_receipt.observed_at) >
          STAGED_CURRENT_MAX_AGE_MS ||
        !verifyEd25519Signature(
          publicKey ?? "",
          liveObservationSigningBytes(receipt.receipt_hash),
          receipt.signature,
        );
      if (receiptBindingInvalid) {
        return yield* Effect.fail(
          new TruthTrustError({
            boundary: "truth.live-observation.verify",
            reason:
              "staged-current live observation receipt is untrusted, stale, or unbound",
          }),
        );
      }
      liveObservationReceiptHash = receipt.receipt_hash;
    }
    const provider = yield* evaluateProviderQuorum(input);
    const candidates: Array<DecisionCandidate> = [
      ...(yield* evaluateEvidenceTime(input)),
      ...provider.candidates,
      ...(yield* evaluateCoverageBinding(input)),
      ...(yield* evaluateActivity(input)),
      ...(yield* evaluateInvalidations(input)),
      ...input.required_sources.map((source) =>
        candidate(source.state, `SOURCE_${String(source.source_id).toUpperCase()}_${source.state}`),
      ),
    ];
    if (!input.root_verified || !input.signing_key_active) {
      candidates.push(candidate("UNKNOWN", "ROOT_OR_SIGNING_KEY_UNVERIFIED"));
    }
    if (!input.root_current) {
      candidates.push(candidate("EXPIRED", "ROOT_NOT_CURRENT"));
    }
    if (!input.event_provenance_compatible) {
      candidates.push(candidate("NOT_READY", "EVENT_PROVENANCE_INCOMPATIBLE"));
    }
    if (time(input.identity.valid_from) > time(input.now)) {
      candidates.push(candidate("NOT_READY", "IDENTITY_NOT_YET_VALID"));
    }
    if (input.identity.effective_status._tag !== "READY") {
      candidates.push(
        candidate(
          input.identity.effective_status._tag,
          `IDENTITY_EFFECTIVE_STATUS_${input.identity.effective_status._tag}`,
        ),
      );
    }
    if (
      !input.identity.admitted ||
      input.identity.proxy_kind === "UNRESOLVABLE" ||
      !input.identity.proxy_evidence_complete
    ) {
      candidates.push(candidate("UNKNOWN", "IDENTITY_EVIDENCE_INCOMPLETE"));
    }
    if (input.identity.alias_ambiguous) {
      candidates.push(candidate("NOT_READY", "IDENTITY_ALIAS_AMBIGUOUS"));
    }
    if (input.identity.contest_state !== "CLEAR") {
      candidates.push(candidate("UNKNOWN", "IDENTITY_CONTESTED_OR_UNSUPPORTED"));
    }
    if (
      !input.reconciliation.passed ||
      input.reconciliation.bundle_hash !== input.bundle_hash ||
      input.reconciliation.identity_snapshot_hash !== input.identity.snapshot_hash
    ) {
      candidates.push(candidate("NOT_READY", "RECONCILIATION_BINDING_INVALID"));
    }
    if (provider.watermark === null) {
      candidates.push(candidate("UNKNOWN", "FINALIZED_WATERMARK_UNPROVEN"));
    } else {
      if (
        String(input.identity.observed_height) !==
          String(provider.watermark.height) ||
        input.identity.observed_hash !== provider.watermark.block_hash ||
        input.identity.observed_at !== provider.watermark.observed_at ||
        input.identity.finality_policy_version !==
          provider.watermark.finality_policy_version
      ) {
        candidates.push(
          candidate("NOT_READY", "IDENTITY_FINALITY_WATERMARK_MISMATCH"),
        );
      }
      if (
        String(input.coverage.required_horizon) !==
          String(provider.watermark.height) ||
        BigInt(input.coverage.processed_through) <
          BigInt(provider.watermark.height)
      ) {
        candidates.push(
          candidate("NOT_READY", "COVERAGE_HORIZON_NOT_FINALIZED_WATERMARK"),
        );
      }
      if (
        input.reconciliation.watermark_hash !== sha256Hex(
          yield* canonicalizeTruthJson(
            provider.watermark,
            "truth.readiness.watermark",
          ),
        )
      ) {
        candidates.push(candidate("NOT_READY", "RECONCILIATION_WATERMARK_MISMATCH"));
      }
    }
    const decision = yield* aggregateRequiredSources(candidates);
    const evidence = uniqueSorted(
      [
        ...input.providers.map((providerObservation) => providerObservation.evidence),
        ...input.identity.effective_status.evidence,
        input.coverage.evidence,
        input.progression.source_head_evidence,
        input.progression.cursor_evidence,
        input.progression.heartbeat_evidence,
        input.progression.cross_source_evidence,
        input.activity.evidence,
        input.reconciliation.evidence,
        ...input.required_sources.flatMap((source) => source.evidence),
        ...input.invalidations
          .filter((invalidation) => invalidation.active)
          .map((invalidation) => invalidation.evidence),
      ],
      (ref) => `${ref.evidence_id}\0${ref.sha256}`,
    );
    const expiresAt = new Date(
      Math.min(
        time(input.now) + Number(input.policy.readiness_ttl_seconds) * 1_000,
        time(input.coverage.expires_at),
        time(input.activity.expires_at),
        time(input.reconciliation.expires_at),
        time(input.identity.effective_status.expires_at),
        input.identity.valid_until === null
          ? Number.POSITIVE_INFINITY
          : time(input.identity.valid_until),
        input.activity.effective_until === null
          ? Number.POSITIVE_INFINITY
          : time(input.activity.effective_until),
        ...input.providers.map(
          (providerObservation) =>
            time(providerObservation.observed_at) +
            Number(input.policy.observation_ttl_seconds) * 1_000,
        ),
        time(input.progression.source_head_observed_at) +
          Number(input.activity.source_head_cadence_seconds) * 1_000,
        time(input.progression.cursor_observed_at) +
          Number(input.activity.cursor_cadence_seconds) * 1_000,
        time(input.progression.heartbeat_observed_at) +
          Number(input.activity.heartbeat_cadence_seconds) * 1_000,
        input.live_observation_receipt === null
          ? Number.POSITIVE_INFINITY
          : time(input.live_observation_receipt.unsigned_receipt.expires_at),
      ),
    ).toISOString();
    const unsignedEnvelope = {
      schema_version: 1,
      environment: input.environment,
      validity_class: input.validity_class,
      evidence_origin: input.evidence_origin,
      live_observation_receipt_hash: liveObservationReceiptHash,
      target_lifecycle: "PRODUCED",
      bundle_hash: input.bundle_hash,
      bundle_generation: input.bundle_generation,
      identity_snapshot_hash: input.identity.snapshot_hash,
      event_vocabulary_hash: input.event_vocabulary_hash,
      network_policy_hash: input.network_policy_hash,
      activity_profile_hash: input.activity_profile_hash,
      denominator_manifest_hash: input.denominator_manifest_hash,
      canonical_collection_id: input.identity.canonical_collection_id,
      evaluated_at: input.now,
      expires_at: expiresAt,
      finalized_watermark: provider.watermark,
      source_digest: input.source_digest,
      adapter_digest: input.adapter_digest,
      invalidation_epoch: input.invalidation_epoch,
      required_source_decisions: [...input.required_sources].sort((left, right) =>
        String(left.source_id).localeCompare(String(right.source_id)),
      ),
      decision: {
        state: decision.state,
        reasons: decision.reasons,
        evidence,
      },
      issuer_key_id: signer.keyId,
    };
    const canonical = yield* canonicalizeTruthJson(
      unsignedEnvelope,
      "truth.readiness.unsigned",
    );
    const envelopeHash = sha256Hex(canonical);
    const signature = yield* Effect.try({
      try: () =>
        signer.sign(
          readinessSigningBytes(
            input.environment,
            String(input.bundle_generation),
            envelopeHash as Sha256Digest,
          ),
        ),
      catch: () =>
        new TruthTrustError({
          boundary: "truth.readiness.sign",
          reason: "Ed25519 signer failed",
        }),
    });
    return yield* decodeStrict(
      TruthReadinessEnvelopeV1,
      "truth.readiness.envelope",
      { unsigned_envelope: unsignedEnvelope, envelope_hash: envelopeHash, signature },
    );
  });

export const verifyTruthReadinessEnvelope = (
  rawEnvelope: unknown,
  input: {
    readonly expectedEnvironment: TruthEnvironmentId;
    readonly expectedKeyId: string;
    readonly publicKeyHex: string;
    readonly expectedValidityClass: "FIXTURE_VALID" | "STAGED_CURRENT";
    readonly expectedBundleHash: Sha256Digest;
    readonly expectedBundleGeneration: string;
    readonly now: string;
  },
): Effect.Effect<
  TruthReadinessEnvelopeV1,
  TruthDecodeError | TruthIntegrityError | TruthTrustError
> =>
  Effect.gen(function* () {
    const envelope = yield* decodeStrict(
      TruthReadinessEnvelopeV1,
      "truth.readiness.envelope",
      rawEnvelope,
    );
    if (
      envelope.unsigned_envelope.environment !== input.expectedEnvironment ||
      envelope.unsigned_envelope.issuer_key_id !== input.expectedKeyId ||
      envelope.unsigned_envelope.validity_class !== input.expectedValidityClass ||
      envelope.unsigned_envelope.bundle_hash !== input.expectedBundleHash
    ) {
      return yield* Effect.fail(
        new TruthTrustError({
          boundary: "truth.readiness.binding",
          reason:
            "readiness envelope environment, issuer, validity class, or bundle mismatch",
        }),
      );
    }
    const invalidValidityClass =
      (envelope.unsigned_envelope.validity_class === "FIXTURE_VALID" &&
        (envelope.unsigned_envelope.evidence_origin !== "HERMETIC_FIXTURE" ||
          envelope.unsigned_envelope.live_observation_receipt_hash !== null)) ||
      (envelope.unsigned_envelope.validity_class === "STAGED_CURRENT" &&
        (envelope.unsigned_envelope.environment !== "staging" ||
          envelope.unsigned_envelope.evidence_origin !== "READ_ONLY_LIVE" ||
          envelope.unsigned_envelope.live_observation_receipt_hash === null));
    if (invalidValidityClass) {
      return yield* Effect.fail(
        new TruthTrustError({
          boundary: "truth.readiness.validity-class",
          reason: "signed readiness validity class and evidence origin disagree",
        }),
      );
    }
    if (
      String(envelope.unsigned_envelope.bundle_generation) !==
        input.expectedBundleGeneration ||
      time(envelope.unsigned_envelope.expires_at) <= time(input.now) ||
      time(envelope.unsigned_envelope.evaluated_at) >
        time(input.now) + TRUTH_MAX_FUTURE_SKEW_MILLISECONDS
    ) {
      return yield* Effect.fail(
        new TruthTrustError({
          boundary: "truth.readiness.freshness",
          reason: "readiness envelope is replayed, expired, or from the future",
        }),
      );
    }
    const canonical = yield* canonicalizeTruthJson(
      envelope.unsigned_envelope,
      "truth.readiness.unsigned",
    );
    if (sha256Hex(canonical) !== envelope.envelope_hash) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.readiness.hash",
          reason: "readiness envelope hash mismatch",
        }),
      );
    }
    if (
      !verifyEd25519Signature(
        input.publicKeyHex,
        readinessSigningBytes(
          envelope.unsigned_envelope.environment,
          String(envelope.unsigned_envelope.bundle_generation),
          envelope.envelope_hash,
        ),
        envelope.signature,
      )
    ) {
      return yield* Effect.fail(
        new TruthTrustError({
          boundary: "truth.readiness.signature",
          reason: "readiness envelope signature mismatch",
        }),
      );
    }
    return envelope;
  });
