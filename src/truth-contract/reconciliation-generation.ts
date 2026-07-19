import { lstatSync, realpathSync, statSync } from "node:fs";

import { Effect } from "effect";

import { jcsCanonicalize, sha256Hex } from "../collection-resolver/trust-protocol.js";
import { TruthDecodeError, TruthIntegrityError, TruthTrustError } from "./errors.js";
import {
  type IndependentReviewReceiptV1,
  type ReconciliationPrincipalV1,
  type SignedReconciliationReceiptV1,
  type SignedSamplingRandomnessBeaconV1,
  type SignedSamplingPlanV1,
  type SamplingAttemptStateV1,
  verifyIndependentReviewReceiptV1,
  verifyReconciliationReceiptV1,
  samplingUniverseAuthorizationDigestV1,
  verifyStatisticalPolicyObjectV1,
  verifySignedSamplingPlanV1,
} from "./reconciliation.js";
import {
  type SignedStagedReconcilerSeparationV1,
  verifyStagedReconcilerSeparationV1,
} from "./reconciler-separation.js";
import { verifyServingPolicyObjectV1 } from "./reorg-serving.js";
import { verifyTruthReadinessEnvelope } from "./readiness-evaluator.js";

export interface StagedProducerGenerationV1 {
  readonly validity_class: "FIXTURE_VALID" | "STAGED_CURRENT";
  readonly lifecycle: "PRODUCED";
  readonly production_authority: false;
  readonly root: {
    readonly root_hash: string;
    readonly unsigned_root: {
      readonly environment: "development" | "staging";
      readonly generation: string;
      readonly objects: readonly { readonly kind: string; readonly sha256: string }[];
    };
  };
  readonly closure: readonly {
    readonly ref: { readonly kind: string; readonly sha256: string };
    readonly value: unknown;
  }[];
  readonly readiness: unknown;
}

export interface ReconciledStagedGenerationV1 {
  readonly validity_class: "STAGED_VALID";
  readonly lifecycle: "RECONCILED";
  readonly display_state: "RECONCILED_STAGED";
  readonly authority_validity: "STAGED_VALID";
  readonly production_authority: false;
  readonly environment: "development" | "staging";
  readonly generation: string;
  readonly invalidation_epoch: string;
  readonly producer_root_hash: string;
  readonly identity_snapshot_hash: string;
  readonly statistical_policy_hash: string;
  readonly serving_policy_hash: string;
  readonly readiness_envelope_hash: string;
  readonly sampling_plan_hash: string;
  readonly reconciliation_receipt_hash: string;
  readonly independent_review_hash: string;
  readonly expires_at: string;
}

export interface ReconciledStagedVerificationV1 {
  readonly producerKeyId: string;
  readonly producerPublicKeyHex: string;
  readonly reconciler: ReconciliationPrincipalV1;
  readonly reconcilerPublicKeyHex: string;
  readonly randomnessBeacon: SignedSamplingRandomnessBeaconV1;
  readonly randomnessWitness: ReconciliationPrincipalV1;
  readonly randomnessWitnessPublicKeyHex: string;
  readonly randomnessWitnessForbiddenKeyIds: readonly string[];
  readonly reviewer: ReconciliationPrincipalV1;
  readonly reviewerPublicKeyHex: string;
  readonly forbiddenAuthorityKeyIds: readonly string[];
  readonly separationAttestation: SignedStagedReconcilerSeparationV1;
  readonly now: string;
}

const verifyRandomnessWitnessDirectorySeparationV1 = (
  witness: ReconciliationPrincipalV1,
  peers: readonly ReconciliationPrincipalV1[],
): boolean => {
  try {
    const link = lstatSync(witness.artifact_directory);
    if (!link.isDirectory() || link.isSymbolicLink()) return false;
    const witnessRealpath = realpathSync(witness.artifact_directory);
    const witnessStat = statSync(witnessRealpath);
    if ((witnessStat.mode & 0o022) !== 0) return false;
    if (
      typeof process.getuid === "function" &&
      witnessStat.uid !== process.getuid()
    ) {
      return false;
    }
    return peers.every(
      (peer) => realpathSync(peer.artifact_directory) !== witnessRealpath,
    );
  } catch {
    return false;
  }
};

/**
 * This is the only Sprint 4 promotion surface. It does not consume the legacy
 * producer-side `reconciliation.passed` boolean: it verifies the separately
 * signed plan, receipt, and review before emitting staged RECONCILED state.
 */
export const compileReconciledStagedGenerationV1 = (
  producer: StagedProducerGenerationV1,
  plan: SignedSamplingPlanV1,
  receipt: SignedReconciliationReceiptV1,
  attempt: SamplingAttemptStateV1,
  review: IndependentReviewReceiptV1,
  verification: ReconciledStagedVerificationV1,
): Effect.Effect<
  ReconciledStagedGenerationV1,
  TruthDecodeError | TruthIntegrityError | TruthTrustError
> =>
  Effect.gen(function* () {
    const requiredWitnessForbiddenKeyIds = [
      verification.producerKeyId,
      verification.reconciler.key_id,
      verification.reviewer.key_id,
      ...verification.forbiddenAuthorityKeyIds.filter(
        (keyId) => keyId !== verification.randomnessWitness.key_id,
      ),
    ];
    const principalFields = [
      "service_id",
      "key_id",
      "process_id",
      "artifact_directory",
      "network_boundary",
    ] as const;
    if (
      new Set(verification.randomnessWitnessForbiddenKeyIds).size !==
        verification.randomnessWitnessForbiddenKeyIds.length ||
      verification.randomnessWitnessForbiddenKeyIds.includes(
        verification.randomnessWitness.key_id,
      ) ||
      !requiredWitnessForbiddenKeyIds.every((keyId) =>
        verification.randomnessWitnessForbiddenKeyIds.includes(keyId),
      ) ||
      ![
        verification.reconciler,
        verification.reviewer,
        plan.body.producer,
      ].every((principal) =>
        principalFields.every(
          (field) => principal[field] !== verification.randomnessWitness[field],
        ),
      ) ||
      !verifyRandomnessWitnessDirectorySeparationV1(
        verification.randomnessWitness,
        [verification.reconciler, plan.body.producer],
      )
    ) {
      return yield* Effect.fail(
        new TruthTrustError({
          boundary: "truth.reconciliation.randomness-separation",
          reason:
            "randomness witness overlaps producer, reconciler, reviewer, governance, recovery, or revocation authority",
        }),
      );
    }
    if (
      !verifySignedSamplingPlanV1(
        plan,
        verification.reconcilerPublicKeyHex,
        verification.reconciler,
        verification.randomnessBeacon,
        verification.randomnessWitness,
        verification.randomnessWitnessPublicKeyHex,
      )
    ) {
      return yield* Effect.fail(
        new TruthTrustError({
          boundary: "truth.reconciliation.plan",
          reason: "sampling plan is untrusted or not bound to the reconciler principal",
        }),
      );
    }
    if (
      verification.separationAttestation.attestation_hash !==
        plan.body.separation_attestation_hash ||
      verification.separationAttestation.body.environment !== plan.body.environment ||
      !verifyStagedReconcilerSeparationV1(
        verification.separationAttestation,
        verification.reconcilerPublicKeyHex,
        plan.body.producer,
        verification.reconciler,
        verification.forbiddenAuthorityKeyIds,
        verification.now,
      )
    ) {
      return yield* Effect.fail(
        new TruthTrustError({
          boundary: "truth.reconciliation.separation",
          reason: "staged reconciler separation attestation is absent or invalid",
        }),
      );
    }
    if (
      producer.root.root_hash !== plan.body.bundle_root_hash ||
      producer.root.unsigned_root.environment !== plan.body.environment ||
      String(producer.root.unsigned_root.generation) !== plan.body.generation
    ) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.reconciliation.producer-binding",
          reason: "sampling plan does not bind the producer generation",
        }),
      );
    }
    const identityRef = producer.root.unsigned_root.objects.find(
      (ref) => ref.kind === "identity_snapshot",
    );
    if (identityRef?.sha256 !== plan.body.identity_snapshot_hash) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.reconciliation.identity-binding",
          reason: "sampling plan does not bind the producer identity",
        }),
      );
    }
    const statisticalPolicyRef = producer.root.unsigned_root.objects.find(
      (ref) => ref.kind === "statistical_policy",
    );
    const statisticalPolicy = producer.closure.find(
      (object) => object.ref.kind === "statistical_policy",
    );
    if (
      statisticalPolicyRef?.sha256 !== plan.body.statistical_policy_hash ||
      statisticalPolicy === undefined ||
      statisticalPolicy.ref.sha256 !== statisticalPolicyRef.sha256 ||
      !verifyStatisticalPolicyObjectV1(
        statisticalPolicy.value,
        statisticalPolicyRef.sha256,
      )
    ) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.reconciliation.statistical-policy-binding",
          reason: "sampling plan does not bind the signed statistical policy",
        }),
      );
    }
    const authorizedScopeDigest = Reflect.get(
      statisticalPolicy.value as object,
      "authorized_sampling_scope_digest",
    );
    if (
      authorizedScopeDigest !==
      samplingUniverseAuthorizationDigestV1({
        producer_snapshot_id: plan.body.producer_snapshot_id,
        universe_digest: plan.body.universe_digest,
        universe_size: plan.body.universe_size,
        mandatory_stratum_count: plan.body.mandatory_stratum_count,
        strata: plan.body.strata,
      })
    ) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.reconciliation.population-authorization",
          reason:
            "sampling universe is not authorized by the producer-signed statistical policy",
        }),
      );
    }
    const servingPolicyRef = producer.root.unsigned_root.objects.find(
      (ref) => ref.kind === "serving_policy",
    );
    const servingPolicy = producer.closure.find(
      (object) => object.ref.kind === "serving_policy",
    );
    if (
      servingPolicyRef === undefined ||
      servingPolicy === undefined ||
      servingPolicy.ref.sha256 !== servingPolicyRef.sha256 ||
      !verifyServingPolicyObjectV1(
        servingPolicy.value,
        servingPolicyRef.sha256,
        producer.root.unsigned_root.environment,
      )
    ) {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.reconciliation.serving-policy-binding",
          reason: "reconciled generation does not bind the frozen serving policy",
        }),
      );
    }
    const readiness = yield* verifyTruthReadinessEnvelope(producer.readiness, {
      expectedEnvironment: producer.root.unsigned_root.environment,
      expectedKeyId: verification.producerKeyId,
      publicKeyHex: verification.producerPublicKeyHex,
      expectedValidityClass: producer.validity_class,
      expectedBundleHash: producer.root.root_hash as never,
      expectedBundleGeneration: String(producer.root.unsigned_root.generation),
      now: verification.now,
    });
    if (readiness.unsigned_envelope.decision.state !== "READY") {
      return yield* Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.reconciliation.readiness",
          reason: "producer readiness is not READY",
        }),
      );
    }
    if (
      String(readiness.unsigned_envelope.invalidation_epoch) !==
      plan.body.invalidation_epoch
    ) {
      return yield* Effect.fail(
        new TruthTrustError({
          boundary: "truth.reconciliation.readiness-epoch",
          reason: "producer readiness does not match reconciliation invalidation epoch",
        }),
      );
    }
    if (
      !verifyReconciliationReceiptV1(
        receipt,
        plan,
        attempt,
        verification.reconcilerPublicKeyHex,
        verification.now,
      ) ||
      receipt.body.decision !== "RECONCILED_STAGED"
    ) {
      return yield* Effect.fail(
        new TruthTrustError({
          boundary: "truth.reconciliation.receipt",
          reason: "reconciliation receipt is untrusted or did not pass",
        }),
      );
    }
    if (
      review.verdict !== "APPROVED" ||
      !verifyIndependentReviewReceiptV1(
        review,
        receipt,
        verification.reconciler,
        plan.body.producer,
        verification.reviewer,
        verification.reviewerPublicKeyHex,
        verification.now,
      )
    ) {
      return yield* Effect.fail(
        new TruthTrustError({
          boundary: "truth.reconciliation.review",
          reason: "independent reconciliation review is absent or untrusted",
        }),
      );
    }
    return {
      validity_class: "STAGED_VALID",
      lifecycle: "RECONCILED",
      display_state: "RECONCILED_STAGED",
      authority_validity: "STAGED_VALID",
      production_authority: false,
      environment: producer.root.unsigned_root.environment,
      generation: String(producer.root.unsigned_root.generation),
      invalidation_epoch: plan.body.invalidation_epoch,
      producer_root_hash: producer.root.root_hash,
      identity_snapshot_hash: plan.body.identity_snapshot_hash,
      statistical_policy_hash: plan.body.statistical_policy_hash,
      serving_policy_hash: servingPolicyRef.sha256,
      readiness_envelope_hash: readiness.envelope_hash,
      sampling_plan_hash: sha256Hex(jcsCanonicalize(plan)),
      reconciliation_receipt_hash: sha256Hex(jcsCanonicalize(receipt)),
      independent_review_hash: sha256Hex(jcsCanonicalize(review)),
      expires_at: receipt.body.expires_at,
    };
  });
