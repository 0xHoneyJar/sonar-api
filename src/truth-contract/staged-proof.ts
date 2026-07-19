import { Effect, Schema } from "effect";

import {
  jcsCanonicalize,
  sha256Hex,
  type TrustEnvelopeSigner,
} from "../collection-resolver/trust-protocol.js";
import {
  computeTruthReadinessObservationSetHash,
  compileTruthLiveObservationReceipt,
  evaluateTruthReadiness,
  verifyTruthReadinessEnvelope,
} from "./readiness-evaluator.js";
import {
  compileReconciledStagedGenerationV1,
  type ReconciledStagedVerificationV1,
  type StagedProducerGenerationV1,
} from "./reconciliation-generation.js";
import type {
  IndependentReviewReceiptV1,
  SamplingAttemptStateV1,
  SignedReconciliationReceiptV1,
  SignedSamplingPlanV1,
} from "./reconciliation.js";
import {
  compileProjectionEventV1,
  queryEffectiveStatusV1,
  rebuildTruthStatusProjectionV1,
  type ProjectionAuthorityRegistryV1,
  type SignedProjectionEventV1,
} from "./invalidation.js";
import { compileTruthInspectionEnvelopeV1 } from "./status-reader.js";
import {
  verifyScoreConsumptionReceiptsV1,
  type ScoreReceiptVerificationContextV1,
} from "./consumption.js";
import {
  MIBERA_INITIAL_ADDRESS,
  MIBERA_INITIAL_CHAIN_ID,
  MIBERA_INITIAL_COLLECTION_ID,
  MIBERA_INITIAL_EVENT_SIGNATURE,
  MIBERA_INITIAL_EVENT_TOPIC0,
  MIBERA_INITIAL_START_HEIGHT,
} from "./producer-generation.js";
import { compileNormativeClosure } from "./normative-compiler.js";
import {
  TruthReadinessEvaluationInputV1,
} from "./schemas/readiness.js";
import {
  TruthInspectionEnvelopeV1,
  TruthInspectionProjectionAuthorityV1,
  TruthInspectionProjectionEventV1,
  TruthInspectionSnapshotV1,
} from "./schemas/inspection.js";
import {
  Sha256Digest,
  TruthIdentifier,
  TruthIsoTimestamp,
  decodeStrict,
} from "./schemas/common.js";
import type { TruthBundleRootV1 } from "./schemas/bundle.js";
import {
  TruthDecodeError,
  TruthIntegrityError,
  TruthTrustError,
} from "./errors.js";

const SEVEN_DAYS_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

const StagedBytecodeObservationV1 = Schema.Struct({
  provider_id: TruthIdentifier,
  operator: TruthIdentifier,
  control_domain: TruthIdentifier,
  chain_id: Schema.Literal(MIBERA_INITIAL_CHAIN_ID),
  canonical_address: Schema.Literal(MIBERA_INITIAL_ADDRESS),
  finalized_height: Schema.String.pipe(Schema.pattern(/^(0|[1-9][0-9]*)$/)),
  finalized_block_hash: Sha256Digest,
  bytecode_hash: Sha256Digest,
  observed_at: TruthIsoTimestamp,
  evidence_id: TruthIdentifier,
  evidence_sha256: Sha256Digest,
});

const StagedBytecodeObservationSetV1 = Schema.Array(
  StagedBytecodeObservationV1,
).pipe(Schema.minItems(2), Schema.maxItems(2));

export interface StagedCurrentReconciliationInputV1 {
  readonly plan: SignedSamplingPlanV1;
  readonly receipt: SignedReconciliationReceiptV1;
  readonly attempt: SamplingAttemptStateV1;
  readonly review: IndependentReviewReceiptV1;
  readonly verification: ReconciledStagedVerificationV1;
}

export interface StagedCurrentProjectionInputV1 {
  readonly artifact_hash: string;
  readonly events: readonly SignedProjectionEventV1[];
  readonly authority_registry: ProjectionAuthorityRegistryV1;
}

export interface StagedCurrentScoreConsumptionInputV1 {
  readonly receipts: readonly unknown[];
  readonly verification: ScoreReceiptVerificationContextV1;
}

export interface CompileMiberaStagedCurrentProofInputV1 {
  readonly normative_objects: ReadonlyArray<unknown>;
  readonly bundle_root: TruthBundleRootV1;
  /**
   * Read-only observations only. The live receipt must be absent here because
   * this operation computes the observation-set hash and signs the receipt.
   */
  readonly readiness_observations: unknown;
  readonly bytecode_observations: unknown;
  readonly reconciliation: StagedCurrentReconciliationInputV1;
  readonly projection: StagedCurrentProjectionInputV1;
  readonly score_consumption: StagedCurrentScoreConsumptionInputV1;
  readonly handoff_sealed_at: string;
}

const integrityFailure = (reason: string): TruthIntegrityError =>
  new TruthIntegrityError({
    boundary: "truth.staged-proof",
    reason,
  });

const containsFixtureMarker = (value: unknown): boolean => {
  if (typeof value === "string") return /fixture/i.test(value);
  if (Array.isArray(value)) return value.some(containsFixtureMarker);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsFixtureMarker);
  }
  return false;
};

const failWhen = (
  condition: boolean,
  reason: string,
): Effect.Effect<void, TruthIntegrityError> =>
  condition ? Effect.fail(integrityFailure(reason)) : Effect.void;

const validateBytecodeQuorum = Effect.fn(
  "truth.staged-proof.validateBytecodeQuorum",
)(function* (
  raw: unknown,
  readiness: TruthReadinessEvaluationInputV1,
) {
  const observations = yield* decodeStrict(
    StagedBytecodeObservationSetV1,
    "truth.staged-proof.bytecode-observations",
    raw,
  );
  const providerIds = observations.map((observation) =>
    String(observation.provider_id),
  );
  const operators = observations.map((observation) =>
    String(observation.operator),
  );
  const domains = observations.map((observation) =>
    String(observation.control_domain),
  );
  const readinessProviders = new Map(
    readiness.providers.map((provider) => [
      String(provider.provider_id),
      provider,
    ]),
  );
  const expectedBytecodeHash = String(readiness.identity.code_hash);
  const invalid =
    new Set(providerIds).size !== observations.length ||
    new Set(operators).size < 2 ||
    new Set(domains).size < 2 ||
    new Set(observations.map((observation) => observation.evidence_id)).size !==
      observations.length ||
    new Set(observations.map((observation) => observation.bytecode_hash)).size !==
      1 ||
    observations.some((observation) => {
      const provider = readinessProviders.get(String(observation.provider_id));
      return (
        provider === undefined ||
        String(provider.operator) !== String(observation.operator) ||
        String(provider.control_domain) !==
          String(observation.control_domain) ||
        provider.finality_method !== "FINALIZED_TAG" ||
        provider.finalized_tag !== "finalized" ||
        String(provider.height) !== String(observation.finalized_height) ||
        provider.block_hash !== observation.finalized_block_hash ||
        provider.observed_at !== observation.observed_at ||
        provider.evidence.evidence_id !== observation.evidence_id ||
        provider.evidence.sha256 !== observation.evidence_sha256 ||
        String(observation.finalized_height) !==
          String(readiness.identity.observed_height) ||
        observation.finalized_block_hash !== readiness.identity.observed_hash ||
        observation.observed_at !== readiness.identity.observed_at ||
        observation.bytecode_hash !== expectedBytecodeHash
      );
    });
  yield* failWhen(
    invalid,
    "two independent finalized providers did not agree on Mibera bytecode",
  );
  return observations;
});

const validateMiberaClosure = Effect.fn(
  "truth.staged-proof.validateMiberaClosure",
)(function* (
  normativeObjects: ReadonlyArray<unknown>,
) {
  yield* failWhen(
    normativeObjects.some(containsFixtureMarker),
    "staged-current closure contains fixture-labeled material",
  );
  const closure = yield* compileNormativeClosure(normativeObjects);
  const identity = closure.find(
    (object) => object.value.kind === "identity_snapshot",
  );
  const vocabulary = closure.find(
    (object) => object.value.kind === "event_vocabulary",
  );
  if (
    identity?.value.kind !== "identity_snapshot" ||
    vocabulary?.value.kind !== "event_vocabulary"
  ) {
    return yield* Effect.fail(
      integrityFailure("identity or event vocabulary is absent"),
    );
  }
  const binding = identity.value.bindings[0];
  const member = vocabulary.value.denominator_members[0];
  const event = vocabulary.value.events[0];
  const invalid =
    identity.value.bindings.length !== 1 ||
    binding === undefined ||
    String(binding.canonical_collection_id) !== MIBERA_INITIAL_COLLECTION_ID ||
    String(binding.chain_id) !== MIBERA_INITIAL_CHAIN_ID ||
    String(binding.canonical_address) !== MIBERA_INITIAL_ADDRESS ||
    vocabulary.value.denominator_scope !== "CLOSED" ||
    vocabulary.value.denominator_members.length !== 1 ||
    member === undefined ||
    String(member.canonical_collection_id) !== MIBERA_INITIAL_COLLECTION_ID ||
    String(member.chain_id) !== MIBERA_INITIAL_CHAIN_ID ||
    String(member.contract_name) !== "MiberaCollection" ||
    String(member.canonical_address) !== MIBERA_INITIAL_ADDRESS ||
    String(member.event_name) !== "Transfer" ||
    String(member.event_signature) !== MIBERA_INITIAL_EVENT_SIGNATURE ||
    String(member.topic0) !== MIBERA_INITIAL_EVENT_TOPIC0 ||
    String(member.start_height) !== MIBERA_INITIAL_START_HEIGHT ||
    vocabulary.value.events.length !== 1 ||
    event === undefined ||
    String(event.event_kind) !== "mibera.erc721.transfer";
  yield* failWhen(
    invalid,
    "staged proof is not the exact closed Berachain MiberaCollection Transfer slice",
  );
  return { closure, binding, vocabulary };
});

export const compileMiberaStagedCurrentProofV1 = Effect.fn(
  "truth.staged-proof.compileMiberaStagedCurrentProofV1",
)(function* (
  input: CompileMiberaStagedCurrentProofInputV1,
  producerSigner: TrustEnvelopeSigner,
  liveObservationSigner: TrustEnvelopeSigner,
  reconcilerSigner: TrustEnvelopeSigner,
): Effect.fn.Return<
  TruthInspectionEnvelopeV1,
  TruthDecodeError | TruthIntegrityError | TruthTrustError
> {
  const handoffSealedAt = yield* decodeStrict(
    TruthIsoTimestamp,
    "truth.staged-proof.handoff-sealed-at",
    input.handoff_sealed_at,
  );
  const { closure, binding } = yield* validateMiberaClosure(
    input.normative_objects,
  );
  const readinessWithoutReceipt = yield* decodeStrict(
    TruthReadinessEvaluationInputV1,
    "truth.staged-proof.readiness-observations",
    input.readiness_observations,
  );
  const invalidReadinessScope =
    input.bundle_root.unsigned_root.environment !== "staging" ||
    readinessWithoutReceipt.environment !== "staging" ||
    readinessWithoutReceipt.validity_class !== "STAGED_CURRENT" ||
    readinessWithoutReceipt.evidence_origin !== "READ_ONLY_LIVE" ||
    readinessWithoutReceipt.live_observation_receipt !== null ||
    String(readinessWithoutReceipt.identity.canonical_collection_id) !==
      MIBERA_INITIAL_COLLECTION_ID ||
    String(readinessWithoutReceipt.identity.chain_id) !==
      MIBERA_INITIAL_CHAIN_ID ||
    String(readinessWithoutReceipt.identity.canonical_address) !==
      MIBERA_INITIAL_ADDRESS ||
    String(readinessWithoutReceipt.policy.chain_id) !==
      MIBERA_INITIAL_CHAIN_ID ||
    String(readinessWithoutReceipt.policy.required_provider_quorum) !== "2" ||
    readinessWithoutReceipt.policy.providers.length !== 2 ||
    readinessWithoutReceipt.policy.finality_method !== "FINALIZED_TAG" ||
    readinessWithoutReceipt.policy.finalized_tag !== "finalized" ||
    readinessWithoutReceipt.providers.length !== 2 ||
    String(binding.observed_height) !==
      String(readinessWithoutReceipt.identity.observed_height) ||
    binding.observed_hash !== readinessWithoutReceipt.identity.observed_hash ||
    binding.observed_at !== readinessWithoutReceipt.identity.observed_at ||
    binding.deployed_code_hash !== readinessWithoutReceipt.identity.code_hash;
  yield* failWhen(
    invalidReadinessScope,
    "read-only readiness observations do not bind staged-current Mibera",
  );
  const bytecodeObservations = yield* validateBytecodeQuorum(
    input.bytecode_observations,
    readinessWithoutReceipt,
  );
  const observationSetHash =
    yield* computeTruthReadinessObservationSetHash(readinessWithoutReceipt);
  const liveObservationReceipt = yield* compileTruthLiveObservationReceipt(
    {
      schema_version: 1,
      environment: "staging",
      bundle_hash: readinessWithoutReceipt.bundle_hash,
      identity_snapshot_hash: readinessWithoutReceipt.identity.snapshot_hash,
      event_vocabulary_hash:
        readinessWithoutReceipt.event_vocabulary_hash,
      network_policy_hash: readinessWithoutReceipt.network_policy_hash,
      activity_profile_hash: readinessWithoutReceipt.activity_profile_hash,
      denominator_manifest_hash:
        readinessWithoutReceipt.denominator_manifest_hash,
      source_digest: readinessWithoutReceipt.source_digest,
      adapter_digest: readinessWithoutReceipt.adapter_digest,
      observation_set_hash: observationSetHash,
      observed_at: readinessWithoutReceipt.now,
      expires_at: new Date(
        new Date(readinessWithoutReceipt.now).getTime() + 30 * 60 * 1_000,
      ).toISOString(),
      issuer_key_id: liveObservationSigner.keyId,
    },
    liveObservationSigner,
  );
  const readinessInput = new TruthReadinessEvaluationInputV1({
    ...readinessWithoutReceipt,
    live_observation_receipt: liveObservationReceipt,
  });
  const readiness = yield* evaluateTruthReadiness(
    readinessInput,
    producerSigner,
    {
      normativeObjects: input.normative_objects,
      bundleRoot: input.bundle_root,
      bundleVerification: {
        expectedEnvironment: "staging",
        expectedKeyId: producerSigner.keyId,
        publicKeyHex: producerSigner.publicKeyHex(),
        trustedGenerationHighWater: input.bundle_root.unsigned_root.generation,
        now: readinessInput.now,
      },
      trustedLiveObservationKeys: new Map([
        [liveObservationSigner.keyId, liveObservationSigner.publicKeyHex()],
      ]),
    },
  );
  yield* verifyTruthReadinessEnvelope(readiness, {
    expectedEnvironment: "staging",
    expectedKeyId: producerSigner.keyId,
    publicKeyHex: producerSigner.publicKeyHex(),
    expectedValidityClass: "STAGED_CURRENT",
    expectedBundleHash: input.bundle_root.root_hash,
    expectedBundleGeneration: String(input.bundle_root.unsigned_root.generation),
    now: readinessInput.now,
  });
  yield* failWhen(
    readiness.unsigned_envelope.decision.state !== "READY",
    `staged-current producer readiness is not READY: ${readiness.unsigned_envelope.decision.reasons.join(",")}`,
  );
  const stagedRoot: StagedProducerGenerationV1["root"] = {
    root_hash: input.bundle_root.root_hash,
    unsigned_root: {
      environment: "staging",
      generation: input.bundle_root.unsigned_root.generation,
      objects: input.bundle_root.unsigned_root.objects,
    },
  };
  const producer: StagedProducerGenerationV1 = {
    validity_class: "STAGED_CURRENT",
    lifecycle: "PRODUCED",
    production_authority: false,
    root: stagedRoot,
    closure,
    readiness,
  };
  yield* failWhen(
    input.reconciliation.verification.now !== readinessInput.now ||
      input.reconciliation.verification.producerKeyId !== producerSigner.keyId ||
      input.reconciliation.verification.producerPublicKeyHex !==
        producerSigner.publicKeyHex() ||
      input.reconciliation.verification.reconciler.key_id !==
        reconcilerSigner.keyId ||
      input.reconciliation.verification.reconcilerPublicKeyHex !==
        reconcilerSigner.publicKeyHex(),
    "reconciliation verification does not bind the staged-current producer",
  );
  const reconciled = yield* compileReconciledStagedGenerationV1(
    producer,
    input.reconciliation.plan,
    input.reconciliation.receipt,
    input.reconciliation.attempt,
    input.reconciliation.review,
    input.reconciliation.verification,
  );
  yield* failWhen(
    reconciled.validity_class !== "STAGED_VALID" ||
      reconciled.display_state !== "RECONCILED_STAGED" ||
      reconciled.production_authority !== false ||
      reconciled.readiness_envelope_hash !== readiness.envelope_hash ||
      input.projection.artifact_hash !==
        reconciled.reconciliation_receipt_hash,
    "reconciled staged generation does not bind the live producer proof",
  );
  const projection = yield* Effect.try({
    try: () =>
      rebuildTruthStatusProjectionV1(
        "staging",
        input.projection.events,
        input.projection.authority_registry,
      ),
    catch: () => integrityFailure("signed staged projection did not rebuild"),
  });
  const effective = yield* Effect.try({
    try: () =>
      queryEffectiveStatusV1(
        projection,
        input.projection.artifact_hash,
        reconciled.generation,
        reconciled.invalidation_epoch,
      ),
    catch: () => integrityFailure("reconciled artifact status query failed"),
  });
  yield* failWhen(
    effective.lifecycle_state !== "RECONCILED" ||
      effective.effective_status !== "READY",
    "reconciled artifact is not effectively READY",
  );
  const reconciliationEvent = input.projection.events[0];
  yield* failWhen(
    input.projection.events.length !== 1 ||
      reconciliationEvent === undefined ||
      reconciliationEvent.body.kind !== "ARTIFACT_ACTIVATED" ||
      reconciliationEvent.body.sequence !== "1" ||
      reconciliationEvent.body.previous_event_hash !== null ||
      reconciliationEvent.body.artifact_hash !==
        reconciled.reconciliation_receipt_hash ||
      reconciliationEvent.body.lifecycle_state !== "RECONCILED" ||
      reconciliationEvent.body.authority !== "RECONCILER" ||
      reconciliationEvent.body.local_status !== "READY" ||
      reconciliationEvent.body.state_floor !== "READY" ||
      reconciliationEvent.body.reason_code !== "RECONCILED_STAGED" ||
      reconciliationEvent.body.depends_on.length !== 0,
    "staged projection is not the exact reconciliation activation",
  );
  const scoreConsumption = yield* verifyScoreConsumptionReceiptsV1(
    input.score_consumption.receipts,
    input.score_consumption.verification,
  );
  const deadline = new Date(
    new Date(handoffSealedAt).getTime() + SEVEN_DAYS_MILLISECONDS,
  ).toISOString();
  const scoreTarget = input.score_consumption.verification.target;
  yield* failWhen(
    scoreConsumption._tag !== "NOT_CONSUMED" ||
      scoreTarget.collection_id !== MIBERA_INITIAL_COLLECTION_ID ||
      scoreTarget.environment !== "staging" ||
      scoreTarget.target_identity_hash !== reconciled.identity_snapshot_hash ||
      scoreTarget.producer_root_hash !== reconciled.producer_root_hash ||
      scoreTarget.producer_generation !== reconciled.generation ||
      scoreTarget.invalidation_epoch !== reconciled.invalidation_epoch ||
      input.score_consumption.verification.handoff.sealed_at !==
        handoffSealedAt ||
      scoreConsumption.owner !== "bd-v54z.1" ||
      scoreConsumption.deadline !== deadline,
    "Score NotConsumed receipt does not bind the staged handoff",
  );
  if (scoreConsumption._tag !== "NOT_CONSUMED") {
    return yield* Effect.fail(
      integrityFailure("Score consumption state is not NotConsumed"),
    );
  }
  const cacheExpiry = [
    liveObservationReceipt.unsigned_receipt.expires_at,
    readiness.unsigned_envelope.expires_at,
    reconciled.expires_at,
  ].sort()[0];
  if (cacheExpiry === undefined) {
    return yield* Effect.fail(
      integrityFailure("staged cache expiry is absent"),
    );
  }
  if (reconciliationEvent === undefined) {
    return yield* Effect.fail(
      integrityFailure("staged reconciliation event is absent"),
    );
  }
  const readinessEvent = compileProjectionEventV1(
    {
      schema_version: 1,
      sequence: "1",
      previous_event_hash: null,
      event_id: "activate-staged-producer-readiness",
      kind: "ARTIFACT_ACTIVATED",
      environment: "staging",
      artifact_hash: readiness.envelope_hash,
      generation: reconciled.generation,
      invalidation_epoch: reconciled.invalidation_epoch,
      authority: "PRODUCER",
      lifecycle_state: "PRODUCED",
      local_status: "READY",
      state_floor: "READY",
      reason_code: "STAGED_CURRENT_READY",
      cause_event_id: null,
      resolves_cause_event_ids: [],
      replacement_evidence_hash: null,
      replacement_evidence_kinds: null,
      replacement_evidence: null,
      depends_on: [],
      occurred_at: readinessInput.now,
      production_authority: false,
    },
    producerSigner,
  );
  const inspectionReconciliationEvent = compileProjectionEventV1(
    {
      schema_version: 1,
      sequence: "2",
      previous_event_hash: sha256Hex(jcsCanonicalize(readinessEvent)),
      event_id: "activate-inspection-staged-reconciliation",
      kind: "ARTIFACT_ACTIVATED",
      environment: "staging",
      artifact_hash: reconciled.reconciliation_receipt_hash,
      generation: reconciled.generation,
      invalidation_epoch: reconciled.invalidation_epoch,
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
      depends_on: [readiness.envelope_hash],
      occurred_at: input.reconciliation.verification.now,
      production_authority: false,
    },
    reconcilerSigner,
  );
  const scoreEvent = compileProjectionEventV1(
    {
      schema_version: 1,
      sequence: "3",
      previous_event_hash: sha256Hex(
        jcsCanonicalize(inspectionReconciliationEvent),
      ),
      event_id: "activate-staged-score-consumption",
      kind: "ARTIFACT_ACTIVATED",
      environment: "staging",
      artifact_hash: scoreConsumption.receipt_hash,
      generation: reconciled.generation,
      invalidation_epoch: reconciled.invalidation_epoch,
      authority: "PRODUCER",
      lifecycle_state: "PRODUCED",
      local_status: "NOT_READY",
      state_floor: "NOT_READY",
      reason_code: "NOT_CONSUMED",
      cause_event_id: null,
      resolves_cause_event_ids: [],
      replacement_evidence_hash: null,
      replacement_evidence_kinds: null,
      replacement_evidence: null,
      depends_on: [reconciled.reconciliation_receipt_hash],
      occurred_at: handoffSealedAt,
      production_authority: false,
    },
    producerSigner,
  );
  const projectionEvents = yield* decodeStrict(
    Schema.Array(TruthInspectionProjectionEventV1),
    "truth.staged-proof.inspection-projection-events",
    [readinessEvent, inspectionReconciliationEvent, scoreEvent],
  );
  const producerGrant =
    input.projection.authority_registry[producerSigner.keyId];
  yield* failWhen(
    producerGrant !== undefined &&
      (producerGrant.public_key_hex !== producerSigner.publicKeyHex() ||
        !producerGrant.authorities.includes("PRODUCER")),
    "producer projection authority conflicts with the staged signer",
  );
  const reconcilerGrant =
    input.projection.authority_registry[reconcilerSigner.keyId];
  yield* failWhen(
    reconcilerGrant === undefined ||
      reconcilerGrant.public_key_hex !== reconcilerSigner.publicKeyHex() ||
      !reconcilerGrant.authorities.includes("RECONCILER"),
    "reconciler projection authority conflicts with the staged signer",
  );
  const projectionAuthorityRegistry: ProjectionAuthorityRegistryV1 = {
    ...input.projection.authority_registry,
    [producerSigner.keyId]: {
      public_key_hex: producerSigner.publicKeyHex(),
      authorities: [
        ...new Set([
          ...(producerGrant?.authorities ?? []),
          "PRODUCER" as const,
        ]),
      ],
    },
  };
  const projectionAuthorities = yield* decodeStrict(
    Schema.Array(TruthInspectionProjectionAuthorityV1),
    "truth.staged-proof.inspection-projection-authorities",
    Object.entries(projectionAuthorityRegistry)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key_id, grant]) => ({
        key_id,
        public_key_hex: grant.public_key_hex,
        authorities: [...grant.authorities],
      })),
  );
  const inspectionProjection = yield* Effect.try({
    try: () =>
      rebuildTruthStatusProjectionV1(
        "staging",
        projectionEvents as unknown as readonly SignedProjectionEventV1[],
        projectionAuthorityRegistry,
      ),
    catch: () =>
      integrityFailure("signed inspection projection did not rebuild"),
  });
  const readinessProjection =
    inspectionProjection.artifacts[readiness.envelope_hash];
  const reconciliationProjection =
    inspectionProjection.artifacts[reconciled.reconciliation_receipt_hash];
  const scoreProjection =
    inspectionProjection.artifacts[scoreConsumption.receipt_hash];
  yield* failWhen(
    Object.keys(inspectionProjection.artifacts).length !== 3 ||
      readinessProjection === undefined ||
      reconciliationProjection === undefined ||
      scoreProjection === undefined,
    "signed inspection projection does not exactly close over staged artifacts",
  );
  if (
    readinessProjection === undefined ||
    reconciliationProjection === undefined ||
    scoreProjection === undefined
  ) {
    return yield* Effect.fail(
      integrityFailure("signed inspection projection is incomplete"),
    );
  }
  const artifacts = [
    {
      artifact_hash: readiness.envelope_hash,
      artifact_kind: "producer_readiness",
      effective_status: readinessProjection.state_floor,
      reason_codes: readinessProjection.reason_codes,
      expires_at: readiness.unsigned_envelope.expires_at,
      dependencies: readinessProjection.depends_on,
      evidence_refs: [liveObservationReceipt.receipt_hash],
    },
    {
      artifact_hash: reconciled.reconciliation_receipt_hash,
      artifact_kind: "reconciliation",
      effective_status: reconciliationProjection.state_floor,
      reason_codes: reconciliationProjection.reason_codes,
      expires_at: reconciled.expires_at,
      dependencies: reconciliationProjection.depends_on,
      evidence_refs: [reconciled.independent_review_hash],
    },
    {
      artifact_hash: scoreConsumption.receipt_hash,
      artifact_kind: "score_consumption",
      effective_status: scoreProjection.state_floor,
      reason_codes: scoreProjection.reason_codes,
      expires_at: null,
      dependencies: scoreProjection.depends_on,
      evidence_refs: [scoreConsumption.receipt_hash],
    },
  ];
  const inspectionProjectionDigest = sha256Hex(
    jcsCanonicalize(
      [...artifacts].sort((left, right) =>
        left.artifact_hash.localeCompare(right.artifact_hash),
      ),
    ),
  );
  const snapshot = yield* decodeStrict(
    TruthInspectionSnapshotV1,
    "truth.staged-proof.inspection-snapshot",
    {
    schema_version: 1,
    environment: "staging",
    collection_id: "mibera",
    canonical_address: MIBERA_INITIAL_ADDRESS,
    chain_id: MIBERA_INITIAL_CHAIN_ID,
    event_signature: MIBERA_INITIAL_EVENT_SIGNATURE,
    validity_class: "STAGED_CURRENT",
    producer_root_hash: reconciled.producer_root_hash,
    producer_generation: reconciled.generation,
    invalidation_epoch: reconciled.invalidation_epoch,
    identity_snapshot_hash: reconciled.identity_snapshot_hash,
    reconciliation_hash: reconciled.reconciliation_receipt_hash,
    score_receipt_hash: scoreConsumption.receipt_hash,
    score_state: "NOT_CONSUMED",
    score_owner: "bd-v54z.1",
    score_deadline: deadline,
    publisher_key_id: producerSigner.keyId,
    trust_root_generation: input.bundle_root.unsigned_root.generation,
    revocation_sequence: reconciled.invalidation_epoch,
    cache_kind: "EXPLICIT_OFFLINE_CACHE",
    cached_at: readinessInput.now,
    authority_validity: "STAGED_VALID",
    production_authority: false,
    observed_at: readinessInput.identity.observed_at,
    expires_at: cacheExpiry,
    artifacts,
    served_projection_digest: inspectionProjectionDigest,
    rebuilt_projection_digest: inspectionProjectionDigest,
    },
  );
  return yield* compileTruthInspectionEnvelopeV1(
    snapshot,
    projectionEvents,
    projectionAuthorities,
    producerSigner,
  );
});
