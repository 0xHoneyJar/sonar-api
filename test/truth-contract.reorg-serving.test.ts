import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  TRUTH_CONTRACT_PROTOCOL,
  TRUTH_NORMATIVE_OBJECT_KINDS,
  SERVING_FAILURE_MATRIX_V1,
  compileTruthBundleRoot,
  compileProjectionEventV1,
  compileReorgProjectionInvalidationV1,
  compileReorgTrustContextV1,
  compileSignedReorgProviderObservationV1,
  compileServingExceptionV1,
  compileSignedReorgEventV1,
  detectReorgV1,
  queryEffectiveStatusV1,
  rebuildTruthStatusProjectionV1,
  servingRuleForV1,
  verifyServingExceptionV1,
  verifySignedReorgEventV1,
  type ReorgDetectionPolicyV1,
} from "../src/truth-contract/index.js";
import {
  fixtureSigners,
  jcsCanonicalize,
  LocalEd25519TrustSigner,
  sha256Hex,
} from "../src/collection-resolver/trust-protocol.js";

const signer = fixtureSigners().sonarRotated;
const rootSigner = fixtureSigners().sonarPrimary;
const providerASigner = fixtureSigners().sonarRevoked;
const providerBSigner = fixtureSigners().orderingReplay;
const providerCSigner = LocalEd25519TrustSigner.fromSeedHex(
  "55".repeat(32),
  "reorg-provider-c",
);
const now = "2026-07-19T06:00:00.000Z";
const oldHash = sha256Hex("active-watermark");
const replacementHash = sha256Hex("replacement-watermark");
const digest = (value: string) => sha256Hex(`reorg:${value}`);
const policyUnsigned = {
  network: "berachain",
  chain_id: "80094",
  finality_policy_version: "berachain-finalized.v1",
  finality_method: "FINALIZED_TAG",
  finalized_tag: "finalized",
  ethereum_depth_fallback_allowed: false,
  required_quorum: 2,
  require_distinct_asn: true,
  require_distinct_client_family: true,
  poll_interval_seconds: 60,
  providers: [
    {
      provider_id: "provider-a",
      operator: "operator-a",
      legal_entity: "entity-a",
      control_domain: "domain-a",
      asn: "asn-a",
      network_path: "path-a",
      client_family: "reth",
      upstream_source: "node-a",
      key_id: providerASigner.keyId,
      public_key_hex: providerASigner.publicKeyHex(),
    },
    {
      provider_id: "provider-b",
      operator: "operator-b",
      legal_entity: "entity-b",
      control_domain: "domain-b",
      asn: "asn-b",
      network_path: "path-b",
      client_family: "nethermind",
      upstream_source: "node-b",
      key_id: providerBSigner.keyId,
      public_key_hex: providerBSigner.publicKeyHex(),
    },
  ],
} as const;
const policy = {
  policy_hash: sha256Hex(jcsCanonicalize(policyUnsigned)),
  ...policyUnsigned,
} as const;
const observation = (
  provider_id: "provider-a" | "provider-b",
  watermarkHash = oldHash,
  overrides: Partial<{
    finalized_height: string | null;
    finalized_hash: string | null;
    observed_at: string;
    finality_method: "FINALIZED_TAG" | "BLOCK_DEPTH" | "UNSUPPORTED";
    finalized_tag: "finalized" | null;
    transport_error: boolean;
    provider_compromised: boolean;
    watermark_parent_hash: string | null;
  }> = {},
) =>
  compileSignedReorgProviderObservationV1(
    {
      provider_id,
      finalized_height: provider_id === "provider-a" ? "19000010" : "19000011",
      finalized_hash: digest(`head-${provider_id}`),
      watermark_height: "19000001",
      watermark_hash_at_height: watermarkHash,
      watermark_parent_hash: digest("common-watermark-parent"),
      observed_at: now,
      finality_method: "FINALIZED_TAG",
      finalized_tag: "finalized",
      transport_error: false,
      provider_compromised: false,
      ...overrides,
    },
    provider_id === "provider-a" ? providerASigner : providerBSigner,
  );
const input = () => ({
  environment: "staging" as const,
  generation: "1",
  invalidation_epoch: "1",
  bundle_root_hash: trust.expected_bundle_root_hash,
  active_watermark: {
    network: "berachain",
    chain_id: "80094",
    height: "19000001",
    block_hash: oldHash,
    observed_at: now,
    finality_policy_version: "berachain-finalized.v1",
    finality_class: "FINALIZED" as const,
  },
  policy,
  observations: [observation("provider-a"), observation("provider-b")],
  detected_at: now,
});
const trustFor = (runtimePolicy: ReorgDetectionPolicyV1): ReturnType<
  typeof compileReorgTrustContextV1
> => {
  const normativePolicy = {
    kind: "network_finality_policy",
    schema_version: 1,
    version: "berachain-policy.v1",
    runtime_scope: "EVM_ONLY",
    networks: [
      {
        network: runtimePolicy.network,
        chain_family: "EVM",
        chain_id: runtimePolicy.chain_id,
        finality_policy_version: runtimePolicy.finality_policy_version,
        finality_method: runtimePolicy.finality_method,
        finalized_tag: runtimePolicy.finalized_tag,
        minimum_block_depth: null,
        ethereum_depth_fallback_allowed:
          runtimePolicy.ethereum_depth_fallback_allowed,
        poll_interval_seconds: runtimePolicy.poll_interval_seconds,
        required_provider_quorum: String(runtimePolicy.required_quorum),
        require_distinct_asn: runtimePolicy.require_distinct_asn,
        require_distinct_client_family:
          runtimePolicy.require_distinct_client_family,
        observation_ttl_seconds: "300",
        readiness_ttl_seconds: "1800",
        max_future_skew_seconds: 60,
        providers: runtimePolicy.providers,
      },
    ],
  };
  const normativeHash = sha256Hex(jcsCanonicalize(normativePolicy));
  const objects = [...TRUTH_NORMATIVE_OBJECT_KINDS].map((kind) => ({
    kind,
    media_type: "application/json",
    sha256:
      kind === "network_finality_policy"
        ? normativeHash
        : digest(`normative:${kind}`),
    byte_length: "100",
  }));
  const byKind = new Map(objects.map((object) => [object.kind, object]));
  const root = Effect.runSync(
    compileTruthBundleRoot(
      {
        schema_version: 1,
        protocol: TRUTH_CONTRACT_PROTOCOL,
        environment: "staging",
        generation: "1",
        supersedes_generation: null,
        objects,
        issuer: { service_id: "sonar-api", key_id: rootSigner.keyId },
        issued_at: now,
        valid_from: now,
        compatibility_version: "sonar-score.v1",
        authority_matrix_hash: byKind.get("authority_matrix")!.sha256,
        security_profile_hash: byKind.get("security_profile")!.sha256,
      },
      rootSigner,
    ),
  );
  return compileReorgTrustContextV1({
    verified_root: root,
    expected_producer_key_id: rootSigner.keyId,
    producer_public_key_hex: rootSigner.publicKeyHex(),
    normative_policy_object: normativePolicy,
    network: "berachain",
    detector_key_id: signer.keyId,
  });
};
const trust = trustFor(policy);

describe("Sprint 4 read-only reorg and serving policy", () => {
  it("confirms the active watermark using independent finalized-tag evidence", () => {
    expect(detectReorgV1(input(), trust)).toMatchObject({
      status: "READY",
      reason: "WATERMARK_CONFIRMED",
      invalidation_required: false,
    });
    const unavailable = input();
    unavailable.observations = [
      observation("provider-a"),
      observation("provider-b", oldHash, { transport_error: true }),
    ];
    expect(detectReorgV1(unavailable, trust)).toMatchObject({
      status: "UNKNOWN",
      reason: "QUORUM_UNAVAILABLE",
    });
    const stale = input();
    stale.observations = [
      observation("provider-a"),
      observation("provider-b", oldHash, {
        observed_at: "2026-07-19T05:57:59.999Z",
      }),
    ];
    expect(detectReorgV1(stale, trust)).toMatchObject({
      status: "UNKNOWN",
      reason: "QUORUM_UNAVAILABLE",
    });
    const unsupported = input();
    unsupported.observations = [
      observation("provider-a", oldHash, {
        finality_method: "BLOCK_DEPTH",
        finalized_tag: null,
      }),
      observation("provider-b"),
    ];
    expect(detectReorgV1(unsupported, trust)).toMatchObject({
      status: "UNKNOWN",
      reason: "UNSUPPORTED_FINALITY_EVIDENCE",
    });
  });

  it("distinguishes conflict, confirmed historical reorg, and compromise", () => {
    const conflict = input();
    conflict.observations = [
      observation("provider-a"),
      observation("provider-b", oldHash, {
        finalized_height: "19000010",
        finalized_hash: digest("conflicting-head"),
      }),
    ];
    const conflictDetected = detectReorgV1(conflict, trust);
    expect(conflictDetected).toMatchObject({
      status: "NOT_READY",
      reason: "CONFLICTING_FINALIZED_HASHES",
      invalidation_required: true,
    });
    const parentConflict = input();
    parentConflict.observations = [
      observation("provider-a"),
      observation("provider-b", oldHash, {
        watermark_parent_hash: digest("conflicting-parent"),
      }),
    ];
    expect(detectReorgV1(parentConflict, trust)).toMatchObject({
      status: "NOT_READY",
      reason: "CONFLICTING_FINALIZED_HASHES",
      invalidation_required: true,
    });

    const reorg = input();
    reorg.observations = [
      observation("provider-a", replacementHash),
      observation("provider-b", replacementHash),
    ];
    const detected = detectReorgV1(reorg, trust);
    expect(detected).toMatchObject({
      status: "NOT_READY",
      reason: "CONFIRMED_REORG_BEHIND_WATERMARK",
      invalidation_required: true,
      replacement_watermark_hash: replacementHash,
    });
    const event = compileSignedReorgEventV1(reorg, detected, trust, signer);
    expect(
      verifySignedReorgEventV1(event, reorg, trust, signer.publicKeyHex()),
    ).toBe(true);
    const activation = compileProjectionEventV1(
      {
        schema_version: 1,
        event_id: "activate-reorg-target",
        sequence: "1",
        previous_event_hash: null,
        kind: "ARTIFACT_ACTIVATED",
        environment: "staging",
        artifact_hash: event.bundle_root_hash,
        generation: "1",
        invalidation_epoch: "0",
        authority: "PRODUCER",
        lifecycle_state: "PRODUCED",
        local_status: "READY",
        state_floor: "READY",
        reason_code: "PRODUCER_READY",
        cause_event_id: null,
        resolves_cause_event_ids: [],
        replacement_evidence_hash: null,
        replacement_evidence_kinds: null,
        replacement_evidence: null,
        depends_on: [],
        occurred_at: now,
        production_authority: false,
      },
      rootSigner,
    );
    const projectionKeys = {
      [rootSigner.keyId]: {
        public_key_hex: rootSigner.publicKeyHex(),
        authorities: ["PRODUCER"] as const,
      },
      [signer.keyId]: {
        public_key_hex: signer.publicKeyHex(),
        authorities: ["SERVING"] as const,
      },
    };
    const beforeReorg = rebuildTruthStatusProjectionV1(
      "staging",
      [activation],
      projectionKeys,
    );
    const projectionEvent = compileReorgProjectionInvalidationV1(
      event,
      reorg,
      trust,
      signer.publicKeyHex(),
      beforeReorg,
      signer,
    );
    const afterReorg = rebuildTruthStatusProjectionV1(
      "staging",
      [activation, projectionEvent],
      projectionKeys,
    );
    expect(
      queryEffectiveStatusV1(
        afterReorg,
        event.bundle_root_hash,
        "1",
        "1",
      ),
    ).toMatchObject({
      effective_status: "NOT_READY",
      reason_codes: expect.arrayContaining(["REORG_BEHIND_WATERMARK"]),
    });
    const conflictEvent = compileSignedReorgEventV1(
      conflict,
      conflictDetected,
      trust,
      signer,
    );
    const conflictProjectionEvent = compileReorgProjectionInvalidationV1(
      conflictEvent,
      conflict,
      trust,
      signer.publicKeyHex(),
      beforeReorg,
      signer,
    );
    expect(
      queryEffectiveStatusV1(
        rebuildTruthStatusProjectionV1(
          "staging",
          [activation, conflictProjectionEvent],
          projectionKeys,
        ),
        conflictEvent.bundle_root_hash,
        "1",
        "1",
      ).effective_status,
    ).toBe("NOT_READY");
    const tampered = structuredClone(event);
    tampered.replacement_watermark_hash = oldHash;
    expect(
      verifySignedReorgEventV1(tampered, reorg, trust, signer.publicKeyHex()),
    ).toBe(false);
    expect(() =>
      compileReorgProjectionInvalidationV1(
        tampered,
        reorg,
        trust,
        signer.publicKeyHex(),
        beforeReorg,
        signer,
      ),
    ).toThrow(/untrusted/);

    const compromised = input();
    compromised.observations = [
      observation("provider-a", oldHash, { provider_compromised: true }),
      observation("provider-b"),
    ];
    const compromisedDetected = detectReorgV1(compromised, trust);
    expect(compromisedDetected).toMatchObject({
      status: "SUSPENDED",
      reason: "PROVIDER_COMPROMISE",
    });
    const compromisedEvent = compileSignedReorgEventV1(
      compromised,
      compromisedDetected,
      trust,
      signer,
    );
    const compromisedProjectionEvent = compileReorgProjectionInvalidationV1(
      compromisedEvent,
      compromised,
      trust,
      signer.publicKeyHex(),
      beforeReorg,
      signer,
    );
    expect(
      queryEffectiveStatusV1(
        rebuildTruthStatusProjectionV1(
          "staging",
          [activation, compromisedProjectionEvent],
          projectionKeys,
        ),
        compromisedEvent.bundle_root_hash,
        "1",
        "1",
      ).effective_status,
    ).toBe("SUSPENDED");
  });

  it("binds a trusted policy and evaluates every signed provider observation", () => {
    const missingFinality = input();
    missingFinality.observations = [
      observation("provider-a", oldHash, {
        finalized_height: null,
        finalized_hash: null,
      }),
      observation("provider-b", oldHash, {
        finalized_height: null,
        finalized_hash: null,
      }),
    ];
    expect(detectReorgV1(missingFinality, trust)).toMatchObject({
      status: "UNKNOWN",
      reason: "QUORUM_UNAVAILABLE",
    });
    const behindWatermark = input();
    behindWatermark.observations = [
      observation("provider-a", oldHash, { finalized_height: "19000000" }),
      observation("provider-b", oldHash, { finalized_height: "19000000" }),
    ];
    expect(detectReorgV1(behindWatermark, trust)).toMatchObject({
      status: "UNKNOWN",
      reason: "QUORUM_UNAVAILABLE",
    });
    expect(() =>
      detectReorgV1(input(), {
        ...trust,
        expected_policy_hash: digest("untrusted-policy"),
      }),
    ).toThrow(/policy is not trusted/);

    const policy3Unsigned = {
      ...policyUnsigned,
      providers: [
        ...policyUnsigned.providers,
        {
          provider_id: "provider-c",
          operator: "operator-c",
          legal_entity: "entity-c",
          control_domain: "domain-c",
          asn: "asn-c",
          network_path: "path-c",
          client_family: "erigon",
          upstream_source: "node-c",
          key_id: providerCSigner.keyId,
          public_key_hex: providerCSigner.publicKeyHex(),
        },
      ],
    } as const;
    const policy3 = {
      policy_hash: sha256Hex(jcsCanonicalize(policy3Unsigned)),
      ...policy3Unsigned,
    } as const;
    const thirdObservation = compileSignedReorgProviderObservationV1(
      {
        provider_id: "provider-c",
        finalized_height: "19000010",
        finalized_hash: digest("head-provider-c"),
        watermark_height: "19000001",
        watermark_hash_at_height: replacementHash,
        watermark_parent_hash: digest("common-parent"),
        observed_at: now,
        finality_method: "FINALIZED_TAG",
        finalized_tag: "finalized",
        transport_error: false,
        provider_compromised: false,
      },
      providerCSigner,
    );
    const threeProviderInput = {
      ...input(),
      policy: policy3,
      observations: [
        observation("provider-a"),
        observation("provider-b"),
        thirdObservation,
      ],
    };
    const trust3 = trustFor(policy3);
    threeProviderInput.bundle_root_hash = trust3.expected_bundle_root_hash;
    expect(
      detectReorgV1(threeProviderInput, trust3),
    ).toMatchObject({
      status: "NOT_READY",
      reason: "CONFLICTING_FINALIZED_HASHES",
    });
  });

  it("freezes an exhaustive nine-class fail-closed serving matrix", () => {
    expect(SERVING_FAILURE_MATRIX_V1).toHaveLength(9);
    expect(new Set(SERVING_FAILURE_MATRIX_V1.map((rule) => rule.failure_class)).size).toBe(9);
    expect(servingRuleForV1("REORG_BEHIND_WATERMARK")).toMatchObject({
      effective_status: "NOT_READY",
      last_good: "FORBIDDEN",
      graduation_eligible: false,
    });
    for (const hardFailure of [
      "SEMANTIC_OR_PROVENANCE_MISMATCH",
      "IDENTITY_REVOKED_OR_CONTESTED",
      "SIGNER_OR_ROOT_COMPROMISE",
      "INCOMPATIBLE_PRODUCER_CONSUMER",
    ] as const) {
      expect(servingRuleForV1(hardFailure)).toMatchObject({
        effective_status: "SUSPENDED",
        last_good: "FORBIDDEN",
        graduation_eligible: false,
      });
    }
  });

  it("allows only signed, bounded, non-graduating exceptions for soft failures", () => {
    const exception = compileServingExceptionV1(
      {
        environment: "staging",
        generation: "1",
        failure_class: "TEMPORARY_TRANSPORT_LOSS",
        impact_set_digest: digest("impact-set"),
        serving_policy_hash: digest("serving-policy"),
        starts_at: now,
        expires_at: "2026-07-19T06:10:00.000Z",
        last_good_policy: "SAME_VERSION_WITHIN_TTL",
      },
      signer,
    );
    expect(
      verifyServingExceptionV1(exception, signer.publicKeyHex(), now, {
        environment: "staging",
        generation: "1",
        impactSetDigest: digest("impact-set"),
        servingPolicyHash: digest("serving-policy"),
        governanceKeyId: signer.keyId,
      }),
    ).toBe(true);
    expect(exception.graduation_eligible).toBe(false);
    const productionException = compileServingExceptionV1(
      {
        environment: "production",
        generation: "1",
        failure_class: "STALE_EVIDENCE",
        impact_set_digest: digest("production-impact"),
        serving_policy_hash: digest("production-serving-policy"),
        starts_at: now,
        expires_at: "2026-07-19T06:15:00.000Z",
        last_good_policy: "SAME_VERSION_ONE_EXTRA_TTL",
      },
      signer,
    );
    expect(productionException.maximum_ttl_seconds).toBe("900");
    expect(() =>
      compileServingExceptionV1(
        {
          environment: "production",
          generation: "1",
          failure_class: "STALE_EVIDENCE",
          impact_set_digest: digest("production-impact"),
          serving_policy_hash: digest("production-serving-policy"),
          starts_at: now,
          expires_at: "2026-07-19T06:15:00.001Z",
          last_good_policy: "SAME_VERSION_ONE_EXTRA_TTL",
        },
        signer,
      ),
    ).toThrow(/exceeds serving-policy TTL/);
    expect(() =>
      compileServingExceptionV1(
        {
          environment: "staging",
          generation: "1",
          failure_class: "SIGNER_OR_ROOT_COMPROMISE",
          impact_set_digest: digest("impact-set"),
          serving_policy_hash: digest("serving-policy"),
          starts_at: now,
          expires_at: "2026-07-19T06:10:00.000Z",
          last_good_policy: "FORBIDDEN",
        },
        signer,
      ),
    ).toThrow(/hard failure/);
    expect(() =>
      compileServingExceptionV1(
        {
          environment: "staging",
          generation: "1",
          failure_class: "TEMPORARY_TRANSPORT_LOSS",
          impact_set_digest: digest("impact-set"),
          serving_policy_hash: digest("serving-policy"),
          starts_at: now,
          expires_at: "2026-07-19T06:30:00.001Z",
          last_good_policy: "SAME_VERSION_WITHIN_TTL",
        },
        signer,
      ),
    ).toThrow(/exceeds serving-policy TTL/);
    expect(
      verifyServingExceptionV1(exception, signer.publicKeyHex(), now, {
        environment: "production",
        generation: "2",
        impactSetDigest: digest("other-impact-set"),
        servingPolicyHash: digest("other-serving-policy"),
        governanceKeyId: signer.keyId,
      }),
    ).toBe(false);
  });
});
