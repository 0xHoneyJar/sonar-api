import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  compileConsumedReceiptV1,
  compileNotConsumedReceiptV1,
  scoreAuthorityAnchorDigestV1,
  scoreAuthorityKeysetHashV1,
  scoreReceiptHashV1,
  type ScoreReceiptVerificationContextV1,
  verifyScoreAuthorityAnchorPinV1,
  verifyScoreConsumptionReceiptsV1,
} from "../src/truth-contract/consumption.js";
import {
  SCORE_AUTHORITY_ANCHOR_DOMAIN,
  SCORE_CONSUMED_RECEIPT_DOMAIN,
  ScoreAuthorityPolicyV1,
  type ScoreReceiptAuthorityKindV1,
  ScoreReceiptTargetV1,
  ScoreTrustedAuthorityAnchorV1,
  SONAR_NOT_CONSUMED_RECEIPT_DOMAIN,
} from "../src/truth-contract/schemas/consumption.js";
import {
  decodeStrict,
  DecimalUint64,
  PositiveDecimalUint64,
  type Sha256Digest,
  TruthIsoTimestamp,
} from "../src/truth-contract/schemas/common.js";
import {
  LocalEd25519TrustSigner,
  sha256Hex,
} from "../src/collection-resolver/trust-protocol.js";

const digest = (value: string) =>
  sha256Hex(`sprint-5:${value}`) as Sha256Digest;
const sonarA = LocalEd25519TrustSigner.fromSeedHex(
  "61".repeat(32),
  "sonar-handoff-authority-a",
);
const sonarB = LocalEd25519TrustSigner.fromSeedHex(
  "62".repeat(32),
  "sonar-handoff-authority-b",
);
const sonarC = LocalEd25519TrustSigner.fromSeedHex(
  "63".repeat(32),
  "sonar-handoff-authority-v2-a",
);
const sonarD = LocalEd25519TrustSigner.fromSeedHex(
  "64".repeat(32),
  "sonar-handoff-authority-v2-b",
);
const scoreA = LocalEd25519TrustSigner.fromSeedHex(
  "71".repeat(32),
  "score-authority-v1-a",
);
const scoreB = LocalEd25519TrustSigner.fromSeedHex(
  "72".repeat(32),
  "score-authority-v1-b",
);
const scoreC = LocalEd25519TrustSigner.fromSeedHex(
  "73".repeat(32),
  "score-authority-v2-a",
);
const scoreD = LocalEd25519TrustSigner.fromSeedHex(
  "74".repeat(32),
  "score-authority-v2-b",
);
const attackerScoreA = LocalEd25519TrustSigner.fromSeedHex(
  "75".repeat(32),
  "attacker-score-authority-a",
);
const attackerScoreB = LocalEd25519TrustSigner.fromSeedHex(
  "76".repeat(32),
  "attacker-score-authority-b",
);

const handoffAt = "2026-07-19T10:00:00.000Z";
const deadline = "2026-07-26T10:00:00.000Z";
const handoffReceiptHash = digest("sealed-e2e-handoff");

const target = Effect.runSync(
  decodeStrict(ScoreReceiptTargetV1, "test.score-target", {
    collection_id: "mibera",
    target_identity_hash: digest("identity"),
    producer_root_hash: digest("root"),
    producer_generation: "1",
    invalidation_epoch: "0",
    environment: "development",
  }),
);

const authority = (
  authorityKind: ScoreReceiptAuthorityKindV1,
  generation: string,
  signers: readonly LocalEd25519TrustSigner[],
  keyOverrides: Readonly<Record<string, Record<string, unknown>>> = {},
) => {
  const unsigned = {
    schema_version: 1,
    authority_kind: authorityKind,
    environment: "development",
    generation,
    keyset_hash: digest("placeholder"),
    threshold: "2",
    keys: signers.map((signer) => ({
      key_id: signer.keyId,
      public_key_hex: signer.publicKeyHex(),
      valid_from_sequence: "1",
      valid_through_sequence: null,
      compromised_from_sequence: null,
      ...keyOverrides[signer.keyId],
    })),
  };
  const provisional = Effect.runSync(
    decodeStrict(
      ScoreAuthorityPolicyV1,
      "test.score-authority-provisional",
      unsigned,
    ),
  );
  return Effect.runSync(
    decodeStrict(ScoreAuthorityPolicyV1, "test.score-authority", {
      ...unsigned,
      keyset_hash: scoreAuthorityKeysetHashV1(provisional),
    }),
  );
};

const sonarV1 = () => authority("SONAR_HANDOFF", "1", [sonarA, sonarB]);
const sonarV2 = () => authority("SONAR_HANDOFF", "2", [sonarC, sonarD]);
const scoreV1 = () => authority("SCORE_CONSUMER", "1", [scoreA, scoreB]);
const scoreV2 = (
  keyOverrides: Readonly<Record<string, Record<string, unknown>>> = {},
) => authority("SCORE_CONSUMER", "2", [scoreC, scoreD], keyOverrides);

const verificationContext = (
  receiptSequenceHighWater: "1" | "2" | "3",
  now: string,
  overrides: Partial<ScoreReceiptVerificationContextV1> = {},
): ScoreReceiptVerificationContextV1 => {
  const sonarPolicy = sonarV1();
  const scorePolicyV1 = scoreV1();
  const scorePolicyV2 = scoreV2();
  const base: ScoreReceiptVerificationContextV1 = {
    target,
    authorities: [sonarPolicy, scorePolicyV1, scorePolicyV2],
    authority_high_water: {
      SONAR_HANDOFF: sonarPolicy.generation,
      SCORE_CONSUMER: scorePolicyV2.generation,
    },
    revocation_high_water: Effect.runSync(
      decodeStrict(DecimalUint64, "test.revocation-high-water", "0"),
    ),
    receipt_sequence_high_water: Effect.runSync(
      decodeStrict(
        DecimalUint64,
        "test.receipt-sequence-high-water",
        receiptSequenceHighWater,
      ),
    ),
    handoff: {
      receipt_hash: handoffReceiptHash,
      sealed_at: Effect.runSync(
        decodeStrict(TruthIsoTimestamp, "test.handoff-sealed-at", handoffAt),
      ),
    },
    now: Effect.runSync(
      decodeStrict(TruthIsoTimestamp, "test.verification-now", now),
    ),
    ...overrides,
  };
  if (Object.hasOwn(overrides, "verified_anchor")) {
    return base;
  }
  const anchorGeneration = Effect.runSync(
    decodeStrict(
      PositiveDecimalUint64,
      "test.authority-anchor-generation",
      "7",
    ),
  );
  const material = {
    target: base.target,
    authorities: base.authorities,
    authority_high_water: base.authority_high_water,
    revocation_high_water: base.revocation_high_water,
    anchor_generation: anchorGeneration,
  };
  const exactPin = Effect.runSync(
    decodeStrict(
      ScoreTrustedAuthorityAnchorV1,
      "test.authority-anchor",
      {
        schema_version: 1,
        domain: SCORE_AUTHORITY_ANCHOR_DOMAIN,
        environment: base.target.environment,
        generation: anchorGeneration,
        digest: scoreAuthorityAnchorDigestV1(material),
      },
    ),
  );
  return {
    ...base,
    verified_anchor: Effect.runSync(
      verifyScoreAuthorityAnchorPinV1(material, exactPin),
    ),
  };
};

const notConsumedInput = (
  sequence = "1",
  issuedAt = handoffAt,
  priorReceiptHash: string | null = null,
) => ({
  _tag: "NotConsumedReceiptV1",
  schema_version: 1,
  domain: SONAR_NOT_CONSUMED_RECEIPT_DOMAIN,
  target,
  sequence,
  issued_at: issuedAt,
  producer_contract_version: "sonar-score-truth-contract/v1",
  consumer_contract_version: "score-consumption/v1",
  authority_kind: "SONAR_HANDOFF",
  authority_generation: "1",
  authority_keyset_hash: sonarV1().keyset_hash,
  revocation_sequence: "0",
  prior_receipt_hash: priorReceiptHash,
  owner: "bd-v54z.1",
  handoff_receipt_hash: handoffReceiptHash,
  handoff_sealed_at: handoffAt,
  deadline,
  expires_at: null,
  reason: "SCORE_IMPLEMENTATION_PENDING",
  supersedes_receipt_hash: null,
});

const compileStub = (
  sequence = "1",
  issuedAt = handoffAt,
  priorReceiptHash: string | null = null,
  signers = [sonarA, sonarB],
) =>
  Effect.runSync(
    compileNotConsumedReceiptV1(
      notConsumedInput(sequence, issuedAt, priorReceiptHash),
      signers,
    ),
  );

const consumedInput = (
  stubHash: string,
  overrides: Record<string, unknown> = {},
) => ({
  _tag: "ConsumedReceiptV1",
  schema_version: 1,
  domain: SCORE_CONSUMED_RECEIPT_DOMAIN,
  target,
  sequence: "2",
  issued_at: "2026-07-20T09:00:00.000Z",
  producer_contract_version: "sonar-score-truth-contract/v1",
  consumer_contract_version: "score-consumption/v1",
  authority_kind: "SCORE_CONSUMER",
  authority_generation: "2",
  authority_keyset_hash: scoreV2().keyset_hash,
  revocation_sequence: "0",
  prior_receipt_hash: stubHash,
  consumer_snapshot_hash: digest("score-snapshot"),
  projection_checkpoint_hash: digest("score-checkpoint"),
  assertion_set_hash: digest("score-assertions"),
  serving_query_hash: digest("score-serving-query"),
  compatibility_result: "COMPATIBLE",
  consumed_at: "2026-07-20T09:00:00.000Z",
  expires_at: "2026-07-27T09:00:00.000Z",
  supersedes_receipt_hash: stubHash,
  ...overrides,
});

const compileConsumed = (
  stubHash: string,
  overrides: Record<string, unknown> = {},
  signers = [scoreC, scoreD],
) =>
  Effect.runSync(
    compileConsumedReceiptV1(consumedInput(stubHash, overrides), signers),
  );

describe("Sprint 5 Score consumption receipt seam", () => {
  it("keeps NotConsumed non-expiring with the sealed-E2E +7 day SLA", () => {
    const stub = compileStub();
    expect(stub.body).toMatchObject({
      owner: "bd-v54z.1",
      expires_at: null,
      handoff_receipt_hash: handoffReceiptHash,
      deadline,
    });
    expect(
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub],
          verificationContext("1", "2026-07-26T09:59:59.999Z"),
        ),
      ),
    ).toMatchObject({ _tag: "NOT_CONSUMED", owner: "bd-v54z.1", deadline });
    expect(
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub],
          verificationContext("1", "2026-07-26T10:00:00.001Z"),
        ),
      ),
    ).toMatchObject({
      _tag: "NOT_CONSUMED_OVERDUE",
      owner: "bd-v54z.1",
      deadline,
    });
  });

  it("rejects deadline, pre-handoff issuance, and exact producer-binding drift", () => {
    expect(() =>
      Effect.runSync(
        compileNotConsumedReceiptV1(
          {
            ...notConsumedInput(),
            deadline: "2026-07-26T09:59:59.999Z",
          },
          [sonarA, sonarB],
        ),
      ),
    ).toThrow(/exactly seven days/);
    expect(() =>
      Effect.runSync(
        compileNotConsumedReceiptV1(
          {
            ...notConsumedInput(),
            issued_at: "2026-07-19T09:59:59.999Z",
          },
          [sonarA, sonarB],
        ),
      ),
    ).toThrow(/precedes its sealed handoff/);

    const stub = compileStub();
    const wrongTarget = Effect.runSync(
      decodeStrict(ScoreReceiptTargetV1, "test.wrong-target", {
        ...target,
        producer_root_hash: digest("wrong-root"),
      }),
    );
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub],
          verificationContext("1", handoffAt, { target: wrongTarget }),
        ),
      ),
    ).toThrow(/target identity or producer binding mismatch/);
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub],
          verificationContext("1", handoffAt, {
            handoff: {
              receipt_hash: digest("wrong-handoff"),
              sealed_at: Effect.runSync(
                decodeStrict(
                  TruthIsoTimestamp,
                  "test.wrong-handoff-sealed-at",
                  handoffAt,
                ),
              ),
            },
          }),
        ),
      ),
    ).toThrow(/sealed Sonar handoff/);
  });

  it("uses distinct domains and Sonar/Score 2-of-2 quorums", () => {
    const wrongStubQuorum = compileStub("1", handoffAt, null, [scoreA, scoreB]);
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [wrongStubQuorum],
          verificationContext("1", handoffAt),
        ),
      ),
    ).toThrow(/SONAR_HANDOFF.*quorum/);

    const stub = compileStub();
    const wrongConsumedQuorum = compileConsumed(
      scoreReceiptHashV1(stub),
      {},
      [sonarA, sonarB],
    );
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub, wrongConsumedQuorum],
          verificationContext("2", "2026-07-20T09:00:00.000Z"),
        ),
      ),
    ).toThrow(/SCORE_CONSUMER.*quorum/);
  });

  it("binds every signed receipt to the exact revocation high-water", () => {
    const stub = compileStub();
    const revocationOne = Effect.runSync(
      decodeStrict(DecimalUint64, "test.revocation-one", "1"),
    );
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub],
          verificationContext("1", handoffAt, {
            revocation_high_water: revocationOne,
          }),
        ),
      ),
    ).toThrow(/revocation sequence.*high-water/);

    const futureStub = Effect.runSync(
      compileNotConsumedReceiptV1(
        { ...notConsumedInput(), revocation_sequence: "1" },
        [sonarA, sonarB],
      ),
    );
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [futureStub],
          verificationContext("1", handoffAt),
        ),
      ),
    ).toThrow(/revocation sequence.*high-water/);

    const tampered = {
      ...stub,
      body: { ...stub.body, revocation_sequence: revocationOne },
    };
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [tampered],
          verificationContext("1", handoffAt, {
            revocation_high_water: revocationOne,
          }),
        ),
      ),
    ).toThrow(/body hash mismatch/);
  });

  it("binds authority and revocation baselines to an independent anchor", () => {
    const baseline = verificationContext("1", handoffAt);
    const revocationOne = Effect.runSync(
      decodeStrict(DecimalUint64, "test.anchored-revocation-one", "1"),
    );
    const futureStub = Effect.runSync(
      compileNotConsumedReceiptV1(
        { ...notConsumedInput(), revocation_sequence: "1" },
        [sonarA, sonarB],
      ),
    );
    const advanced = verificationContext("1", handoffAt, {
      revocation_high_water: revocationOne,
    });
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1([futureStub], {
          ...advanced,
          verified_anchor: baseline.verified_anchor,
        }),
      ),
    ).toThrow(/do not match the trusted anchor/);

    const stub = compileStub();
    const consumed = compileConsumed(scoreReceiptHashV1(stub));
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub, consumed],
          verificationContext(
            "2",
            "2026-07-20T09:00:00.000Z",
            { verified_anchor: undefined },
          ),
        ),
      ),
    ).toThrow(/requires an independently supplied trusted authority anchor/);

    const attackerPolicy = authority(
      "SCORE_CONSUMER",
      "2",
      [attackerScoreA, attackerScoreB],
    );
    const forgedConsumed = compileConsumed(
      scoreReceiptHashV1(stub),
      { authority_keyset_hash: attackerPolicy.keyset_hash },
      [attackerScoreA, attackerScoreB],
    );
    const selfSelectedPolicies = verificationContext(
      "2",
      "2026-07-20T09:00:00.000Z",
      {
        authorities: [sonarV1(), scoreV1(), attackerPolicy],
      },
    );
    const rawSelfSelectedAnchor = Effect.runSync(
      decodeStrict(
        ScoreTrustedAuthorityAnchorV1,
        "test.attacker-self-selected-anchor",
        {
          schema_version: 1,
          domain: SCORE_AUTHORITY_ANCHOR_DOMAIN,
          environment: selfSelectedPolicies.target.environment,
          generation: "7",
          digest: scoreAuthorityAnchorDigestV1({
            target: selfSelectedPolicies.target,
            authorities: selfSelectedPolicies.authorities,
            authority_high_water: selfSelectedPolicies.authority_high_water,
            revocation_high_water: selfSelectedPolicies.revocation_high_water,
            anchor_generation: "7" as never,
          }),
        },
      ),
    );
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub, forgedConsumed],
          {
            ...selfSelectedPolicies,
            verified_anchor: rawSelfSelectedAnchor as never,
          },
        ),
      ),
    ).toThrow(/opaque verified capability/);
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub, forgedConsumed],
          {
            ...selfSelectedPolicies,
            verified_anchor: verificationContext(
              "2",
              "2026-07-20T09:00:00.000Z",
            ).verified_anchor,
          },
        ),
      ),
    ).toThrow(/do not match the trusted anchor/);
  });

  it("rejects inactive authority generations after rotation", () => {
    const rotatedSonar = sonarV2();
    const currentScore = scoreV2();
    const stubSignedByOldOpenEndedKeys = compileStub();
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stubSignedByOldOpenEndedKeys],
          verificationContext("1", handoffAt, {
            authorities: [
              sonarV1(),
              rotatedSonar,
              scoreV1(),
              currentScore,
            ],
            authority_high_water: {
              SONAR_HANDOFF: rotatedSonar.generation,
              SCORE_CONSUMER: currentScore.generation,
            },
          }),
        ),
      ),
    ).toThrow(/SONAR_HANDOFF.*not the active high-water generation/);

    const stub = compileStub();
    const oldScoreReceipt = compileConsumed(
      scoreReceiptHashV1(stub),
      {
        authority_generation: "1",
        authority_keyset_hash: scoreV1().keyset_hash,
      },
      [scoreA, scoreB],
    );
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub, oldScoreReceipt],
          verificationContext("2", "2026-07-20T09:00:00.000Z"),
        ),
      ),
    ).toThrow(/SCORE_CONSUMER.*not the active high-water generation/);
  });

  it("applies the frozen zero-skew policy to issuance and consumption", () => {
    const futureIssuedStub = compileStub(
      "1",
      "2026-07-19T10:00:00.001Z",
    );
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [futureIssuedStub],
          verificationContext("1", handoffAt),
        ),
      ),
    ).toThrow(/issuance exceeds the zero-skew verification time/);

    const stub = compileStub();
    const futureConsumed = compileConsumed(scoreReceiptHashV1(stub), {
      issued_at: "2026-07-20T08:00:00.000Z",
      consumed_at: "2026-07-20T09:00:00.000Z",
    });
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub, futureConsumed],
          verificationContext("2", "2026-07-20T08:59:59.999Z"),
        ),
      ),
    ).toThrow(/chronology or expiry is invalid/);
  });

  it("requires contiguous sequence, prior-body hash, and committed high-water", () => {
    const stub = compileStub();
    const stubHash = scoreReceiptHashV1(stub);
    const gap = compileConsumed(stubHash, {
      sequence: "3",
      prior_receipt_hash: stubHash,
    });
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub, gap],
          verificationContext("3", "2026-07-20T09:00:00.000Z"),
        ),
      ),
    ).toThrow(/not contiguous/);

    const wrongPrior = compileConsumed(stubHash, {
      prior_receipt_hash: digest("wrong-prior"),
    });
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub, wrongPrior],
          verificationContext("2", "2026-07-20T09:00:00.000Z"),
        ),
      ),
    ).toThrow(/prior hash/);

    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub],
          verificationContext("2", handoffAt),
        ),
      ),
    ).toThrow(/sequence high-water/);
  });

  it("settles any same-sequence valid equivocation to suspended", () => {
    const first = compileStub();
    const second = compileStub("1", "2026-07-19T10:30:00.000Z");
    const result = Effect.runSync(
      verifyScoreConsumptionReceiptsV1(
        [first, second],
        verificationContext("1", "2026-07-19T10:30:00.000Z"),
      ),
    );
    expect(result._tag).toBe("SUSPENDED_CONFLICT");
    if (result._tag === "SUSPENDED_CONFLICT") {
      expect(result.conflicting_receipt_hashes).toHaveLength(2);
    }
  });

  it("promotes only an exact Score receipt that supersedes the Sonar stub", () => {
    const stub = compileStub();
    const consumed = compileConsumed(scoreReceiptHashV1(stub));
    expect(
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub, consumed],
          verificationContext("2", "2026-07-20T09:00:00.000Z"),
        ),
      ),
    ).toMatchObject({
      _tag: "CONSUMED",
      consumer_snapshot_hash: digest("score-snapshot"),
    });

    const wrongSupersession = compileConsumed(scoreReceiptHashV1(stub), {
      supersedes_receipt_hash: digest("wrong-stub"),
    });
    const conflict = Effect.runSync(
      verifyScoreConsumptionReceiptsV1(
        [stub, wrongSupersession],
        verificationContext("2", "2026-07-20T09:00:00.000Z"),
      ),
    );
    expect(conflict._tag).toBe("SUSPENDED_CONFLICT");
  });

  it("fails closed on rotation rollback, mixed generations, and compromise", () => {
    const stub = compileStub();
    const stubHash = scoreReceiptHashV1(stub);
    const consumed = compileConsumed(stubHash);
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub, consumed],
          verificationContext("2", "2026-07-20T09:00:00.000Z", {
            authorities: [sonarV1(), scoreV1()],
          }),
        ),
      ),
    ).toThrow(/contiguous high-water/);

    const mixedGeneration = compileConsumed(stubHash, {}, [scoreA, scoreC]);
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub, mixedGeneration],
          verificationContext("2", "2026-07-20T09:00:00.000Z"),
        ),
      ),
    ).toThrow(/SCORE_CONSUMER.*quorum/);

    const compromisedAuthority = scoreV2({
      [scoreC.keyId]: { compromised_from_sequence: "2" },
    });
    const compromisedReceipt = compileConsumed(stubHash, {
      authority_keyset_hash: compromisedAuthority.keyset_hash,
    });
    expect(() =>
      Effect.runSync(
        verifyScoreConsumptionReceiptsV1(
          [stub, compromisedReceipt],
          verificationContext("2", "2026-07-20T09:00:00.000Z", {
            authorities: [
              sonarV1(),
              scoreV1(),
              compromisedAuthority,
            ],
          }),
        ),
      ),
    ).toThrow(/SCORE_CONSUMER.*quorum/);
  });
});
