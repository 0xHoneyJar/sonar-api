import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  jcsCanonicalize,
  LocalEd25519TrustSigner,
  sha256Hex,
} from "../src/collection-resolver/trust-protocol.js";
import { compileTruthBundleRoot } from "../src/truth-contract/bundle-compiler.js";
import {
  compileTruthAuditEvent,
  makeTruthAuditVerifier,
} from "../src/truth-contract/audit-control-plane.js";
import {
  compileNotConsumedReceiptV1,
  scoreAuthorityKeysetHashV1,
} from "../src/truth-contract/consumption.js";
import { compileProjectionEventV1 } from "../src/truth-contract/invalidation.js";
import { makeFixtureTruthSigner } from "../src/truth-contract/layers.js";
import { compileNormativeClosure } from "../src/truth-contract/normative-compiler.js";
import { makeInMemoryTruthRegistryStore } from "../src/truth-contract/registry-store.js";
import {
  makeTruthInspector,
  verifyTruthInspectionEnvelopeV1,
} from "../src/truth-contract/status-reader.js";
import {
  buildMiberaFixtureNormativeObjects,
  MIBERA_ADAPTER_BYTES_SHA256,
  MIBERA_CONFIG_BYTES_SHA256,
  MIBERA_DENOMINATOR_BYTES_SHA256,
  MIBERA_DENOMINATOR_MEMBER,
  MIBERA_HANDLER_BYTES_SHA256,
  MIBERA_INITIAL_ADDRESS,
  MIBERA_INITIAL_CHAIN_ID,
  MIBERA_INITIAL_COLLECTION_ID,
  MIBERA_INITIAL_NETWORK,
} from "../src/truth-contract/producer-generation.js";
import {
  FROZEN_FOOTPRINT_POLICY_V1,
  SamplingAttemptLedgerV1,
  SamplingRandomnessBeaconLedgerV1,
  advanceSamplingAttemptV1,
  compileIndependentReviewReceiptV1,
  compileReconciliationReceiptV1,
  compileSignedSamplingPlanV1,
  deriveSamplingNonceV1,
  deterministicSampleMembersV1,
  finalizeSamplingQueryV1,
  samplingPlanScopeDigestV1,
  samplingRandomnessRoundDigestV1,
  samplingUniverseAuthorizationDigestV1,
} from "../src/truth-contract/reconciliation.js";
import { compileStagedReconcilerSeparationV1 } from "../src/truth-contract/reconciler-separation.js";
import { TRUTH_NORMATIVE_OBJECT_KINDS } from "../src/truth-contract/schemas/bundle.js";
import { TRUTH_CONTRACT_PROTOCOL } from "../src/truth-contract/schemas/common.js";
import {
  TRUTH_AUTHORITY_ACTIONS,
  TRUTH_COMPATIBILITY_CHANGE_KINDS,
  TRUTH_SERVING_FAILURE_CLASSES,
} from "../src/truth-contract/schemas/normative.js";
import {
  compileTruthGenerationActivation,
  makeTruthActivationVerifier,
} from "../src/truth-contract/trust-control-plane.js";
import {
  type CompileMiberaStagedCurrentProofInputV1,
  compileMiberaStagedCurrentProofV1,
} from "../src/truth-contract/staged-proof.js";

const now = "2026-07-19T09:00:00.000Z";
const evidenceExpiry = "2026-07-19T09:30:00.000Z";
const identityExpiry = "2026-07-19T10:00:00.000Z";
const scoreDeadline = "2026-07-26T09:00:00.000Z";
const digest = (label: string) => sha256Hex(`staged-proof:${label}`);
const codeHash =
  "6cbf0a2f6bde17afc7d0c56f67675964b57d6e4168c6d302e7f284770f287f6f";
const bytecodeResponseDigest =
  "d4da3d41ee2a8796309c91cdcc721abbcf69a2d9395efe1c1b5280197d576a2d";
const identityHash =
  "5296d5160b0e0e6d55b8af09fbfb1a4516cfc905195bb0bb69466ceafb6a617c";
const finalizedHeight = "23718180";
const finalizedHash =
  "cdf90542afbee65e908eacec5481088e9eec1993d682c1268647f4a1ddbb33cb";
const finalizedWatermark = {
  network: "berachain",
  chain_id: MIBERA_INITIAL_CHAIN_ID,
  height: finalizedHeight,
  block_hash: finalizedHash,
  observed_at: now,
  finality_policy_version: "berachain-finalized.v1",
  finality_class: "FINALIZED",
} as const;

const ordinaryMembers = Array.from({ length: 1_000 }, (_, index) =>
  `ordinary-${String(index).padStart(4, "0")}`,
);
const highRiskMembers = Array.from({ length: 5 }, (_, index) =>
  `custody-${String(index).padStart(2, "0")}`,
);
const partition = [
  ...ordinaryMembers.map((member_id) => ({
    member_id,
    stratum_id: "mibera.transfer.direct",
  })),
  ...highRiskMembers.map((member_id) => ({
    member_id,
    stratum_id: "mibera.transfer.staking",
  })),
];
const strata = [
  {
    stratum_id: "mibera.transfer.direct",
    contract: MIBERA_INITIAL_ADDRESS,
    event_kind: "mibera.erc721.transfer",
    semantic_leg: "DIRECT_TRANSFER",
    population: "1000",
    universe_members_digest: sha256Hex(jcsCanonicalize(ordinaryMembers)),
    high_risk: false,
    empty_proof_hash: null,
  },
  {
    stratum_id: "mibera.transfer.staking",
    contract: MIBERA_INITIAL_ADDRESS,
    event_kind: "mibera.erc721.transfer",
    semantic_leg: "STAKING_INGRESS",
    population: "5",
    universe_members_digest: sha256Hex(jcsCanonicalize(highRiskMembers)),
    high_risk: true,
    empty_proof_hash: null,
  },
] as const;
const producerSnapshotId = "mibera-staged-snapshot-1";
const universeDigest = sha256Hex(jcsCanonicalize(partition));
const authorizedScopeDigest = samplingUniverseAuthorizationDigestV1({
  producer_snapshot_id: producerSnapshotId,
  universe_digest: universeDigest,
  universe_size: String(partition.length),
  mandatory_stratum_count: String(strata.length),
  strata,
});

const stagedNormatives = (
  producerKeyId: string,
): Array<Record<string, unknown>> => [
  {
    kind: "bundle_schema",
    schema_version: 1,
    protocol: TRUTH_CONTRACT_PROTOCOL,
    object_kinds: [...TRUTH_NORMATIVE_OBJECT_KINDS],
  },
  {
    kind: "identity_snapshot",
    schema_version: 1,
    version: "mibera-identity.staged-current.v1",
    bindings: [
      {
        canonical_collection_id: MIBERA_INITIAL_COLLECTION_ID,
        chain_family: "EVM",
        chain_id: MIBERA_INITIAL_CHAIN_ID,
        canonical_address: MIBERA_INITIAL_ADDRESS,
        aliases: ["mibera-collection"],
        config_digest: MIBERA_CONFIG_BYTES_SHA256,
        config_source: "config.mibera.yaml",
        observed_height: finalizedHeight,
        observed_hash: finalizedHash,
        observed_at: now,
        finality_policy_version: "berachain-finalized.v1",
        deployed_identity_hash: identityHash,
        deployed_code_hash: codeHash,
        proxy_kind: "NONE",
        implementation_address: null,
        implementation_code_hash: null,
        upgrade_mechanism: "IMMUTABLE",
        valid_from: now,
        valid_until: identityExpiry,
        supersedes_snapshot: null,
        contest_state: "CLEAR",
        evidence: [
          {
            evidence_id: "mibera-bytecode-live",
            sha256: bytecodeResponseDigest,
          },
          {
            evidence_id: "provider-a-finalized-live",
            sha256: bytecodeResponseDigest,
          },
          {
            evidence_id: "provider-b-finalized-live",
            sha256: bytecodeResponseDigest,
          },
        ],
        effective_status: {
          _tag: "READY",
          reasons: ["LIVE_IDENTITY_VERIFIED"],
          evidence: [
            {
              evidence_id: "mibera-identity-live",
              sha256: digest("identity-live"),
            },
          ],
          evaluated_at: now,
          expires_at: identityExpiry,
          invalidation_epoch: "0",
        },
      },
    ],
  },
  {
    kind: "event_vocabulary",
    schema_version: 1,
    version: "mibera-transfer.v1",
    denominator_scope: "CLOSED",
    denominator_manifest_hash: MIBERA_DENOMINATOR_BYTES_SHA256,
    denominator_members: [MIBERA_DENOMINATOR_MEMBER],
    events: [
      {
        event_kind: "mibera.erc721.transfer",
        semantic_version: "1.0.0",
        source_entities: ["MiberaTransfer"],
        identity_fields: ["chain_id", "contract_address", "token_id"],
        required_provenance: [
          "chain_id",
          "contract_address",
          "event_signature",
          "topic0",
          "block_number",
          "block_hash",
          "finality_class",
          "transaction_hash",
          "log_index",
          "from",
          "to",
          "token_id",
          "observed_at",
          "identity_snapshot_sha256",
          "source_adapter_sha256",
        ],
        user_meaning:
          "A finalized ERC-721 Transfer is classified as mint, burn, staking custody, direct transfer, or unresolved intermediary movement.",
        non_user_legs: [
          "STAKING_INGRESS",
          "STAKING_EGRESS",
          "UNCLASSIFIED_INTERMEDIARY",
        ],
        semantic_legs: [
          ["MINT", "1", true, "ACQUIRE"],
          ["BURN", "2", true, "RELEASE"],
          ["STAKING_INGRESS", "3", false, "PRESERVE_EFFECTIVE_OWNER"],
          ["STAKING_EGRESS", "4", false, "PRESERVE_EFFECTIVE_OWNER"],
          ["DIRECT_TRANSFER", "5", true, "TRANSFER"],
          ["UNCLASSIFIED_INTERMEDIARY", "6", false, "UNKNOWN"],
        ].map(([leg_kind, precedence, user_meaning, ownership_effect]) => ({
          leg_kind,
          precedence,
          user_meaning,
          ownership_effect,
          required_provenance: [
            "block_hash",
            "transaction_hash",
            "log_index",
            "address_class",
          ],
          denominator_member: true,
        })),
        denominator_membership: "mibera-transfer-denominator.v1",
        breaking_change_rules: [
          "meaning_change",
          "provenance_change",
          "denominator_change",
        ],
      },
    ],
  },
  {
    kind: "provenance_rules",
    schema_version: 1,
    version: "mibera-provenance.v1",
    requirements: [
      {
        event_kind: "mibera.erc721.transfer",
        required_fields: [
          "chain_id",
          "contract_address",
          "event_signature",
          "topic0",
          "block_number",
          "block_hash",
          "finality_class",
          "transaction_hash",
          "log_index",
          "from",
          "to",
          "token_id",
          "observed_at",
          "identity_snapshot_sha256",
          "source_adapter_sha256",
        ],
        address_classes: [
          "wallet",
          "mint_zero",
          "burn",
          "paddlefi_staking",
          "jiko_staking",
          "unclassified_intermediary",
        ],
        symmetric_ingress_egress: true,
        score_rpc_recovery_allowed: false,
      },
    ],
  },
  {
    kind: "behavioral_invariants",
    schema_version: 1,
    version: "mibera-invariants.v1",
    invariants: [
      {
        invariant_id: "mibera-custody-symmetry",
        statement:
          "PaddleFi and Jiko staking ingress and egress preserve the effective user owner symmetrically.",
        severity: "MUST",
        assertion_fixture: "mibera-custody-symmetry.staged.v1",
      },
    ],
  },
  {
    kind: "compatibility_matrix",
    schema_version: 1,
    version: "compatibility.v1",
    producer_protocol: TRUTH_CONTRACT_PROTOCOL,
    rules: TRUTH_COMPATIBILITY_CHANGE_KINDS.map((changeKind) => {
      const additive =
        changeKind === "OPTIONAL_FIELD_ADDED" ||
        changeKind === "EVENT_KIND_ADDED";
      return {
        change_kind: changeKind,
        result: additive ? "CONDITIONAL" : "BREAKING",
        consumer_support_required: additive,
      };
    }),
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
    version: "berachain-policy.v1",
    runtime_scope: "EVM_ONLY",
    networks: [
      {
        network: MIBERA_INITIAL_NETWORK,
        chain_family: "EVM",
        chain_id: MIBERA_INITIAL_CHAIN_ID,
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
            provider_id: "berachain-provider-a",
            operator: "operator-a",
            legal_entity: "entity-a",
            control_domain: "domain-a",
            network_path: "path-a",
            asn: "asn-a",
            client_family: "reth",
            upstream_source: "independent-node-a",
            key_id: "berachain-provider-a-staged",
            public_key_hex:
              "a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0",
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
            key_id: "berachain-provider-b-staged",
            public_key_hex:
              "17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce",
          },
        ],
      },
    ],
  },
  {
    kind: "activity_profiles",
    schema_version: 1,
    version: "mibera-activity.staged-current.v1",
    profiles: [
      {
        collection_id: MIBERA_INITIAL_COLLECTION_ID,
        owner: "sonar-ops",
        expected_event_window_seconds: "900",
        collection_launch_interval_seconds: "3600",
        source_head_cadence_seconds: "60",
        cursor_cadence_seconds: "60",
        provider_heartbeat_cadence_seconds: "60",
        cross_source_availability_required: true,
        quiet_window_permitted: true,
        expected_event_distribution: "staged-quiet-window.v1",
        evidence_window_start: now,
        evidence_window_end: identityExpiry,
        denominator: "1",
        backtest_digest: digest("mibera-activity-backtest"),
        confidence_basis: "staged-read-only.v1",
        approval: "staged-governance",
        effective_from: now,
        effective_until: identityExpiry,
        supersedes_version: null,
      },
    ],
  },
  {
    kind: "statistical_policy",
    schema_version: 1,
    version: "statistical-policy.v1",
    population_version: "mibera-transfer-population.v1",
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
    authorized_sampling_scope_digest: authorizedScopeDigest,
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
    rules: TRUTH_SERVING_FAILURE_CLASSES.map((failureClass) => ({
      failure_class: failureClass,
      effective_status:
        failureClass === "temporary_source_transport_loss"
          ? "DEGRADED"
          : failureClass === "stale_projection_or_evidence"
            ? "EXPIRED"
            : failureClass === "source_cursor_not_advancing"
              ? "UNKNOWN"
              : failureClass === "reorg_behind_watermark" ||
                  failureClass === "reconciliation_count_breach"
                ? "NOT_READY"
                : "SUSPENDED",
      last_good_allowed:
        failureClass === "temporary_source_transport_loss" ||
        failureClass === "stale_projection_or_evidence" ||
        failureClass === "source_cursor_not_advancing" ||
        failureClass === "reconciliation_count_breach",
      last_good_policy:
        failureClass === "temporary_source_transport_loss"
          ? "SAME_VERSION_WITHIN_TTL"
          : failureClass === "stale_projection_or_evidence"
            ? "SAME_VERSION_ONE_EXTRA_TTL"
            : failureClass === "source_cursor_not_advancing"
              ? "PRIOR_PROJECTION_ONLY"
              : failureClass === "reconciliation_count_breach"
                ? "PRIOR_GENERATION_ONLY"
                : "FORBIDDEN",
      maximum_last_good_seconds:
        failureClass === "temporary_source_transport_loss" ||
        failureClass === "stale_projection_or_evidence" ||
        failureClass === "source_cursor_not_advancing"
          ? "1800"
          : "0",
      graduation_eligible: false,
      user_label:
        failureClass === "temporary_source_transport_loss"
          ? "degraded/stale timestamp"
          : failureClass === "stale_projection_or_evidence"
            ? "stale"
            : failureClass === "source_cursor_not_advancing"
              ? "delayed/unknown"
              : failureClass === "reorg_behind_watermark"
                ? "temporarily unavailable"
                : failureClass === "reconciliation_count_breach"
                  ? "update held"
                  : failureClass === "incompatible_producer_consumer"
                    ? "update required"
                    : "unavailable",
      escalation_seconds:
        failureClass === "source_cursor_not_advancing" ? "120" : "0",
      recovery_evidence: [
        failureClass === "temporary_source_transport_loss"
          ? "fresh-source-and-readiness-evidence"
          : failureClass === "stale_projection_or_evidence"
            ? "fresh-reconciliation-and-serving-observation"
            : failureClass === "source_cursor_not_advancing"
              ? "independent-head-cursor-and-coverage-proof"
              : failureClass === "reorg_behind_watermark"
                ? "replacement-watermark-and-all-dependent-receipts"
                : failureClass === "reconciliation_count_breach"
                  ? "completed-census-pass"
                  : failureClass === "semantic_provenance_mismatch"
                    ? "corrected-bundle-and-new-score-receipt"
                    : failureClass === "identity_revoked_or_contested"
                      ? "identity-readmission-and-new-evidence"
                      : failureClass === "signer_root_compromise"
                        ? "recovered-root-and-fresh-evidence"
                        : "compatible-build-and-receipt",
      ],
    })),
  },
  {
    kind: "issuer_metadata",
    schema_version: 1,
    version: "issuer.staged-current.v1",
    service_id: "sonar-api",
    key_id: producerKeyId,
    build_id: "mibera-staged-current-build",
    repository: "0xHoneyJar/sonar-api",
    source_commit: digest("staged-source-commit"),
    issued_at: now,
  },
];

const makePrincipal = (
  root: string,
  role: string,
  keyId: string,
  processId: string,
) => {
  const artifactDirectory = join(root, role);
  mkdirSync(artifactDirectory, { mode: 0o700 });
  return {
    service_id: `sonar-${role}`,
    key_id: keyId,
    process_id: `pid-${processId}`,
    artifact_directory: artifactDirectory,
    network_boundary: `${role}-network`,
  };
};

const makeHarness = (): {
  readonly input: CompileMiberaStagedCurrentProofInputV1;
  readonly producerSigner: LocalEd25519TrustSigner;
  readonly liveSigner: LocalEd25519TrustSigner;
  readonly reconcilerSigner: LocalEd25519TrustSigner;
  readonly cleanup: () => void;
} => {
  const rootDirectory = join(tmpdir(), "sonar-staged-proof-contract-v1");
  rmSync(rootDirectory, { recursive: true, force: true });
  mkdirSync(rootDirectory, { recursive: true });
  const producerSigner = LocalEd25519TrustSigner.fromSeedHex(
    "11".repeat(32),
    "sonar-staged-publisher",
  );
  const reconcilerSigner = LocalEd25519TrustSigner.fromSeedHex(
    "22".repeat(32),
    "sonar-staged-reconciler",
  );
  const reviewerSigner = LocalEd25519TrustSigner.fromSeedHex(
    "33".repeat(32),
    "sonar-staged-reviewer",
  );
  const randomnessSigner = LocalEd25519TrustSigner.fromSeedHex(
    "44".repeat(32),
    "sonar-staged-randomness",
  );
  const liveSigner = LocalEd25519TrustSigner.fromSeedHex(
    "55".repeat(32),
    "sonar-live-observer",
  );
  const handoffSigners = [
    LocalEd25519TrustSigner.fromSeedHex(
      "66".repeat(32),
      "sonar-handoff-a",
    ),
    LocalEd25519TrustSigner.fromSeedHex(
      "77".repeat(32),
      "sonar-handoff-b",
    ),
  ] as const;
  const scoreSigners = [
    LocalEd25519TrustSigner.fromSeedHex("88".repeat(32), "score-consumer-a"),
    LocalEd25519TrustSigner.fromSeedHex("99".repeat(32), "score-consumer-b"),
  ] as const;
  const producer = makePrincipal(
    rootDirectory,
    "producer",
    producerSigner.keyId,
    "101",
  );
  const reconciler = makePrincipal(
    rootDirectory,
    "reconciler",
    reconcilerSigner.keyId,
    "202",
  );
  const reviewer = makePrincipal(
    rootDirectory,
    "reviewer",
    reviewerSigner.keyId,
    "303",
  );
  const randomnessWitness = makePrincipal(
    rootDirectory,
    "randomness",
    randomnessSigner.keyId,
    "404",
  );
  const normativeObjects = stagedNormatives(producerSigner.keyId);
  const closure = Effect.runSync(compileNormativeClosure(normativeObjects));
  const refs = closure.map((object) => object.ref);
  const byKind = new Map(refs.map((ref) => [String(ref.kind), ref]));
  const ref = (kind: string) => {
    const found = byKind.get(kind);
    if (found === undefined) throw new Error(`missing ${kind}`);
    return found.sha256;
  };
  const bundleRoot = Effect.runSync(
    compileTruthBundleRoot(
      {
        schema_version: 1,
        protocol: TRUTH_CONTRACT_PROTOCOL,
        environment: "staging",
        generation: "1",
        supersedes_generation: null,
        objects: refs,
        issuer: { service_id: "sonar-api", key_id: producerSigner.keyId },
        issued_at: now,
        valid_from: now,
        compatibility_version: "compatibility.v1",
        authority_matrix_hash: ref("authority_matrix"),
        security_profile_hash: ref("security_profile"),
      },
      producerSigner,
    ),
  );
  const identityObject = normativeObjects.find(
    (object) => object.kind === "identity_snapshot",
  )!;
  const binding = (
    identityObject.bindings as Array<Record<string, unknown>>
  )[0]!;
  const activityObject = normativeObjects.find(
    (object) => object.kind === "activity_profiles",
  )!;
  const activityProfile = (
    activityObject.profiles as Array<Record<string, unknown>>
  )[0]!;
  const evidence = (id: string) => ({
    evidence_id: id,
    sha256: digest(id),
  });
  const provider = (
    suffix: "a" | "b",
    client: "reth" | "nethermind",
  ) => ({
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
    height: finalizedHeight,
    block_hash: finalizedHash,
    observed_at: now,
    evidence: {
      evidence_id: `provider-${suffix}-read-only-response`,
      sha256: bytecodeResponseDigest,
    },
    source_error: false,
  });
  const readinessObservations = {
    schema_version: 1,
    environment: "staging",
    validity_class: "STAGED_CURRENT",
    evidence_origin: "READ_ONLY_LIVE",
    live_observation_receipt: null,
    now,
    bundle_hash: bundleRoot.root_hash,
    bundle_generation: "1",
    event_vocabulary_hash: ref("event_vocabulary"),
    network_policy_hash: ref("network_finality_policy"),
    activity_profile_hash: ref("activity_profiles"),
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
      chain_id: MIBERA_INITIAL_CHAIN_ID,
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
      snapshot_hash: ref("identity_snapshot"),
      canonical_collection_id: MIBERA_INITIAL_COLLECTION_ID,
      chain_family: "EVM",
      chain_id: MIBERA_INITIAL_CHAIN_ID,
      network: "berachain",
      canonical_address: MIBERA_INITIAL_ADDRESS,
      aliases: ["mibera-collection"],
      observed_height: finalizedHeight,
      observed_hash: finalizedHash,
      observed_at: now,
      finality_policy_version: "berachain-finalized.v1",
      network_listed: true,
      admitted: true,
      alias_ambiguous: false,
      proxy_kind: "NONE",
      proxy_evidence_complete: true,
      contest_state: "CLEAR",
      deployed_identity_hash: identityHash,
      code_hash: codeHash,
      implementation_address: null,
      implementation_code_hash: null,
      upgrade_mechanism: "IMMUTABLE",
      valid_from: now,
      valid_until: identityExpiry,
      effective_status: binding.effective_status,
      config_digest: MIBERA_CONFIG_BYTES_SHA256,
    },
    providers: [provider("a", "reth"), provider("b", "nethermind")],
    coverage: {
      marker_complete: true,
      processed_through: finalizedHeight,
      required_horizon: finalizedHeight,
      bundle_hash: bundleRoot.root_hash,
      identity_snapshot_hash: ref("identity_snapshot"),
      source_digest: MIBERA_HANDLER_BYTES_SHA256,
      adapter_digest: MIBERA_ADAPTER_BYTES_SHA256,
      config_digest: MIBERA_CONFIG_BYTES_SHA256,
      event_count: "17",
      observed_at: now,
      expires_at: evidenceExpiry,
      evidence: evidence("mibera-coverage-live"),
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
      source_head_evidence: evidence("mibera-source-head-live"),
      cursor_evidence: evidence("mibera-cursor-live"),
      heartbeat_evidence: evidence("mibera-heartbeat-live"),
      cross_source_evidence: evidence("mibera-cross-source-live"),
    },
    activity: {
      profile_version: activityObject.version,
      owner: activityProfile.owner,
      approval: activityProfile.approval,
      backtest_digest: activityProfile.backtest_digest,
      profile_approved: true,
      quiet_window_permitted: activityProfile.quiet_window_permitted,
      expected_event_window_seconds:
        activityProfile.expected_event_window_seconds,
      source_head_cadence_seconds:
        activityProfile.source_head_cadence_seconds,
      cursor_cadence_seconds: activityProfile.cursor_cadence_seconds,
      heartbeat_cadence_seconds:
        activityProfile.provider_heartbeat_cadence_seconds,
      evidence_window_start: activityProfile.evidence_window_start,
      evidence_window_end: activityProfile.evidence_window_end,
      effective_from: activityProfile.effective_from,
      effective_until: activityProfile.effective_until,
      observed_at: now,
      expires_at: evidenceExpiry,
      evidence: {
        evidence_id: activityProfile.approval,
        sha256: activityProfile.backtest_digest,
      },
    },
    reconciliation: {
      passed: true,
      bundle_hash: bundleRoot.root_hash,
      identity_snapshot_hash: ref("identity_snapshot"),
      watermark_hash: sha256Hex(jcsCanonicalize(finalizedWatermark)),
      observed_at: now,
      expires_at: evidenceExpiry,
      evidence: evidence("mibera-reconciliation-live"),
    },
    required_sources: [],
    invalidations: [],
  };
  const bytecodeObservations = [
    {
      provider_id: "berachain-provider-a",
      operator: "operator-a",
      control_domain: "domain-a",
      chain_id: MIBERA_INITIAL_CHAIN_ID,
      canonical_address: MIBERA_INITIAL_ADDRESS,
      finalized_height: finalizedHeight,
      finalized_block_hash: finalizedHash,
      bytecode_hash: codeHash,
      observed_at: now,
      evidence_id: "provider-a-read-only-response",
      evidence_sha256: bytecodeResponseDigest,
    },
    {
      provider_id: "berachain-provider-b",
      operator: "operator-b",
      control_domain: "domain-b",
      chain_id: MIBERA_INITIAL_CHAIN_ID,
      canonical_address: MIBERA_INITIAL_ADDRESS,
      finalized_height: finalizedHeight,
      finalized_block_hash: finalizedHash,
      bytecode_hash: codeHash,
      observed_at: now,
      evidence_id: "provider-b-read-only-response",
      evidence_sha256: bytecodeResponseDigest,
    },
  ];
  const forbiddenAuthorityKeyIds = [
    reviewerSigner.keyId,
    ...handoffSigners.map((signer) => signer.keyId),
    ...scoreSigners.map((signer) => signer.keyId),
  ];
  const separation = compileStagedReconcilerSeparationV1(
    {
      environment: "staging",
      producer,
      reconciler,
      producer_pid: "101",
      reconciler_pid: "202",
      forbidden_authority_key_ids: forbiddenAuthorityKeyIds,
      launched_at: now,
      expires_at: identityExpiry,
    },
    reconcilerSigner,
  );
  const planInput = {
    schema_version: 1,
    environment: "staging",
    generation: "1",
    invalidation_epoch: "0",
    bundle_root_hash: bundleRoot.root_hash,
    identity_snapshot_hash: ref("identity_snapshot"),
    producer_snapshot_id: producerSnapshotId,
    universe_digest: universeDigest,
    universe_size: String(partition.length),
    mandatory_stratum_count: String(strata.length),
    universe_partition: partition,
    strata,
    query_digest: digest("query"),
    parameter_digest: digest("parameters"),
    adapter_digest: MIBERA_ADAPTER_BYTES_SHA256,
    statistical_policy_hash: ref("statistical_policy"),
    selection_algorithm_version: "hypergeometric-sha256-order.v1",
    reconciler,
    producer,
    separation_attestation_hash: separation.attestation_hash,
    committed_at: "2026-07-19T08:59:30.000Z",
  } as const;
  const randomnessLedger = new SamplingRandomnessBeaconLedgerV1(
    randomnessWitness,
  );
  const randomnessBeacon = randomnessLedger.issue(
    {
      environment: "staging",
      generation: "1",
      round_digest: samplingRandomnessRoundDigestV1(planInput),
      scope_digest: samplingPlanScopeDigestV1(planInput),
      issued_at: planInput.committed_at,
      witness: randomnessWitness,
    },
    randomnessSigner,
  );
  const plan = compileSignedSamplingPlanV1(
    planInput,
    randomnessBeacon,
    randomnessSigner.publicKeyHex(),
    reconcilerSigner,
  );
  const nonce = deriveSamplingNonceV1(
    plan.body.randomness_scope_digest,
    randomnessBeacon.beacon_value,
  );
  const selected = Object.fromEntries(
    plan.body.targets.map((target) => [
      target.stratum_id,
      deterministicSampleMembersV1(
        target.stratum_id === "mibera.transfer.direct"
          ? ordinaryMembers
          : highRiskMembers,
        Number(target.target),
        nonce,
        target.stratum_id,
      ),
    ]),
  );
  const attemptLedger = new SamplingAttemptLedgerV1(
    join(reconciler.artifact_directory, "attempt-ledger"),
  );
  let attempt = attemptLedger.commit(plan, now, reconcilerSigner);
  attempt = finalizeSamplingQueryV1(
    attempt,
    {
      environment: "staging",
      generation: "1",
      invalidation_epoch: "0",
      bundle_root_hash: bundleRoot.root_hash,
      identity_snapshot_hash: ref("identity_snapshot"),
      producer_snapshot_id: producerSnapshotId,
      universe_digest: universeDigest,
      query_digest: digest("query"),
      parameter_digest: digest("parameters"),
      adapter_digest: MIBERA_ADAPTER_BYTES_SHA256,
      statistical_policy_hash: ref("statistical_policy"),
      source_snapshot_hash: digest("source-snapshot"),
      projection_snapshot_hash: digest("source-snapshot"),
      finalized_at: now,
    },
    reconciler,
    reconcilerSigner,
  );
  attempt = advanceSamplingAttemptV1(
    attempt,
    "NONCE_REVEALED",
    sha256Hex(nonce),
    now,
    reconciler,
    reconcilerSigner,
    nonce,
  );
  const publication = compileReconciliationReceiptV1(
    {
      plan,
      attempt,
      nonce,
      source_snapshot_hash: digest("source-snapshot"),
      projection_snapshot_hash: digest("source-snapshot"),
      selected_members: selected,
      observations: Object.entries(selected).flatMap(
        ([stratum_id, members]) =>
          members.map((member_id) => ({
            stratum_id,
            member_id,
            observed: true,
            semantic_match: true,
            identity_match: true,
            provenance_complete: true,
          })),
      ),
      census_members: { "mibera.transfer.staking": highRiskMembers },
      footprint_counts: FROZEN_FOOTPRINT_POLICY_V1.map((policy, index) => ({
        ...policy,
        source_count: String(10_000 + index),
        projection_count: String(10_000 + index),
      })),
      retry_owner: "sonar-reconciliation-owner",
      retry_deadline: "2026-07-19T09:10:00.000Z",
      observed_at: now,
      expires_at: evidenceExpiry,
    },
    reconcilerSigner,
  );
  const review = compileIndependentReviewReceiptV1(
    publication.receipt,
    reviewer,
    reconciler,
    producer,
    now,
    "APPROVED",
    reviewerSigner,
  );
  const verification = {
    producerKeyId: producerSigner.keyId,
    producerPublicKeyHex: producerSigner.publicKeyHex(),
    reconciler,
    reconcilerPublicKeyHex: reconcilerSigner.publicKeyHex(),
    randomnessBeacon,
    randomnessWitness,
    randomnessWitnessPublicKeyHex: randomnessSigner.publicKeyHex(),
    randomnessWitnessForbiddenKeyIds: [
      ...new Set([
        producerSigner.keyId,
        reconcilerSigner.keyId,
        reviewerSigner.keyId,
        ...forbiddenAuthorityKeyIds,
      ]),
    ],
    reviewer,
    reviewerPublicKeyHex: reviewerSigner.publicKeyHex(),
    forbiddenAuthorityKeyIds,
    separationAttestation: separation,
    now,
  };
  const reconciliationHash = sha256Hex(
    jcsCanonicalize(publication.receipt),
  );
  const activated = compileProjectionEventV1(
    {
      schema_version: 1,
      sequence: "1",
      previous_event_hash: null,
      event_id: "activate-staged-reconciliation",
      kind: "ARTIFACT_ACTIVATED",
      environment: "staging",
      artifact_hash: reconciliationHash,
      generation: "1",
      invalidation_epoch: "0",
      authority: "RECONCILER",
      lifecycle_state: "RECONCILED",
      local_status: "READY",
      state_floor: "READY",
      reason_code: "RECONCILED_STAGED",
      cause_event_id: null,
      resolves_cause_event_ids: [],
      replacement_evidence_hash: null,
      replacement_evidence_kinds: null,
      replacement_evidence: null,
      depends_on: [],
      occurred_at: now,
      production_authority: false,
    },
    reconcilerSigner,
  );
  const target = {
    collection_id: MIBERA_INITIAL_COLLECTION_ID,
    target_identity_hash: ref("identity_snapshot"),
    producer_root_hash: bundleRoot.root_hash,
    producer_generation: "1",
    invalidation_epoch: "0",
    environment: "staging",
  } as const;
  const handoffAuthorityBase = {
    schema_version: 1,
    authority_kind: "SONAR_HANDOFF",
    environment: "staging",
    generation: "1",
    threshold: "2",
    keys: handoffSigners.map((signer) => ({
      key_id: signer.keyId,
      public_key_hex: signer.publicKeyHex(),
      valid_from_sequence: "1",
      valid_through_sequence: null,
      compromised_from_sequence: null,
    })),
  } as const;
  const scoreAuthorityBase = {
    schema_version: 1,
    authority_kind: "SCORE_CONSUMER",
    environment: "staging",
    generation: "1",
    threshold: "2",
    keys: scoreSigners.map((signer) => ({
      key_id: signer.keyId,
      public_key_hex: signer.publicKeyHex(),
      valid_from_sequence: "1",
      valid_through_sequence: null,
      compromised_from_sequence: null,
    })),
  } as const;
  const handoffAuthority = {
    ...handoffAuthorityBase,
    keyset_hash: scoreAuthorityKeysetHashV1(handoffAuthorityBase),
  };
  const scoreAuthority = {
    ...scoreAuthorityBase,
    keyset_hash: scoreAuthorityKeysetHashV1(scoreAuthorityBase),
  };
  const handoffReceiptHash = digest("sealed-handoff");
  const notConsumed = Effect.runSync(
    compileNotConsumedReceiptV1(
      {
        _tag: "NotConsumedReceiptV1",
        schema_version: 1,
        domain: "sonar.score-not-consumed-receipt.v1",
        authority_kind: "SONAR_HANDOFF",
        target,
        sequence: "1",
        issued_at: now,
        producer_contract_version: "sonar-score-truth-contract/v1",
        consumer_contract_version: "score-consumption/v1",
        authority_generation: "1",
        authority_keyset_hash: handoffAuthority.keyset_hash,
        revocation_sequence: "0",
        prior_receipt_hash: null,
        owner: "bd-v54z.1",
        handoff_receipt_hash: handoffReceiptHash,
        handoff_sealed_at: now,
        deadline: scoreDeadline,
        expires_at: null,
        reason: "SCORE_IMPLEMENTATION_PENDING",
        supersedes_receipt_hash: null,
      },
      handoffSigners,
    ),
  );
  return {
    producerSigner,
    liveSigner,
    reconcilerSigner,
    cleanup: () => rmSync(rootDirectory, { recursive: true, force: true }),
    input: {
      normative_objects: normativeObjects,
      bundle_root: bundleRoot,
      readiness_observations: readinessObservations,
      bytecode_observations: bytecodeObservations,
      reconciliation: {
        plan,
        receipt: publication.receipt,
        attempt: publication.completed_attempt,
        review,
        verification,
      },
      projection: {
        artifact_hash: reconciliationHash,
        events: [activated],
        authority_registry: {
          [reconcilerSigner.keyId]: {
            public_key_hex: reconcilerSigner.publicKeyHex(),
            authorities: ["RECONCILER"],
          },
        },
      },
      score_consumption: {
        receipts: [notConsumed],
        verification: {
          target,
          authorities: [handoffAuthority, scoreAuthority],
          authority_high_water: {
            SONAR_HANDOFF: "1",
            SCORE_CONSUMER: "1",
          },
          revocation_high_water: "0",
          receipt_sequence_high_water: "1",
          handoff: {
            receipt_hash: handoffReceiptHash,
            sealed_at: now,
          },
          now,
        },
      },
      handoff_sealed_at: now,
    },
  };
};

describe("Mibera STAGED_CURRENT proof", () => {
  it("compiles signed live observations into a read-only staged inspection snapshot", () => {
    const harness = makeHarness();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network is forbidden"));
    try {
      const envelope = Effect.runSync(
        compileMiberaStagedCurrentProofV1(
          harness.input,
          harness.producerSigner,
          harness.liveSigner,
          harness.reconcilerSigner,
        ),
      );
      const verifiedSource = Effect.runSync(
        verifyTruthInspectionEnvelopeV1(envelope, {
          keyId: harness.producerSigner.keyId,
          publicKeyHex: harness.producerSigner.publicKeyHex(),
          envelopeHash: envelope.envelope_hash,
          trustRootGeneration: "1",
          revocationSequence: "0",
        }),
      );
      const snapshot = envelope.unsigned_envelope.snapshot;
      expect(verifiedSource.envelope.envelope_hash).toBe(
        envelope.envelope_hash,
      );
      expect(snapshot.publisher_key_id).toBe("sonar-staged-publisher");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(
        envelope.unsigned_envelope.projection_events.map((event) => ({
          sequence: event.body.sequence,
          kind: event.body.lifecycle_state,
          signer: event.signer_key_id,
          dependencies: event.body.depends_on,
        })),
      ).toEqual([
        {
          sequence: "1",
          kind: "PRODUCED",
          signer: harness.producerSigner.keyId,
          dependencies: [],
        },
        {
          sequence: "2",
          kind: "RECONCILED",
          signer: harness.reconcilerSigner.keyId,
          dependencies: [snapshot.artifacts[0]!.artifact_hash],
        },
        {
          sequence: "3",
          kind: "PRODUCED",
          signer: harness.producerSigner.keyId,
          dependencies: [snapshot.reconciliation_hash],
        },
      ]);
      expect(() =>
        Effect.runSync(
          verifyTruthInspectionEnvelopeV1(envelope, {
            keyId: harness.liveSigner.keyId,
            publicKeyHex: harness.liveSigner.publicKeyHex(),
            envelopeHash: envelope.envelope_hash,
            trustRootGeneration: "1",
            revocationSequence: "0",
          }),
        ),
      ).toThrow(/explicit trust pin/);
      expect(snapshot).toMatchObject({
        environment: "staging",
        collection_id: "mibera",
        chain_id: "80094",
        validity_class: "STAGED_CURRENT",
        authority_validity: "STAGED_VALID",
        production_authority: false,
        producer_generation: "1",
        invalidation_epoch: "0",
        score_state: "NOT_CONSUMED",
        score_owner: "bd-v54z.1",
        score_deadline: scoreDeadline,
        publisher_key_id: harness.producerSigner.keyId,
        trust_root_generation: "1",
        revocation_sequence: "0",
        cache_kind: "EXPLICIT_OFFLINE_CACHE",
        cached_at: now,
      });
      expect(snapshot.artifacts.map((artifact) => artifact.artifact_kind)).toEqual([
        "producer_readiness",
        "reconciliation",
        "score_consumption",
      ]);
      expect(snapshot.artifacts[2]).toMatchObject({
        effective_status: "NOT_READY",
        reason_codes: ["NOT_CONSUMED"],
      });
      expect(JSON.stringify(envelope)).not.toMatch(/fixture/i);
      expect(verifiedSource.snapshot).toEqual(snapshot);
      const inspected = Effect.runSync(
        makeTruthInspector(verifiedSource).status(
          "mibera",
          "staging",
          "reconciled_staged",
          now as never,
        ),
      );
      expect(inspected).toMatchObject({
        target_state: "reconciled_staged",
        target_ready: true,
        lifecycle: "RECONCILED",
        display_state: "RECONCILED_STAGED",
        effective_status: "READY",
      });

      const signerService = makeFixtureTruthSigner(
        harness.producerSigner,
        harness.producerSigner.publicKeyHex(),
      );
      const closure = Effect.runSync(
        compileNormativeClosure(harness.input.normative_objects),
      );
      const activation = Effect.runSync(
        compileTruthGenerationActivation(
          {
            schema_version: 1,
            protocol: TRUTH_CONTRACT_PROTOCOL,
            environment: "staging",
            prior_generation: "0",
            generation: "1",
            root: harness.input.bundle_root,
            audit_sequence: "1",
            audit_prior_record_sha256: null,
            audit_recorded_at: now,
            prepared_at: now,
            issuer: {
              service_id: "sonar-api",
              key_id: harness.producerSigner.keyId,
            },
          },
          signerService,
          now as never,
        ),
      );
      const store = makeInMemoryTruthRegistryStore(
        makeTruthActivationVerifier(signerService, now as never),
        makeTruthAuditVerifier(signerService),
      );
      for (const object of closure) {
        Effect.runSync(
          store.putObjectIfAbsent(
            "staging",
            object.ref.sha256,
            object.canonicalBytes,
          ),
        );
      }
      Effect.runSync(
        store.appendAuditEvent(
          Effect.runSync(
            compileTruthAuditEvent(
              {
                schema_version: 1,
                protocol: TRUTH_CONTRACT_PROTOCOL,
                environment: "staging",
                sequence: "1",
                kind: "GENERATION_ACTIVATED",
                generation: "1",
                subject_hash: activation.activation_hash,
                prior_record_sha256: null,
                recorded_at: now,
                issuer_key_id: signerService.keyId,
              },
              signerService,
            ),
          ),
        ),
      );
      Effect.runSync(
        store.compareAndSwapRoot("staging", "0" as never, activation),
      );
      const reloaded = Effect.runSync(store.readRoot("staging"));
      expect(reloaded.unsigned_activation.root.root_hash).toBe(
        snapshot.producer_root_hash,
      );
      expect(Effect.runSync(store.readActiveGeneration("staging"))).toBe("1");
      for (const object of closure) {
        expect(
          Effect.runSync(store.readObject("staging", object.ref.sha256)),
        ).toEqual(object.canonicalBytes);
      }
    } finally {
      fetchSpy.mockRestore();
      harness.cleanup();
    }
  });

  it("refuses relabeled fixture normatives", () => {
    const harness = makeHarness();
    try {
      expect(() =>
        Effect.runSync(
          compileMiberaStagedCurrentProofV1(
            {
              ...harness.input,
              normative_objects: buildMiberaFixtureNormativeObjects(now),
            },
            harness.producerSigner,
            harness.liveSigner,
            harness.reconcilerSigner,
          ),
        ),
      ).toThrow(/fixture-labeled material/);
    } finally {
      harness.cleanup();
    }
  });

  it("refuses a split or non-independent bytecode quorum", () => {
    const harness = makeHarness();
    try {
      const observations = structuredClone(
        harness.input.bytecode_observations,
      ) as Array<Record<string, unknown>>;
      observations[1]!.operator = "operator-a";
      observations[1]!.bytecode_hash = digest("conflicting-bytecode");
      expect(() =>
        Effect.runSync(
          compileMiberaStagedCurrentProofV1(
            { ...harness.input, bytecode_observations: observations },
            harness.producerSigner,
            harness.liveSigner,
            harness.reconcilerSigner,
          ),
        ),
      ).toThrow(/did not agree on Mibera bytecode/);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects bytecode evidence that is not attested by its readiness provider", () => {
    const harness = makeHarness();
    try {
      const observations = structuredClone(
        harness.input.bytecode_observations,
      ) as Array<Record<string, unknown>>;
      observations[1]!.evidence_sha256 = digest("unattested-response");
      expect(() =>
        Effect.runSync(
          compileMiberaStagedCurrentProofV1(
            { ...harness.input, bytecode_observations: observations },
            harness.producerSigner,
            harness.liveSigner,
            harness.reconcilerSigner,
          ),
        ),
      ).toThrow(/did not agree on Mibera bytecode/);
    } finally {
      harness.cleanup();
    }
  });

  it("changes the signed live receipt when a provider response commitment changes", () => {
    const harness = makeHarness();
    try {
      const original = Effect.runSync(
        compileMiberaStagedCurrentProofV1(
          harness.input,
          harness.producerSigner,
          harness.liveSigner,
          harness.reconcilerSigner,
        ),
      );
      const readiness = structuredClone(
        harness.input.readiness_observations,
      ) as {
        providers: Array<{
          evidence: { evidence_id: string; sha256: string };
        }>;
      };
      const bytecode = structuredClone(
        harness.input.bytecode_observations,
      ) as Array<Record<string, unknown>>;
      const replacementCommitment = digest("replacement-provider-response");
      readiness.providers[0]!.evidence.sha256 = replacementCommitment;
      bytecode[0]!.evidence_sha256 = replacementCommitment;
      const replaced = Effect.runSync(
        compileMiberaStagedCurrentProofV1(
          {
            ...harness.input,
            readiness_observations: readiness,
            bytecode_observations: bytecode,
          },
          harness.producerSigner,
          harness.liveSigner,
          harness.reconcilerSigner,
        ),
      );
      expect(
        original.unsigned_envelope.snapshot.artifacts[0]!.evidence_refs[0],
      ).not.toBe(
        replaced.unsigned_envelope.snapshot.artifacts[0]!.evidence_refs[0],
      );
    } finally {
      harness.cleanup();
    }
  });
});
