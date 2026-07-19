import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  TRUTH_CONTRACT_PROTOCOL,
  TRUTH_AUTHORITY_ACTIONS,
  TRUTH_NORMATIVE_OBJECT_KINDS,
  TRUTH_SERVING_FAILURE_CLASSES,
  TRUTH_REQUIREMENT_TRACEABILITY,
  TruthDecodeError,
  TruthIntegrityError,
  compileNormativeClosure,
  compileTruthBundleRoot,
  validateTruthRequirementTraceability,
} from "../src/truth-contract/index.js";
import {
  fixtureSigners,
  sha256Hex,
} from "../src/collection-resolver/trust-protocol.js";

const signer = fixtureSigners().sonarPrimary;
const digest = (value: string) => sha256Hex(`normative:${value}`);
const timestamp = "2026-07-19T03:00:00.000Z";

const normativeObjects = (): ReadonlyArray<unknown> => [
  {
    kind: "bundle_schema",
    schema_version: 1,
    protocol: TRUTH_CONTRACT_PROTOCOL,
    object_kinds: [...TRUTH_NORMATIVE_OBJECT_KINDS],
  },
  {
    kind: "identity_snapshot",
    schema_version: 1,
    version: "identity.v1",
    bindings: [
      {
        canonical_collection_id: "fixture-collection",
        chain_family: "EVM",
        chain_id: "80094",
        canonical_address: "0x1234",
        aliases: ["fixture-alias"],
        config_digest: digest("fixture-config"),
        config_source: "config.fixture.yaml",
        observed_height: "1",
        observed_hash: digest("fixture-block"),
        observed_at: timestamp,
        finality_policy_version: "berachain-finalized.v1",
        deployed_identity_hash: digest("fixture-identity"),
        deployed_code_hash: digest("fixture-code"),
        proxy_kind: "NONE",
        implementation_address: null,
        implementation_code_hash: null,
        upgrade_mechanism: "IMMUTABLE",
        valid_from: timestamp,
        valid_until: null,
        supersedes_snapshot: null,
        contest_state: "CLEAR",
        evidence: [{ evidence_id: "fixture-identity", sha256: digest("evidence") }],
        effective_status: {
          _tag: "READY",
          reasons: ["identity_verified"],
          evidence: [],
          evaluated_at: timestamp,
          expires_at: "2026-07-19T04:00:00.000Z",
          invalidation_epoch: "0",
        },
      },
    ],
  },
  {
    kind: "event_vocabulary",
    schema_version: 1,
    version: "events.v1",
    denominator_scope: "CLOSED",
    denominator_manifest_hash: digest("denominator"),
    denominator_members: [
      {
        canonical_collection_id: "fixture-collection",
        chain_id: "80094",
        contract_name: "FixtureCollection",
        canonical_address: "0x1234",
        event_name: "Transfer",
        event_signature: "Transfer(address,address,uint256)",
        topic0: digest("topic"),
        start_height: "1",
        handler_reference: "src/handlers/fixture.ts",
      },
    ],
    events: [
      {
        event_kind: "hold721",
        semantic_version: "1.0.0",
        source_entities: ["Transfer"],
        identity_fields: ["chain_id", "contract", "token_id"],
        required_provenance: ["transaction_hash", "log_index", "address_class"],
        user_meaning: "Effective ownership changed after classified custody legs.",
        non_user_legs: ["custody_ingress", "custody_egress"],
        semantic_legs: [
          {
            leg_kind: "DIRECT_TRANSFER",
            precedence: "1",
            user_meaning: true,
            ownership_effect: "TRANSFER",
            required_provenance: ["transaction_hash", "log_index"],
            denominator_member: true,
          },
        ],
        denominator_membership: "erc721_ownership",
        breaking_change_rules: ["meaning_change", "required_provenance_change"],
      },
    ],
  },
  {
    kind: "provenance_rules",
    schema_version: 1,
    version: "provenance.v1",
    requirements: [
      {
        event_kind: "hold721",
        required_fields: ["transaction_hash", "log_index", "address_class"],
        address_classes: ["wallet", "custody", "staking", "marketplace"],
        symmetric_ingress_egress: true,
        score_rpc_recovery_allowed: false,
      },
    ],
  },
  {
    kind: "behavioral_invariants",
    schema_version: 1,
    version: "invariants.v1",
    invariants: [
      {
        invariant_id: "hold721-custody-symmetry",
        statement: "Custody and staking ingress and egress are classified symmetrically.",
        severity: "MUST",
        assertion_fixture: "hold721-custody-symmetry.v1",
      },
    ],
  },
  {
    kind: "compatibility_matrix",
    schema_version: 1,
    version: "compatibility.v1",
    producer_protocol: TRUTH_CONTRACT_PROTOCOL,
    rules: [
      ["OPTIONAL_FIELD_ADDED", "CONDITIONAL", true],
      ["EVENT_KIND_ADDED", "CONDITIONAL", true],
      ["REQUIRED_FIELD_REMOVED", "BREAKING", false],
      ["MEANING_CHANGED", "BREAKING", false],
      ["PROVENANCE_CHANGED", "BREAKING", false],
      ["IDENTITY_REINTERPRETED", "BREAKING", false],
    ].map(([change_kind, result, consumer_support_required]) => ({
      change_kind,
      result,
      consumer_support_required,
    })),
    trust_namespaces: ["development", "staging", "production"],
  },
  {
    kind: "authority_matrix",
    schema_version: 1,
    version: "authority.v1",
    grants: TRUTH_AUTHORITY_ACTIONS.map((action) => ({
      action,
      role: action === "graduate" ? "governance" : "authorized_service",
      approval_rule: action === "graduate" ? "signed_quorum" : "active_root",
      owner: action === "graduate" ? "governance" : "sonar-ops",
    })),
    planning_agent_can_graduate: false,
  },
  {
    kind: "security_profile",
    schema_version: 1,
    version: "security.v1",
    signature_algorithm: "Ed25519",
    digest_algorithm: "SHA-256",
    canonicalization: "RFC8785-JCS",
    production_key_custody: "KMS_OR_HSM_NON_EXPORTABLE",
    revocation_cache_seconds: 300,
    max_future_skew_seconds: 60,
  },
  {
    kind: "network_finality_policy",
    schema_version: 1,
    version: "networks.v1",
    runtime_scope: "EVM_ONLY",
    networks: [
      {
        network: "berachain",
        chain_family: "EVM",
        chain_id: "80094",
        finality_policy_version: "berachain-finalized.v1",
        finality_method: "FINALIZED_TAG",
        finalized_tag: "finalized",
        minimum_block_depth: null,
        ethereum_depth_fallback_allowed: false,
        poll_interval_seconds: 60,
        required_provider_quorum: "2",
        require_distinct_asn: true,
        require_distinct_client_family: true,
        observation_ttl_seconds: "300",
        readiness_ttl_seconds: "1800",
        max_future_skew_seconds: 60,
        providers: [
          {
            provider_id: "provider-a",
            operator: "operator-a",
            legal_entity: "entity-a",
            control_domain: "domain-a",
            network_path: "path-a",
            asn: "asn-a",
            client_family: "geth",
            upstream_source: "source-a",
            key_id: "provider-a-key",
            public_key_hex: "11".repeat(32),
          },
          {
            provider_id: "provider-b",
            operator: "operator-b",
            legal_entity: "entity-b",
            control_domain: "domain-b",
            network_path: "path-b",
            asn: "asn-b",
            client_family: "nethermind",
            upstream_source: "source-b",
            key_id: "provider-b-key",
            public_key_hex: "22".repeat(32),
          },
        ],
      },
    ],
  },
  {
    kind: "activity_profiles",
    schema_version: 1,
    version: "activity.v1",
    profiles: [
      {
        collection_id: "fixture-collection",
        owner: "sonar-ops",
        expected_event_window_seconds: "900",
        collection_launch_interval_seconds: "3600",
        source_head_cadence_seconds: "60",
        cursor_cadence_seconds: "60",
        provider_heartbeat_cadence_seconds: "60",
        cross_source_availability_required: true,
        quiet_window_permitted: true,
        expected_event_distribution: "fixture-window.v1",
        evidence_window_start: timestamp,
        evidence_window_end: "2026-07-20T03:00:00.000Z",
        denominator: "1",
        backtest_digest: digest("fixture-backtest"),
        confidence_basis: "fixture.v1",
        approval: "fixture-governance",
        effective_from: timestamp,
        effective_until: "2026-07-20T03:00:00.000Z",
        supersedes_version: null,
      },
    ],
  },
  {
    kind: "statistical_policy",
    schema_version: 1,
    version: "statistical-policy.v1",
    population_version: "fixture-population.v1",
    strata_dimensions: ["contract", "event_kind", "semantic_leg"],
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
    authorized_sampling_scope_digest: digest("authorized-sampling-scope"),
    missing_observation_treatment: "DEFECT",
    integer_rounding: "CEILING",
    defect_rate_prior: null,
    historical_n_300_is_acceptance_threshold: false,
    high_risk_classes: [
      "CUSTODY_STAKING",
      "PROXY_UPGRADE",
      "SALE",
      "MINT_BURN",
    ],
  },
  {
    kind: "serving_policy",
    schema_version: 1,
    version: "serving.v1",
    environment: "staging",
    rules: TRUTH_SERVING_FAILURE_CLASSES.map((failure_class) => ({
      failure_class,
      effective_status:
        failure_class === "temporary_source_transport_loss"
          ? "DEGRADED"
          : failure_class === "stale_projection_or_evidence"
            ? "EXPIRED"
            : failure_class === "source_cursor_not_advancing"
              ? "UNKNOWN"
              : failure_class === "reorg_behind_watermark" ||
                  failure_class === "reconciliation_count_breach"
                ? "NOT_READY"
                : "SUSPENDED",
      last_good_allowed:
        failure_class === "temporary_source_transport_loss" ||
        failure_class === "stale_projection_or_evidence" ||
        failure_class === "source_cursor_not_advancing" ||
        failure_class === "reconciliation_count_breach",
      last_good_policy:
        failure_class === "temporary_source_transport_loss"
          ? "SAME_VERSION_WITHIN_TTL"
          : failure_class === "stale_projection_or_evidence"
            ? "SAME_VERSION_ONE_EXTRA_TTL"
            : failure_class === "source_cursor_not_advancing"
              ? "PRIOR_PROJECTION_ONLY"
              : failure_class === "reconciliation_count_breach"
                ? "PRIOR_GENERATION_ONLY"
                : "FORBIDDEN",
      maximum_last_good_seconds:
        failure_class === "temporary_source_transport_loss" ||
        failure_class === "stale_projection_or_evidence" ||
        failure_class === "source_cursor_not_advancing"
          ? "1800"
          : "0",
      graduation_eligible: false,
      user_label:
        failure_class === "temporary_source_transport_loss"
          ? "degraded/stale timestamp"
          : failure_class === "stale_projection_or_evidence"
            ? "stale"
            : failure_class === "source_cursor_not_advancing"
              ? "delayed/unknown"
              : failure_class === "reorg_behind_watermark"
                ? "temporarily unavailable"
                : failure_class === "reconciliation_count_breach"
                  ? "update held"
                  : failure_class === "incompatible_producer_consumer"
                    ? "update required"
                    : "unavailable",
      escalation_seconds:
        failure_class === "source_cursor_not_advancing" ? "120" : "0",
      recovery_evidence: [
        failure_class === "temporary_source_transport_loss"
          ? "fresh-source-and-readiness-evidence"
          : failure_class === "stale_projection_or_evidence"
            ? "fresh-reconciliation-and-serving-observation"
            : failure_class === "source_cursor_not_advancing"
              ? "independent-head-cursor-and-coverage-proof"
              : failure_class === "reorg_behind_watermark"
                ? "replacement-watermark-and-all-dependent-receipts"
                : failure_class === "reconciliation_count_breach"
                  ? "completed-census-pass"
                  : failure_class === "semantic_provenance_mismatch"
                    ? "corrected-bundle-and-new-score-receipt"
                    : failure_class === "identity_revoked_or_contested"
                      ? "identity-readmission-and-new-evidence"
                      : failure_class === "signer_root_compromise"
                        ? "recovered-root-and-fresh-evidence"
                        : "compatible-build-and-receipt",
      ],
    })),
  },
  {
    kind: "issuer_metadata",
    schema_version: 1,
    version: "issuer.v1",
    service_id: "sonar-api",
    key_id: signer.keyId,
    build_id: "fixture-build",
    repository: "0xHoneyJar/sonar-api",
    source_commit: digest("source"),
    issued_at: timestamp,
  },
];

const expectFailure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected typed failure");
  if (exit.cause._tag !== "Fail") throw new Error(`expected Fail, got ${exit.cause._tag}`);
  return exit.cause.error;
};

describe("truth normative closure and traceability", () => {
  it("compiles every required normative object into one signed closed root", () => {
    const closure = Effect.runSync(compileNormativeClosure(normativeObjects()));
    expect(closure.map((object) => object.ref.kind)).toEqual(
      [...TRUTH_NORMATIVE_OBJECT_KINDS].sort(),
    );
    const refs = closure.map((object) => object.ref);
    const byKind = new Map(refs.map((ref) => [ref.kind, ref]));
    const root = Effect.runSync(
      compileTruthBundleRoot(
        {
          schema_version: 1,
          protocol: TRUTH_CONTRACT_PROTOCOL,
          environment: "staging",
          generation: "1",
          supersedes_generation: null,
          objects: refs,
          issuer: { service_id: "sonar-api", key_id: signer.keyId },
          issued_at: timestamp,
          valid_from: timestamp,
          compatibility_version: "compatibility.v1",
          authority_matrix_hash: byKind.get("authority_matrix")!.sha256,
          security_profile_hash: byKind.get("security_profile")!.sha256,
        },
        signer,
      ),
    );
    expect(root.unsigned_root.objects).toHaveLength(TRUTH_NORMATIVE_OBJECT_KINDS.length);
  });

  it("fails closed when a required normative object is absent", () => {
    const failure = expectFailure(
      compileNormativeClosure(normativeObjects().slice(1)),
    );
    expect(failure).toBeInstanceOf(TruthIntegrityError);
  });

  it("rejects semantically incomplete signed policy matrices", () => {
    const duplicateCompatibility = structuredClone(normativeObjects()) as Array<
      Record<string, unknown>
    >;
    const compatibility = duplicateCompatibility.find(
      (object) => object.kind === "compatibility_matrix",
    )!;
    const compatibilityRules = compatibility.rules as Array<Record<string, unknown>>;
    compatibilityRules[0] = { ...compatibilityRules[1] };
    expect(
      expectFailure(compileNormativeClosure(duplicateCompatibility)),
    ).toBeInstanceOf(TruthIntegrityError);

    const duplicateAuthority = structuredClone(normativeObjects()) as Array<
      Record<string, unknown>
    >;
    const authority = duplicateAuthority.find(
      (object) => object.kind === "authority_matrix",
    )!;
    const grants = authority.grants as Array<Record<string, unknown>>;
    grants[0] = { ...grants[1] };
    expect(expectFailure(compileNormativeClosure(duplicateAuthority))).toBeInstanceOf(
      TruthIntegrityError,
    );

    const invalidQuorum = structuredClone(normativeObjects()) as Array<
      Record<string, unknown>
    >;
    const networkPolicy = invalidQuorum.find(
      (object) => object.kind === "network_finality_policy",
    )!;
    const networks = networkPolicy.networks as Array<Record<string, unknown>>;
    networks[0]!.required_provider_quorum = "3";
    expect(expectFailure(compileNormativeClosure(invalidQuorum))).toBeInstanceOf(
      TruthIntegrityError,
    );

    const overlappingPairs = structuredClone(normativeObjects()) as Array<
      Record<string, unknown>
    >;
    const overlapPolicy = overlappingPairs.find(
      (object) => object.kind === "network_finality_policy",
    )!;
    const overlapNetworks = overlapPolicy.networks as Array<Record<string, unknown>>;
    overlapNetworks[0]!.required_provider_quorum = "3";
    overlapNetworks[0]!.providers = [
      { provider_id: "a-x", operator: "operator-a", legal_entity: "entity-a", control_domain: "domain-x", network_path: "path-1", asn: "asn-1", client_family: "geth", upstream_source: "source-1", key_id: "key-a-x", public_key_hex: "31".repeat(32) },
      { provider_id: "a-y", operator: "operator-a", legal_entity: "entity-a", control_domain: "domain-y", network_path: "path-2", asn: "asn-2", client_family: "geth", upstream_source: "source-2", key_id: "key-a-y", public_key_hex: "32".repeat(32) },
      { provider_id: "b-z", operator: "operator-b", legal_entity: "entity-b", control_domain: "domain-z", network_path: "path-3", asn: "asn-3", client_family: "nethermind", upstream_source: "source-3", key_id: "key-b-z", public_key_hex: "33".repeat(32) },
      { provider_id: "c-z", operator: "operator-c", legal_entity: "entity-c", control_domain: "domain-z", network_path: "path-4", asn: "asn-4", client_family: "reth", upstream_source: "source-4", key_id: "key-c-z", public_key_hex: "34".repeat(32) },
    ];
    expect(expectFailure(compileNormativeClosure(overlappingPairs))).toBeInstanceOf(
      TruthIntegrityError,
    );

    const duplicateIdentity = structuredClone(normativeObjects()) as Array<
      Record<string, unknown>
    >;
    const identity = duplicateIdentity.find(
      (object) => object.kind === "identity_snapshot",
    )!;
    const binding = {
      canonical_collection_id: "mibera",
      chain_family: "EVM",
      chain_id: "80094",
      canonical_address: "0x1234",
      aliases: ["legacy-mibera"],
      config_digest: digest("config"),
      config_source: "config.mibera.yaml",
      observed_height: "1",
      observed_hash: digest("block"),
      observed_at: timestamp,
      finality_policy_version: "berachain.v1",
      deployed_identity_hash: digest("code"),
      deployed_code_hash: digest("code"),
      proxy_kind: "NONE",
      implementation_address: null,
      implementation_code_hash: null,
      upgrade_mechanism: "IMMUTABLE",
      valid_from: timestamp,
      valid_until: null,
      supersedes_snapshot: null,
      contest_state: "CLEAR",
      evidence: [{ evidence_id: "identity-fixture", sha256: digest("identity") }],
      effective_status: {
        _tag: "READY",
        reasons: ["identity_verified"],
        evidence: [],
        evaluated_at: timestamp,
        expires_at: "2026-07-19T04:00:00.000Z",
        invalidation_epoch: "0",
      },
    };
    identity.bindings = [binding, { ...binding }];
    expect(expectFailure(compileNormativeClosure(duplicateIdentity))).toBeInstanceOf(
      TruthIntegrityError,
    );

    const zeroActivity = structuredClone(normativeObjects()) as Array<
      Record<string, unknown>
    >;
    const activity = zeroActivity.find(
      (object) => object.kind === "activity_profiles",
    )!;
    activity.profiles = [
      {
        collection_id: "mibera",
        owner: "sonar-ops",
        expected_event_window_seconds: "0",
        collection_launch_interval_seconds: "60",
        source_head_cadence_seconds: "60",
        cursor_cadence_seconds: "60",
        provider_heartbeat_cadence_seconds: "60",
        cross_source_availability_required: true,
        quiet_window_permitted: true,
        expected_event_distribution: "quiet-window.v1",
        evidence_window_start: timestamp,
        evidence_window_end: "2026-07-20T03:00:00.000Z",
        denominator: "1",
        backtest_digest: digest("backtest"),
        confidence_basis: "fixture-confidence.v1",
        approval: "governance",
        effective_from: timestamp,
        effective_until: "2026-07-20T03:00:00.000Z",
        supersedes_version: null,
      },
    ];
    expect(expectFailure(compileNormativeClosure(zeroActivity))).toBeInstanceOf(
      TruthDecodeError,
    );
  });

  it("executes the FR-1 through FR-13 traceability gate", () => {
    expect(Effect.runSync(validateTruthRequirementTraceability())).toBeUndefined();
    expect(
      TRUTH_REQUIREMENT_TRACEABILITY.every((entry) => entry.owner.startsWith("bd-")),
    ).toBe(true);
    expect(
      TRUTH_REQUIREMENT_TRACEABILITY.filter(
        (entry) => entry.status === "implemented",
      ).map((entry) => entry.requirement),
    ).toEqual([
      "FR-1",
      "FR-2",
      "FR-3",
      "FR-4",
      "FR-5",
      "FR-8",
      "FR-9",
      "FR-11",
      "FR-12",
    ]);
    expect(
      TRUTH_REQUIREMENT_TRACEABILITY.filter(
        (entry) => entry.status === "planned",
      ).every((entry) => (entry.remaining?.length ?? 0) > 0),
    ).toBe(true);
  });
});
