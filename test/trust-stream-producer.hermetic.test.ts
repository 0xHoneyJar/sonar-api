import { describe, expect, it } from "vitest";
import {
  createStreamConsumerState,
  FIXTURE_STREAM_ID,
  ingestTrustEnvelope,
  installEpochBaseline,
  requestGapRepairRange,
  TrustEnvelopeRejectedError,
  verifyTrustEnvelope,
} from "../src/collection-resolver/trust-protocol.js";
import {
  CAPABILITY_EVIDENCE_CAPABILITY,
  createPublicTrustStreamProducer,
  fixtureCapabilityEvidenceBody,
  fixtureOwnershipEvidenceBody,
  loadSharedProducerConsumerFixtures,
  SONAR_PUBLIC_CAPABILITY_STREAM_ID,
  SONAR_PUBLIC_OWNERSHIP_STREAM_ID,
  TrustStreamProducerError,
} from "../src/collection-resolver/trust-stream-producer/index.js";

describe("CR-011A public trust-stream producer (Sonar)", () => {
  const fixtures = loadSharedProducerConsumerFixtures();

  it("vendored trust-envelope protocol fixtures verify before producer tests", () => {
    for (const scenario of fixtures.bundle.envelopes.filter((entry) => entry.expect === "accept")) {
      expect(() =>
        verifyTrustEnvelope({
          envelope: scenario.envelope,
          registry: fixtures.registry,
          acceptedAtMs: fixtures.acceptedAtMs,
        }),
      ).not.toThrow();
    }
  });

  it("emits capability and ownership envelopes that pass CR-009 verification", () => {
    const issuedAtMs = Date.parse("2026-07-17T21:00:00.000Z");
    const producer = createPublicTrustStreamProducer({
      signer: fixtures.signers.sonarPrimary,
      registry: fixtures.registry,
      issuedAtMs: () => issuedAtMs,
    });

    const capability = producer.appendCapabilityEvidence({
      eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      body: fixtureCapabilityEvidenceBody(),
    });
    const ownership = producer.appendOwnershipEvidence({
      eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      body: fixtureOwnershipEvidenceBody(),
    });

    expect(capability.header.stream_id).toBe(SONAR_PUBLIC_CAPABILITY_STREAM_ID);
    expect(capability.header.sequence).toBe(1);
    expect(capability.header.capability).toBe(CAPABILITY_EVIDENCE_CAPABILITY);
    expect(ownership.header.stream_id).toBe(SONAR_PUBLIC_OWNERSHIP_STREAM_ID);
    expect(ownership.header.sequence).toBe(1);

    for (const envelope of [capability, ownership]) {
      expect(() =>
        verifyTrustEnvelope({
          envelope,
          registry: fixtures.registry,
          acceptedAtMs: fixtures.acceptedAtMs,
        }),
      ).not.toThrow();
    }
  });

  it("allocates contiguous sequences atomically with the outbox", () => {
    const issuedAtMs = Date.parse("2026-07-17T21:00:00.000Z");
    const producer = createPublicTrustStreamProducer({
      signer: fixtures.signers.sonarPrimary,
      registry: fixtures.registry,
      issuedAtMs: () => issuedAtMs,
    });

    const first = producer.appendCapabilityEvidence({
      eventId: "11111111-1111-4111-8111-111111111111",
      body: fixtureCapabilityEvidenceBody({ capability_state: "ready" }),
    });
    const second = producer.appendCapabilityEvidence({
      eventId: "22222222-2222-4222-8222-222222222222",
      body: fixtureCapabilityEvidenceBody({ capability_state: "degraded" }),
    });

    expect(first.header.sequence).toBe(1);
    expect(second.header.sequence).toBe(2);

    const replay = producer.replayRange({
      streamId: SONAR_PUBLIC_CAPABILITY_STREAM_ID,
      streamEpoch: 1,
      fromSequence: 1,
      toSequence: 2,
    });
    expect(replay.map((entry) => entry.header.sequence)).toEqual([1, 2]);
  });

  it("rejects duplicate event_id at the producer boundary", () => {
    const issuedAtMs = Date.parse("2026-07-17T21:00:00.000Z");
    const producer = createPublicTrustStreamProducer({
      signer: fixtures.signers.sonarPrimary,
      registry: fixtures.registry,
      issuedAtMs: () => issuedAtMs,
    });

    producer.appendCapabilityEvidence({
      eventId: "33333333-3333-4333-8333-333333333333",
      body: fixtureCapabilityEvidenceBody(),
    });

    expect(() =>
      producer.appendCapabilityEvidence({
        eventId: "33333333-3333-4333-8333-333333333333",
        body: fixtureCapabilityEvidenceBody({ capability_state: "retry" }),
      }),
    ).toThrowError(TrustStreamProducerError);

    let state = createStreamConsumerState(SONAR_PUBLIC_CAPABILITY_STREAM_ID, 1);
    const first = producer.replayRange({
      streamId: SONAR_PUBLIC_CAPABILITY_STREAM_ID,
      streamEpoch: 1,
      fromSequence: 1,
      toSequence: 1,
    })[0]!;
    const accepted = ingestTrustEnvelope({
      envelope: first,
      registry: fixtures.registry,
      acceptedAtMs: fixtures.acceptedAtMs,
      state,
    });
    expect(accepted.kind).toBe("accepted");
    state = accepted.state;

    const replay = ingestTrustEnvelope({
      envelope: first,
      registry: fixtures.registry,
      acceptedAtMs: fixtures.acceptedAtMs,
      state,
    });
    expect(replay.kind).toBe("rejected");
    if (replay.kind === "rejected") {
      expect(replay.error.reason).toBe("event_id_replay");
    }
  });

  it("never emits sequence gaps and surfaces gap repair on consumer ingest", () => {
    const issuedAtMs = Date.parse("2026-07-17T21:00:00.000Z");
    const producer = createPublicTrustStreamProducer({
      signer: fixtures.signers.sonarPrimary,
      registry: fixtures.registry,
      issuedAtMs: () => issuedAtMs,
    });

    producer.appendCapabilityEvidence({
      eventId: "11111111-1111-4111-8111-111111111111",
      body: fixtureCapabilityEvidenceBody(),
    });
    producer.appendCapabilityEvidence({
      eventId: "22222222-2222-4222-8222-222222222222",
      body: fixtureCapabilityEvidenceBody(),
    });

    const gapFixture = fixtures.bundle.envelopes.find((entry) => entry.id === "sequence-gap");
    expect(gapFixture).toBeDefined();

    let state = createStreamConsumerState(FIXTURE_STREAM_ID, 1);
    for (const envelope of fixtures.bundle.envelopes.filter((entry) =>
      ["valid-primary", "rotation-overlap-new-key"].includes(entry.id),
    )) {
      const result = ingestTrustEnvelope({
        envelope: envelope.envelope,
        registry: fixtures.registry,
        acceptedAtMs: fixtures.acceptedAtMs,
        state,
      });
      expect(result.kind).toBe("accepted");
      if (result.kind === "accepted") state = result.state;
    }

    const gapResult = ingestTrustEnvelope({
      envelope: gapFixture!.envelope,
      registry: fixtures.registry,
      acceptedAtMs: fixtures.acceptedAtMs,
      state,
    });
    expect(gapResult.kind).toBe("rejected");
    if (gapResult.kind === "rejected") {
      expect(gapResult.error.reason).toBe("sequence_gap");
      expect(requestGapRepairRange(gapResult.state)).toEqual({ fromSequence: 3, toSequence: 5 });
    }

    const sequences = producer.replayRange({
      streamId: SONAR_PUBLIC_CAPABILITY_STREAM_ID,
      streamEpoch: 1,
      fromSequence: 1,
      toSequence: 10,
    }).map((entry) => entry.header.sequence);
    for (let index = 1; index < sequences.length; index++) {
      expect(sequences[index]).toBe(sequences[index - 1]! + 1);
    }
  });

  it("seals epoch reset with signed baseline before advancing sequence", () => {
    const issuedAtMs = Date.parse("2026-07-17T21:00:00.000Z");
    const producer = createPublicTrustStreamProducer({
      signer: fixtures.signers.sonarPrimary,
      registry: fixtures.registry,
      issuedAtMs: () => issuedAtMs,
    });

    producer.appendCapabilityEvidence({
      eventId: "11111111-1111-4111-8111-111111111111",
      body: fixtureCapabilityEvidenceBody(),
    });
    producer.appendCapabilityEvidence({
      eventId: "22222222-2222-4222-8222-222222222222",
      body: fixtureCapabilityEvidenceBody(),
    });

    const baseline = producer.signEpochBaseline({
      streamId: SONAR_PUBLIC_CAPABILITY_STREAM_ID,
      streamEpoch: 1,
      issuedAtMs,
    });
    expect(baseline.stream_epoch).toBe(2);

    producer.resetEpoch({
      streamId: SONAR_PUBLIC_CAPABILITY_STREAM_ID,
      newEpoch: 2,
      baseline,
    });

    const epochTwo = producer.appendCapabilityEvidence({
      eventId: "66666666-6666-4666-8666-666666666666",
      body: fixtureCapabilityEvidenceBody({ capability_state: "epoch-two" }),
    });
    expect(epochTwo.header.stream_epoch).toBe(2);
    expect(epochTwo.header.sequence).toBe(1);

    let state = createStreamConsumerState(SONAR_PUBLIC_CAPABILITY_STREAM_ID, 1);
    for (const envelope of producer.replayRange({
      streamId: SONAR_PUBLIC_CAPABILITY_STREAM_ID,
      streamEpoch: 1,
      fromSequence: 1,
      toSequence: 2,
    })) {
      const result = ingestTrustEnvelope({
        envelope,
        registry: fixtures.registry,
        acceptedAtMs: fixtures.acceptedAtMs,
        state,
      });
      expect(result.kind).toBe("accepted");
      if (result.kind === "accepted") state = result.state;
    }

    state = installEpochBaseline({
      baseline,
      registry: fixtures.registry,
      acceptedAtMs: fixtures.acceptedAtMs,
      state,
      expectedBaselineDigest: baseline.baseline_digest,
    });

    const resumedOldEpoch = ingestTrustEnvelope({
      envelope: producer.replayRange({
        streamId: SONAR_PUBLIC_CAPABILITY_STREAM_ID,
        streamEpoch: 1,
        fromSequence: 1,
        toSequence: 1,
      })[0]!,
      registry: fixtures.registry,
      acceptedAtMs: fixtures.acceptedAtMs,
      state,
    });
    expect(resumedOldEpoch.kind).toBe("rejected");
    if (resumedOldEpoch.kind === "rejected") {
      expect(resumedOldEpoch.error.reason).toBe("epoch_resume_forbidden");
    }
  });

  it("rejects revoked and not-yet-active signing keys at verification", () => {
    const issuedAtMs = Date.parse("2026-07-17T21:00:00.000Z");
    const revoked = fixtures.bundle.envelopes.find((entry) => entry.id === "revoked-key");
    expect(revoked).toBeDefined();
    expect(() =>
      verifyTrustEnvelope({
        envelope: revoked!.envelope,
        registry: fixtures.registry,
        acceptedAtMs: fixtures.acceptedAtMs,
      }),
    ).toThrow(TrustEnvelopeRejectedError);

    expect(() =>
      createPublicTrustStreamProducer({
        signer: fixtures.signers.sonarRevoked,
        registry: fixtures.registry,
        issuedAtMs: () => issuedAtMs,
      }).appendCapabilityEvidence({
        eventId: "33333333-3333-4333-8333-333333333333",
        body: fixtureCapabilityEvidenceBody(),
      }),
    ).toThrowError(TrustStreamProducerError);

    const beforeActivation = Date.parse("2026-06-15T00:00:00.000Z");
    expect(() =>
      createPublicTrustStreamProducer({
        signer: fixtures.signers.sonarPrimary,
        registry: fixtures.registry,
        issuedAtMs: () => beforeActivation,
      }).appendCapabilityEvidence({
        eventId: "44444444-4444-4444-8444-444444444444",
        body: fixtureCapabilityEvidenceBody(),
      }),
    ).toThrowError(TrustStreamProducerError);
  });

  it("failover clone restores outbox state and continues contiguous emission", () => {
    const clock = { now: Date.parse("2026-07-17T21:00:00.000Z") };
    const producer = createPublicTrustStreamProducer({
      signer: fixtures.signers.sonarPrimary,
      registry: fixtures.registry,
      issuedAtMs: () => clock.now,
    });

    producer.appendCapabilityEvidence({
      eventId: "11111111-1111-4111-8111-111111111111",
      body: fixtureCapabilityEvidenceBody(),
    });
    producer.appendCapabilityEvidence({
      eventId: "22222222-2222-4222-8222-222222222222",
      body: fixtureCapabilityEvidenceBody(),
    });

    const restored = producer.failoverClone();
    clock.now = Date.parse("2026-07-17T21:00:05.000Z");
    const third = restored.appendCapabilityEvidence({
      eventId: "33333333-3333-4333-8333-333333333333",
      body: fixtureCapabilityEvidenceBody({ capability_state: "after-failover" }),
    });

    expect(third.header.sequence).toBe(3);
    const replay = restored.replayRange({
      streamId: SONAR_PUBLIC_CAPABILITY_STREAM_ID,
      streamEpoch: 1,
      fromSequence: 1,
      toSequence: 3,
    });
    expect(replay).toHaveLength(3);
    expect(replay[0]!.header.event_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(replay[2]!.header.event_id).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("loads shared producer-consumer fixture bundle from vendored package", () => {
    expect(fixtures.bundle.schema_version).toBe(1);
    expect(fixtures.bundle.envelopes.some((entry) => entry.id === "valid-primary")).toBe(true);
  });
});
