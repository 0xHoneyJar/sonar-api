import { describe, expect, it } from "vitest";

import {
  DEPENDENCY_QUERY_LIMITS_V1,
  INVALIDATION_REASON_POLICY_V1,
  INVALIDATION_STATUS_PRECEDENCE,
  PROJECTION_STATE_EVENT_TABLE_V1,
  ProjectionEventJournalV1,
  assertProjectionDigestEqualityV1,
  compileProjectionEventV1,
  compileRecoveryEvidenceVerificationV1,
  executeInvalidationFanoutV1,
  planInvalidationFanoutV1,
  queryEffectiveStatusV1,
  rebuildTruthStatusProjectionV1,
  validateDependencyGraphV1,
  worseProjectionStatus,
  type ArtifactProjectionV1,
  type ProjectionEventBodyV1,
  type SignedProjectionEventV1,
  type TruthStatusProjectionV1,
  type VerifiedRecoveryEvidenceRegistryV1,
} from "../src/truth-contract/index.js";
import {
  fixtureSigners,
  jcsCanonicalize,
  LocalEd25519TrustSigner,
  sha256Hex,
} from "../src/collection-resolver/trust-protocol.js";

const signers = fixtureSigners();
const producer = signers.sonarPrimary;
const reconciler = signers.sonarRotated;
const revocation = signers.orderingReplay;
const governance = signers.sonarRevoked;
const recoveryVerifier = LocalEd25519TrustSigner.fromSeedHex(
  "77".repeat(32),
  "sonar-fixture-recovery-verifier",
);
const now = "2026-07-19T06:00:00.000Z";
const rootHash = sha256Hex("sprint-4:producer-root");
const receiptHash = sha256Hex("sprint-4:reconciliation-receipt");
const keys = {
  [producer.keyId]: {
    public_key_hex: producer.publicKeyHex(),
    authorities: ["PRODUCER"] as const,
  },
  [reconciler.keyId]: {
    public_key_hex: reconciler.publicKeyHex(),
    authorities: ["RECONCILER"] as const,
  },
  [revocation.keyId]: {
    public_key_hex: revocation.publicKeyHex(),
    authorities: ["REVOCATION"] as const,
  },
  [governance.keyId]: {
    public_key_hex: governance.publicKeyHex(),
    authorities: ["GOVERNANCE"] as const,
  },
  [recoveryVerifier.keyId]: {
    public_key_hex: recoveryVerifier.publicKeyHex(),
    authorities: ["RECOVERY"] as const,
  },
};

const syntheticNode = (
  artifact_hash: string,
  depends_on: readonly string[] = [],
): ArtifactProjectionV1 => ({
  artifact_hash,
  generation: "1",
  invalidation_epoch: "0",
  lifecycle_state: "PRODUCED",
  local_status: "READY",
  state_floor: "READY",
  reason_codes: ["SYNTHETIC_LIMIT_FIXTURE"],
  active_causes: [],
  depends_on,
  last_sequence: "1",
});

const syntheticProjection = (
  artifacts: Readonly<Record<string, ArtifactProjectionV1>>,
  root: string,
): TruthStatusProjectionV1 => {
  const unsigned = {
    environment: "development" as const,
    last_sequence: "1",
    tail_event_hash: null,
    invalidation_epoch: "0",
    artifacts,
    applied_event_ids: [`synthetic:${root}`],
    production_authority: false as const,
  };
  return {
    ...unsigned,
    projection_digest: sha256Hex(jcsCanonicalize(unsigned)),
  };
};

const append = (
  events: SignedProjectionEventV1[],
  input: Omit<
    ProjectionEventBodyV1,
    | "schema_version"
    | "sequence"
    | "previous_event_hash"
    | "occurred_at"
    | "cause_event_id"
    | "resolves_cause_event_ids"
    | "replacement_evidence_hash"
    | "replacement_evidence_kinds"
    | "replacement_evidence"
    | "production_authority"
  > &
    Partial<
      Pick<
        ProjectionEventBodyV1,
        | "cause_event_id"
        | "resolves_cause_event_ids"
        | "replacement_evidence_hash"
        | "replacement_evidence_kinds"
        | "replacement_evidence"
      >
    >,
  signer = producer,
): SignedProjectionEventV1[] => {
  const previous = events.at(-1);
  const event = compileProjectionEventV1(
    {
      schema_version: 1,
      sequence: String(events.length + 1),
      previous_event_hash: previous === undefined ? null : sha256Hex(jcsCanonicalize(previous)),
      occurred_at: now,
      cause_event_id:
        input.kind === "INVALIDATION" ||
        input.kind === "REVOCATION" ||
        input.kind === "DELIVERY_DEAD_LETTER"
          ? input.event_id
          : null,
      resolves_cause_event_ids: [],
      replacement_evidence_hash: null,
      replacement_evidence_kinds: null,
      replacement_evidence: null,
      production_authority: false,
      ...input,
    },
    signer,
  );
  return [...events, event];
};

const baseEvents = (): SignedProjectionEventV1[] => {
  let events: SignedProjectionEventV1[] = [];
  events = append(events, {
    event_id: "activate-producer-root",
    kind: "ARTIFACT_ACTIVATED",
    environment: "development",
    artifact_hash: rootHash,
    generation: "1",
    invalidation_epoch: "0",
    authority: "PRODUCER",
    lifecycle_state: "PRODUCED",
    local_status: "READY",
    state_floor: "READY",
    reason_code: "PRODUCER_READY",
    depends_on: [],
  });
  events = append(
    events,
    {
      event_id: "activate-reconciliation",
      kind: "ARTIFACT_ACTIVATED",
      environment: "development",
      artifact_hash: receiptHash,
      generation: "1",
      invalidation_epoch: "0",
      authority: "RECONCILER",
      lifecycle_state: "RECONCILED",
      local_status: "READY",
      state_floor: "READY",
      reason_code: "RECONCILED_STAGED",
      depends_on: [rootHash],
    },
    reconciler,
  );
  return events;
};

const verifiedRecoveryRegistryFor = (
  events: readonly SignedProjectionEventV1[],
): VerifiedRecoveryEvidenceRegistryV1 =>
  Object.fromEntries(
    events
      .filter(
        (
          event,
        ): event is SignedProjectionEventV1 & {
          body: ProjectionEventBodyV1 & {
            replacement_evidence_hash: string;
            replacement_evidence: NonNullable<
              ProjectionEventBodyV1["replacement_evidence"]
            >;
          };
        } =>
          event.body.kind === "RECOVERY" &&
          event.body.replacement_evidence_hash !== null &&
          event.body.replacement_evidence !== null,
      )
      .map((event) => [
        event.body.replacement_evidence_hash,
        compileRecoveryEvidenceVerificationV1(
          {
            environment: event.body.environment,
            artifact_hash: event.body.artifact_hash,
            generation: event.body.generation,
            invalidation_epoch: event.body.invalidation_epoch,
            resolves_cause_event_ids: event.body.resolves_cause_event_ids,
            evidence_hash: event.body.replacement_evidence_hash,
            evidence: event.body.replacement_evidence,
            verified_artifact_hashes:
              event.body.replacement_evidence.items.flatMap(
                (item) => item.artifact_hashes,
              ),
            verifier_service_id: "sonar-staged-recovery-verifier",
            verified_at: now,
          },
          recoveryVerifier,
        ),
      ]),
  );

describe("Sprint 4 invalidation and deterministic recovery", () => {
  it("implements the exhaustive monotonic projection lattice", () => {
    for (const left of INVALIDATION_STATUS_PRECEDENCE) {
      for (const right of INVALIDATION_STATUS_PRECEDENCE) {
        const expected =
          INVALIDATION_STATUS_PRECEDENCE.indexOf(left) >=
          INVALIDATION_STATUS_PRECEDENCE.indexOf(right)
            ? left
            : right;
        expect(worseProjectionStatus(left, right)).toBe(expected);
        expect(worseProjectionStatus(right, left)).toBe(expected);
        for (const eventFloor of INVALIDATION_STATUS_PRECEDENCE) {
          const forward = [left, right, eventFloor].reduce(worseProjectionStatus);
          const reverse = [eventFloor, right, left].reduce(worseProjectionStatus);
          const expectedTriple = [left, right, eventFloor].sort(
            (a, b) =>
              INVALIDATION_STATUS_PRECEDENCE.indexOf(b) -
              INVALIDATION_STATUS_PRECEDENCE.indexOf(a),
          )[0];
          expect(forward).toBe(expectedTriple);
          expect(reverse).toBe(expectedTriple);
        }
      }
    }
    expect(
      worseProjectionStatus(
        worseProjectionStatus("NOT_READY", "UNKNOWN"),
        "EXPIRED",
      ),
    ).toBe("EXPIRED");
    expect(PROJECTION_STATE_EVENT_TABLE_V1).toHaveLength(6 * 6 * 9);
    expect(
      new Set(
        PROJECTION_STATE_EVENT_TABLE_V1.map(
          (row) =>
            `${row.local_status}\0${row.ancestor_status}\0${row.event_reason}`,
        ),
      ).size,
    ).toBe(PROJECTION_STATE_EVENT_TABLE_V1.length);
    const eventReasons = [
      "NO_EVENT",
      ...Object.keys(INVALIDATION_REASON_POLICY_V1),
    ];
    for (const localStatus of INVALIDATION_STATUS_PRECEDENCE) {
      for (const ancestorStatus of INVALIDATION_STATUS_PRECEDENCE) {
        for (const eventReason of eventReasons) {
          const row = PROJECTION_STATE_EVENT_TABLE_V1.find(
            (candidate) =>
              candidate.local_status === localStatus &&
              candidate.ancestor_status === ancestorStatus &&
              candidate.event_reason === eventReason,
          );
          expect(row).toBeDefined();
          expect(row!.effective_status).toBe(
            [
              localStatus,
              ancestorStatus,
              row!.event_floor,
            ].reduce(worseProjectionStatus),
          );
        }
      }
    }
  });

  it("inherits invalid ancestor state immediately and rejects stale epochs", () => {
    let events = baseEvents();
    events = append(events, {
      event_id: "reorg-root-epoch-1",
      kind: "INVALIDATION",
      environment: "development",
      artifact_hash: rootHash,
      generation: "1",
      invalidation_epoch: "1",
      authority: "PRODUCER",
      lifecycle_state: "PRODUCED",
      local_status: "NOT_READY",
      state_floor: "NOT_READY",
      reason_code: "REORG_BEHIND_WATERMARK",
      depends_on: [],
    });
    const projection = rebuildTruthStatusProjectionV1("development", events, keys);
    expect(
      queryEffectiveStatusV1(projection, receiptHash, "1", "1").effective_status,
    ).toBe("UNKNOWN");
    expect(
      queryEffectiveStatusV1(projection, receiptHash, "1", "0"),
    ).toMatchObject({
      effective_status: "UNKNOWN",
      reason_codes: ["STALE_GENERATION_OR_INVALIDATION_EPOCH"],
    });

    const sameEpochRecovery = append(events, {
      event_id: "same-epoch-recovery-refused",
      kind: "RECOVERY",
      environment: "development",
      artifact_hash: rootHash,
      generation: "1",
      invalidation_epoch: "1",
      authority: "PRODUCER",
      lifecycle_state: "PRODUCED",
      local_status: "READY",
      state_floor: "READY",
      reason_code: "CHILD_ATTEMPTED_RECOVERY",
      resolves_cause_event_ids: ["reorg-root-epoch-1"],
      replacement_evidence_hash: sha256Hex(
        jcsCanonicalize({
          items: [
            {
              kind: "REPLACEMENT_WATERMARK_AND_RECEIPTS",
              artifact_hashes: [
                sha256Hex("same-epoch-watermark"),
                sha256Hex("same-epoch-receipt"),
              ],
              census_complete: null,
              reconciliation_decision: null,
            },
          ],
        }),
      ),
      replacement_evidence_kinds: ["REPLACEMENT_WATERMARK_AND_RECEIPTS"],
      replacement_evidence: {
        items: [
          {
            kind: "REPLACEMENT_WATERMARK_AND_RECEIPTS",
            artifact_hashes: [
              sha256Hex("same-epoch-watermark"),
              sha256Hex("same-epoch-receipt"),
            ],
            census_complete: null,
            reconciliation_decision: null,
          },
        ],
      },
      depends_on: [],
    }, producer);
    expect(() =>
      rebuildTruthStatusProjectionV1("development", sameEpochRecovery, keys),
    ).toThrow(/same-epoch recovery/);

    const newerEpochRecovery = append(events, {
      event_id: "replacement-evidence-epoch-2",
      kind: "RECOVERY",
      environment: "development",
      artifact_hash: rootHash,
      generation: "1",
      invalidation_epoch: "2",
      authority: "PRODUCER",
      lifecycle_state: "PRODUCED",
      local_status: "READY",
      state_floor: "READY",
      reason_code: "REPLACEMENT_WATERMARK_AND_RECONCILIATION",
      resolves_cause_event_ids: ["reorg-root-epoch-1"],
      replacement_evidence_hash: sha256Hex(
        jcsCanonicalize({
          items: [
            {
              kind: "REPLACEMENT_WATERMARK_AND_RECEIPTS",
              artifact_hashes: [
                sha256Hex("replacement-watermark"),
                sha256Hex("replacement-receipt"),
              ],
              census_complete: null,
              reconciliation_decision: null,
            },
          ],
        }),
      ),
      replacement_evidence_kinds: ["REPLACEMENT_WATERMARK_AND_RECEIPTS"],
      replacement_evidence: {
        items: [
          {
            kind: "REPLACEMENT_WATERMARK_AND_RECEIPTS",
            artifact_hashes: [
              sha256Hex("replacement-watermark"),
              sha256Hex("replacement-receipt"),
            ],
            census_complete: null,
            reconciliation_decision: null,
          },
        ],
      },
      depends_on: [],
    }, producer);
    const recovered = rebuildTruthStatusProjectionV1(
      "development",
      newerEpochRecovery,
      keys,
      verifiedRecoveryRegistryFor(newerEpochRecovery),
    );
    expect(
      queryEffectiveStatusV1(recovered, rootHash, "1", "2"),
    ).toMatchObject({
      effective_status: "READY",
    });
    expect(recovered.artifacts[rootHash]!.active_causes).toEqual([]);
  });

  it("fans out deterministically and dead letters never weaken the cause", () => {
    const cleanProjection = rebuildTruthStatusProjectionV1(
      "development",
      baseEvents(),
      keys,
    );
    let invalidatedEvents = baseEvents();
    invalidatedEvents = append(invalidatedEvents, {
      event_id: "semantic-root-epoch-1",
      kind: "INVALIDATION",
      environment: "development",
      artifact_hash: rootHash,
      generation: "1",
      invalidation_epoch: "1",
      authority: "PRODUCER",
      lifecycle_state: "PRODUCED",
      local_status: "SUSPENDED",
      state_floor: "SUSPENDED",
      reason_code: "SEMANTIC_PROVENANCE_MISMATCH",
      depends_on: [],
    });
    const projection = rebuildTruthStatusProjectionV1(
      "development",
      invalidatedEvents,
      keys,
    );
    const fanout = planInvalidationFanoutV1(
      projection,
      rootHash,
      "1",
      "SUSPENDED",
      "semantic-root-epoch-1",
      new Set([receiptHash]),
    );
    expect(fanout.deliveries.map((delivery) => delivery.artifact_hash)).toEqual([
      rootHash,
      receiptHash,
    ]);
    expect(fanout.deliveries[1]).toMatchObject({
      status: "DEAD_LETTER",
      state_floor: "SUSPENDED",
      attempts: 5,
      retry_owner: "sonar-truth-operations",
    });
    expect(fanout.converged).toBe(false);
    expect(
      planInvalidationFanoutV1(
        projection,
        rootHash,
        "1",
        "SUSPENDED",
        "semantic-root-epoch-1",
      ),
    ).toEqual(
      planInvalidationFanoutV1(
        projection,
        rootHash,
        "1",
        "SUSPENDED",
        "semantic-root-epoch-1",
      ),
    );
    const executed = executeInvalidationFanoutV1(
      projection,
      rootHash,
      "1",
      "SUSPENDED",
      "semantic-root-epoch-1",
      producer,
      now,
    );
    const convergedProjection = rebuildTruthStatusProjectionV1(
      "development",
      [...invalidatedEvents, ...executed.signed_events],
      keys,
    );
    expect(
      queryEffectiveStatusV1(
        convergedProjection,
        receiptHash,
        "1",
        "1",
      ).effective_status,
    ).toBe("SUSPENDED");
    expect(
      queryEffectiveStatusV1(cleanProjection, receiptHash, "1", "0", {
        operationBudget: 1,
      }),
    ).toMatchObject({ effective_status: "UNKNOWN", reason_codes: ["RESOURCE_LIMIT"] });
    expect(
      queryEffectiveStatusV1(cleanProjection, receiptHash, "1", "0", {
        byteBudget: 1,
      }),
    ).toMatchObject({ effective_status: "UNKNOWN", reason_codes: ["RESOURCE_LIMIT"] });
    let clock = 0;
    expect(
      queryEffectiveStatusV1(cleanProjection, receiptHash, "1", "0", {
        monotonicNow: () => {
          clock += 2_001;
          return clock;
        },
      }),
    ).toMatchObject({ effective_status: "UNKNOWN", reason_codes: ["RESOURCE_LIMIT"] });
  });

  it("rebuilds byte-identically from a hash-chained total order and fails closed on gaps", () => {
    const events = baseEvents();
    const served = rebuildTruthStatusProjectionV1("development", events, keys);
    const rebuilt = rebuildTruthStatusProjectionV1(
      "development",
      [...events].reverse(),
      keys,
    );
    expect(rebuilt.projection_digest).toBe(served.projection_digest);
    expect(() => assertProjectionDigestEqualityV1(served, rebuilt)).not.toThrow();

    const broken = structuredClone(events);
    broken[1]!.body.previous_event_hash = sha256Hex("wrong-tail");
    expect(() =>
      rebuildTruthStatusProjectionV1("development", broken, keys),
    ).toThrow(/signature|hash chain/);
    expect(() =>
      rebuildTruthStatusProjectionV1("development", [events[1]!], keys),
    ).toThrow(/sequence|hash chain/);
    expect(
      rebuildTruthStatusProjectionV1(
        "development",
        [...events, events[1]!],
        keys,
      ).projection_digest,
    ).toBe(served.projection_digest);
    expect(() =>
      append(
        events,
        {
          event_id: "producer-claims-score-authority",
          kind: "LIFECYCLE_TRANSITION",
          environment: "development",
          artifact_hash: receiptHash,
          generation: "1",
          invalidation_epoch: "1",
          authority: "SCORE",
          lifecycle_state: "CONSUMED",
          local_status: "READY",
          state_floor: "READY",
          reason_code: "FORGED_CONSUMPTION",
          depends_on: [],
        },
        producer,
      ),
    ).toThrow(/post-reconciliation authority/);
  });

  it("binds negative reasons to severity and trust-owned recovery", () => {
    const events = baseEvents();
    expect(() =>
      append(events, {
        event_id: "weakened-semantic-cause",
        kind: "INVALIDATION",
        environment: "development",
        artifact_hash: rootHash,
        generation: "1",
        invalidation_epoch: "1",
        authority: "PRODUCER",
        lifecycle_state: "PRODUCED",
        local_status: "DEGRADED",
        state_floor: "DEGRADED",
        reason_code: "SEMANTIC_PROVENANCE_MISMATCH",
        depends_on: [],
      }),
    ).toThrow(/weakens required severity/);

    const revoked = append(
      events,
      {
        event_id: "revoked-root-epoch-1",
        kind: "REVOCATION",
        environment: "development",
        artifact_hash: rootHash,
        generation: "1",
        invalidation_epoch: "1",
        authority: "REVOCATION",
        lifecycle_state: "PRODUCED",
        local_status: "SUSPENDED",
        state_floor: "SUSPENDED",
        reason_code: "SIGNER_ROOT_COMPROMISE_REVOCATION",
        depends_on: [],
      },
      revocation,
    );
    const forgedRecovery = append(revoked, {
      event_id: "producer-cannot-clear-revocation",
      kind: "RECOVERY",
      environment: "development",
      artifact_hash: rootHash,
      generation: "1",
      invalidation_epoch: "2",
      authority: "PRODUCER",
      lifecycle_state: "PRODUCED",
      local_status: "READY",
      state_floor: "READY",
      reason_code: "UNTRUSTED_RECOVERY",
      resolves_cause_event_ids: ["revoked-root-epoch-1"],
      replacement_evidence_hash: sha256Hex(
        jcsCanonicalize({
          items: [
            {
              kind: "RECOVERED_TRUST_ROOT",
              artifact_hashes: [
                sha256Hex("verified-recovered-root"),
                sha256Hex("verified-revocation-receipt"),
              ],
              census_complete: null,
              reconciliation_decision: null,
            },
          ],
        }),
      ),
      replacement_evidence_kinds: ["RECOVERED_TRUST_ROOT"],
      replacement_evidence: {
        items: [
          {
            kind: "RECOVERED_TRUST_ROOT",
            artifact_hashes: [
              sha256Hex("verified-recovered-root"),
              sha256Hex("verified-revocation-receipt"),
            ],
            census_complete: null,
            reconciliation_decision: null,
          },
        ],
      },
      depends_on: [],
    });
    expect(() =>
      rebuildTruthStatusProjectionV1("development", forgedRecovery, keys),
    ).toThrow(/does not satisfy every active cause/);

    const validTrustRecovery = append(
      revoked,
      {
        event_id: "revocation-authority-recovers-root",
        kind: "RECOVERY",
        environment: "development",
        artifact_hash: rootHash,
        generation: "1",
        invalidation_epoch: "2",
        authority: "REVOCATION",
        lifecycle_state: "PRODUCED",
        local_status: "READY",
        state_floor: "READY",
        reason_code: "RECOVERED_TRUST_ROOT",
        resolves_cause_event_ids: ["revoked-root-epoch-1"],
        replacement_evidence_hash: forgedRecovery.at(-1)!.body.replacement_evidence_hash,
        replacement_evidence_kinds: ["RECOVERED_TRUST_ROOT"],
        replacement_evidence: forgedRecovery.at(-1)!.body.replacement_evidence,
        depends_on: [],
      },
      revocation,
    );
    expect(() =>
      rebuildTruthStatusProjectionV1("development", validTrustRecovery, keys),
    ).toThrow(/absent from the verified registry/);
    const incompleteVerifiedRegistry =
      verifiedRecoveryRegistryFor(validTrustRecovery);
    const trustEvidenceHash =
      validTrustRecovery.at(-1)!.body.replacement_evidence_hash!;
    expect(() =>
      rebuildTruthStatusProjectionV1(
        "development",
        validTrustRecovery,
        keys,
        {
          [trustEvidenceHash]: {
            ...incompleteVerifiedRegistry[trustEvidenceHash]!,
            body: {
              ...incompleteVerifiedRegistry[trustEvidenceHash]!.body,
              verified_artifact_hashes: [
                sha256Hex("verified-recovered-root"),
              ],
            },
          },
        },
      ),
    ).toThrow(/verification receipt is untrusted/);
    expect(
      queryEffectiveStatusV1(
        rebuildTruthStatusProjectionV1(
          "development",
          validTrustRecovery,
          keys,
          verifiedRecoveryRegistryFor(validTrustRecovery),
        ),
        rootHash,
        "1",
        "2",
      ).effective_status,
    ).toBe("READY");

    let mixed = append(events, {
      event_id: "mixed-reorg",
      kind: "INVALIDATION",
      environment: "development",
      artifact_hash: rootHash,
      generation: "1",
      invalidation_epoch: "1",
      authority: "PRODUCER",
      lifecycle_state: "PRODUCED",
      local_status: "NOT_READY",
      state_floor: "NOT_READY",
      reason_code: "REORG_BEHIND_WATERMARK",
      depends_on: [],
    });
    mixed = append(mixed, {
      event_id: "mixed-expiry",
      kind: "INVALIDATION",
      environment: "development",
      artifact_hash: rootHash,
      generation: "1",
      invalidation_epoch: "1",
      authority: "PRODUCER",
      lifecycle_state: "PRODUCED",
      local_status: "EXPIRED",
      state_floor: "EXPIRED",
      reason_code: "STALE_EVIDENCE_EXPIRED",
      depends_on: [],
    });
    const mixedEvidence = {
      items: [
        {
          kind: "REPLACEMENT_WATERMARK_AND_RECEIPTS" as const,
          artifact_hashes: [
            sha256Hex("mixed-watermark"),
            sha256Hex("mixed-receipt"),
          ],
          census_complete: null,
          reconciliation_decision: null,
        },
        {
          kind: "FRESH_READINESS_EVIDENCE" as const,
          artifact_hashes: [sha256Hex("mixed-readiness")],
          census_complete: null,
          reconciliation_decision: null,
        },
      ],
    };
    mixed = append(
      mixed,
      {
        event_id: "mixed-governance-recovery",
        kind: "RECOVERY",
        environment: "development",
        artifact_hash: rootHash,
        generation: "1",
        invalidation_epoch: "2",
        authority: "GOVERNANCE",
        lifecycle_state: "PRODUCED",
        local_status: "READY",
        state_floor: "READY",
        reason_code: "MIXED_CAUSES_RECOVERED",
        resolves_cause_event_ids: ["mixed-reorg", "mixed-expiry"],
        replacement_evidence_hash: sha256Hex(jcsCanonicalize(mixedEvidence)),
        replacement_evidence_kinds: [
          "REPLACEMENT_WATERMARK_AND_RECEIPTS",
          "FRESH_READINESS_EVIDENCE",
        ],
        replacement_evidence: mixedEvidence,
        depends_on: [],
      },
      governance,
    );
    expect(
      queryEffectiveStatusV1(
        rebuildTruthStatusProjectionV1(
          "development",
          mixed,
          keys,
          verifiedRecoveryRegistryFor(mixed),
        ),
        rootHash,
        "1",
        "2",
      ).effective_status,
    ).toBe("READY");

    let trustAndSemantic = append(
      events,
      {
        event_id: "mixed-trust-revocation",
        kind: "REVOCATION",
        environment: "development",
        artifact_hash: rootHash,
        generation: "1",
        invalidation_epoch: "1",
        authority: "REVOCATION",
        lifecycle_state: "PRODUCED",
        local_status: "SUSPENDED",
        state_floor: "SUSPENDED",
        reason_code: "SIGNER_ROOT_COMPROMISE_REVOCATION",
        depends_on: [],
      },
      revocation,
    );
    trustAndSemantic = append(trustAndSemantic, {
      event_id: "mixed-trust-semantic",
      kind: "INVALIDATION",
      environment: "development",
      artifact_hash: rootHash,
      generation: "1",
      invalidation_epoch: "1",
      authority: "PRODUCER",
      lifecycle_state: "PRODUCED",
      local_status: "SUSPENDED",
      state_floor: "SUSPENDED",
      reason_code: "SEMANTIC_PROVENANCE_MISMATCH",
      depends_on: [],
    });
    const trustAndSemanticEvidence = {
      items: [
        {
          kind: "RECOVERED_TRUST_ROOT" as const,
          artifact_hashes: [
            sha256Hex("mixed-trust-root"),
            sha256Hex("mixed-trust-receipt"),
          ],
          census_complete: null,
          reconciliation_decision: null,
        },
        {
          kind: "CORRECTED_BUNDLE_AND_SCORE_RECEIPT" as const,
          artifact_hashes: [
            sha256Hex("mixed-corrected-bundle"),
            sha256Hex("mixed-score-receipt"),
          ],
          census_complete: null,
          reconciliation_decision: null,
        },
      ],
    };
    const revocationRecovery = append(
      trustAndSemantic,
      {
        event_id: "revocation-cannot-clear-semantic-cause",
        kind: "RECOVERY",
        environment: "development",
        artifact_hash: rootHash,
        generation: "1",
        invalidation_epoch: "2",
        authority: "REVOCATION",
        lifecycle_state: "PRODUCED",
        local_status: "READY",
        state_floor: "READY",
        reason_code: "MIXED_TRUST_SEMANTIC_RECOVERY",
        resolves_cause_event_ids: [
          "mixed-trust-revocation",
          "mixed-trust-semantic",
        ],
        replacement_evidence_hash: sha256Hex(
          jcsCanonicalize(trustAndSemanticEvidence),
        ),
        replacement_evidence_kinds: [
          "RECOVERED_TRUST_ROOT",
          "CORRECTED_BUNDLE_AND_SCORE_RECEIPT",
        ],
        replacement_evidence: trustAndSemanticEvidence,
        depends_on: [],
      },
      revocation,
    );
    expect(() =>
      rebuildTruthStatusProjectionV1(
        "development",
        revocationRecovery,
        keys,
        verifiedRecoveryRegistryFor(revocationRecovery),
      ),
    ).toThrow(/does not satisfy every active cause/);
    const correctedGovernanceRecovery = append(
      trustAndSemantic,
      {
        event_id: "governance-clears-mixed-trust-semantic-causes",
        kind: "RECOVERY",
        environment: "development",
        artifact_hash: rootHash,
        generation: "1",
        invalidation_epoch: "2",
        authority: "GOVERNANCE",
        lifecycle_state: "PRODUCED",
        local_status: "READY",
        state_floor: "READY",
        reason_code: "MIXED_TRUST_SEMANTIC_RECOVERY",
        resolves_cause_event_ids: [
          "mixed-trust-revocation",
          "mixed-trust-semantic",
        ],
        replacement_evidence_hash: sha256Hex(
          jcsCanonicalize(trustAndSemanticEvidence),
        ),
        replacement_evidence_kinds: [
          "RECOVERED_TRUST_ROOT",
          "CORRECTED_BUNDLE_AND_SCORE_RECEIPT",
        ],
        replacement_evidence: trustAndSemanticEvidence,
        depends_on: [],
      },
      governance,
    );
    expect(
      queryEffectiveStatusV1(
        rebuildTruthStatusProjectionV1(
          "development",
          correctedGovernanceRecovery,
          keys,
          verifiedRecoveryRegistryFor(correctedGovernanceRecovery),
        ),
        rootHash,
        "1",
        "2",
      ).effective_status,
    ).toBe("READY");
  });

  it.each([
    {
      suffix: "census",
      reason: "RECONCILIATION_COUNT_BREACH",
      floor: "NOT_READY",
      evidenceKind: "COMPLETED_CENSUS_PASS",
      censusComplete: true,
      reconciliationDecision: "RECONCILED_STAGED",
    },
    {
      suffix: "ordinary",
      reason: "SOURCE_TRANSPORT_LOSS",
      floor: "DEGRADED",
      evidenceKind: "FRESH_READINESS_EVIDENCE",
      censusComplete: null,
      reconciliationDecision: null,
    },
  ] as const)(
    "requires the authority intersection for trust + $suffix recovery",
    ({
      suffix,
      reason,
      floor,
      evidenceKind,
      censusComplete,
      reconciliationDecision,
    }) => {
      let causes = append(
        baseEvents(),
        {
          event_id: `intersection-trust-${suffix}`,
          kind: "REVOCATION",
          environment: "development",
          artifact_hash: rootHash,
          generation: "1",
          invalidation_epoch: "1",
          authority: "REVOCATION",
          lifecycle_state: "PRODUCED",
          local_status: "SUSPENDED",
          state_floor: "SUSPENDED",
          reason_code: "SIGNER_ROOT_COMPROMISE_REVOCATION",
          depends_on: [],
        },
        revocation,
      );
      causes = append(causes, {
        event_id: `intersection-${suffix}`,
        kind: "INVALIDATION",
        environment: "development",
        artifact_hash: rootHash,
        generation: "1",
        invalidation_epoch: "1",
        authority: "PRODUCER",
        lifecycle_state: "PRODUCED",
        local_status: floor,
        state_floor: floor,
        reason_code: reason,
        depends_on: [],
      });
      const evidence = {
        items: [
          {
            kind: "RECOVERED_TRUST_ROOT" as const,
            artifact_hashes: [
              sha256Hex(`intersection-root-${suffix}`),
              sha256Hex(`intersection-trust-receipt-${suffix}`),
            ],
            census_complete: null,
            reconciliation_decision: null,
          },
          {
            kind: evidenceKind,
            artifact_hashes: [sha256Hex(`intersection-evidence-${suffix}`)],
            census_complete: censusComplete,
            reconciliation_decision: reconciliationDecision,
          },
        ],
      };
      const recoveryInput = {
        kind: "RECOVERY" as const,
        environment: "development" as const,
        artifact_hash: rootHash,
        generation: "1",
        invalidation_epoch: "2",
        lifecycle_state: "PRODUCED" as const,
        local_status: "READY" as const,
        state_floor: "READY" as const,
        reason_code: `INTERSECTION_RECOVERY_${suffix}`,
        resolves_cause_event_ids: [
          `intersection-trust-${suffix}`,
          `intersection-${suffix}`,
        ],
        replacement_evidence_hash: sha256Hex(jcsCanonicalize(evidence)),
        replacement_evidence_kinds: [
          "RECOVERED_TRUST_ROOT" as const,
          evidenceKind,
        ],
        replacement_evidence: evidence,
        depends_on: [],
      };
      const revocationAttempt = append(
        causes,
        {
          ...recoveryInput,
          event_id: `intersection-revocation-attempt-${suffix}`,
          authority: "REVOCATION",
        },
        revocation,
      );
      expect(() =>
        rebuildTruthStatusProjectionV1(
          "development",
          revocationAttempt,
          keys,
          verifiedRecoveryRegistryFor(revocationAttempt),
        ),
      ).toThrow(/does not satisfy every active cause/);
      const governanceRecovery = append(
        causes,
        {
          ...recoveryInput,
          event_id: `intersection-governance-${suffix}`,
          authority: "GOVERNANCE",
        },
        governance,
      );
      expect(
        queryEffectiveStatusV1(
          rebuildTruthStatusProjectionV1(
            "development",
            governanceRecovery,
            keys,
            verifiedRecoveryRegistryFor(governanceRecovery),
          ),
          rootHash,
          "1",
          "2",
        ).effective_status,
      ).toBe("READY");
    },
  );

  it.each([
    {
      reason: "SOURCE_TRANSPORT_LOSS",
      floor: "DEGRADED",
      authority: "PRODUCER",
      signer: producer,
    },
    {
      reason: "STALE_EVIDENCE_EXPIRED",
      floor: "EXPIRED",
      authority: "PRODUCER",
      signer: producer,
    },
    {
      reason: "REORG_BEHIND_WATERMARK",
      floor: "NOT_READY",
      authority: "PRODUCER",
      signer: producer,
    },
    {
      reason: "RECONCILIATION_COUNT_BREACH",
      floor: "NOT_READY",
      authority: "PRODUCER",
      signer: producer,
    },
    {
      reason: "SEMANTIC_PROVENANCE_MISMATCH",
      floor: "SUSPENDED",
      authority: "PRODUCER",
      signer: producer,
    },
    {
      reason: "IDENTITY_REVOKED_OR_CONTESTED",
      floor: "SUSPENDED",
      authority: "REVOCATION",
      signer: revocation,
    },
    {
      reason: "SIGNER_ROOT_COMPROMISE_REVOCATION",
      floor: "SUSPENDED",
      authority: "REVOCATION",
      signer: revocation,
    },
    {
      reason: "INCOMPATIBLE_PRODUCER_CONSUMER",
      floor: "SUSPENDED",
      authority: "PRODUCER",
      signer: producer,
    },
  ] as const)(
    "fans out and replays $reason without weakening",
    ({ reason, floor, authority, signer }) => {
      const causeId = `negative:${reason}`;
      const kind =
        authority === "REVOCATION" ? ("REVOCATION" as const) : ("INVALIDATION" as const);
      const invalidated = append(
        baseEvents(),
        {
          event_id: causeId,
          kind,
          environment: "development",
          artifact_hash: rootHash,
          generation: "1",
          invalidation_epoch: "1",
          authority,
          lifecycle_state: "PRODUCED",
          local_status: floor,
          state_floor: floor,
          reason_code: reason,
          depends_on: [],
        },
        signer,
      );
      const projection = rebuildTruthStatusProjectionV1(
        "development",
        invalidated,
        keys,
      );
      const executed = executeInvalidationFanoutV1(
        projection,
        rootHash,
        "1",
        floor,
        causeId,
        signer,
        now,
      );
      const replayed = rebuildTruthStatusProjectionV1(
        "development",
        [...invalidated, ...executed.signed_events].reverse(),
        keys,
      );
      expect(
        queryEffectiveStatusV1(replayed, receiptHash, "1", "1").effective_status,
      ).toBe(floor);
      expect(
        rebuildTruthStatusProjectionV1(
          "development",
          [...invalidated, ...executed.signed_events],
          keys,
        ).projection_digest,
      ).toBe(replayed.projection_digest);
    },
  );

  it("fails closed on projection mutation and stale concurrent fan-out writers", () => {
    const events = baseEvents();
    const projection = rebuildTruthStatusProjectionV1("development", events, keys);
    const tampered = structuredClone(projection);
    tampered.artifacts[receiptHash]!.depends_on = [];
    expect(
      queryEffectiveStatusV1(tampered, receiptHash, "1", "0"),
    ).toMatchObject({
      effective_status: "UNKNOWN",
      reason_codes: ["PROJECTION_DIGEST_MISMATCH"],
    });

    const journal = new ProjectionEventJournalV1();
    journal.appendBatch(null, events);
    expect(() => journal.appendBatch(null, events)).toThrow(/CAS conflict/);
    expect(journal.readAll()).toHaveLength(events.length);
  });

  it("enforces exact and plus-one node, edge, byte, time, and fan-out bounds", () => {
    const exactNodes: Record<string, ArtifactProjectionV1> = {};
    for (let index = 0; index < DEPENDENCY_QUERY_LIMITS_V1.nodes; index += 1) {
      const hash = sha256Hex(`node-bound-${index}`);
      exactNodes[hash] = syntheticNode(hash);
    }
    expect(() => validateDependencyGraphV1(exactNodes)).not.toThrow();
    const plusOneHash = sha256Hex("node-bound-plus-one");
    expect(() =>
      validateDependencyGraphV1({
        ...exactNodes,
        [plusOneHash]: syntheticNode(plusOneHash),
      }),
    ).toThrow(/node limit/);

    const edgeNodes: Record<string, ArtifactProjectionV1> = {};
    const leaves = Array.from({ length: 400 }, (_, index) =>
      sha256Hex(`edge-leaf-${index}`),
    );
    leaves.forEach((hash) => {
      edgeNodes[hash] = syntheticNode(hash);
    });
    for (let index = 0; index < 400; index += 1) {
      const hash = sha256Hex(`edge-parent-${index}`);
      edgeNodes[hash] = syntheticNode(hash, leaves.slice(0, 125));
    }
    expect(() => validateDependencyGraphV1(edgeNodes)).not.toThrow();
    const firstParent = sha256Hex("edge-parent-0");
    expect(() =>
      validateDependencyGraphV1({
        ...edgeNodes,
        [firstParent]: syntheticNode(firstParent, leaves.slice(0, 126)),
      }),
    ).toThrow(/edge limit/);

    const singleHash = sha256Hex("single-limit-node");
    const one = syntheticProjection(
      { [singleHash]: syntheticNode(singleHash) },
      singleHash,
    );
    const nodeBytes = new TextEncoder().encode(
      jcsCanonicalize(one.artifacts[singleHash]),
    ).byteLength;
    expect(
      queryEffectiveStatusV1(one, singleHash, "1", "0", {
        byteBudget: nodeBytes,
        monotonicNow: (() => {
          const ticks = [0, 2_000];
          return () => ticks.shift() ?? 2_000;
        })(),
      }).effective_status,
    ).toBe("READY");
    expect(
      queryEffectiveStatusV1(one, singleHash, "1", "0", {
        byteBudget: nodeBytes - 1,
      }),
    ).toMatchObject({ effective_status: "UNKNOWN", reason_codes: ["RESOURCE_LIMIT"] });
    expect(
      queryEffectiveStatusV1(one, singleHash, "1", "0", {
        monotonicNow: (() => {
          const ticks = [0, 2_001];
          return () => ticks.shift() ?? 2_001;
        })(),
      }),
    ).toMatchObject({ effective_status: "UNKNOWN", reason_codes: ["RESOURCE_LIMIT"] });

    const fanoutOrigin = sha256Hex("fanout-bound-origin");
    const fanoutArtifacts: Record<string, ArtifactProjectionV1> = {
      [fanoutOrigin]: {
        ...syntheticNode(fanoutOrigin),
        invalidation_epoch: "1",
        local_status: "NOT_READY",
        state_floor: "NOT_READY",
        reason_codes: ["REORG_BEHIND_WATERMARK"],
        active_causes: [
          {
            event_id: "fanout-bound-cause",
            state_floor: "NOT_READY",
            reason_code: "REORG_BEHIND_WATERMARK",
            authority: "PRODUCER",
            signer_key_id: producer.keyId,
          },
        ],
      },
    };
    for (
      let index = 0;
      index < DEPENDENCY_QUERY_LIMITS_V1.fanoutBatch;
      index += 1
    ) {
      const hash = sha256Hex(`fanout-bound-child-${index}`);
      fanoutArtifacts[hash] = {
        ...syntheticNode(hash, [fanoutOrigin]),
        invalidation_epoch: "1",
      };
    }
    const fanoutUnsigned = {
      environment: "development" as const,
      last_sequence: "1",
      tail_event_hash: null,
      invalidation_epoch: "1",
      artifacts: fanoutArtifacts,
      applied_event_ids: ["fanout-bound-cause"],
      production_authority: false as const,
    };
    const fanoutProjection: TruthStatusProjectionV1 = {
      ...fanoutUnsigned,
      projection_digest: sha256Hex(jcsCanonicalize(fanoutUnsigned)),
    };
    const fanoutPlan = planInvalidationFanoutV1(
      fanoutProjection,
      fanoutOrigin,
      "1",
      "NOT_READY",
      "fanout-bound-cause",
    );
    expect(fanoutPlan.deliveries).toHaveLength(
      DEPENDENCY_QUERY_LIMITS_V1.fanoutBatch + 1,
    );
    expect(fanoutPlan.batches).toBe(2);
    expect(() =>
      executeInvalidationFanoutV1(
        fanoutProjection,
        fanoutOrigin,
        "1",
        "NOT_READY",
        "fanout-bound-cause",
        reconciler,
        now,
      ),
    ).toThrow(/signer differs from persisted source cause/);
  });

  it("enforces the depth-32 query closure independently of the depth-64 decode bound", () => {
    expect(DEPENDENCY_QUERY_LIMITS_V1).toMatchObject({
      nodes: 10_000,
      edges: 50_000,
      depth: 32,
      fanoutBatch: 1_000,
      wallMilliseconds: 2_000,
      estimatedBytes: 268_435_456,
    });
    let events: SignedProjectionEventV1[] = [];
    let dependency: string | null = null;
    for (let index = 0; index <= 33; index += 1) {
      const artifact = sha256Hex(`depth-node-${index}`);
      events = append(events, {
        event_id: `activate-depth-${index}`,
        kind: "ARTIFACT_ACTIVATED",
        environment: "development",
        artifact_hash: artifact,
        generation: "1",
        invalidation_epoch: "0",
        authority: "PRODUCER",
        lifecycle_state: "PRODUCED",
        local_status: "READY",
        state_floor: "READY",
        reason_code: "DEPTH_FIXTURE",
        depends_on: dependency === null ? [] : [dependency],
      });
      dependency = artifact;
    }
    expect(() =>
      rebuildTruthStatusProjectionV1("development", events, keys),
    ).toThrow(/depth limit/);
  });

  // Regression: TC-001 (Bridgebuilder review of PR #221).
  // A LIFECYCLE_TRANSITION carrying resolves_cause_event_ids + replacement
  // evidence must NOT be able to act as a recovery. Recovery semantics
  // (cause resolution, evidence checks) are reachable only via kind RECOVERY,
  // at both the validation boundary and the projection layer.
  describe("TC-001: LIFECYCLE_TRANSITION cannot masquerade as recovery", () => {
    const transportEvidence = {
      items: [
        {
          kind: "FRESH_READINESS_EVIDENCE" as const,
          artifact_hashes: [sha256Hex("tc001-fresh-readiness")],
          census_complete: null,
          reconciliation_decision: null,
        },
      ],
    };
    const transportEvidenceHash = sha256Hex(jcsCanonicalize(transportEvidence));

    // A DRAFT→PRODUCED transition is a legal PRODUCER lifecycle move
    // (allowedLifecycleAuthorities[PRODUCED] === "PRODUCER"), and PRODUCER is
    // inside SOURCE_TRANSPORT_LOSS.recovery_authorities — so without the guard
    // one PRODUCER-signed event both advances lifecycle and clears the cause.
    const draftedRoot = sha256Hex("tc001-draft-root");

    const smugglingTransitionBody = (): ProjectionEventBodyV1 => ({
      schema_version: 1,
      event_id: "tc001-smuggling-transition",
      kind: "LIFECYCLE_TRANSITION",
      environment: "development",
      artifact_hash: draftedRoot,
      generation: "1",
      invalidation_epoch: "2",
      sequence: "3",
      previous_event_hash: sha256Hex("tc001-prev"),
      occurred_at: now,
      authority: "PRODUCER",
      lifecycle_state: "PRODUCED",
      local_status: "READY",
      state_floor: "READY",
      reason_code: "TC001_SMUGGLED_RECOVERY",
      cause_event_id: null,
      resolves_cause_event_ids: ["tc001-transport-cause"],
      replacement_evidence_hash: transportEvidenceHash,
      replacement_evidence_kinds: ["FRESH_READINESS_EVIDENCE"],
      replacement_evidence: transportEvidence,
      depends_on: [],
      production_authority: false,
    });

    it("rejects the smuggling event at the validation boundary", () => {
      // Pre-fix: validateEventBody places no constraint on LIFECYCLE_TRANSITION,
      // so this compiles cleanly. The fix must reject any non-RECOVERY kind that
      // carries resolution fields.
      expect(() =>
        compileProjectionEventV1(smugglingTransitionBody(), producer),
      ).toThrow(/resolve|recovery/i);
    });

    it("never enters the resolution path for a non-RECOVERY kind during rebuild", () => {
      let events = append(baseEvents(), {
        event_id: "tc001-activate-draft",
        kind: "ARTIFACT_ACTIVATED",
        environment: "development",
        artifact_hash: draftedRoot,
        generation: "1",
        invalidation_epoch: "0",
        authority: "PRODUCER",
        lifecycle_state: "DRAFT",
        local_status: "READY",
        state_floor: "READY",
        reason_code: "TC001_DRAFT",
        depends_on: [],
      });
      events = append(events, {
        event_id: "tc001-transport-cause",
        kind: "INVALIDATION",
        environment: "development",
        artifact_hash: draftedRoot,
        generation: "1",
        invalidation_epoch: "1",
        authority: "PRODUCER",
        lifecycle_state: "DRAFT",
        local_status: "DEGRADED",
        state_floor: "DEGRADED",
        reason_code: "SOURCE_TRANSPORT_LOSS",
        depends_on: [],
      });
      const smuggle = (): SignedProjectionEventV1[] =>
        append(events, {
          event_id: "tc001-transition-clears-cause",
          kind: "LIFECYCLE_TRANSITION",
          environment: "development",
          artifact_hash: draftedRoot,
          generation: "1",
          invalidation_epoch: "2",
          authority: "PRODUCER",
          lifecycle_state: "PRODUCED",
          local_status: "READY",
          state_floor: "READY",
          reason_code: "TC001_TRANSITION_RECOVERY",
          resolves_cause_event_ids: ["tc001-transport-cause"],
          replacement_evidence_hash: transportEvidenceHash,
          replacement_evidence_kinds: ["FRESH_READINESS_EVIDENCE"],
          replacement_evidence: transportEvidence,
          depends_on: [],
        });

      // A registry entry constructed as if the transition were a legitimate
      // recovery — this is exactly the material the length-keyed resolution
      // branch would consume. The guard must make the branch unreachable
      // regardless of what the registry contains.
      const forgedRegistry: VerifiedRecoveryEvidenceRegistryV1 = {
        [transportEvidenceHash]: compileRecoveryEvidenceVerificationV1(
          {
            environment: "development",
            artifact_hash: draftedRoot,
            generation: "1",
            invalidation_epoch: "2",
            resolves_cause_event_ids: ["tc001-transport-cause"],
            evidence_hash: transportEvidenceHash,
            evidence: transportEvidence,
            verified_artifact_hashes: [sha256Hex("tc001-fresh-readiness")],
            verifier_service_id: "sonar-staged-recovery-verifier",
            verified_at: now,
          },
          recoveryVerifier,
        ),
      };

      // Pre-fix: the transition compiles, rebuild succeeds, the cause is
      // cleared, and status flips READY — the smuggled transition acted as a
      // recovery. Post-fix: the smuggling event is rejected at validation
      // (compile time), so building/replaying the log throws.
      expect(() =>
        rebuildTruthStatusProjectionV1(
          "development",
          smuggle(),
          keys,
          forgedRegistry,
        ),
      ).toThrow(/resolve|recovery/i);
    });
  });
});
