import { mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  TRUTH_CONTRACT_PROTOCOL,
  TRUTH_REVOCATION_AUTHORITY_PRODUCER,
  TRUTH_REVOCATION_STREAM_CAPABILITY,
  TruthIntegrityError,
  TruthRevocationGapError,
  TruthTrustError,
  compileEmergencyRevocation,
  evaluateRevocationFreshness,
  emitEmergencyRevocationEnvelope,
  makeFixtureTruthSigner,
  makeFilesystemRevocationConsumerBaselineStore,
  makeInMemoryRevocationConsumerBaselineStore,
  makeInMemoryTruthRegistryStore,
  makeRevocationConsumer,
  makeTruthActivationVerifier,
  provisionFilesystemRevocationConsumerBaseline,
  rebuildTruthRegistryStatusProjection,
  signedTimeObservationBytes,
  verifyEmergencyRevocation,
  verifyEmergencyRevocationEnvelope,
  verifySignedTimeCheckpoint,
} from "../src/truth-contract/index.js";
import {
  fixtureSigners,
  jcsCanonicalize,
  ServiceKeyRegistry,
  sha256Hex,
  type TrustEnvelopeSigner,
} from "../src/collection-resolver/trust-protocol.js";

const signers = fixtureSigners();
const authority = makeFixtureTruthSigner(
  signers.orderingReplay,
  signers.orderingReplay.publicKeyHex(),
);
const forbidden = new Set([
  signers.sonarPrimary.keyId,
  signers.sonarRotated.keyId,
]);

const revocationInput = (
  sequence: string,
  targetId = "artifact-1",
  epoch = "1",
) => ({
  schema_version: 1,
  protocol: TRUTH_CONTRACT_PROTOCOL,
  environment: "staging",
  sequence,
  prior_record_sha256:
    sequence === "1"
      ? null
      : sha256Hex(
          jcsCanonicalize(
            compileRevocation(
              (BigInt(sequence) - 1n).toString(),
              `artifact-${BigInt(sequence) - 1n}`,
              epoch,
            ),
          ),
        ),
  event_id: `revocation-${sequence}`,
  target_kind: "artifact",
  target_id: targetId,
  compromised_from: "2026-07-19T04:00:00.000Z",
  revoked_at: "2026-07-19T04:01:00.000Z",
  reason: "fixture compromise",
  issuer_key_id: authority.keyId,
  epoch,
});

const compileRevocation = (sequence: string, targetId?: string, epoch?: string) =>
  Effect.runSync(
    compileEmergencyRevocation(
      revocationInput(sequence, targetId, epoch),
      authority,
      forbidden,
    ),
  );

const expectFailure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected typed failure");
  if (exit.cause._tag !== "Fail") throw new Error(`expected Fail, got ${exit.cause._tag}`);
  return exit.cause.error;
};

const timeKey = (
  sourceId: string,
  channelId: string,
  signer: TrustEnvelopeSigner,
) => ({
  sourceId,
  channelId,
  keyId: signer.keyId,
  publicKeyHex: signer.publicKeyHex(),
});

const sourceKeys = new Map([
  ["time-a", timeKey("time-a", "push-a", signers.sonarPrimary)],
  ["time-b", timeKey("time-b", "poll-b", signers.sonarRotated)],
]);

interface CheckpointOverrides {
  readonly environment?: "staging" | "production";
  readonly generation?: string;
  readonly revocationEpoch?: string;
  readonly revocationSequence?: string;
  readonly revocationRecordSha256?: string | null;
}

const checkpoint = (
  bootId: string,
  wall: string,
  monotonic: string,
  observedA = wall,
  observedB = wall,
  overrides: CheckpointOverrides = {},
) => {
  const unsigned = {
    schema_version: 1,
    protocol: TRUTH_CONTRACT_PROTOCOL,
    environment: overrides.environment ?? "staging",
    boot_id: bootId,
    generation: overrides.generation ?? "2",
    revocation_epoch: overrides.revocationEpoch ?? "1",
    revocation_sequence: overrides.revocationSequence ?? "0",
    revocation_record_sha256:
      overrides.revocationRecordSha256 !== undefined
        ? overrides.revocationRecordSha256
        : (overrides.revocationSequence ?? "0") === "0"
          ? null
          : sha256Hex(
              jcsCanonicalize(
                compileRevocation(overrides.revocationSequence ?? "0"),
              ),
            ),
    wall_clock_milliseconds: wall,
    monotonic_milliseconds: monotonic,
    recorded_at: new Date(Number(wall)).toISOString(),
  };
  const observations = [
    {
      source_id: "time-a",
      channel_id: "push-a",
      key_id: signers.sonarPrimary.keyId,
      unix_milliseconds: observedA,
      signature: signers.sonarPrimary.sign(
        signedTimeObservationBytes(
          unsigned as never,
          "time-a",
          "push-a",
          observedA as never,
        ),
      ),
    },
    {
      source_id: "time-b",
      channel_id: "poll-b",
      key_id: signers.sonarRotated.keyId,
      unix_milliseconds: observedB,
      signature: signers.sonarRotated.sign(
        signedTimeObservationBytes(
          unsigned as never,
          "time-b",
          "poll-b",
          observedB as never,
        ),
      ),
    },
  ];
  return { unsigned_checkpoint: unsigned, observations } as never;
};

const baseline = (
  revocationSequence = "0",
  revocationEpoch = "1",
  generation = "2",
) => ({
  environment: "staging",
  generation,
  revocationEpoch,
  revocationSequence,
  revocationRecordSha256:
    revocationSequence === "0"
      ? null
      : sha256Hex(jcsCanonicalize(compileRevocation(revocationSequence))),
}) as never;

const freshnessProof = (
  revocationSequence = "0",
  revocationEpoch = "1",
  priorWall = "1784433600000",
  currentWall = "1784433900000",
  priorMonotonic = "1000",
  currentMonotonic = "301000",
) =>
  Effect.runSync(
    evaluateRevocationFreshness(
      "staged",
      baseline(revocationSequence, revocationEpoch),
      checkpoint("boot-a", priorWall, priorMonotonic, priorWall, priorWall, {
        revocationEpoch,
        revocationSequence,
      }),
      checkpoint(
        "boot-a",
        currentWall,
        currentMonotonic,
        currentWall,
        currentWall,
        { revocationEpoch, revocationSequence },
      ),
      {
        wallClockMilliseconds: currentWall,
        monotonicMilliseconds: currentMonotonic,
        bootId: "boot-a",
        trustedGenerationHighWater: "2",
        pushChannelConnected: true,
        pollChannelConnected: true,
      } as never,
      sourceKeys,
    ),
  );

const consumerWithBaseline = (
  revocationSequence = "0",
  revocationEpoch = "1",
) =>
  makeRevocationConsumer(
    "staging",
    authority,
    forbidden,
    makeInMemoryRevocationConsumerBaselineStore(
      baseline(revocationSequence, revocationEpoch),
    ),
    "FIXTURE",
  );

describe("authenticated emergency revocation", () => {
  it("rejects a structural persistent-baseline imposter at runtime", () => {
    const imposter = {
      persistence: "FILESYSTEM",
      read: Effect.succeed(baseline()),
      write: () => Effect.void,
    } as never;
    const consumer = makeRevocationConsumer(
      "staging",
      authority,
      forbidden,
      imposter,
    );
    const registry = makeInMemoryTruthRegistryStore(
      makeTruthActivationVerifier(
        makeFixtureTruthSigner(
          signers.sonarPrimary,
          signers.sonarPrimary.publicKeyHex(),
        ),
      ),
    );
    expect(expectFailure(consumer.repairFromRegistry(registry))).toBeInstanceOf(
      TruthTrustError,
    );
    expect(
      expectFailure(
        rebuildTruthRegistryStatusProjection(
          registry,
          "staging",
          imposter,
          verifyEmergencyRevocation,
        ),
      ),
    ).toBeInstanceOf(TruthIntegrityError);
  });

  it("persists the revocation baseline across restart and fails closed on loss", () => {
    const volatileConsumer = makeRevocationConsumer(
      "staging",
      authority,
      forbidden,
      makeInMemoryRevocationConsumerBaselineStore(baseline()),
    );
    const emptyRegistry = makeInMemoryTruthRegistryStore(
      makeTruthActivationVerifier(
        makeFixtureTruthSigner(
          signers.sonarPrimary,
          signers.sonarPrimary.publicKeyHex(),
        ),
      ),
    );
    expectFailure(volatileConsumer.repairFromRegistry(emptyRegistry));

    const root = mkdtempSync(join(tmpdir(), "sonar-revocation-baseline-"));
    try {
      Effect.runSync(
        provisionFilesystemRevocationConsumerBaseline(root, baseline()),
      );
      const store = makeFilesystemRevocationConsumerBaselineStore(
        root,
        "staging",
      );
      Effect.runSync(store.write(baseline("1", "1")));
      expect(statSync(join(root, "baseline.json")).mode & 0o777).toBe(0o600);
      const restarted = makeFilesystemRevocationConsumerBaselineStore(
        root,
        "staging",
      );
      expect(Effect.runSync(restarted.read).revocationSequence).toBe("1");
      expectFailure(restarted.write(baseline("0", "1")));
      expectFailure(
        restarted.write({
          ...baseline("1", "1"),
          revocationRecordSha256: "0".repeat(64),
        }),
      );
      unlinkSync(join(root, "baseline.json"));
      expectFailure(restarted.read);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rides the pinned trust-envelope stream with exact header/body binding", () => {
    const issuedAt = Date.parse("2026-07-19T04:01:00.000Z");
    const tenant = sha256Hex("staging-revocation-scope");
    const record = compileRevocation("1");
    const envelope = emitEmergencyRevocationEnvelope(
      record,
      signers.orderingReplay,
      issuedAt,
      tenant,
    );
    const registry = new ServiceKeyRegistry([
      {
        signing_key_id: signers.orderingReplay.keyId,
        public_key_hex: signers.orderingReplay.publicKeyHex(),
        producer: TRUTH_REVOCATION_AUTHORITY_PRODUCER,
        capabilities: [TRUTH_REVOCATION_STREAM_CAPABILITY],
        tenant_scope_digests: [tenant],
        activated_at: "2026-07-19T03:00:00.000Z",
      },
    ]);
    expect(
      Effect.runSync(
        verifyEmergencyRevocationEnvelope(
          envelope,
          registry,
          issuedAt,
          "staging",
        ),
      ),
    ).toEqual(record);
    expectFailure(
      verifyEmergencyRevocationEnvelope(
        envelope,
        registry,
        issuedAt,
        "production",
      ),
    );
  });

  it("evicts cached green state synchronously and rejects replay", () => {
    const record = compileRevocation("1");
    const consumer = consumerWithBaseline();
    const registry = makeInMemoryTruthRegistryStore(
      makeTruthActivationVerifier(
        makeFixtureTruthSigner(
          signers.sonarPrimary,
          signers.sonarPrimary.publicKeyHex(),
        ),
        "2026-07-19T04:00:00.000Z" as never,
      ),
    );
    expect(Effect.runSync(consumer.repairFromRegistry(registry))).toEqual([]);
    Effect.runSync(consumer.establishFreshness(freshnessProof(), "301000" as never));
    Effect.runSync(consumer.cacheGreen("artifact-1", "301000" as never));
    expect(
      Effect.runSync(consumer.isGreen("artifact-1", "301000" as never)),
    ).toBe(true);
    Effect.runSync(consumer.ingest(record));
    expect(
      Effect.runSync(consumer.isGreen("artifact-1", "301001" as never)),
    ).toBe(false);
    expectFailure(consumer.cacheGreen("artifact-1", "301001" as never));
    expect(Effect.runSync(consumer.snapshot).sequence).toBe("1");
    expect(expectFailure(consumer.ingest(record))).toBeInstanceOf(TruthTrustError);
  });

  it("reconstructs revoked targets after restart and never re-caches them green", () => {
    const record = compileRevocation("1");
    const registry = makeInMemoryTruthRegistryStore(
      makeTruthActivationVerifier(
        makeFixtureTruthSigner(
          signers.sonarPrimary,
          signers.sonarPrimary.publicKeyHex(),
        ),
        "2026-07-19T04:00:00.000Z" as never,
      ),
    );
    Effect.runSync(registry.appendRevocation(record));
    const restarted = consumerWithBaseline();
    expectFailure(
      restarted.establishFreshness({
        status: "FRESH",
        environment: "staging",
        generation: "2",
        revocationEpoch: "1",
        revocationSequence: "1",
        bootId: "boot-a",
        evaluatedAtMonotonicMilliseconds: "301000",
        expiresAtMonotonicMilliseconds: "331000",
      } as never),
    );
    expect(Effect.runSync(restarted.repairFromRegistry(registry))).toEqual([
      record,
    ]);
    Effect.runSync(
      restarted.establishFreshness(
        freshnessProof("1"),
        "301000" as never,
      ),
    );
    expectFailure(restarted.cacheGreen("artifact-1", "301000" as never));
    expect(
      Effect.runSync(restarted.isGreen("artifact-1", "301000" as never)),
    ).toBe(false);
  });

  it("rejects a forged or replayed freshness proof even when its fields match", () => {
    const consumer = consumerWithBaseline();
    const registry = makeInMemoryTruthRegistryStore(
      makeTruthActivationVerifier(
        makeFixtureTruthSigner(
          signers.sonarPrimary,
          signers.sonarPrimary.publicKeyHex(),
        ),
      ),
    );
    Effect.runSync(consumer.repairFromRegistry(registry));
    const proof = freshnessProof();
    const forged = { ...proof };
    expectFailure(
      consumer.establishFreshness(forged as never, "301000" as never),
    );
    Effect.runSync(
      consumer.establishFreshness(proof, "301000" as never),
    );
    expectFailure(
      consumer.establishFreshness(proof, "301000" as never),
    );
  });

  it("expires green cache leases and can recover with a newer proof", () => {
    const consumer = consumerWithBaseline();
    const registry = makeInMemoryTruthRegistryStore(
      makeTruthActivationVerifier(
        makeFixtureTruthSigner(
          signers.sonarPrimary,
          signers.sonarPrimary.publicKeyHex(),
        ),
      ),
    );
    Effect.runSync(consumer.repairFromRegistry(registry));
    Effect.runSync(
      consumer.establishFreshness(freshnessProof(), "301000" as never),
    );
    Effect.runSync(consumer.cacheGreen("artifact-safe", "301000" as never));
    expect(
      Effect.runSync(
        consumer.isGreen("artifact-safe", "331001" as never),
      ),
    ).toBe(false);
    expectFailure(
      consumer.cacheGreen("artifact-safe", "331001" as never),
    );

    const renewed = freshnessProof(
      "0",
      "1",
      "1784433900000",
      "1784434200000",
      "301000",
      "601000",
    );
    Effect.runSync(
      consumer.establishFreshness(renewed, "601000" as never),
    );
    Effect.runSync(consumer.cacheGreen("artifact-safe", "601000" as never));
    expect(
      Effect.runSync(
        consumer.isGreen("artifact-safe", "601000" as never),
      ),
    ).toBe(true);
  });

  it("rejects a registry that becomes empty after an accepted revocation", () => {
    const highWater = makeInMemoryRevocationConsumerBaselineStore(baseline());
    const consumer = makeRevocationConsumer(
      "staging",
      authority,
      forbidden,
      highWater,
      "FIXTURE",
    );
    const emptyRegistry = makeInMemoryTruthRegistryStore(
      makeTruthActivationVerifier(
        makeFixtureTruthSigner(
          signers.sonarPrimary,
          signers.sonarPrimary.publicKeyHex(),
        ),
      ),
    );
    Effect.runSync(consumer.repairFromRegistry(emptyRegistry));
    Effect.runSync(consumer.ingest(compileRevocation("1")));
    const restarted = makeRevocationConsumer(
      "staging",
      authority,
      forbidden,
      highWater,
      "FIXTURE",
    );
    expectFailure(restarted.repairFromRegistry(emptyRegistry));
  });

  it("rejects a substituted persisted prefix even when the attacker supplies a valid chained suffix", () => {
    const originalFirst = compileRevocation("1", "artifact-1");
    const persisted = makeInMemoryRevocationConsumerBaselineStore({
      ...baseline("1", "1"),
      revocationRecordSha256: sha256Hex(
        jcsCanonicalize(originalFirst),
      ),
    });
    const consumer = makeRevocationConsumer(
      "staging",
      authority,
      forbidden,
      persisted,
      "FIXTURE",
    );
    const alternateFirst = compileRevocation("1", "alternate-artifact");
    const alternateSecond = Effect.runSync(
      compileEmergencyRevocation(
        {
          ...revocationInput("2", "artifact-2"),
          prior_record_sha256: sha256Hex(
            jcsCanonicalize(alternateFirst),
          ),
        },
        authority,
        forbidden,
      ),
    );
    const baseRegistry = makeInMemoryTruthRegistryStore(
      makeTruthActivationVerifier(
        makeFixtureTruthSigner(
          signers.sonarPrimary,
          signers.sonarPrimary.publicKeyHex(),
        ),
      ),
    );
    expectFailure(
      consumer.repairFromRegistry({
        ...baseRegistry,
        readRevocations: () =>
          Effect.succeed([alternateFirst, alternateSecond]),
      }),
    );
  });

  it("surfaces exact repair range on a gap and repairs from registry fallback", () => {
    const first = compileRevocation("1", "artifact-1");
    const second = compileRevocation("2", "artifact-2");
    const third = compileRevocation("3", "artifact-3");
    const consumer = consumerWithBaseline();
    const registry = makeInMemoryTruthRegistryStore(
      makeTruthActivationVerifier(
        makeFixtureTruthSigner(
          signers.sonarPrimary,
          signers.sonarPrimary.publicKeyHex(),
        ),
        "2026-07-19T04:00:00.000Z" as never,
      ),
    );
    Effect.runSync(consumer.repairFromRegistry(registry));
    Effect.runSync(consumer.ingest(first));
    const gap = expectFailure(consumer.ingest(third));
    expect(gap).toBeInstanceOf(TruthRevocationGapError);
    expect((gap as TruthRevocationGapError).expected_sequence).toBe("2");

    Effect.runSync(registry.appendRevocation(first));
    Effect.runSync(registry.appendRevocation(second));
    expect(Effect.runSync(consumer.repairFromRegistry(registry))).toEqual([second]);
    expect(Effect.runSync(consumer.snapshot).sequence).toBe("2");
  });

  it("rejects unauthorized principals, tamper, rollback epoch, and wrong environment", () => {
    const producerSigner = makeFixtureTruthSigner(
      signers.sonarPrimary,
      signers.sonarPrimary.publicKeyHex(),
    );
    expectFailure(
      compileEmergencyRevocation(
        {
          ...revocationInput("1"),
          issuer_key_id: producerSigner.keyId,
        },
        producerSigner,
        forbidden,
      ),
    );
    expectFailure(
      compileEmergencyRevocation(
        { ...revocationInput("1"), untrusted_extra: true },
        authority,
        forbidden,
      ),
    );
    const record = compileRevocation("1");
    const tampered = { ...record, reason: "changed" };
    expectFailure(
      verifyEmergencyRevocation(
        tampered,
        authority,
        "staging",
        "1" as never,
        null,
        "1" as never,
        forbidden,
      ),
    );
    expectFailure(
      verifyEmergencyRevocation(
        record,
        authority,
        "production",
        "1" as never,
        null,
        "1" as never,
        forbidden,
      ),
    );
    expectFailure(
      verifyEmergencyRevocation(
        record,
        authority,
        "staging",
        "1" as never,
        null,
        "2" as never,
        forbidden,
      ),
    );
  });
});

describe("signed revocation freshness", () => {
  it("requires two independent agreeing signed-time sources", () => {
    const valid = checkpoint("boot-a", "1784433600000", "1000");
    expect(Effect.runSync(verifySignedTimeCheckpoint(valid, sourceKeys))).toEqual(
      valid,
    );
    const tampered = structuredClone(valid);
    tampered.unsigned_checkpoint.wall_clock_milliseconds =
      "1784433601000" as never;
    expectFailure(verifySignedTimeCheckpoint(tampered, sourceKeys));
    const disagree = checkpoint(
      "boot-a",
      "1784433600000",
      "1000",
      "1784433600000",
      "1784433640001",
    );
    expectFailure(verifySignedTimeCheckpoint(disagree, sourceKeys));

    const aliasKeys = new Map([
      ["time-a", timeKey("time-a", "push-a", signers.sonarPrimary)],
      [
        "time-b",
        {
          ...timeKey("time-b", "poll-b", signers.sonarRotated),
          publicKeyHex: signers.sonarPrimary.publicKeyHex(),
        },
      ],
    ]);
    expectFailure(verifySignedTimeCheckpoint(valid, aliasKeys));

    const wrongChannel = new Map([
      ["time-a", timeKey("time-a", "not-push-a", signers.sonarPrimary)],
      ["time-b", timeKey("time-b", "poll-b", signers.sonarRotated)],
    ]);
    expectFailure(verifySignedTimeCheckpoint(valid, wrongChannel));
  });

  it("allows staged offline age up to 15 minutes and detects stale or channel loss", () => {
    const prior = checkpoint("boot-a", "1784433600000", "1000");
    const current = checkpoint("boot-a", "1784433900000", "301000");
    const observation = {
      wallClockMilliseconds: "1784434500000",
      monotonicMilliseconds: "901000",
      bootId: "boot-a",
      trustedGenerationHighWater: "2",
      pushChannelConnected: false,
      pollChannelConnected: true,
    } as const;
    expect(
      Effect.runSync(
        evaluateRevocationFreshness(
          "staged",
          baseline(),
          prior,
          current,
          observation as never,
          sourceKeys,
        ),
      ),
    ).toMatchObject({ status: "FRESH", environment: "staging" });
    expectFailure(
      evaluateRevocationFreshness(
        "staged",
        baseline(),
        prior,
        current,
        {
          ...observation,
          wallClockMilliseconds: "1784434800001",
        } as never,
        sourceKeys,
      ),
    );
    expectFailure(
      evaluateRevocationFreshness(
        "staged",
        baseline(),
        prior,
        current,
        {
          ...observation,
          pushChannelConnected: false,
          pollChannelConnected: false,
        } as never,
        sourceKeys,
      ),
    );
  });

  it("suspends missing startup state, clock rollback, and snapshot restore", () => {
    const prior = checkpoint("boot-a", "1784433600000", "1000");
    const rollback = checkpoint("boot-a", "1784433599000", "999");
    const observation = {
      wallClockMilliseconds: "1784433599000",
      monotonicMilliseconds: "999",
      bootId: "boot-a",
      trustedGenerationHighWater: "2",
      pushChannelConnected: true,
      pollChannelConnected: true,
    };
    expectFailure(
      evaluateRevocationFreshness(
        "staged",
        baseline(),
        null,
        prior,
        observation as never,
        sourceKeys,
      ),
    );
    expectFailure(
      evaluateRevocationFreshness(
        "staged",
        baseline(),
        prior,
        rollback,
        observation as never,
        sourceKeys,
      ),
    );
  });

  it("accepts a reboot only with a fresh two-source checkpoint", () => {
    const prior = checkpoint("boot-a", "1784433600000", "1000");
    const rebooted = checkpoint("boot-b", "1784433900000", "50");
    expect(
      Effect.runSync(
        evaluateRevocationFreshness(
          "staged",
          baseline(),
          prior,
          rebooted,
          {
            wallClockMilliseconds: "1784433900000",
            monotonicMilliseconds: "50",
            bootId: "boot-b",
            trustedGenerationHighWater: "2",
            pushChannelConnected: true,
            pollChannelConnected: true,
          } as never,
          sourceKeys,
        ),
      ),
    ).toMatchObject({ status: "FRESH", environment: "staging" });
  });

  it("rejects wrong environment, future generation, and lower epoch or sequence", () => {
    const observation = {
      wallClockMilliseconds: "1784433900000",
      monotonicMilliseconds: "301000",
      bootId: "boot-a",
      trustedGenerationHighWater: "2",
      pushChannelConnected: true,
      pollChannelConnected: true,
    } as never;
    const prior = checkpoint("boot-a", "1784433600000", "1000");

    expectFailure(
      evaluateRevocationFreshness(
        "staged",
        baseline(),
        prior,
        checkpoint(
          "boot-a",
          "1784433900000",
          "301000",
          "1784433900000",
          "1784433900000",
          { environment: "production" },
        ),
        observation,
        sourceKeys,
      ),
    );
    expectFailure(
      evaluateRevocationFreshness(
        "staged",
        baseline(),
        prior,
        checkpoint(
          "boot-a",
          "1784433900000",
          "301000",
          "1784433900000",
          "1784433900000",
          { generation: "3" },
        ),
        observation,
        sourceKeys,
      ),
    );
    expectFailure(
      evaluateRevocationFreshness(
        "staged",
        baseline("0", "1"),
        checkpoint(
          "boot-a",
          "1784433600000",
          "1000",
          "1784433600000",
          "1784433600000",
          { revocationEpoch: "2" },
        ),
        checkpoint("boot-a", "1784433900000", "301000"),
        observation,
        sourceKeys,
      ),
    );
    expectFailure(
      evaluateRevocationFreshness(
        "staged",
        baseline("0", "1"),
        checkpoint(
          "boot-a",
          "1784433600000",
          "1000",
          "1784433600000",
          "1784433600000",
          { revocationSequence: "1" },
        ),
        checkpoint("boot-a", "1784433900000", "301000"),
        observation,
        sourceKeys,
      ),
    );
  });
});
