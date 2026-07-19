import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  jcsCanonicalize,
  LocalEd25519TrustSigner,
  sha256Hex,
} from "../src/collection-resolver/trust-protocol.js";
import { compileProjectionEventV1 } from "../src/truth-contract/invalidation.js";
import {
  compileTruthInspectionEnvelopeV1,
  makeTruthInspector,
  projectionDigestForInspectionV1,
  verifyTruthInspectionEnvelopeV1,
} from "../src/truth-contract/status-reader.js";
import type {
  TruthInspectionArtifactV1,
  TruthInspectionSnapshotV1,
} from "../src/truth-contract/schemas/inspection.js";
import { decodeStrict } from "../src/truth-contract/schemas/common.js";
import { TruthInspectionSnapshotV1 as SnapshotSchema } from "../src/truth-contract/schemas/inspection.js";

const digest = (value: string) => sha256Hex(value);
const now = "2026-07-19T08:47:42.000Z";
const deadline = "2026-07-26T08:47:42.000Z";
const signer = LocalEd25519TrustSigner.fromSeedHex(
  "ad".repeat(32),
  "sonar-staged-publisher",
);

const artifacts = [
  {
    artifact_hash: digest("producer"),
    artifact_kind: "producer_readiness",
    effective_status: "READY",
    reason_codes: ["PRODUCER_READY"],
    expires_at: "2026-07-19T09:47:42.000Z",
    dependencies: [],
    evidence_refs: [digest("live-observation")],
  },
  {
    artifact_hash: digest("reconciliation"),
    artifact_kind: "reconciliation",
    effective_status: "READY",
    reason_codes: ["RECONCILED_STAGED"],
    expires_at: "2026-07-19T09:47:42.000Z",
    dependencies: [digest("producer")],
    evidence_refs: [digest("reconciliation-receipt")],
  },
  {
    artifact_hash: digest("score"),
    artifact_kind: "score_consumption",
    effective_status: "NOT_READY",
    reason_codes: ["NOT_CONSUMED"],
    expires_at: null,
    dependencies: [digest("reconciliation")],
    evidence_refs: [digest("not-consumed-receipt")],
  },
  {
    artifact_hash: digest("live"),
    artifact_kind: "live_proof",
    effective_status: "NOT_READY",
    reason_codes: ["NOT_CONSUMED"],
    expires_at: null,
    dependencies: [digest("score")],
    evidence_refs: [],
  },
  {
    artifact_hash: digest("graduation"),
    artifact_kind: "graduation",
    effective_status: "NOT_READY",
    reason_codes: ["NOT_CONSUMED"],
    expires_at: null,
    dependencies: [digest("live")],
    evidence_refs: [],
  },
] as const;

const snapshot = (
  overrides: Record<string, unknown> = {},
): TruthInspectionSnapshotV1 => {
  const projection = overrides.artifacts ?? artifacts;
  return Effect.runSync(
    decodeStrict(SnapshotSchema, "test.truth-inspection", {
      schema_version: 1,
      environment: "staging",
      collection_id: "mibera",
      canonical_address: "0x6666397dfe9a8c469bf65dc744cb1c733416c420",
      chain_id: "80094",
      event_signature: "Transfer(address,address,uint256)",
      validity_class: "STAGED_CURRENT",
      producer_root_hash: digest("root"),
      producer_generation: "1",
      invalidation_epoch: "0",
      identity_snapshot_hash: digest("identity"),
      reconciliation_hash: digest("reconciliation-receipt"),
      score_receipt_hash: digest("not-consumed-receipt"),
      score_state: "NOT_CONSUMED",
      score_owner: "bd-v54z.1",
      score_deadline: deadline,
      publisher_key_id: signer.keyId,
      trust_root_generation: "1",
      revocation_sequence: "0",
      cache_kind: "EXPLICIT_OFFLINE_CACHE",
      cached_at: now,
      authority_validity: "STAGED_VALID",
      production_authority: false,
      observed_at: now,
      expires_at: "2026-07-19T09:47:42.000Z",
      artifacts: projection,
      served_projection_digest: projectionDigestForInspectionV1(
        projection as readonly TruthInspectionArtifactV1[],
      ),
      rebuilt_projection_digest: projectionDigestForInspectionV1(
        projection as readonly TruthInspectionArtifactV1[],
      ),
      ...overrides,
    }),
  );
};

const projectionEvents = (projection: readonly TruthInspectionArtifactV1[]) => {
  let previous: ReturnType<typeof compileProjectionEventV1> | null = null;
  return projection.map((artifact, index) => {
    const lifecycle =
      artifact.artifact_kind === "producer_readiness"
        ? "PRODUCED"
        : artifact.artifact_kind === "reconciliation"
          ? "RECONCILED"
          : artifact.artifact_kind === "score_consumption" &&
              artifact.effective_status === "READY"
            ? "CONSUMED"
            : artifact.artifact_kind === "live_proof" &&
                artifact.effective_status === "READY"
              ? "LIVE_PROVEN"
              : artifact.artifact_kind === "graduation" &&
                  artifact.effective_status === "READY"
                ? "GRADUATED"
                : "RECONCILED";
    const authority =
      lifecycle === "PRODUCED"
        ? "PRODUCER"
        : lifecycle === "CONSUMED"
          ? "SCORE"
          : lifecycle === "LIVE_PROVEN"
            ? "SERVING"
            : lifecycle === "GRADUATED"
              ? "GOVERNANCE"
              : "RECONCILER";
    const event = compileProjectionEventV1(
      {
        schema_version: 1,
        event_id: `inspection-event-${index + 1}`,
        sequence: String(index + 1),
        previous_event_hash:
          previous === null ? null : sha256Hex(jcsCanonicalize(previous)),
        kind: "ARTIFACT_ACTIVATED",
        environment: "staging",
        artifact_hash: artifact.artifact_hash,
        generation: "1",
        invalidation_epoch: "0",
        authority,
        lifecycle_state: lifecycle,
        local_status: artifact.effective_status,
        state_floor: artifact.effective_status,
        reason_code: artifact.reason_codes[0] ?? "STATUS_UNSPECIFIED",
        cause_event_id: null,
        resolves_cause_event_ids: [],
        replacement_evidence_hash: null,
        replacement_evidence_kinds: null,
        replacement_evidence: null,
        depends_on: artifact.dependencies,
        occurred_at: now,
        production_authority: false,
      },
      signer,
    );
    previous = event;
    return event;
  });
};

const envelopeFor = (value: TruthInspectionSnapshotV1) =>
  Effect.runSync(
    compileTruthInspectionEnvelopeV1(
      value,
      projectionEvents(value.artifacts),
      [
        {
          key_id: signer.keyId,
          public_key_hex: signer.publicKeyHex(),
          authorities: [
            "PRODUCER",
            "RECONCILER",
            "GOVERNANCE",
          ],
        },
      ],
      signer,
    ),
  );

const pinFor = (
  envelope: ReturnType<typeof envelopeFor>,
  overrides: Record<string, string> = {},
) => ({
  keyId: signer.keyId,
  publicKeyHex: signer.publicKeyHex(),
  envelopeHash: envelope.envelope_hash,
  trustRootGeneration: "1",
  revocationSequence: "0",
  ...overrides,
});

const source = (overrides: Record<string, unknown> = {}) =>
  (() => {
    const envelope = envelopeFor(snapshot(overrides));
    return Effect.runSync(
      verifyTruthInspectionEnvelopeV1(envelope, pinFor(envelope)),
    );
  })();

describe("truth-contract status reader", () => {
  it("verifies a pinned signed envelope and returns exact producer states", async () => {
    const inspector = makeTruthInspector(source());
    await expect(
      Effect.runPromise(inspector.status("mibera", "staging", "produced", now)),
    ).resolves.toMatchObject({
      target_state: "produced",
      target_ready: true,
      lifecycle: "PRODUCED",
      effective_status: "READY",
    });
    await expect(
      Effect.runPromise(
        inspector.status("mibera", "staging", "reconciled_staged", now),
      ),
    ).resolves.toMatchObject({
      target_ready: true,
      lifecycle: "RECONCILED",
      display_state: "RECONCILED_STAGED",
    });
    await expect(
      Effect.runPromise(inspector.status("mibera", "staging", "consumed", now)),
    ).resolves.toMatchObject({
      target_ready: false,
      display_state: "NOT_CONSUMED",
      blocking_owner: "bd-v54z.1",
      blocking_deadline: deadline,
    });
  });

  it("rejects a tampered envelope and a wrong explicit trust pin", () => {
    const envelope = structuredClone(envelopeFor(snapshot()));
    envelope.unsigned_envelope.snapshot.artifacts[0]!.reason_codes = [
      "TAMPERED",
    ] as never;
    expect(() =>
      Effect.runSync(
        verifyTruthInspectionEnvelopeV1(envelope, pinFor(envelope)),
      ),
    ).toThrow(/signature or digest/);
    const validEnvelope = envelopeFor(snapshot());
    expect(() =>
      Effect.runSync(
        verifyTruthInspectionEnvelopeV1(
          validEnvelope,
          pinFor(validEnvelope, { keyId: "wrong-publisher" }),
        ),
      ),
    ).toThrow(/explicit trust pin/);
  });

  it("rebuilds from signed events and rejects a caller-supplied divergent digest", async () => {
    expect(() =>
      source({ rebuilt_projection_digest: digest("untrusted-claim") }),
    ).toThrow(/differs from signed replay/);
    const inspector = makeTruthInspector(source());
    await expect(
      Effect.runPromise(inspector.rebuild("staging")),
    ).resolves.toMatchObject({ equal: true });

    const envelope = envelopeFor(snapshot());
    const forged = structuredClone(envelope);
    forged.unsigned_envelope.projection_events[0]!.signature =
      envelope.unsigned_envelope.projection_events[1]!.signature;
    const rehashed = Effect.runSync(
      compileTruthInspectionEnvelopeV1(
        forged.unsigned_envelope.snapshot,
        forged.unsigned_envelope.projection_events,
        forged.unsigned_envelope.projection_authorities,
        signer,
      ),
    );
    expect(() =>
      Effect.runSync(
        verifyTruthInspectionEnvelopeV1(rehashed, pinFor(rehashed)),
      ),
    ).toThrow(/did not rebuild/);
  });

  it("rejects replay after envelope, trust-root, or revocation pin advances", () => {
    const envelope = envelopeFor(snapshot());
    for (const mismatch of [
      { envelopeHash: digest("new-envelope") },
      { trustRootGeneration: "2" },
      { revocationSequence: "1" },
    ]) {
      expect(() =>
        Effect.runSync(
          verifyTruthInspectionEnvelopeV1(
            envelope,
            pinFor(envelope, mismatch),
          ),
        ),
      ).toThrow(
        /signature or digest|explicit trust pin|generation or revocation sequence/,
      );
    }
  });

  it("derives artifact expiry and NotConsumed overdue state at query time", async () => {
    const expiredArtifacts = structuredClone(artifacts) as Array<
      TruthInspectionArtifactV1
    >;
    expiredArtifacts[0] = {
      ...expiredArtifacts[0]!,
      expires_at: "2026-07-19T08:47:41.999Z" as never,
    };
    await expect(
      Effect.runPromise(
        makeTruthInspector(source({ artifacts: expiredArtifacts })).status(
          "mibera",
          "staging",
          "produced",
          now,
        ),
      ),
    ).resolves.toMatchObject({
      target_ready: false,
      effective_status: "EXPIRED",
      reason_codes: expect.arrayContaining(["ARTIFACT_EXPIRED"]),
    });

    const later = "2026-07-27T00:00:00.000Z";
    const longLived = structuredClone(artifacts) as Array<
      TruthInspectionArtifactV1
    >;
    longLived[0]!.expires_at = "2026-07-30T00:00:00.000Z" as never;
    longLived[1]!.expires_at = "2026-07-30T00:00:00.000Z" as never;
    await expect(
      Effect.runPromise(
        makeTruthInspector(
          source({
            artifacts: longLived,
            expires_at: "2026-07-30T00:00:00.000Z",
          }),
        ).status("mibera", "staging", "consumed", later as never),
      ),
    ).resolves.toMatchObject({
      target_ready: false,
      display_state: "NOT_CONSUMED_OVERDUE",
      reason_codes: expect.arrayContaining(["NOT_CONSUMED_OVERDUE"]),
    });
  });

  it("rejects Sonar-minted Score claims and never promotes staged end-to-end targets", async () => {
    expect(() =>
      snapshot({
        score_state: "CONSUMED",
        authority_validity: "AUTHORITY_VALID",
      }),
    ).toThrow();

    const inspector = makeTruthInspector(source());
    for (const target of ["consumed", "live_proven", "graduated"] as const) {
      await expect(
        Effect.runPromise(
          inspector.status("mibera", "staging", target, now),
        ),
      ).resolves.toMatchObject({
        target_ready: false,
        effective_status: "SUSPENDED",
        reason_codes: expect.arrayContaining([
          "STAGED_INSPECTION_SCORE_AUTHORITY_REFUSED",
        ]),
      });
    }
  });

  it("rejects a publisher-signed projection that self-selects Score authority", () => {
    const scoreReadyArtifacts = structuredClone(artifacts) as Array<
      TruthInspectionArtifactV1
    >;
    scoreReadyArtifacts[2] = {
      ...scoreReadyArtifacts[2]!,
      effective_status: "READY",
      reason_codes: ["SCORE_CONSUMED"],
    } as never;
    expect(() =>
      Effect.runSync(
        compileTruthInspectionEnvelopeV1(
          snapshot({ artifacts: scoreReadyArtifacts }),
          projectionEvents(scoreReadyArtifacts),
          [
            {
              key_id: signer.keyId,
              public_key_hex: signer.publicKeyHex(),
              authorities: ["PRODUCER", "RECONCILER", "SCORE"] as never,
            },
          ],
          signer,
        ),
      ),
    ).toThrow();
  });
});
