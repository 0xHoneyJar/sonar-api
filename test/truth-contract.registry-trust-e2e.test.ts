import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  TRUTH_CONTRACT_PROTOCOL,
  TRUTH_NORMATIVE_OBJECT_KINDS,
  applyTrustBootstrapReceipt,
  bootstrapObservationSigningBytes,
  compileEmergencyRevocation,
  compileTruthAuditEvent,
  compileTrustBootstrap,
  compileTruthBundleRoot,
  compileTruthGenerationActivation,
  makeFixtureTruthSigner,
  makeInMemoryBootstrapEquivocationLedger,
  makeInMemoryRevocationConsumerBaselineStore,
  makeInMemoryTrustedGenerationStore,
  makeInMemoryTruthRegistryStore,
  makeTruthActivationVerifier,
  makeTruthAuditVerifier,
  makeRevocationConsumer,
  rebuildTruthRegistryStatusProjection,
  verifyEmergencyRevocation,
  verifyTruthGenerationActivationForAdvance,
} from "../src/truth-contract/index.js";
import {
  fixtureSigners,
  jcsCanonicalize,
  LocalEd25519TrustSigner,
  sha256Hex,
} from "../src/collection-resolver/trust-protocol.js";
import goldenProjection from "./fixtures/truth-contract/golden-registry-projection-v1.json";

const signers = fixtureSigners();
const recoverySecond = LocalEd25519TrustSigner.fromSeedHex(
  "4444444444444444444444444444444444444444444444444444444444444444",
  "recovery-fixture-second",
);
const channelA = LocalEd25519TrustSigner.fromSeedHex(
  "5555555555555555555555555555555555555555555555555555555555555555",
  "bootstrap-channel-a",
);
const channelB = LocalEd25519TrustSigner.fromSeedHex(
  "6666666666666666666666666666666666666666666666666666666666666666",
  "bootstrap-channel-b",
);
const producer = makeFixtureTruthSigner(
  signers.sonarPrimary,
  signers.sonarPrimary.publicKeyHex(),
);
const revocationAuthority = makeFixtureTruthSigner(
  signers.orderingReplay,
  signers.orderingReplay.publicKeyHex(),
);
const forbiddenRevocationPrincipals = new Set([
  producer.keyId,
  signers.sonarRotated.keyId,
]);
const encoder = new TextEncoder();
const trustKey = (signer: typeof channelA) => ({
  key_id: signer.keyId,
  algorithm: "Ed25519",
  public_key_hex: signer.publicKeyHex(),
  valid_from: "2026-07-19T04:00:00.000Z",
  valid_until: null,
});

const compileBootstrapFixture = () =>
  Effect.runSync(
    compileTrustBootstrap({
      schema_version: 1,
      protocol: TRUTH_CONTRACT_PROTOCOL,
      environment: "staging",
      bootstrap_generation: "1",
      producer_root: trustKey(signers.sonarPrimary),
      governance_quorum: {
        threshold: "2",
        keys: [trustKey(signers.sonarRotated), trustKey(signers.sonarRevoked)],
      },
      recovery_quorum: {
        threshold: "2",
        keys: [trustKey(signers.orderingReplay), trustKey(recoverySecond)],
      },
      issued_at: "2026-07-19T04:00:00.000Z",
    }),
  );

const bootstrapReceipt = (digest: string) => {
  const unsigned = [
    {
      channel_id: "release-channel-a",
      operator_id: "operator-a",
      credential_id: "credential-a",
      bundle_digest: digest,
      observed_at: "2026-07-19T04:00:00.000Z",
    },
    {
      channel_id: "release-channel-b",
      operator_id: "operator-b",
      credential_id: "credential-b",
      bundle_digest: digest,
      observed_at: "2026-07-19T04:00:00.000Z",
    },
  ];
  return {
    schema_version: 1,
    environment: "staging",
    observations: unsigned.map((observation, index) => ({
      ...observation,
      signature: (index === 0 ? channelA : channelB).sign(
        bootstrapObservationSigningBytes("staging", observation as never),
      ),
    })),
  };
};

const compileGeneration = () => {
  const objects = TRUTH_NORMATIVE_OBJECT_KINDS.map((kind) => {
    const bytes = encoder.encode(jcsCanonicalize({ kind, fixture: "sprint-2-e2e" }));
    return {
      kind,
      bytes,
      ref: {
        kind,
        media_type: "application/json",
        sha256: sha256Hex(bytes),
        byte_length: bytes.byteLength.toString(),
      },
    };
  });
  const byKind = new Map(objects.map((object) => [object.kind, object.ref]));
  const root = Effect.runSync(
    compileTruthBundleRoot(
      {
        schema_version: 1,
        protocol: TRUTH_CONTRACT_PROTOCOL,
        environment: "staging",
        generation: "1",
        supersedes_generation: null,
        objects: objects.map((object) => object.ref),
        issuer: { service_id: "sonar-api", key_id: producer.keyId },
        issued_at: "2026-07-19T04:00:00.000Z",
        valid_from: "2026-07-19T04:00:00.000Z",
        compatibility_version: "sonar-score.v1",
        authority_matrix_hash: byKind.get("authority_matrix")!.sha256,
        security_profile_hash: byKind.get("security_profile")!.sha256,
      },
      signers.sonarPrimary,
    ),
  );
  const activation = Effect.runSync(
    compileTruthGenerationActivation(
      {
        schema_version: 1,
        protocol: TRUTH_CONTRACT_PROTOCOL,
        environment: "staging",
        prior_generation: "0",
        generation: "1",
        root,
        audit_sequence: "1",
        audit_prior_record_sha256: null,
        audit_recorded_at: "2026-07-19T04:00:00.000Z",
        prepared_at: "2026-07-19T04:00:00.000Z",
        issuer: { service_id: "sonar-api", key_id: producer.keyId },
      },
      producer,
      "2026-07-19T04:00:00.000Z" as never,
    ),
  );
  return { objects, activation };
};

describe("Sprint 2 registry and trust end-to-end conformance", () => {
  it("publishes one complete generation, revokes, repairs, and rebuilds a stable projection", () => {
    const store = makeInMemoryTruthRegistryStore(
      makeTruthActivationVerifier(
        producer,
        "2026-07-19T04:00:00.000Z" as never,
      ),
      makeTruthAuditVerifier(producer),
    );
    const highWater = makeInMemoryTrustedGenerationStore();
    const { objects, activation } = compileGeneration();

    Effect.runSync(
      verifyTruthGenerationActivationForAdvance(
        activation,
        producer,
        "staging",
        "0" as never,
        "2026-07-19T04:00:00.000Z" as never,
      ),
    );
    for (const object of objects) {
      Effect.runSync(
        store.putObjectIfAbsent(
          "staging",
          object.ref.sha256 as never,
          object.bytes,
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
              recorded_at: "2026-07-19T04:00:00.000Z",
              issuer_key_id: producer.keyId,
            },
            producer,
          ),
        ),
      ),
    );
    Effect.runSync(
      store.compareAndSwapRoot(
        "staging",
        "0" as never,
        activation,
      ),
    );
    const bootstrap = compileBootstrapFixture();
    Effect.runSync(
      applyTrustBootstrapReceipt(
        bootstrap,
        bootstrapReceipt(bootstrap.bundle_digest),
        "staging",
        new Map([
          [
            "credential-a",
            {
              keyId: channelA.keyId,
              publicKeyHex: channelA.publicKeyHex(),
              channelId: "release-channel-a",
              operatorId: "operator-a",
            },
          ],
          [
            "credential-b",
            {
              keyId: channelB.keyId,
              publicKeyHex: channelB.publicKeyHex(),
              channelId: "release-channel-b",
              operatorId: "operator-b",
            },
          ],
        ]),
        makeInMemoryBootstrapEquivocationLedger(),
        activation,
        {
          now: Effect.succeed("2026-07-19T04:00:00.000Z" as never),
          unixMilliseconds: Effect.succeed("1784433600000" as never),
        },
        highWater,
      ),
    );

    const revocation = Effect.runSync(
      compileEmergencyRevocation(
        {
          schema_version: 1,
          protocol: TRUTH_CONTRACT_PROTOCOL,
          environment: "staging",
          sequence: "1",
          prior_record_sha256: null,
          event_id: "revocation-e2e-1",
          target_kind: "artifact",
          target_id: activation.unsigned_activation.root.root_hash,
          compromised_from: "2026-07-19T04:00:00.000Z",
          revoked_at: "2026-07-19T04:01:00.000Z",
          reason: "end-to-end compromise fixture",
          issuer_key_id: revocationAuthority.keyId,
          epoch: "1",
        },
        revocationAuthority,
        forbiddenRevocationPrincipals,
      ),
    );
    Effect.runSync(store.appendRevocation(revocation));
    const revocationBaseline =
      makeInMemoryRevocationConsumerBaselineStore({
        environment: "staging",
        generation: "1",
        revocationEpoch: "0",
        revocationSequence: "0",
        revocationRecordSha256: null,
      } as never);
    const consumer = makeRevocationConsumer(
      "staging",
      revocationAuthority,
      forbiddenRevocationPrincipals,
      revocationBaseline,
      "FIXTURE",
    );
    expect(Effect.runSync(consumer.repairFromRegistry(store))).toEqual([
      revocation,
    ]);
    expect(
      Effect.runSyncExit(
        consumer.cacheGreen(activation.unsigned_activation.root.root_hash),
      )._tag,
    ).toBe("Failure");
    expect(
      Effect.runSync(
        consumer.isGreen(activation.unsigned_activation.root.root_hash),
      ),
    ).toBe(false);

    const projection = Effect.runSync(
      rebuildTruthRegistryStatusProjection(
        store,
        "staging",
        revocationBaseline,
        (
          record,
          expectedSequence,
          expectedPriorRecordSha256,
          minimumEpoch,
        ) =>
          verifyEmergencyRevocation(
            record,
            revocationAuthority,
            "staging",
            expectedSequence,
            expectedPriorRecordSha256,
            minimumEpoch,
            forbiddenRevocationPrincipals,
          ),
        "FIXTURE",
      ),
    );
    expect(projection).toEqual(goldenProjection);
  });
});
