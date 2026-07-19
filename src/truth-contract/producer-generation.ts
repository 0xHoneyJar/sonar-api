import { Effect } from "effect";

import type { TrustEnvelopeSigner } from "../collection-resolver/trust-protocol.js";
import {
  jcsCanonicalize,
  sha256Hex,
} from "../collection-resolver/trust-protocol.js";
import { canonicalizeTruthJson } from "./canonical.js";
import { compileTruthBundleRoot } from "./bundle-compiler.js";
import { TruthIntegrityError } from "./errors.js";
import { compileNormativeClosure } from "./normative-compiler.js";
import { evaluateTruthReadiness } from "./readiness-evaluator.js";
import { compileFinalizedEvmIdentity } from "./identity-compiler.js";
import { samplingUniverseAuthorizationDigestV1 } from "./reconciliation.js";
import {
  TRUTH_AUTHORITY_ACTIONS,
  TRUTH_COMPATIBILITY_CHANGE_KINDS,
  TRUTH_SERVING_FAILURE_CLASSES,
} from "./schemas/normative.js";
import {
  TRUTH_CONTRACT_PROTOCOL,
  type Sha256Digest,
} from "./schemas/common.js";
import { TRUTH_NORMATIVE_OBJECT_KINDS } from "./schemas/bundle.js";

export const MIBERA_INITIAL_COLLECTION_ID = "mibera";
export const MIBERA_INITIAL_CHAIN_ID = "80094";
export const MIBERA_INITIAL_NETWORK = "berachain";
export const MIBERA_INITIAL_ADDRESS =
  "0x6666397dfe9a8c469bf65dc744cb1c733416c420";
export const MIBERA_INITIAL_START_HEIGHT = "3837808";
export const MIBERA_INITIAL_EVENT_SIGNATURE = "Transfer(address,address,uint256)";
export const MIBERA_INITIAL_EVENT_TOPIC0 =
  "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const MIBERA_DENOMINATOR_BYTES_SHA256 =
  "bf76119fb8da50f51eacf393fa2ca596828e203fd314e950e3f13fce1febe0b8";
export const MIBERA_CONFIG_BYTES_SHA256 =
  "87278b803f5c4b13fbaecb423827b322ecc425a9d8829df111b206b125c3fa8a";
export const MIBERA_HANDLER_BYTES_SHA256 =
  "23456ae7774d2330da12d7bc4f8b618c8da27d8f2559138287bbb8959de2570a";
export const MIBERA_ADAPTER_BYTES_SHA256 =
  "9a8962c63fe5a1899a29991759756e6dfa581c3f77d305f3d967c593b63c62da";

const digest = (value: string): string => sha256Hex(`truth-fixture:${value}`);
const addMilliseconds = (timestamp: string, milliseconds: number): string =>
  new Date(new Date(timestamp).getTime() + milliseconds).toISOString();

const MIBERA_FIXTURE_ORDINARY_MEMBERS = Array.from({ length: 1_000 }, (_, index) =>
  `ordinary-${String(index).padStart(4, "0")}`,
);
const MIBERA_FIXTURE_HIGH_RISK_MEMBERS = Array.from({ length: 5 }, (_, index) =>
  `custody-${String(index).padStart(2, "0")}`,
);
const MIBERA_FIXTURE_UNIVERSE = [
  ...MIBERA_FIXTURE_ORDINARY_MEMBERS.map((member_id) => ({
    member_id,
    stratum_id: "mibera.transfer.direct",
  })),
  ...MIBERA_FIXTURE_HIGH_RISK_MEMBERS.map((member_id) => ({
    member_id,
    stratum_id: "mibera.transfer.staking",
  })),
];
const MIBERA_FIXTURE_STRATA = [
  {
    stratum_id: "mibera.transfer.direct",
    contract: MIBERA_INITIAL_ADDRESS,
    event_kind: "mibera.erc721.transfer",
    semantic_leg: "DIRECT_TRANSFER",
    population: String(MIBERA_FIXTURE_ORDINARY_MEMBERS.length),
    universe_members_digest: sha256Hex(
      jcsCanonicalize(MIBERA_FIXTURE_ORDINARY_MEMBERS),
    ),
    high_risk: false,
    empty_proof_hash: null,
  },
  {
    stratum_id: "mibera.transfer.staking",
    contract: MIBERA_INITIAL_ADDRESS,
    event_kind: "mibera.erc721.transfer",
    semantic_leg: "STAKING_INGRESS",
    population: String(MIBERA_FIXTURE_HIGH_RISK_MEMBERS.length),
    universe_members_digest: sha256Hex(
      jcsCanonicalize(MIBERA_FIXTURE_HIGH_RISK_MEMBERS),
    ),
    high_risk: true,
    empty_proof_hash: null,
  },
] as const;
const MIBERA_FIXTURE_AUTHORIZED_SAMPLING_SCOPE_DIGEST =
  samplingUniverseAuthorizationDigestV1({
    producer_snapshot_id: "mibera-fixture-snapshot-1",
    universe_digest: sha256Hex(jcsCanonicalize(MIBERA_FIXTURE_UNIVERSE)),
    universe_size: String(MIBERA_FIXTURE_UNIVERSE.length),
    mandatory_stratum_count: String(MIBERA_FIXTURE_STRATA.length),
    strata: MIBERA_FIXTURE_STRATA,
  });

export const MIBERA_DENOMINATOR_MEMBER = Object.freeze({
  canonical_collection_id: MIBERA_INITIAL_COLLECTION_ID,
  chain_id: MIBERA_INITIAL_CHAIN_ID,
  contract_name: "MiberaCollection",
  canonical_address: MIBERA_INITIAL_ADDRESS,
  event_name: "Transfer",
  event_signature: MIBERA_INITIAL_EVENT_SIGNATURE,
  topic0: MIBERA_INITIAL_EVENT_TOPIC0,
  start_height: MIBERA_INITIAL_START_HEIGHT,
  handler_reference: "src/handlers/mibera-collection.ts",
});

export const MIBERA_DENOMINATOR_MANIFEST = Object.freeze({
  schema_version: 1,
  scope: "CLOSED",
  members: [MIBERA_DENOMINATOR_MEMBER],
});

const makeEffectiveStatus = (now: string) => ({
  _tag: "READY",
  reasons: ["FIXTURE_IDENTITY_VERIFIED"],
  evidence: [
    {
      evidence_id: "mibera-identity-fixture",
      sha256: digest("mibera-identity-evidence"),
    },
  ],
  evaluated_at: now,
  expires_at: addMilliseconds(now, 60 * 60 * 1_000),
  invalidation_epoch: "0",
});

export const buildMiberaFixtureNormativeObjects = (
  now: string,
): ReadonlyArray<unknown> => [
  {
    kind: "bundle_schema",
    schema_version: 1,
    protocol: TRUTH_CONTRACT_PROTOCOL,
    object_kinds: [...TRUTH_NORMATIVE_OBJECT_KINDS],
  },
  {
    kind: "identity_snapshot",
    schema_version: 1,
    version: "mibera-identity.fixture.v1",
    bindings: [
      {
        canonical_collection_id: MIBERA_INITIAL_COLLECTION_ID,
        chain_family: "EVM",
        chain_id: MIBERA_INITIAL_CHAIN_ID,
        canonical_address: MIBERA_INITIAL_ADDRESS,
        aliases: ["mibera-collection"],
        config_digest: MIBERA_CONFIG_BYTES_SHA256,
        config_source: "config.mibera.yaml",
        observed_height: "19000001",
        observed_hash: digest("berachain-finalized-block-19000001"),
        observed_at: now,
        finality_policy_version: "berachain-finalized.v1",
        deployed_identity_hash:
          "5296d5160b0e0e6d55b8af09fbfb1a4516cfc905195bb0bb69466ceafb6a617c",
        deployed_code_hash:
          "29448593ff971f65861dcf1d150d13e2adbcd442beac89c908a0f37d00a06c3a",
        proxy_kind: "NONE",
        implementation_address: null,
        implementation_code_hash: null,
        upgrade_mechanism: "IMMUTABLE",
        valid_from: now,
        valid_until: addMilliseconds(now, 60 * 60 * 1_000),
        supersedes_snapshot: null,
        contest_state: "CLEAR",
        evidence: [
          {
            evidence_id: "mibera-bytecode-fixture",
            sha256: digest("mibera-identity-evidence"),
          },
          {
            evidence_id: "provider-a-finalized-fixture",
            sha256: digest("provider-a-finalized-fixture"),
          },
          {
            evidence_id: "provider-b-finalized-fixture",
            sha256: digest("provider-b-finalized-fixture"),
          },
        ],
        effective_status: makeEffectiveStatus(now),
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
        assertion_fixture: "mibera-custody-symmetry.v1",
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
        changeKind === "OPTIONAL_FIELD_ADDED" || changeKind === "EVENT_KIND_ADDED";
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
            key_id: "sonar-fixture-revoked",
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
            key_id: "ordering-fixture-replay",
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
    version: "mibera-activity.fixture.v1",
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
        expected_event_distribution: "fixture-quiet-window.v1",
        evidence_window_start: now,
        evidence_window_end: addMilliseconds(now, 60 * 60 * 1_000),
        denominator: "1",
        backtest_digest: digest("mibera-activity-backtest"),
        confidence_basis: "fixture-only.v1",
        approval: "fixture-governance",
        effective_from: now,
        effective_until: addMilliseconds(now, 60 * 60 * 1_000),
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
    authorized_sampling_scope_digest:
      MIBERA_FIXTURE_AUTHORIZED_SAMPLING_SCOPE_DIGEST,
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
    environment: "development",
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
    version: "issuer.fixture.v1",
    service_id: "sonar-api",
    key_id: "replaced-by-compiler",
    build_id: "mibera-fixture-build",
    repository: "0xHoneyJar/sonar-api",
    source_commit: digest("fixture-source-commit"),
    issued_at: now,
  },
];

export const compileMiberaFixtureGeneration = (
  input: {
    readonly denominatorBytes: Uint8Array;
    readonly now: string;
  },
  signer: TrustEnvelopeSigner,
) =>
  Effect.gen(function* () {
    const actualDenominatorDigest = sha256Hex(input.denominatorBytes);
    if (actualDenominatorDigest !== MIBERA_DENOMINATOR_BYTES_SHA256) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.producer.denominator",
          reason: "committed denominator manifest bytes do not match the reviewed pin",
        }),
      );
    }
    const parsedDenominator = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(input.denominatorBytes)) as unknown,
      catch: () =>
        new TruthIntegrityError({
          boundary: "truth.producer.denominator",
          reason: "committed denominator manifest is not valid JSON",
        }),
    });
    const [actualManifest, expectedManifest] = yield* Effect.all([
      canonicalizeTruthJson(parsedDenominator, "truth.producer.denominator.actual"),
      canonicalizeTruthJson(
        MIBERA_DENOMINATOR_MANIFEST,
        "truth.producer.denominator.expected",
      ),
    ]);
    if (actualManifest !== expectedManifest) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.producer.denominator",
          reason:
            "committed denominator manifest does not equal the signed event denominator",
        }),
      );
    }
    const objects = structuredClone(
      buildMiberaFixtureNormativeObjects(input.now),
    ) as Array<Record<string, unknown>>;
    const identityCompilation = yield* compileFinalizedEvmIdentity(
      {
        canonicalCollectionId: MIBERA_INITIAL_COLLECTION_ID,
        chainId: MIBERA_INITIAL_CHAIN_ID,
        canonicalAddress: MIBERA_INITIAL_ADDRESS,
        aliases: ["mibera-collection"],
        configDigest: MIBERA_CONFIG_BYTES_SHA256,
        configSource: "config.mibera.yaml",
        expectedFinalityPolicyVersion: "berachain-finalized.v1",
        validFrom: input.now,
        validUntil: addMilliseconds(input.now, 60 * 60 * 1_000),
        statusExpiresAt: addMilliseconds(input.now, 60 * 60 * 1_000),
      },
      {
        resolve: () =>
          Effect.succeed({
            chain_id: MIBERA_INITIAL_CHAIN_ID,
            canonical_address: MIBERA_INITIAL_ADDRESS,
            observed_height: "19000001",
            observed_hash: digest("berachain-finalized-block-19000001"),
            observed_at: input.now,
            finality_policy_version: "berachain-finalized.v1",
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
                finality_method: "FINALIZED_TAG",
                finalized_tag: "finalized",
                height: "19000001",
                block_hash: digest("berachain-finalized-block-19000001"),
                observed_at: input.now,
                evidence: {
                  evidence_id: "provider-a-finalized-fixture",
                  sha256: digest("provider-a-finalized-fixture"),
                },
                source_error: false,
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
                finality_method: "FINALIZED_TAG",
                finalized_tag: "finalized",
                height: "19000001",
                block_hash: digest("berachain-finalized-block-19000001"),
                observed_at: input.now,
                evidence: {
                  evidence_id: "provider-b-finalized-fixture",
                  sha256: digest("provider-b-finalized-fixture"),
                },
                source_error: false,
              },
            ],
            deployed_identity_hash:
              "5296d5160b0e0e6d55b8af09fbfb1a4516cfc905195bb0bb69466ceafb6a617c",
            deployed_code_hash:
              "29448593ff971f65861dcf1d150d13e2adbcd442beac89c908a0f37d00a06c3a",
            proxy_kind: "NONE",
            implementation_address: null,
            implementation_code_hash: null,
            upgrade_mechanism: "IMMUTABLE",
            code_evidence_id: "mibera-bytecode-fixture",
            code_evidence_sha256: digest("mibera-identity-evidence"),
          }),
      },
    );
    if (identityCompilation._tag !== "VERIFIED") {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.producer.identity",
          reason: `fixture identity did not verify: ${identityCompilation.reason}`,
        }),
      );
    }
    const identityObject = objects.find(
      (object) => object.kind === "identity_snapshot",
    )!;
    identityObject.bindings = [identityCompilation.binding];
    const issuer = objects.find((object) => object.kind === "issuer_metadata")!;
    issuer.key_id = signer.keyId;
    const closure = yield* compileNormativeClosure(objects);
    const refs = closure.map((object) => object.ref);
    const byKind = new Map(refs.map((ref) => [String(ref.kind), ref]));
    const root = yield* compileTruthBundleRoot(
      {
        schema_version: 1,
        protocol: TRUTH_CONTRACT_PROTOCOL,
        environment: "development",
        generation: "1",
        supersedes_generation: null,
        objects: refs,
        issuer: { service_id: "sonar-api", key_id: signer.keyId },
        issued_at: input.now,
        valid_from: input.now,
        compatibility_version: "compatibility.v1",
        authority_matrix_hash: byKind.get("authority_matrix")!.sha256,
        security_profile_hash: byKind.get("security_profile")!.sha256,
      },
      signer,
    );
    const identitySnapshotHash = byKind.get("identity_snapshot")!.sha256;
    const watermark = {
      network: MIBERA_INITIAL_NETWORK,
      chain_id: MIBERA_INITIAL_CHAIN_ID,
      height: "19000001",
      block_hash: digest("berachain-finalized-block-19000001"),
      observed_at: input.now,
      finality_policy_version: "berachain-finalized.v1",
      finality_class: "FINALIZED",
    };
    const watermarkHash = sha256Hex(
      yield* canonicalizeTruthJson(watermark, "truth.producer.watermark"),
    );
    const evidenceExpiry = addMilliseconds(input.now, 30 * 60 * 1_000);
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
      height: watermark.height,
      block_hash: watermark.block_hash,
      observed_at: input.now,
      evidence: {
        evidence_id: `provider-${suffix}-finalized-fixture`,
        sha256: digest(`provider-${suffix}-finalized-fixture`),
      },
      source_error: false,
    });
    const readiness = yield* evaluateTruthReadiness(
      {
        schema_version: 1,
        environment: "development",
        validity_class: "FIXTURE_VALID",
        evidence_origin: "HERMETIC_FIXTURE",
        live_observation_receipt: null,
        now: input.now,
        bundle_hash: root.root_hash,
        bundle_generation: "1",
        event_vocabulary_hash: byKind.get("event_vocabulary")!.sha256,
        network_policy_hash: byKind.get("network_finality_policy")!.sha256,
        activity_profile_hash: byKind.get("activity_profiles")!.sha256,
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
          network: MIBERA_INITIAL_NETWORK,
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
          snapshot_hash: identitySnapshotHash,
          canonical_collection_id: MIBERA_INITIAL_COLLECTION_ID,
          chain_family: "EVM",
          chain_id: MIBERA_INITIAL_CHAIN_ID,
          network: MIBERA_INITIAL_NETWORK,
          canonical_address: MIBERA_INITIAL_ADDRESS,
          aliases: ["mibera-collection"],
          observed_height: watermark.height,
          observed_hash: watermark.block_hash,
          observed_at: input.now,
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
          valid_from: input.now,
          valid_until: addMilliseconds(input.now, 60 * 60 * 1_000),
          effective_status: makeEffectiveStatus(input.now),
          config_digest: MIBERA_CONFIG_BYTES_SHA256,
        },
        providers: [provider("a", "reth"), provider("b", "nethermind")],
        coverage: {
          marker_complete: true,
          processed_through: watermark.height,
          required_horizon: watermark.height,
          bundle_hash: root.root_hash,
          identity_snapshot_hash: identitySnapshotHash,
          source_digest: MIBERA_HANDLER_BYTES_SHA256,
          adapter_digest: MIBERA_ADAPTER_BYTES_SHA256,
          config_digest: MIBERA_CONFIG_BYTES_SHA256,
          event_count: "0",
          observed_at: input.now,
          expires_at: evidenceExpiry,
          evidence: {
            evidence_id: "mibera-coverage-fixture",
            sha256: digest("mibera-coverage-fixture"),
          },
        },
        progression: {
          source_head_advancing: true,
          cursor_advancing: true,
          heartbeat_present: true,
          cross_source_available: true,
          source_head_observed_at: input.now,
          cursor_observed_at: input.now,
          heartbeat_observed_at: input.now,
          source_failure: false,
          bounded_last_good_allowed: false,
          source_head_evidence: {
            evidence_id: "mibera-source-head-fixture",
            sha256: digest("mibera-source-head-fixture"),
          },
          cursor_evidence: {
            evidence_id: "mibera-cursor-fixture",
            sha256: digest("mibera-cursor-fixture"),
          },
          heartbeat_evidence: {
            evidence_id: "mibera-heartbeat-fixture",
            sha256: digest("mibera-heartbeat-fixture"),
          },
          cross_source_evidence: {
            evidence_id: "mibera-cross-source-fixture",
            sha256: digest("mibera-cross-source-fixture"),
          },
        },
        activity: {
          profile_version: "mibera-activity.fixture.v1",
          owner: "sonar-ops",
          approval: "fixture-governance",
          backtest_digest: digest("mibera-activity-backtest"),
          profile_approved: true,
          quiet_window_permitted: true,
          expected_event_window_seconds: "900",
          source_head_cadence_seconds: "60",
          cursor_cadence_seconds: "60",
          heartbeat_cadence_seconds: "60",
          evidence_window_start: input.now,
          evidence_window_end: addMilliseconds(input.now, 60 * 60 * 1_000),
          effective_from: input.now,
          effective_until: addMilliseconds(input.now, 60 * 60 * 1_000),
          observed_at: input.now,
          expires_at: evidenceExpiry,
          evidence: {
            evidence_id: "fixture-governance",
            sha256: digest("mibera-activity-backtest"),
          },
        },
        reconciliation: {
          passed: true,
          bundle_hash: root.root_hash,
          identity_snapshot_hash: identitySnapshotHash,
          watermark_hash: watermarkHash,
          observed_at: input.now,
          expires_at: evidenceExpiry,
          evidence: {
            evidence_id: "mibera-reconciliation-fixture",
            sha256: digest("mibera-reconciliation-fixture"),
          },
        },
        required_sources: [],
        invalidations: [],
      },
      signer,
      {
        normativeObjects: closure.map((object) => object.value),
        bundleRoot: root,
        bundleVerification: {
          expectedEnvironment: "development",
          expectedKeyId: signer.keyId,
          publicKeyHex: signer.publicKeyHex(),
          trustedGenerationHighWater: "1" as never,
          now: input.now as never,
        },
      },
    );
    return {
      validity_class: "FIXTURE_VALID" as const,
      lifecycle: "PRODUCED" as const,
      production_authority: false as const,
      denominator_digest: actualDenominatorDigest as Sha256Digest,
      closure,
      root,
      readiness,
    };
  });
