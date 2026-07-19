import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  MIBERA_ADAPTER_BYTES_SHA256,
  MIBERA_CONFIG_BYTES_SHA256,
  MIBERA_DENOMINATOR_BYTES_SHA256,
  MIBERA_HANDLER_BYTES_SHA256,
  TRUTH_CONTRACT_PROTOCOL,
  buildMiberaFixtureNormativeObjects,
  aggregateRequiredSources,
  canonicalizeTruthJson,
  compileTruthLiveObservationReceipt,
  compileNormativeClosure,
  compileTruthBundleRoot,
  computeTruthReadinessObservationSetHash,
  evaluateTruthReadiness,
  verifyTruthReadinessEnvelope,
} from "../src/truth-contract/index.js";
import {
  fixtureSigners,
  sha256Hex,
} from "../src/collection-resolver/trust-protocol.js";

const signer = fixtureSigners().sonarPrimary;
const now = "2026-07-19T06:00:00.000Z";
const expires = "2026-07-19T06:30:00.000Z";
const identityExpires = "2026-07-19T07:00:00.000Z";
const digest = (value: string) => sha256Hex(`readiness-test:${value}`);
const blockHash = sha256Hex("truth-fixture:berachain-finalized-block-19000001");
const normativeObjects = structuredClone(
  buildMiberaFixtureNormativeObjects(now),
) as Array<Record<string, unknown>>;
normativeObjects.find((object) => object.kind === "issuer_metadata")!.key_id =
  signer.keyId;
const normativeClosure = Effect.runSync(compileNormativeClosure(normativeObjects));
const normativeByKind = new Map(
  normativeClosure.map((object) => [String(object.ref.kind), object.ref]),
);
const bundleRoot = Effect.runSync(
  compileTruthBundleRoot(
    {
      schema_version: 1,
      protocol: TRUTH_CONTRACT_PROTOCOL,
      environment: "development",
      generation: "1",
      supersedes_generation: null,
      objects: normativeClosure.map((object) => object.ref),
      issuer: { service_id: "sonar-api", key_id: signer.keyId },
      issued_at: now,
      valid_from: now,
      compatibility_version: "compatibility.v1",
      authority_matrix_hash: normativeByKind.get("authority_matrix")!.sha256,
      security_profile_hash: normativeByKind.get("security_profile")!.sha256,
    },
    signer,
  ),
);
const evaluationOptions = {
  normativeObjects: normativeClosure.map((object) => object.value),
  bundleRoot,
  bundleVerification: {
    expectedEnvironment: "development" as const,
    expectedKeyId: signer.keyId,
    publicKeyHex: signer.publicKeyHex(),
    trustedGenerationHighWater: "1" as never,
    now: now as never,
  },
};

const makeInput = () => {
  const watermark = {
    network: "berachain",
    chain_id: "80094",
    height: "19000001",
    block_hash: blockHash,
    observed_at: now,
    finality_policy_version: "berachain-finalized.v1",
    finality_class: "FINALIZED",
  };
  const watermarkHash = sha256Hex(
    Effect.runSync(canonicalizeTruthJson(watermark, "test.watermark")),
  );
  const provider = (suffix: "a" | "b", client: "reth" | "nethermind") => ({
    provider_id: `berachain-provider-${suffix}`,
    operator: `operator-${suffix}`,
    legal_entity: `entity-${suffix}`,
    control_domain: `domain-${suffix}`,
    network_path: `path-${suffix}`,
    asn: `asn-${suffix}`,
    client_family: client,
    upstream_source: `independent-node-${suffix}`,
    finality_method: "FINALIZED_TAG",
    finalized_tag: "finalized",
    height: "19000001",
    block_hash: blockHash,
    observed_at: now,
    evidence: {
      evidence_id: `provider-${suffix}`,
      sha256: digest(`provider-${suffix}`),
    },
    source_error: false,
  });
  const bundleHash = bundleRoot.root_hash;
  const identityHash = normativeByKind.get("identity_snapshot")!.sha256;
  return {
    schema_version: 1,
    environment: "development",
    validity_class: "FIXTURE_VALID",
    evidence_origin: "HERMETIC_FIXTURE",
    live_observation_receipt: null,
    now,
    bundle_hash: bundleHash,
    bundle_generation: "1",
    event_vocabulary_hash: normativeByKind.get("event_vocabulary")!.sha256,
    network_policy_hash: normativeByKind.get("network_finality_policy")!.sha256,
    activity_profile_hash: normativeByKind.get("activity_profiles")!.sha256,
    root_verified: true,
    root_current: true,
    signing_key_active: true,
    event_provenance_compatible: true,
    denominator_manifest_hash: MIBERA_DENOMINATOR_BYTES_SHA256,
    denominator_byte_verified: true,
    source_digest: MIBERA_HANDLER_BYTES_SHA256,
    adapter_digest: MIBERA_ADAPTER_BYTES_SHA256,
    invalidation_epoch: "0",
    policy: {
      network: "berachain",
      chain_id: "80094",
      finality_policy_version: "berachain-finalized.v1",
      finality_method: "FINALIZED_TAG",
      finalized_tag: "finalized",
      ethereum_depth_fallback_allowed: false,
      required_provider_quorum: "2",
      require_distinct_asn: true,
      require_distinct_client_family: true,
      providers: [
        {
          provider_id: "berachain-provider-a",
          operator: "operator-a",
          legal_entity: "entity-a",
          control_domain: "domain-a",
          network_path: "path-a",
          asn: "asn-a",
          client_family: "reth",
          upstream_source: "independent-node-a",
        },
        {
          provider_id: "berachain-provider-b",
          operator: "operator-b",
          legal_entity: "entity-b",
          control_domain: "domain-b",
          network_path: "path-b",
          asn: "asn-b",
          client_family: "nethermind",
          upstream_source: "independent-node-b",
        },
      ],
      denominator_manifest_hash: MIBERA_DENOMINATOR_BYTES_SHA256,
      observation_ttl_seconds: "300",
      readiness_ttl_seconds: "1800",
      max_future_skew_seconds: 60,
    },
    identity: {
      snapshot_hash: identityHash,
      canonical_collection_id: "mibera",
      chain_family: "EVM",
      chain_id: "80094",
      network: "berachain",
      canonical_address: "0x6666397dfe9a8c469bf65dc744cb1c733416c420",
      aliases: ["mibera-collection"],
      observed_height: "19000001",
      observed_hash: blockHash,
      observed_at: now,
      finality_policy_version: "berachain-finalized.v1",
      network_listed: true,
      admitted: true,
      alias_ambiguous: false,
      proxy_kind: "NONE",
      proxy_evidence_complete: true,
      contest_state: "CLEAR",
      deployed_identity_hash:
        "5296d5160b0e0e6d55b8af09fbfb1a4516cfc905195bb0bb69466ceafb6a617c",
      code_hash:
        "29448593ff971f65861dcf1d150d13e2adbcd442beac89c908a0f37d00a06c3a",
      implementation_address: null,
      implementation_code_hash: null,
      upgrade_mechanism: "IMMUTABLE",
      valid_from: now,
      valid_until: identityExpires,
      effective_status: {
        _tag: "READY",
        reasons: ["FIXTURE_IDENTITY_VERIFIED"],
        evidence: [
          {
            evidence_id: "mibera-identity-fixture",
            sha256: sha256Hex("truth-fixture:mibera-identity-evidence"),
          },
        ],
        evaluated_at: now,
        expires_at: identityExpires,
        invalidation_epoch: "0",
      },
      config_digest: MIBERA_CONFIG_BYTES_SHA256,
    },
    providers: [provider("a", "reth"), provider("b", "nethermind")],
    coverage: {
      marker_complete: true,
      processed_through: "19000001",
      required_horizon: "19000001",
      bundle_hash: bundleHash,
      identity_snapshot_hash: identityHash,
      source_digest: MIBERA_HANDLER_BYTES_SHA256,
      adapter_digest: MIBERA_ADAPTER_BYTES_SHA256,
      config_digest: MIBERA_CONFIG_BYTES_SHA256,
      event_count: "0",
      observed_at: now,
      expires_at: expires,
      evidence: { evidence_id: "coverage", sha256: digest("coverage") },
    },
    progression: {
      source_head_advancing: true,
      cursor_advancing: true,
      heartbeat_present: true,
      cross_source_available: true,
      source_head_observed_at: now,
      cursor_observed_at: now,
      heartbeat_observed_at: now,
      source_failure: false,
      bounded_last_good_allowed: false,
      source_head_evidence: { evidence_id: "head", sha256: digest("head") },
      cursor_evidence: { evidence_id: "cursor", sha256: digest("cursor") },
      heartbeat_evidence: {
        evidence_id: "heartbeat",
        sha256: digest("heartbeat"),
      },
      cross_source_evidence: {
        evidence_id: "cross-source",
        sha256: digest("cross-source"),
      },
    },
    activity: {
      profile_version: "mibera-activity.fixture.v1",
      owner: "sonar-ops",
      approval: "fixture-governance",
      backtest_digest: sha256Hex("truth-fixture:mibera-activity-backtest"),
      profile_approved: true,
      quiet_window_permitted: true,
      expected_event_window_seconds: "900",
      source_head_cadence_seconds: "60",
      cursor_cadence_seconds: "60",
      heartbeat_cadence_seconds: "60",
      evidence_window_start: now,
      evidence_window_end: identityExpires,
      effective_from: now,
      effective_until: identityExpires,
      observed_at: now,
      expires_at: expires,
      evidence: {
        evidence_id: "fixture-governance",
        sha256: sha256Hex("truth-fixture:mibera-activity-backtest"),
      },
    },
    reconciliation: {
      passed: true,
      bundle_hash: bundleHash,
      identity_snapshot_hash: identityHash,
      watermark_hash: watermarkHash,
      observed_at: now,
      expires_at: expires,
      evidence: {
        evidence_id: "reconciliation",
        sha256: digest("reconciliation"),
      },
    },
    required_sources: [],
    invalidations: [],
  };
};

const evaluate = (input: unknown) =>
  Effect.runSync(evaluateTruthReadiness(input, signer, evaluationOptions));

describe("truth readiness evaluator", () => {
  it("reaches READY only with the complete finalized, coverage, and quiet-data proof", () => {
    const envelope = evaluate(makeInput());
    expect(envelope.unsigned_envelope.decision).toMatchObject({
      state: "READY",
      reasons: ["ALL_REQUIRED_EVIDENCE_VERIFIED"],
    });
    expect(envelope.unsigned_envelope.finalized_watermark).toMatchObject({
      network: "berachain",
      height: "19000001",
      finality_class: "FINALIZED",
    });
    expect(envelope.unsigned_envelope.validity_class).toBe("FIXTURE_VALID");
    expect(envelope.unsigned_envelope.target_lifecycle).toBe("PRODUCED");
  });

  it("implements the total worst-source lattice deterministically", () => {
    const states = [
      "READY",
      "DEGRADED",
      "EXPIRED",
      "UNKNOWN",
      "NOT_READY",
      "SUSPENDED",
    ] as const;
    for (const expected of states) {
      const candidates = states
        .slice(0, states.indexOf(expected) + 1)
        .map((state) => ({ state, reason: `REASON_${state}` }));
      const forward = Effect.runSync(aggregateRequiredSources(candidates));
      const reversed = Effect.runSync(
        aggregateRequiredSources([...candidates].reverse()),
      );
      expect(forward.state).toBe(expected);
      expect(reversed).toEqual(forward);
    }
  });

  it("fails closed on correlated, unsupported, disagreeing, or unlisted finality", () => {
    const correlated = makeInput();
    correlated.providers[1]!.operator = correlated.providers[0]!.operator;
    expect(evaluate(correlated).unsigned_envelope.decision.state).toBe("UNKNOWN");

    const depthFallback = makeInput();
    depthFallback.providers[0]!.finality_method = "BLOCK_DEPTH";
    depthFallback.providers[0]!.finalized_tag = null;
    expect(evaluate(depthFallback).unsigned_envelope.decision.state).toBe("UNKNOWN");

    const disagreement = makeInput();
    disagreement.providers[1]!.block_hash = digest("conflicting-finalized-block");
    expect(evaluate(disagreement).unsigned_envelope.decision.state).toBe("UNKNOWN");

    const unlisted = makeInput();
    unlisted.identity.network_listed = false;
    expect(evaluate(unlisted).unsigned_envelope.decision.state).toBe("UNKNOWN");
  });

  it("does not mistake starvation for a quiet source", () => {
    for (const field of [
      "source_head_advancing",
      "cursor_advancing",
      "heartbeat_present",
      "cross_source_available",
    ] as const) {
      const input = makeInput();
      input.progression[field] = false;
      expect(evaluate(input).unsigned_envelope.decision).toMatchObject({
        state: "UNKNOWN",
        reasons: ["INDEPENDENT_PROGRESSION_MISSING"],
      });
    }
    const incompleteCoverage = makeInput();
    incompleteCoverage.coverage.marker_complete = false;
    expect(evaluate(incompleteCoverage).unsigned_envelope.decision.state).toBe(
      "NOT_READY",
    );
  });

  it("binds coverage, denominator bytes, reconciliation, and identity", () => {
    const denominator = makeInput();
    denominator.denominator_byte_verified = false;
    expect(evaluate(denominator).unsigned_envelope.decision.state).toBe("NOT_READY");

    const coverage = makeInput();
    coverage.coverage.adapter_digest = digest("wrong-adapter");
    expect(evaluate(coverage).unsigned_envelope.decision.state).toBe("NOT_READY");

    const proxy = makeInput();
    proxy.identity.proxy_kind = "EIP1967";
    proxy.identity.proxy_evidence_complete = false;
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          evaluateTruthReadiness(proxy, signer, evaluationOptions),
        ),
      ),
    ).toBe(true);

    const reconciliation = makeInput();
    reconciliation.reconciliation.watermark_hash = digest("wrong-watermark");
    expect(evaluate(reconciliation).unsigned_envelope.decision.state).toBe(
      "NOT_READY",
    );
  });

  it("binds signed identity, policy TTL, root issuer, and finalized horizon", () => {
    for (const mutate of [
      (input: ReturnType<typeof makeInput>) => {
        input.identity.canonical_address = "0x1111";
      },
      (input: ReturnType<typeof makeInput>) => {
        input.identity.aliases = ["laundered-alias"];
      },
      (input: ReturnType<typeof makeInput>) => {
        input.identity.upgrade_mechanism = "METAMORPHIC";
      },
      (input: ReturnType<typeof makeInput>) => {
        input.identity.valid_until = "2026-07-19T08:00:00.000Z";
      },
    ]) {
      const input = makeInput();
      mutate(input);
      expect(
        Exit.isFailure(
          Effect.runSyncExit(
            evaluateTruthReadiness(input, signer, evaluationOptions),
          ),
        ),
      ).toBe(true);
    }

    const relaxedTtl = makeInput();
    relaxedTtl.policy.observation_ttl_seconds = "3600";
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          evaluateTruthReadiness(relaxedTtl, signer, evaluationOptions),
        ),
      ),
    ).toBe(true);

    const wrongSigner = fixtureSigners().sonarRotated;
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          evaluateTruthReadiness(makeInput(), wrongSigner, evaluationOptions),
        ),
      ),
    ).toBe(true);

    const zeroHorizon = makeInput();
    zeroHorizon.coverage.required_horizon = "0";
    zeroHorizon.coverage.processed_through = "0";
    expect(evaluate(zeroHorizon).unsigned_envelope.decision.state).toBe(
      "NOT_READY",
    );
  });

  it("caps the envelope at sensor expiry and rejects duplicate providers", () => {
    const soon = makeInput();
    soon.coverage.expires_at = "2026-07-19T06:00:01.000Z";
    expect(evaluate(soon).unsigned_envelope.expires_at).toBe(
      "2026-07-19T06:00:01.000Z",
    );

    const staleCadence = makeInput();
    staleCadence.progression.cursor_observed_at = "2026-07-19T05:58:59.999Z";
    expect(evaluate(staleCadence).unsigned_envelope.decision.state).toBe("EXPIRED");

    const duplicate = makeInput();
    duplicate.providers[1] = structuredClone(duplicate.providers[0]!);
    expect(evaluate(duplicate).unsigned_envelope.decision.state).toBe("UNKNOWN");
  });

  it("requires and verifies a separately signed live observation receipt", () => {
    const forged = makeInput();
    forged.environment = "staging";
    forged.validity_class = "STAGED_CURRENT";
    forged.evidence_origin = "READ_ONLY_LIVE";
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          evaluateTruthReadiness(forged, signer, evaluationOptions),
        ),
      ),
    ).toBe(true);

    const stagingRoot = Effect.runSync(
      compileTruthBundleRoot(
        {
          ...bundleRoot.unsigned_root,
          environment: "staging",
        },
        signer,
      ),
    );
    const staged = makeInput();
    staged.environment = "staging";
    staged.validity_class = "STAGED_CURRENT";
    staged.evidence_origin = "READ_ONLY_LIVE";
    staged.bundle_hash = stagingRoot.root_hash;
    staged.coverage.bundle_hash = stagingRoot.root_hash;
    staged.reconciliation.bundle_hash = stagingRoot.root_hash;
    const observationSetHash = Effect.runSync(
      computeTruthReadinessObservationSetHash(staged),
    );
    const observer = fixtureSigners().sonarRotated;
    staged.live_observation_receipt = Effect.runSync(
      compileTruthLiveObservationReceipt(
        {
          schema_version: 1,
          environment: "staging",
          bundle_hash: stagingRoot.root_hash,
          identity_snapshot_hash: staged.identity.snapshot_hash,
          event_vocabulary_hash: staged.event_vocabulary_hash,
          network_policy_hash: staged.network_policy_hash,
          activity_profile_hash: staged.activity_profile_hash,
          denominator_manifest_hash: staged.denominator_manifest_hash,
          source_digest: staged.source_digest,
          adapter_digest: staged.adapter_digest,
          observation_set_hash: observationSetHash,
          observed_at: now,
          expires_at: expires,
          issuer_key_id: observer.keyId,
        },
        observer,
      ),
    );
    const envelope = Effect.runSync(
      evaluateTruthReadiness(staged, signer, {
        ...evaluationOptions,
        bundleRoot: stagingRoot,
        bundleVerification: {
          ...evaluationOptions.bundleVerification,
          expectedEnvironment: "staging",
        },
        trustedLiveObservationKeys: new Map([
          [observer.keyId, observer.publicKeyHex()],
        ]),
      }),
    );
    expect(envelope.unsigned_envelope).toMatchObject({
      validity_class: "STAGED_CURRENT",
      evidence_origin: "READ_ONLY_LIVE",
      live_observation_receipt_hash:
        staged.live_observation_receipt.receipt_hash,
      decision: { state: "READY" },
    });
  });

  it("honors expiry, future-skew, degradation, and invalidation precedence", () => {
    const expired = makeInput();
    expired.coverage.expires_at = now;
    expect(evaluate(expired).unsigned_envelope.decision.state).toBe("EXPIRED");

    const future = makeInput();
    future.progression.heartbeat_observed_at = "2026-07-19T06:01:00.001Z";
    expect(evaluate(future).unsigned_envelope.decision.state).toBe("UNKNOWN");

    const degraded = makeInput();
    degraded.progression.source_failure = true;
    degraded.progression.bounded_last_good_allowed = true;
    expect(evaluate(degraded).unsigned_envelope.decision.state).toBe("DEGRADED");

    const suspended = makeInput();
    suspended.invalidations.push({
      invalidation_id: "semantic-invalid",
      state_floor: "SUSPENDED",
      affected_artifact_hash: suspended.identity.snapshot_hash,
      active: true,
      evidence: { evidence_id: "invalidation", sha256: digest("invalidation") },
    });
    expect(evaluate(suspended).unsigned_envelope.decision.state).toBe("SUSPENDED");
  });

  it("domain-signs the envelope and rejects relabeling fixture evidence", () => {
    const envelope = evaluate(makeInput());
    expect(
      Effect.runSync(
        verifyTruthReadinessEnvelope(envelope, {
          expectedEnvironment: "development",
          expectedKeyId: signer.keyId,
          publicKeyHex: signer.publicKeyHex(),
          expectedValidityClass: "FIXTURE_VALID",
          expectedBundleHash: envelope.unsigned_envelope.bundle_hash,
          expectedBundleGeneration: "1",
          now,
        }),
      ),
    ).toEqual(envelope);

    const relabeled = structuredClone(envelope) as Record<string, any>;
    relabeled.unsigned_envelope.validity_class = "STAGED_CURRENT";
    const exit = Effect.runSyncExit(
      verifyTruthReadinessEnvelope(relabeled, {
        expectedEnvironment: "development",
        expectedKeyId: signer.keyId,
        publicKeyHex: signer.publicKeyHex(),
        expectedValidityClass: "FIXTURE_VALID",
        expectedBundleHash: envelope.unsigned_envelope.bundle_hash,
        expectedBundleGeneration: "1",
        now,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
