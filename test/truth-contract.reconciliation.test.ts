import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  SamplingAttemptLedgerV1,
  advanceSamplingAttemptV1,
  calculateSamplingTargetV1,
  compileIndependentReviewReceiptV1,
  compileMiberaFixtureGeneration,
  compileReconciledStagedGenerationV1,
  compileReconciliationReceiptV1,
  compileSignedSamplingPlanV1,
  deriveSamplingNonceV1,
  deterministicSampleMembersV1,
  finalizeSamplingQueryV1,
  FROZEN_FOOTPRINT_POLICY_V1,
  SamplingRandomnessBeaconLedgerV1,
  samplingRandomnessRoundDigestV1,
  samplingPlanScopeDigestV1,
  verifyReconciliationReceiptV1,
  verifySignedSamplingPlanV1,
  verifyStagedReconcilerSeparationV1,
  type ReconciliationPrincipalV1,
  type SignedSamplingRandomnessBeaconV1,
  type SignedStagedReconcilerSeparationV1,
} from "../src/truth-contract/index.js";
import {
  fixtureSigners,
  jcsCanonicalize,
  LocalEd25519TrustSigner,
  sha256Hex,
} from "../src/collection-resolver/trust-protocol.js";

const signers = fixtureSigners();
const producerSigner = signers.sonarPrimary;
const reconcilerSigner = signers.sonarRotated;
const reviewerSigner = LocalEd25519TrustSigner.fromSeedHex(
  "44".repeat(32),
  "sonar-fixture-reviewer",
);
const randomnessWitnessSigner = LocalEd25519TrustSigner.fromSeedHex(
  "66".repeat(32),
  "sonar-fixture-randomness-witness",
);
const forbiddenAuthorityKeyIds = [
  reviewerSigner.keyId,
  randomnessWitnessSigner.keyId,
  signers.orderingReplay.keyId,
] as const;
const randomnessWitnessForbiddenKeyIds = [
  producerSigner.keyId,
  reconcilerSigner.keyId,
  reviewerSigner.keyId,
  signers.orderingReplay.keyId,
] as const;
const now = "2026-07-19T06:00:00.000Z";
const expires = "2026-07-19T06:30:00.000Z";
const retryDeadline = "2026-07-19T06:10:00.000Z";
const digest = (value: string) => sha256Hex(`sprint-4:${value}`);
const producer = {
  service_id: "sonar-producer",
  key_id: producerSigner.keyId,
  process_id: "producer-process-100",
  artifact_directory: "/var/lib/sonar-producer",
  network_boundary: "producer-vpc",
} as const;
const reconciler = {
  service_id: "sonar-staged-reconciler",
  key_id: reconcilerSigner.keyId,
  process_id: "reconciler-process-200",
  artifact_directory: "/var/lib/sonar-reconciler",
  network_boundary: "reconciler-vpc",
} as const;
const reviewer = {
  service_id: "sonar-staged-reviewer",
  key_id: reviewerSigner.keyId,
  process_id: "reviewer-process-300",
  artifact_directory: "/var/lib/sonar-reviewer",
  network_boundary: "reviewer-vpc",
} as const;
const randomnessWitnessArtifactDirectory = mkdtempSync(
  join(tmpdir(), "sonar-randomness-witness-"),
);
const randomnessWitness = {
  service_id: "sonar-randomness-witness",
  key_id: randomnessWitnessSigner.keyId,
  process_id: "randomness-witness-process-400",
  artifact_directory: randomnessWitnessArtifactDirectory,
  network_boundary: "randomness-witness-vpc",
} as const;
const randomnessWitnessLedger = new SamplingRandomnessBeaconLedgerV1(
  randomnessWitness,
);
let samplingPlanSequence = 0;

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
    contract: "0x6666397dfe9a8c469bf65dc744cb1c733416c420",
    event_kind: "mibera.erc721.transfer",
    semantic_leg: "DIRECT_TRANSFER",
    population: String(ordinaryMembers.length),
    universe_members_digest: sha256Hex(jcsCanonicalize(ordinaryMembers)),
    high_risk: false,
    empty_proof_hash: null,
  },
  {
    stratum_id: "mibera.transfer.staking",
    contract: "0x6666397dfe9a8c469bf65dc744cb1c733416c420",
    event_kind: "mibera.erc721.transfer",
    semantic_leg: "STAKING_INGRESS",
    population: String(highRiskMembers.length),
    universe_members_digest: sha256Hex(jcsCanonicalize(highRiskMembers)),
    high_risk: true,
    empty_proof_hash: null,
  },
] as const;

const randomnessBeaconsByCommitment = new Map<
  string,
  SignedSamplingRandomnessBeaconV1
>();

const compilePlan = (
  bundleRootHash = digest(`bundle-${samplingPlanSequence + 1}`),
  identityHash = digest("identity"),
  separationAttestationHash = digest("separate-process-directory-network"),
  planReconciler: ReconciliationPrincipalV1 = reconciler,
  planProducer: ReconciliationPrincipalV1 = producer,
  statisticalPolicyHash = digest("statistical-policy"),
) => {
  samplingPlanSequence += 1;
  const committedAt = new Date(
    Date.parse(now) - 30_000 + samplingPlanSequence,
  ).toISOString();
  const input = {
      schema_version: 1,
      environment: "development",
      generation: "1",
      invalidation_epoch: "0",
      bundle_root_hash: bundleRootHash,
      identity_snapshot_hash: identityHash,
      producer_snapshot_id: "mibera-fixture-snapshot-1",
      universe_digest: sha256Hex(jcsCanonicalize(partition)),
      universe_size: String(partition.length),
      mandatory_stratum_count: String(strata.length),
      universe_partition: partition,
      strata,
      query_digest: digest("query"),
      parameter_digest: digest("parameters"),
      adapter_digest: digest("adapter"),
      statistical_policy_hash: statisticalPolicyHash,
      selection_algorithm_version: "hypergeometric-sha256-order.v1",
      reconciler: planReconciler,
      producer: planProducer,
      separation_attestation_hash: separationAttestationHash,
      committed_at: committedAt,
    } as const;
  const beacon = randomnessWitnessLedger.issue(
    {
      environment: input.environment,
      generation: input.generation,
      round_digest: samplingRandomnessRoundDigestV1(input),
      scope_digest: samplingPlanScopeDigestV1(input),
      issued_at: committedAt,
      witness: randomnessWitness,
    },
    randomnessWitnessSigner,
  );
  const plan = compileSignedSamplingPlanV1(
    input,
    beacon,
    randomnessWitnessSigner.publicKeyHex(),
    reconcilerSigner,
  );
  randomnessBeaconsByCommitment.set(plan.nonce_commitment, beacon);
  return plan;
};

const beaconFor = (
  plan: ReturnType<typeof compilePlan>,
): SignedSamplingRandomnessBeaconV1 => {
  const beacon = randomnessBeaconsByCommitment.get(plan.nonce_commitment);
  if (beacon === undefined) {
    throw new Error("missing randomness beacon for sampling plan");
  }
  return beacon;
};

const nonceFor = (plan: ReturnType<typeof compilePlan>) =>
  deriveSamplingNonceV1(
    plan.body.randomness_scope_digest,
    beaconFor(plan).beacon_value,
  );

const selectedFor = (plan: ReturnType<typeof compilePlan>) =>
  Object.fromEntries(
    plan.body.targets.map((target) => {
      const members =
        target.stratum_id === "mibera.transfer.direct"
          ? ordinaryMembers
          : highRiskMembers;
      return [
        target.stratum_id,
        deterministicSampleMembersV1(
          members,
          Number(target.target),
          nonceFor(plan),
          target.stratum_id,
        ),
      ];
    }),
  );

const revealedAttemptFor = (
  plan: ReturnType<typeof compilePlan>,
  ledgerDirectory = mkdtempSync(join(tmpdir(), "sonar-attempt-ledger-")),
) => {
  const nonce = nonceFor(plan);
  const ledger = new SamplingAttemptLedgerV1(ledgerDirectory);
  let attempt = ledger.commit(plan, now, reconcilerSigner);
  attempt = finalizeSamplingQueryV1(
    attempt,
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
      source_snapshot_hash: digest("same-snapshot"),
      projection_snapshot_hash: digest("same-snapshot"),
      finalized_at: now,
    },
    plan.body.reconciler,
    reconcilerSigner,
  );
  ledger.replace(attempt);
  attempt = advanceSamplingAttemptV1(
    attempt,
    "NONCE_REVEALED",
    sha256Hex(nonce),
    now,
    plan.body.reconciler,
    reconcilerSigner,
    nonce,
  );
  ledger.replace(attempt);
  return attempt;
};

const passingObservations = (selected: Record<string, readonly string[]>) =>
  Object.entries(selected).flatMap(([stratum_id, members]) =>
    members.map((member_id) => ({
      stratum_id,
      member_id,
      observed: true,
      semantic_match: true,
      identity_match: true,
      provenance_complete: true,
    })),
  );
const passingFootprints = FROZEN_FOOTPRINT_POLICY_V1.map((policy, index) => ({
  ...policy,
  source_count: String(10_000 + index),
  projection_count: String(10_000 + index),
}));

describe("Sprint 4 committed reconciliation", () => {
  it("freezes exact rational hypergeometric targets and never uses n=300 globally", () => {
    const golden = JSON.parse(
      readFileSync(
        "test/fixtures/truth-contract/statistical-policy-v1-golden.json",
        "utf8",
      ),
    ) as { vectors: Array<Record<string, unknown>> };
    const ordinary = calculateSamplingTargetV1(strata[0], 2);
    const highRisk = calculateSamplingTargetV1(strata[1], 2);
    expect(ordinary).toEqual({
      stratum_id: "mibera.transfer.direct",
      population: "1000",
      target: "284",
      mode: "SAMPLE",
      alpha_ppm: "25000",
      achieved_power_ppm: "999999",
      reason: "POWERED_SAMPLE",
    });
    expect(highRisk).toMatchObject({
      target: "5",
      mode: "CENSUS",
      reason: "HIGH_RISK_CENSUS",
    });
    expect(calculateSamplingTargetV1({ ...strata[0], population: "1" }, 1)).toMatchObject({
      target: "1",
      mode: "CENSUS",
      reason: "UNDERSIZED_CENSUS",
    });
    expect([ordinary, highRisk]).toEqual(
      golden.vectors.slice(0, 2).map(
        ({ population, mandatory_strata: _mandatory, high_risk: _risk, ...vector }) => ({
          stratum_id:
            vector.mode === "SAMPLE"
              ? "mibera.transfer.direct"
              : "mibera.transfer.staking",
          population,
          ...vector,
        }),
      ),
    );
    for (const vector of golden.vectors as Array<{
      population: string;
      mandatory_strata: number;
      high_risk: boolean;
      target: string;
      mode: "SAMPLE" | "CENSUS";
      alpha_ppm: string;
      achieved_power_ppm: string;
      reason: string;
    }>) {
      const actual = calculateSamplingTargetV1(
        {
          ...strata[0],
          stratum_id: `golden-${vector.population}-${vector.mandatory_strata}`,
          population: vector.population,
          semantic_leg: vector.high_risk
            ? "STAKING_INGRESS"
            : "DIRECT_TRANSFER",
          high_risk: vector.high_risk,
        },
        vector.mandatory_strata,
      );
      expect({
        target: actual.target,
        mode: actual.mode,
        alpha_ppm: actual.alpha_ppm,
        achieved_power_ppm: actual.achieved_power_ppm,
        reason: actual.reason,
      }).toEqual({
        target: vector.target,
        mode: vector.mode,
        alpha_ppm: vector.alpha_ppm,
        achieved_power_ppm: vector.achieved_power_ppm,
        reason: vector.reason,
      });
    }
  });

  it("binds the complete partition, signer, immutable plan, and ordered reveal", () => {
    const plan = compilePlan();
    const nonce = nonceFor(plan);
    const symlinkTarget = mkdtempSync(
      join(tmpdir(), "sonar-randomness-symlink-target-"),
    );
    const symlinkPath = `${symlinkTarget}-alias`;
    symlinkSync(symlinkTarget, symlinkPath);
    expect(
      () =>
        new SamplingRandomnessBeaconLedgerV1({
          ...randomnessWitness,
          artifact_directory: symlinkPath,
        }),
    ).toThrow(/not a real directory/);
    rmSync(symlinkPath);
    rmSync(symlinkTarget, { recursive: true, force: true });
    const journalParent = mkdtempSync(
      join(tmpdir(), "sonar-randomness-journal-parent-"),
    );
    const journalTarget = mkdtempSync(
      join(tmpdir(), "sonar-randomness-journal-target-"),
    );
    symlinkSync(journalTarget, join(journalParent, "beacons-v1"));
    expect(
      () =>
        new SamplingRandomnessBeaconLedgerV1({
          ...randomnessWitness,
          artifact_directory: journalParent,
        }),
    ).toThrow(/journal is not a real directory/);
    rmSync(journalParent, { recursive: true, force: true });
    rmSync(journalTarget, { recursive: true, force: true });
    expect(
      verifySignedSamplingPlanV1(
        plan,
        reconcilerSigner.publicKeyHex(),
        reconciler,
        beaconFor(plan),
        randomnessWitness,
        randomnessWitnessSigner.publicKeyHex(),
      ),
    ).toBe(true);
    const beacon = beaconFor(plan);
    expect(
      samplingRandomnessRoundDigestV1({
        ...plan.body,
        producer_snapshot_id: "reconciler-selected-alternate-snapshot",
        universe_digest: digest("reconciler-selected-alternate-universe"),
      }),
    ).toBe(beacon.round_digest);
    expect(
      samplingPlanScopeDigestV1({
        ...plan.body,
        producer_snapshot_id: "reconciler-selected-alternate-snapshot",
        universe_digest: digest("reconciler-selected-alternate-universe"),
      }),
    ).toBe(beacon.round_digest);
    const restartedWitnessLedger = new SamplingRandomnessBeaconLedgerV1(
      randomnessWitness,
    );
    expect(restartedWitnessLedger.read(beacon.round_digest)).toEqual(beacon);
    expect(() =>
      restartedWitnessLedger.issue(
        {
          environment: beacon.environment,
          generation: beacon.generation,
          round_digest: beacon.round_digest,
          scope_digest: beacon.scope_digest,
          issued_at: beacon.issued_at,
          witness: randomnessWitness,
        },
        randomnessWitnessSigner,
      ),
    ).toThrow(/round already has an issued beacon/);
    rmSync(
      join(
        randomnessWitness.artifact_directory,
        "beacons-v1",
        `${beacon.round_digest}.json`,
      ),
    );
    expect(() =>
      restartedWitnessLedger.issue(
        {
          environment: beacon.environment,
          generation: beacon.generation,
          round_digest: beacon.round_digest,
          scope_digest: digest("alternate-plan-scope"),
          issued_at: beacon.issued_at,
          witness: randomnessWitness,
        },
        randomnessWitnessSigner,
      ),
    ).toThrow(/scope must equal the producer-authorized round/);
    const rollbackReissue = restartedWitnessLedger.issue(
      {
        environment: beacon.environment,
        generation: beacon.generation,
        round_digest: beacon.round_digest,
        scope_digest: beacon.scope_digest,
        issued_at: beacon.issued_at,
        witness: randomnessWitness,
      },
      randomnessWitnessSigner,
    );
    expect(rollbackReissue).toEqual(beacon);
    expect(() =>
      restartedWitnessLedger.issue(
        {
          environment: beacon.environment,
          generation: beacon.generation,
          round_digest: beacon.round_digest,
          scope_digest: digest("alternate-plan-scope"),
          issued_at: beacon.issued_at,
          witness: randomnessWitness,
        },
        randomnessWitnessSigner,
      ),
    ).toThrow(/scope must equal the producer-authorized round/);
    expect(() =>
      compileSignedSamplingPlanV1(
        { ...plan.body, producer, targets: undefined, policy: undefined } as never,
        beaconFor(plan),
        randomnessWitnessSigner.publicKeyHex(),
        producerSigner,
      ),
    ).toThrow(/reconciler signer key mismatch/);

    const mutated = structuredClone(plan);
    mutated.body.query_digest = digest("mutated-query");
    expect(
      verifySignedSamplingPlanV1(
        mutated,
        reconcilerSigner.publicKeyHex(),
        reconciler,
        beaconFor(plan),
        randomnessWitness,
        randomnessWitnessSigner.publicKeyHex(),
      ),
    ).toBe(false);
    const mutatedBeacon = structuredClone(beaconFor(plan));
    mutatedBeacon.beacon_value = digest("reconciler-chosen-randomness");
    expect(
      verifySignedSamplingPlanV1(
        plan,
        reconcilerSigner.publicKeyHex(),
        reconciler,
        mutatedBeacon,
        randomnessWitness,
        randomnessWitnessSigner.publicKeyHex(),
      ),
    ).toBe(false);

    const ledgerDirectory = mkdtempSync(join(tmpdir(), "sonar-attempt-ledger-"));
    const ledger = new SamplingAttemptLedgerV1(ledgerDirectory);
    let attempt = ledger.commit(plan, now, reconcilerSigner);
    expect(() => ledger.commit(plan, now, reconcilerSigner)).toThrow(
      /already has a committed plan/,
    );
    const restartedLedger = new SamplingAttemptLedgerV1(ledgerDirectory);
    expect(() =>
      restartedLedger.commit(plan, now, reconcilerSigner),
    ).toThrow(/already has a committed plan/);
    expect(restartedLedger.read(plan)?.plan_hash).toBe(attempt.plan_hash);
    attempt = finalizeSamplingQueryV1(
      attempt,
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
        source_snapshot_hash: digest("same-snapshot"),
        projection_snapshot_hash: digest("same-snapshot"),
        finalized_at: now,
      },
      reconciler,
      reconcilerSigner,
    );
    expect(() =>
      advanceSamplingAttemptV1(
        attempt,
        "RECEIPT_PUBLISHED",
        digest("skip-reveal"),
        now,
        reconciler,
        reconcilerSigner,
      ),
    ).toThrow(/expected NONCE_REVEALED/);
    attempt = advanceSamplingAttemptV1(
      attempt,
      "NONCE_REVEALED",
      sha256Hex(nonce),
      now,
      reconciler,
      reconcilerSigner,
      nonce,
    );
    expect(attempt.events.map((event) => event.kind)).toEqual([
      "PLAN_COMMITTED",
      "QUERY_FINALIZED",
      "NONCE_REVEALED",
    ]);
  });

  it("passes only complete strata and terminates mismatch or missing-census paths", () => {
    const plan = compilePlan();
    const nonce = nonceFor(plan);
    const selected = selectedFor(plan);
    const observations = passingObservations(selected);
    const attempt = revealedAttemptFor(plan);
    const passingPublication = compileReconciliationReceiptV1(
      {
        plan,
        attempt,
        nonce,
        source_snapshot_hash: digest("same-snapshot"),
        projection_snapshot_hash: digest("same-snapshot"),
        selected_members: selected,
        observations,
        census_members: {
          "mibera.transfer.staking": highRiskMembers,
        },
        footprint_counts: passingFootprints,
        retry_owner: "sonar-reconciliation-owner",
        retry_deadline: retryDeadline,
        observed_at: now,
        expires_at: expires,
      },
      reconcilerSigner,
    );
    const passing = passingPublication.receipt;
    const completedAttempt = passingPublication.completed_attempt;
    expect(passing.body.decision).toBe("RECONCILED_STAGED");
    expect(passing.body.authority_valid).toBe(false);
    expect(
      verifyReconciliationReceiptV1(
        passing,
        plan,
        completedAttempt,
        reconcilerSigner.publicKeyHex(),
        now,
      ),
    ).toBe(true);
    const receiptMutations: Array<(candidate: typeof passing) => void> = [
      (candidate) => {
        candidate.body.generation = "2";
      },
      (candidate) => {
        candidate.body.bundle_root_hash = digest("other-bundle");
      },
      (candidate) => {
        candidate.body.identity_snapshot_hash = digest("other-identity");
      },
      (candidate) => {
        candidate.body.nonce_commitment = digest("other-commitment");
      },
      (candidate) => {
        candidate.body.universe_digest = digest("other-universe");
      },
      (candidate) => {
        candidate.body.source_snapshot_hash = digest("other-snapshot");
      },
      (candidate) => {
        candidate.body.query_digest = digest("other-query");
      },
      (candidate) => {
        candidate.body.adapter_digest = digest("other-adapter");
      },
      (candidate) => {
        candidate.body.expires_at = "2026-07-19T06:31:00.000Z";
      },
    ];
    for (const mutate of receiptMutations) {
      const candidate = structuredClone(passing);
      mutate(candidate);
      expect(
        verifyReconciliationReceiptV1(
          candidate,
          plan,
          completedAttempt,
          reconcilerSigner.publicKeyHex(),
          now,
        ),
      ).toBe(false);
    }

    const mismatch = structuredClone(observations);
    mismatch[0]!.semantic_match = false;
    const failed = compileReconciliationReceiptV1(
      {
        plan,
        attempt,
        nonce,
        source_snapshot_hash: digest("same-snapshot"),
        projection_snapshot_hash: digest("same-snapshot"),
        selected_members: selected,
        observations: mismatch,
        census_members: {},
        footprint_counts: passingFootprints,
        retry_owner: "sonar-reconciliation-owner",
        retry_deadline: retryDeadline,
        observed_at: now,
        expires_at: expires,
      },
      reconcilerSigner,
    );
    expect(failed.receipt.body.decision).toBe("NOT_READY");
    expect(failed.receipt.body.retry_owner).toBe("sonar-reconciliation-owner");

    const missingHighRisk = compileReconciliationReceiptV1(
      {
        plan,
        attempt,
        nonce,
        source_snapshot_hash: digest("same-snapshot"),
        projection_snapshot_hash: digest("same-snapshot"),
        selected_members: selected,
        observations: observations.filter(
          (observation) => observation.stratum_id !== "mibera.transfer.staking",
        ),
        census_members: {},
        footprint_counts: passingFootprints,
        retry_owner: "sonar-reconciliation-owner",
        retry_deadline: retryDeadline,
        observed_at: now,
        expires_at: expires,
      },
      reconcilerSigner,
    );
    expect(missingHighRisk.receipt.body.decision).toBe("UNKNOWN");
    expect(() =>
      compileReconciliationReceiptV1(
        {
          plan,
          attempt,
          nonce,
          source_snapshot_hash: digest("same-snapshot"),
          projection_snapshot_hash: digest("same-snapshot"),
          selected_members: {
            ...selected,
            "mibera.transfer.direct": [],
          },
          observations,
          census_members: { "mibera.transfer.staking": highRiskMembers },
          footprint_counts: passingFootprints,
          retry_owner: "sonar-reconciliation-owner",
          retry_deadline: retryDeadline,
          observed_at: now,
          expires_at: expires,
        },
        reconcilerSigner,
      ),
    ).toThrow(/deterministic sample/);
    expect(() =>
      compileReconciliationReceiptV1(
        {
          plan,
          attempt,
          nonce,
          source_snapshot_hash: digest("same-snapshot"),
          projection_snapshot_hash: digest("same-snapshot"),
          selected_members: selected,
          observations,
          census_members: {
            "mibera.transfer.staking": Array(highRiskMembers.length).fill(
              highRiskMembers[0],
            ),
          },
          footprint_counts: passingFootprints,
          retry_owner: "sonar-reconciliation-owner",
          retry_deadline: retryDeadline,
          observed_at: now,
          expires_at: expires,
        },
        reconcilerSigner,
      ),
    ).toThrow(/duplicate members/);
    const countBreach = compileReconciliationReceiptV1(
      {
        plan,
        attempt,
        nonce,
        source_snapshot_hash: digest("same-snapshot"),
        projection_snapshot_hash: digest("same-snapshot"),
        selected_members: selected,
        observations,
        census_members: { "mibera.transfer.staking": highRiskMembers },
        footprint_counts: passingFootprints.map((count) =>
          count.entity === "NftBurn"
            ? {
                ...count,
                source_count: "1",
                projection_count: "0",
              }
            : count,
        ),
        retry_owner: "sonar-reconciliation-owner",
        retry_deadline: retryDeadline,
        observed_at: now,
        expires_at: expires,
      },
      reconcilerSigner,
    );
    expect(countBreach.receipt.body.decision).toBe("CENSUS_REQUIRED");
    expect(() =>
      compileReconciliationReceiptV1(
        {
          ...{
            plan,
            attempt,
            nonce,
            source_snapshot_hash: digest("same-snapshot"),
            projection_snapshot_hash: digest("same-snapshot"),
            selected_members: selected,
            observations,
            census_members: { "mibera.transfer.staking": highRiskMembers },
            retry_owner: "sonar-reconciliation-owner",
            retry_deadline: retryDeadline,
            observed_at: now,
            expires_at: expires,
          },
          footprint_counts: passingFootprints.map((count) =>
            count.entity === "MiberaTransfer"
              ? { ...count, absolute_floor: "100" }
              : count,
          ),
        },
        reconcilerSigner,
      ),
    ).toThrow(/footprint policy drift/);
  });

  it("reaches only staged RECONCILED through producer, receipt, and independent review", () => {
    const root = mkdtempSync(join(tmpdir(), "sonar-reconciler-boundary-"));
    const producerDirectory = join(root, "producer");
    const reconcilerDirectory = join(root, "reconciler");
    mkdirSync(producerDirectory, { mode: 0o700 });
    mkdirSync(reconcilerDirectory, { mode: 0o700 });
    chmodSync(producerDirectory, 0o700);
    chmodSync(reconcilerDirectory, 0o700);
    const harness = spawnSync(
      "pnpm",
      [
        "exec",
        "tsx",
        "scripts/staged-reconciler-harness.ts",
        "--producer-pid",
        String(process.pid),
        "--producer-process-id",
        `pid-${process.pid}`,
        "--producer-directory",
        producerDirectory,
        "--reconciler-directory",
        reconcilerDirectory,
        "--launched-at",
        now,
        "--expires-at",
        expires,
        "--reviewer-key-id",
        reviewerSigner.keyId,
        "--randomness-witness-key-id",
        randomnessWitnessSigner.keyId,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(harness.status, harness.stderr).toBe(0);
    const separation = JSON.parse(
      harness.stdout.trim(),
    ) as SignedStagedReconcilerSeparationV1;
    expect(separation.body.reconciler_pid).not.toBe(String(process.pid));
    expect(
      verifyStagedReconcilerSeparationV1(
        separation,
        reconcilerSigner.publicKeyHex(),
        separation.body.producer,
        separation.body.reconciler,
        forbiddenAuthorityKeyIds,
        now,
      ),
    ).toBe(true);
    const denominatorBytes = Uint8Array.from(
      readFileSync("test/fixtures/truth-contract/mibera-transfer-denominator-v1.json"),
    );
    const produced = Effect.runSync(
      compileMiberaFixtureGeneration({ denominatorBytes, now }, producerSigner),
    );
    const identityHash = produced.root.unsigned_root.objects.find(
      (ref) => ref.kind === "identity_snapshot",
    )!.sha256;
    const statisticalPolicyHash = produced.root.unsigned_root.objects.find(
      (ref) => ref.kind === "statistical_policy",
    )!.sha256;
    const plan = compilePlan(
      produced.root.root_hash,
      identityHash,
      separation.attestation_hash,
      separation.body.reconciler,
      separation.body.producer,
      statisticalPolicyHash,
    );
    const nonce = nonceFor(plan);
    const selected = selectedFor(plan);
    const ledgerDirectory = join(reconcilerDirectory, "attempt-ledger");
    const attempt = revealedAttemptFor(plan, ledgerDirectory);
    const publication = compileReconciliationReceiptV1(
      {
        plan,
        attempt,
        nonce,
        source_snapshot_hash: digest("same-snapshot"),
        projection_snapshot_hash: digest("same-snapshot"),
        selected_members: selected,
        observations: passingObservations(selected),
        census_members: { "mibera.transfer.staking": highRiskMembers },
        footprint_counts: passingFootprints,
        retry_owner: "sonar-reconciliation-owner",
        retry_deadline: retryDeadline,
        observed_at: now,
        expires_at: expires,
      },
      reconcilerSigner,
    );
    const receipt = publication.receipt;
    const completedAttempt = publication.completed_attempt;
    const restartedLedger = new SamplingAttemptLedgerV1(ledgerDirectory);
    restartedLedger.replace(completedAttempt);
    expect(restartedLedger.read(plan)?.events.map((event) => event.kind)).toEqual([
      "PLAN_COMMITTED",
      "QUERY_FINALIZED",
      "NONCE_REVEALED",
      "RECEIPT_PUBLISHED",
    ]);
    const review = compileIndependentReviewReceiptV1(
      receipt,
      reviewer,
      separation.body.reconciler,
      separation.body.producer,
      now,
      "APPROVED",
      reviewerSigner,
    );
    const reconciled = Effect.runSync(
      compileReconciledStagedGenerationV1(
        produced,
        plan,
        receipt,
        completedAttempt,
        review,
        {
        producerKeyId: producerSigner.keyId,
        producerPublicKeyHex: producerSigner.publicKeyHex(),
        reconciler: separation.body.reconciler,
        reconcilerPublicKeyHex: reconcilerSigner.publicKeyHex(),
        randomnessBeacon: beaconFor(plan),
        randomnessWitness,
        randomnessWitnessPublicKeyHex: randomnessWitnessSigner.publicKeyHex(),
        randomnessWitnessForbiddenKeyIds,
        reviewer,
        reviewerPublicKeyHex: reviewerSigner.publicKeyHex(),
        forbiddenAuthorityKeyIds,
        separationAttestation: separation,
        now,
        },
      ),
    );
    expect(reconciled).toMatchObject({
      validity_class: "STAGED_VALID",
      lifecycle: "RECONCILED",
      display_state: "RECONCILED_STAGED",
      authority_validity: "STAGED_VALID",
      production_authority: false,
    });
    expect(() =>
      Effect.runSync(
        compileReconciledStagedGenerationV1(
          produced,
          plan,
          receipt,
          completedAttempt,
          review,
          {
            producerKeyId: producerSigner.keyId,
            producerPublicKeyHex: producerSigner.publicKeyHex(),
            reconciler: separation.body.reconciler,
            reconcilerPublicKeyHex: reconcilerSigner.publicKeyHex(),
            randomnessBeacon: beaconFor(plan),
            randomnessWitness,
            randomnessWitnessPublicKeyHex:
              randomnessWitnessSigner.publicKeyHex(),
            randomnessWitnessForbiddenKeyIds: [],
            reviewer,
            reviewerPublicKeyHex: reviewerSigner.publicKeyHex(),
            forbiddenAuthorityKeyIds,
            separationAttestation: separation,
            now,
          },
        ),
      ),
    ).toThrow(/randomness witness overlaps/);
    rmSync(root, { recursive: true, force: true });
  });
});
