import { Context, Effect, Schema, SynchronizedRef } from "effect";

import {
  emitTrustEnvelope,
  jcsCanonicalize,
  sha256Hex,
  verifyTrustEnvelope,
  verifyEd25519Signature,
  type ServiceKeyRegistry,
  type TrustEnvelope,
  type TrustEnvelopeSigner,
} from "../collection-resolver/trust-protocol.js";
import { hashCanonicalTruthJson } from "./canonical.js";
import { TruthIntegrityError, TruthTrustError } from "./errors.js";
import {
  DecimalUint64,
  type TruthEnvironmentId,
} from "./schemas/common.js";
import { decodeStrict } from "./schemas/common.js";
import { SignedTimeCheckpointV1 } from "./schemas/revocation.js";
import {
  TruthRevocationRecordV1,
  TruthRevocationUnsignedV1,
} from "./schemas/registry.js";
import type {
  TruthRegistryStoreService,
  TruthSignerService,
} from "./services.js";
import { isFilesystemRevocationConsumerBaselineStore } from "./revocation-baseline-store.js";

const encoder = new TextEncoder();
const STAGED_MAX_OFFLINE_MS = 15 * 60 * 1_000;
const STAGED_MAX_CLOCK_SKEW_MS = 30 * 1_000;
const FRESHNESS_LEASE_MS = 30 * 1_000;
export const TRUTH_REVOCATION_STREAM_CAPABILITY =
  "sonar.truth.emergency-revocation.v1";
export const TRUTH_REVOCATION_AUTHORITY_PRODUCER =
  "sonar-revocation-authority";

export class TruthRevocationGapError extends Schema.TaggedError<TruthRevocationGapError>()(
  "TruthRevocationGapError",
  {
    expected_sequence: DecimalUint64,
    received_sequence: DecimalUint64,
  },
) {}

export interface RevocationFreshnessProof {
  readonly status: "FRESH";
  readonly environment: TruthEnvironmentId;
  readonly generation: DecimalUint64;
  readonly revocationEpoch: DecimalUint64;
  readonly revocationSequence: DecimalUint64;
  readonly revocationRecordSha256: string | null;
  readonly bootId: string;
  readonly evaluatedAtMonotonicMilliseconds: DecimalUint64;
  readonly expiresAtMonotonicMilliseconds: DecimalUint64;
}

interface VerifiedFreshnessProofMetadata {
  readonly environment: TruthEnvironmentId;
  readonly generation: DecimalUint64;
  readonly revocationEpoch: DecimalUint64;
  readonly revocationSequence: DecimalUint64;
  readonly revocationRecordSha256: string | null;
  readonly evaluatedAtMonotonicMilliseconds: DecimalUint64;
  readonly expiresAtMonotonicMilliseconds: DecimalUint64;
}

const verifiedFreshnessProofs = new WeakMap<
  RevocationFreshnessProof,
  VerifiedFreshnessProofMetadata
>();

const trustFailure = (boundary: string, reason: string): TruthTrustError =>
  new TruthTrustError({ boundary, reason });

const revocationUnsigned = (record: TruthRevocationRecordV1) => ({
  schema_version: record.schema_version,
  protocol: record.protocol,
  environment: record.environment,
  sequence: record.sequence,
  prior_record_sha256: record.prior_record_sha256,
  event_id: record.event_id,
  target_kind: record.target_kind,
  target_id: record.target_id,
  compromised_from: record.compromised_from,
  revoked_at: record.revoked_at,
  reason: record.reason,
  issuer_key_id: record.issuer_key_id,
  epoch: record.epoch,
});

export const emergencyRevocationSigningBytes = (
  environment: TruthEnvironmentId,
  epoch: DecimalUint64,
  sequence: DecimalUint64,
  bodyHash: string,
): Uint8Array =>
  encoder.encode(
    `sonar.truth-emergency-revocation.v1\0${environment}\0${epoch}\0${sequence}\0${bodyHash}`,
  );

export const compileEmergencyRevocation = (
  input: unknown,
  authoritySigner: TruthSignerService,
  forbiddenPrincipalKeyIds: ReadonlySet<string>,
): Effect.Effect<
  TruthRevocationRecordV1,
  TruthTrustError | TruthIntegrityError
> =>
  Effect.gen(function* () {
    const unsigned = yield* decodeStrict(
      TruthRevocationUnsignedV1,
      "truth.revocation.unsigned",
      input,
    ).pipe(
      Effect.mapError(() =>
        trustFailure(
          "truth.revocation.compile",
          "unsigned revocation schema is invalid",
        ),
      ),
    );
    if (
      forbiddenPrincipalKeyIds.has(authoritySigner.keyId) ||
      unsigned.issuer_key_id !== authoritySigner.keyId
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.revocation.compile",
          "revocation authority must be distinct from producer and reconciler",
        ),
      );
    }
    const compromised = new Date(String(unsigned.compromised_from)).getTime();
    const revoked = new Date(String(unsigned.revoked_at)).getTime();
    if (!Number.isFinite(compromised) || !Number.isFinite(revoked) || revoked < compromised) {
      return yield* Effect.fail(
        trustFailure("truth.revocation.compile", "revocation chronology is invalid"),
      );
    }
    const bodyHash = yield* hashCanonicalTruthJson(
      unsigned,
      "truth.revocation.body",
    );
    const signature = yield* authoritySigner.sign(
      unsigned.environment,
      emergencyRevocationSigningBytes(
        unsigned.environment,
        unsigned.epoch,
        unsigned.sequence,
        bodyHash,
      ),
    );
    return yield* decodeStrict(
      TruthRevocationRecordV1,
      "truth.revocation.signed",
      { ...unsigned, body_hash: bodyHash, signature },
    ).pipe(
      Effect.mapError(() =>
        trustFailure("truth.revocation.compile", "signed revocation is invalid"),
      ),
    );
  });

export const verifyEmergencyRevocation = (
  recordInput: unknown,
  authoritySigner: TruthSignerService,
  expectedEnvironment: TruthEnvironmentId,
  expectedSequence: DecimalUint64,
  expectedPriorRecordSha256: string | null,
  minimumEpoch: DecimalUint64,
  forbiddenPrincipalKeyIds: ReadonlySet<string>,
): Effect.Effect<
  TruthRevocationRecordV1,
  TruthTrustError | TruthIntegrityError | TruthRevocationGapError
> =>
  Effect.gen(function* () {
    const record = yield* decodeStrict(
      TruthRevocationRecordV1,
      "truth.revocation.verify",
      recordInput,
    ).pipe(
      Effect.mapError(() =>
        trustFailure("truth.revocation.verify", "revocation schema is invalid"),
      ),
    );
    if (record.sequence !== expectedSequence) {
      if (BigInt(record.sequence) > BigInt(expectedSequence)) {
        return yield* new TruthRevocationGapError({
          expected_sequence: expectedSequence,
          received_sequence: record.sequence,
        });
      }
      return yield* Effect.fail(
        trustFailure("truth.revocation.verify", "revocation replay rejected"),
      );
    }
    const unsigned = revocationUnsigned(record);
    const actualHash = yield* hashCanonicalTruthJson(
      unsigned,
      "truth.revocation.verify_body",
    );
    if (
      record.environment !== expectedEnvironment ||
      record.issuer_key_id !== authoritySigner.keyId ||
      forbiddenPrincipalKeyIds.has(record.issuer_key_id) ||
      BigInt(record.epoch) < BigInt(minimumEpoch) ||
      record.prior_record_sha256 !== expectedPriorRecordSha256 ||
      record.body_hash !== actualHash ||
      new Date(record.revoked_at).getTime() <
        new Date(record.compromised_from).getTime()
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.revocation.verify",
          "revocation authority, epoch, chronology, or digest is invalid",
        ),
      );
    }
    yield* authoritySigner.verify(
      expectedEnvironment,
      emergencyRevocationSigningBytes(
        expectedEnvironment,
        record.epoch,
        record.sequence,
        record.body_hash,
      ),
      record.signature,
    );
    return record;
  });

export const emitEmergencyRevocationEnvelope = (
  record: TruthRevocationRecordV1,
  signer: TrustEnvelopeSigner,
  issuedAtMilliseconds: number,
  tenantScopeDigest: string,
): TrustEnvelope => {
  const sequence = Number(record.sequence);
  const epoch = Number(record.epoch);
  if (
    !Number.isSafeInteger(sequence) ||
    !Number.isSafeInteger(epoch) ||
    signer.keyId !== record.issuer_key_id
  ) {
    throw trustFailure(
      "truth.revocation.envelope",
      "revocation sequence, epoch, or envelope signer is invalid",
    );
  }
  return emitTrustEnvelope({
    signer,
    producer: TRUTH_REVOCATION_AUTHORITY_PRODUCER,
    contract: {
      name: "sonar-truth-emergency-revocation",
      major_version: 1,
      minor_version: 0,
    },
    eventId: record.event_id,
    streamId: `sonar.truth.revocation.v1.${record.environment}`,
    streamEpoch: epoch,
    sequence,
    trustStream: true,
    issuedAtMs: issuedAtMilliseconds,
    ttlMs: STAGED_MAX_OFFLINE_MS,
    tenantScopeDigest,
    capability: TRUTH_REVOCATION_STREAM_CAPABILITY,
    body: record,
  });
};

export const verifyEmergencyRevocationEnvelope = (
  envelope: TrustEnvelope,
  registry: ServiceKeyRegistry,
  acceptedAtMilliseconds: number,
  expectedEnvironment: TruthEnvironmentId,
): Effect.Effect<TruthRevocationRecordV1, TruthTrustError> =>
  Effect.try({
    try: () => {
      verifyTrustEnvelope({
        envelope,
        registry,
        acceptedAtMs: acceptedAtMilliseconds,
      });
      if (
        envelope.header.producer !== TRUTH_REVOCATION_AUTHORITY_PRODUCER ||
        envelope.header.capability !== TRUTH_REVOCATION_STREAM_CAPABILITY ||
        envelope.header.stream_id !==
          `sonar.truth.revocation.v1.${expectedEnvironment}` ||
        envelope.header.trust_stream !== true
      ) {
        throw new Error("revocation envelope route binding is invalid");
      }
      const record = Schema.decodeUnknownSync(TruthRevocationRecordV1, {
        errors: "all",
        onExcessProperty: "error",
      })(envelope.body);
      const headerSequence = envelope.header.sequence;
      const headerEpoch = envelope.header.stream_epoch;
      if (
        !Number.isSafeInteger(headerSequence) ||
        !Number.isSafeInteger(headerEpoch) ||
        headerSequence < 0 ||
        headerEpoch < 0 ||
        record.environment !== expectedEnvironment ||
        BigInt(record.sequence) !== BigInt(headerSequence) ||
        BigInt(record.epoch) !== BigInt(headerEpoch) ||
        record.event_id !== envelope.header.event_id ||
        record.issuer_key_id !== envelope.header.signing_key_id
      ) {
        throw new Error("revocation body and envelope header are not identical");
      }
      return record;
    },
    catch: (cause) =>
      trustFailure(
        "truth.revocation.envelope",
        cause instanceof Error ? cause.message : "revocation envelope rejected",
      ),
  });

interface RevocationConsumerState {
  readonly sequence: DecimalUint64;
  readonly epoch: DecimalUint64;
  readonly revocationRecordSha256: string | null;
  readonly generation: DecimalUint64;
  readonly baselineLoaded: boolean;
  readonly freshness: VerifiedFreshnessProofMetadata | null;
  readonly greenTargets: ReadonlySet<string>;
  readonly revokedTargets: ReadonlySet<string>;
}

export interface RevocationConsumerBaseline {
  readonly environment: TruthEnvironmentId;
  readonly generation: DecimalUint64;
  readonly revocationEpoch: DecimalUint64;
  readonly revocationSequence: DecimalUint64;
  readonly revocationRecordSha256: string | null;
}

export interface RevocationConsumerBaselineStore {
  readonly read: Effect.Effect<RevocationConsumerBaseline | null, TruthTrustError>;
  readonly write: (
    baseline: RevocationConsumerBaseline,
  ) => Effect.Effect<void, TruthTrustError>;
}

export const RevocationConsumerBaselineStore =
  Context.GenericTag<RevocationConsumerBaselineStore>(
    "sonar/truth-contract/RevocationConsumerBaselineStore",
  );

export const makeInMemoryRevocationConsumerBaselineStore = (
  initial: RevocationConsumerBaseline,
): RevocationConsumerBaselineStore => {
  const value = SynchronizedRef.unsafeMake<RevocationConsumerBaseline>(initial);
  return {
    read: SynchronizedRef.get(value),
    write: (baseline) => SynchronizedRef.set(value, baseline),
  };
};

export interface RevocationConsumer {
  readonly establishFreshness: (
    proof: RevocationFreshnessProof,
    monotonicMilliseconds?: DecimalUint64,
  ) => Effect.Effect<void, TruthTrustError>;
  readonly cacheGreen: (
    targetId: string,
    monotonicMilliseconds?: DecimalUint64,
  ) => Effect.Effect<void, TruthTrustError>;
  readonly isGreen: (
    targetId: string,
    monotonicMilliseconds?: DecimalUint64,
  ) => Effect.Effect<boolean>;
  readonly ingest: (
    record: unknown,
  ) => Effect.Effect<
    TruthRevocationRecordV1,
    TruthTrustError | TruthIntegrityError | TruthRevocationGapError
  >;
  readonly repairFromRegistry: (
    registry: TruthRegistryStoreService,
  ) => Effect.Effect<
    ReadonlyArray<TruthRevocationRecordV1>,
    | TruthTrustError
    | TruthIntegrityError
    | TruthRevocationGapError
    | import("./errors.js").TruthRegistryError
  >;
  readonly snapshot: Effect.Effect<RevocationConsumerState>;
}

export const makeRevocationConsumer = (
  environment: TruthEnvironmentId,
  authoritySigner: TruthSignerService,
  forbiddenPrincipalKeyIds: ReadonlySet<string>,
  persistedBaselineStore?: RevocationConsumerBaselineStore,
  executionMode: "RUNTIME" | "FIXTURE" = "RUNTIME",
): RevocationConsumer => {
  const baselineStore: RevocationConsumerBaselineStore =
    persistedBaselineStore ?? {
      read: Effect.succeed(null),
      write: () => Effect.void,
    };
  const baselinePersistenceAccepted =
    isFilesystemRevocationConsumerBaselineStore(baselineStore) ||
    executionMode === "FIXTURE";
  const state = SynchronizedRef.unsafeMake<RevocationConsumerState>({
    sequence: "0" as DecimalUint64,
    epoch: "0" as DecimalUint64,
    revocationRecordSha256: null,
    generation: "0" as DecimalUint64,
    baselineLoaded: false,
    freshness: null,
    greenTargets: new Set<string>(),
    revokedTargets: new Set<string>(),
  });
  const expireFreshness = (
    current: RevocationConsumerState,
    monotonicMilliseconds: DecimalUint64 | undefined,
  ): RevocationConsumerState => {
    if (
      current.freshness === null ||
      monotonicMilliseconds === undefined ||
      BigInt(monotonicMilliseconds) <
        BigInt(current.freshness.evaluatedAtMonotonicMilliseconds) ||
      BigInt(monotonicMilliseconds) >
        BigInt(current.freshness.expiresAtMonotonicMilliseconds)
    ) {
      return {
        ...current,
        freshness: null,
        greenTargets: new Set<string>(),
      };
    }
    return current;
  };
  const ingestVerified = (recordInput: unknown) =>
    SynchronizedRef.modifyEffect(state, (current) =>
      Effect.gen(function* () {
        if (
          !current.baselineLoaded ||
          !baselinePersistenceAccepted
        ) {
          return yield* Effect.fail(
            trustFailure(
              "truth.revocation.consumer",
              "SUSPENDED: durable registry baseline must be loaded before ingest",
            ),
          );
        }
        const expected = (BigInt(current.sequence) + 1n).toString() as DecimalUint64;
        const record = yield* verifyEmergencyRevocation(
          recordInput,
          authoritySigner,
          environment,
          expected,
          current.revocationRecordSha256,
          current.epoch,
          forbiddenPrincipalKeyIds,
        );
        const greenTargets = new Set(current.greenTargets);
        greenTargets.delete(record.target_id);
        const revokedTargets = new Set(current.revokedTargets);
        revokedTargets.add(record.target_id);
        yield* baselineStore.write({
          environment,
          generation: current.generation,
          revocationEpoch: record.epoch,
          revocationSequence: record.sequence,
          revocationRecordSha256: sha256Hex(jcsCanonicalize(record)),
        });
        return [
          record,
          {
            sequence: record.sequence,
            epoch: record.epoch,
            revocationRecordSha256: sha256Hex(jcsCanonicalize(record)),
            generation: current.generation,
            baselineLoaded: current.baselineLoaded,
            freshness: null,
            greenTargets,
            revokedTargets,
          },
        ] as const;
      }),
    );
  const suspend = <E>(error: E): Effect.Effect<never, E> =>
    SynchronizedRef.update(state, (current) => ({
      ...current,
      baselineLoaded: false,
      freshness: null,
      greenTargets: new Set<string>(),
    })).pipe(Effect.zipRight(Effect.fail(error)));
  const ingest = (recordInput: unknown) =>
    ingestVerified(recordInput).pipe(Effect.catchAll(suspend));
  return {
    establishFreshness: (proof, monotonicMilliseconds) =>
      SynchronizedRef.modifyEffect(state, (current) =>
        Effect.gen(function* () {
          const verified = verifiedFreshnessProofs.get(proof);
          if (verified !== undefined) {
            verifiedFreshnessProofs.delete(proof);
          }
          if (
            verified === undefined ||
            monotonicMilliseconds === undefined ||
            !baselinePersistenceAccepted ||
            !current.baselineLoaded ||
            verified.environment !== environment ||
            verified.generation !== current.generation ||
            verified.revocationEpoch !== current.epoch ||
            verified.revocationSequence !== current.sequence ||
            verified.revocationRecordSha256 !==
              current.revocationRecordSha256 ||
            BigInt(monotonicMilliseconds) <
              BigInt(verified.evaluatedAtMonotonicMilliseconds) ||
            BigInt(monotonicMilliseconds) >
              BigInt(verified.expiresAtMonotonicMilliseconds)
          ) {
            return yield* Effect.fail(
              trustFailure(
                "truth.revocation.consumer",
                "SUSPENDED: freshness proof does not match the durable registry baseline",
              ),
            );
          }
          return [
            undefined,
            { ...current, freshness: verified },
          ] as const;
        }),
      ),
    cacheGreen: (targetId, monotonicMilliseconds) =>
      SynchronizedRef.modify(state, (current) => {
        const checked = expireFreshness(current, monotonicMilliseconds);
        if (
          !checked.baselineLoaded ||
          checked.freshness === null ||
          checked.revokedTargets.has(targetId)
        ) {
          return [
            false,
            checked,
          ] as const;
        }
        return [
          true,
          {
            ...checked,
            greenTargets: new Set(checked.greenTargets).add(targetId),
          },
        ] as const;
      }).pipe(
        Effect.flatMap((cached) =>
          cached
            ? Effect.void
            : Effect.fail(
                trustFailure(
                  "truth.revocation.consumer",
                  "SUSPENDED: target is revoked or revocation state is not fresh",
                ),
              ),
        ),
      ),
    isGreen: (targetId, monotonicMilliseconds) =>
      SynchronizedRef.modify(state, (current) => {
        const checked = expireFreshness(current, monotonicMilliseconds);
        return [
          checked.baselineLoaded &&
            checked.freshness !== null &&
            !checked.revokedTargets.has(targetId) &&
            checked.greenTargets.has(targetId),
          checked,
        ] as const;
      }),
    ingest,
    repairFromRegistry: (registry) =>
      Effect.gen(function* () {
        if (!baselinePersistenceAccepted) {
          return yield* Effect.fail(
            trustFailure(
              "truth.revocation.consumer",
              "SUSPENDED: runtime consumers require a persistent revocation baseline",
            ),
          );
        }
        const records = yield* registry.readRevocations(environment);
        const current = yield* SynchronizedRef.get(state);
        const persisted = yield* baselineStore.read;
        if (persisted !== null && persisted.environment !== environment) {
          return yield* Effect.fail(
            trustFailure(
              "truth.revocation.consumer",
              "SUSPENDED: persisted revocation baseline has the wrong environment",
            ),
          );
        }
        const persistedSequence =
          persisted?.revocationSequence ?? ("0" as DecimalUint64);
        const persistedEpoch =
          persisted?.revocationEpoch ?? ("0" as DecimalUint64);
        const registrySequence =
          records.at(-1)?.sequence ?? ("0" as DecimalUint64);
        const registryEpoch =
          records.at(-1)?.epoch ?? persistedEpoch;
        const registryRecordSha256 =
          records.length === 0
            ? null
            : sha256Hex(jcsCanonicalize(records.at(-1)!));
        const persistedPrefix =
          persistedSequence === "0"
            ? null
            : records.find(
                (record) => record.sequence === persistedSequence,
              );
        const persistedPrefixMatches =
          persistedSequence === "0"
            ? persisted?.revocationRecordSha256 === null ||
              persisted?.revocationRecordSha256 === undefined
            : persistedPrefix !== undefined &&
              sha256Hex(jcsCanonicalize(persistedPrefix)) ===
                persisted?.revocationRecordSha256;
        if (
          BigInt(registrySequence) < BigInt(current.sequence) ||
          BigInt(registrySequence) < BigInt(persistedSequence) ||
          BigInt(registryEpoch) < BigInt(current.epoch) ||
          BigInt(registryEpoch) < BigInt(persistedEpoch) ||
          !persistedPrefixMatches
        ) {
          return yield* Effect.fail(
            trustFailure(
              "truth.revocation.consumer",
              "SUSPENDED: registry baseline was reset, truncated, or rolled back",
            ),
          );
        }
        const accepted: TruthRevocationRecordV1[] = [];
        const revokedTargets = new Set<string>();
        let expected = "1" as DecimalUint64;
        let epoch = "0" as DecimalUint64;
        let priorRecordSha256: string | null = null;
        for (const record of records) {
          const verified = yield* verifyEmergencyRevocation(
            record,
            authoritySigner,
            environment,
            expected,
            priorRecordSha256,
            epoch,
            forbiddenPrincipalKeyIds,
          );
          revokedTargets.add(verified.target_id);
          if (BigInt(verified.sequence) > BigInt(current.sequence)) {
            accepted.push(verified);
          }
          expected = (BigInt(expected) + 1n).toString() as DecimalUint64;
          epoch = verified.epoch;
          priorRecordSha256 = sha256Hex(jcsCanonicalize(verified));
        }
        const generation =
          persisted?.generation ?? current.generation;
        const nextBaseline: RevocationConsumerBaseline = {
          environment,
          generation,
          revocationEpoch: registryEpoch,
          revocationSequence: registrySequence,
          revocationRecordSha256: registryRecordSha256,
        };
        yield* baselineStore.write(nextBaseline);
        yield* SynchronizedRef.update(state, () => ({
          sequence: registrySequence,
          epoch: registryEpoch,
          revocationRecordSha256: registryRecordSha256,
          generation,
          baselineLoaded: true,
          freshness: null,
          greenTargets: new Set<string>(),
          revokedTargets,
        }));
        return accepted;
      }).pipe(Effect.catchAll(suspend)),
    snapshot: SynchronizedRef.get(state),
  };
};

export interface SignedTimeKey {
  readonly sourceId: string;
  readonly channelId: string;
  readonly keyId: string;
  readonly publicKeyHex: string;
}

export const signedTimeObservationBytes = (
  checkpoint: SignedTimeCheckpointV1["unsigned_checkpoint"],
  sourceId: string,
  channelId: string,
  unixMilliseconds: DecimalUint64,
): Uint8Array =>
  encoder.encode(
    `sonar.truth-signed-time.v1\0${jcsCanonicalize({
      checkpoint,
      source_id: sourceId,
      channel_id: channelId,
      unix_milliseconds: unixMilliseconds,
    })}`,
  );

export const verifySignedTimeCheckpoint = (
  checkpointInput: unknown,
  sourceKeys: ReadonlyMap<string, SignedTimeKey>,
): Effect.Effect<SignedTimeCheckpointV1, TruthTrustError> =>
  Effect.gen(function* () {
    const checkpoint = yield* decodeStrict(
      SignedTimeCheckpointV1,
      "truth.revocation.signed_time",
      checkpointInput,
    ).pipe(
      Effect.mapError(() =>
        trustFailure("truth.revocation.signed_time", "checkpoint schema is invalid"),
      ),
    );
    const sourceIds = checkpoint.observations.map((item) => String(item.source_id));
    const channelIds = checkpoint.observations.map((item) =>
      String(item.channel_id),
    );
    const keyIds = checkpoint.observations.map((item) => String(item.key_id));
    const configuredPublicKeys = checkpoint.observations.map(
      (item) => sourceKeys.get(item.source_id)?.publicKeyHex.toLowerCase(),
    );
    if (
      new Set(sourceIds).size !== 2 ||
      new Set(channelIds).size !== 2 ||
      new Set(keyIds).size !== 2 ||
      configuredPublicKeys.some((key) => key === undefined) ||
      new Set(configuredPublicKeys).size !== 2
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.revocation.signed_time",
          "two independent signed-time source, channel, and key identities are required",
        ),
      );
    }
    const times = checkpoint.observations.map((item) =>
      BigInt(item.unix_milliseconds),
    );
    if (times[0] === undefined || times[1] === undefined || (times[0] > times[1] ? times[0] - times[1] : times[1] - times[0]) > BigInt(STAGED_MAX_CLOCK_SKEW_MS)) {
      return yield* Effect.fail(
        trustFailure("truth.revocation.signed_time", "signed-time sources disagree"),
      );
    }
    const checkpointWall = BigInt(
      checkpoint.unsigned_checkpoint.wall_clock_milliseconds,
    );
    if (
      times.some((time) => {
        const difference =
          time > checkpointWall ? time - checkpointWall : checkpointWall - time;
        return difference > BigInt(STAGED_MAX_CLOCK_SKEW_MS);
      })
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.revocation.signed_time",
          "signed-time sources do not bind the checkpoint wall clock",
        ),
      );
    }
    for (const observation of checkpoint.observations) {
      const key = sourceKeys.get(observation.source_id);
      if (
        key === undefined ||
        key.sourceId !== observation.source_id ||
        key.channelId !== observation.channel_id ||
        key.keyId !== observation.key_id ||
        !verifyEd25519Signature(
          key.publicKeyHex,
          signedTimeObservationBytes(
            checkpoint.unsigned_checkpoint,
            observation.source_id,
            observation.channel_id,
            observation.unix_milliseconds,
          ),
          observation.signature,
        )
      ) {
        return yield* Effect.fail(
          trustFailure("truth.revocation.signed_time", "signed-time signature is invalid"),
        );
      }
    }
    return checkpoint;
  });

export interface FreshnessObservation {
  readonly wallClockMilliseconds: DecimalUint64;
  readonly monotonicMilliseconds: DecimalUint64;
  readonly bootId: string;
  readonly trustedGenerationHighWater: DecimalUint64;
  readonly pushChannelConnected: boolean;
  readonly pollChannelConnected: boolean;
}

export const evaluateRevocationFreshness = (
  mode: "staged" | "authority",
  expectedBaseline: RevocationConsumerBaseline,
  previousCheckpoint: SignedTimeCheckpointV1 | null,
  currentCheckpointInput: unknown,
  observation: FreshnessObservation,
  sourceKeys: ReadonlyMap<string, SignedTimeKey>,
): Effect.Effect<RevocationFreshnessProof, TruthTrustError> =>
  Effect.gen(function* () {
    if (previousCheckpoint === null) {
      return yield* Effect.fail(
        trustFailure(
          "truth.revocation.freshness",
          "SUSPENDED: startup checkpoint is missing",
        ),
      );
    }
    const verifiedPrevious = yield* verifySignedTimeCheckpoint(
      previousCheckpoint,
      sourceKeys,
    );
    const current = yield* verifySignedTimeCheckpoint(
      currentCheckpointInput,
      sourceKeys,
    );
    const unsigned = current.unsigned_checkpoint;
    const previous = verifiedPrevious.unsigned_checkpoint;
    if (
      expectedBaseline.environment !== unsigned.environment ||
      previous.environment !== expectedBaseline.environment ||
      unsigned.boot_id !== observation.bootId ||
      unsigned.generation !== expectedBaseline.generation ||
      unsigned.generation !== observation.trustedGenerationHighWater ||
      unsigned.revocation_epoch !== expectedBaseline.revocationEpoch ||
      unsigned.revocation_sequence !== expectedBaseline.revocationSequence ||
      unsigned.revocation_record_sha256 !==
        expectedBaseline.revocationRecordSha256 ||
      BigInt(previous.generation) > BigInt(unsigned.generation) ||
      BigInt(previous.revocation_epoch) > BigInt(unsigned.revocation_epoch) ||
      BigInt(previous.revocation_sequence) >
        BigInt(unsigned.revocation_sequence) ||
      (!observation.pushChannelConnected && !observation.pollChannelConnected)
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.revocation.freshness",
          "SUSPENDED: environment, boot, generation, revocation baseline, or channel continuity is untrusted",
        ),
      );
    }
    const age =
      BigInt(observation.wallClockMilliseconds) -
      BigInt(unsigned.wall_clock_milliseconds);
    const allowed = mode === "staged" ? BigInt(STAGED_MAX_OFFLINE_MS) : 0n;
    if (age < 0n || age > allowed) {
      return yield* Effect.fail(
        trustFailure("truth.revocation.freshness", "SUSPENDED: revocation state is stale"),
      );
    }
    const localMonotonicDelta =
      BigInt(observation.monotonicMilliseconds) -
      BigInt(unsigned.monotonic_milliseconds);
    const localDrift =
      age > localMonotonicDelta
        ? age - localMonotonicDelta
        : localMonotonicDelta - age;
    if (
      localMonotonicDelta < 0n ||
      (mode === "staged" &&
        localDrift > BigInt(STAGED_MAX_CLOCK_SKEW_MS)) ||
      (mode === "authority" && localDrift !== 0n)
    ) {
      return yield* Effect.fail(
        trustFailure(
          "truth.revocation.freshness",
          "SUSPENDED: local wall and monotonic samples diverged",
        ),
      );
    }
    if (previous.boot_id === unsigned.boot_id) {
      const wallDelta =
        BigInt(unsigned.wall_clock_milliseconds) -
        BigInt(previous.wall_clock_milliseconds);
      const monotonicDelta =
        BigInt(unsigned.monotonic_milliseconds) -
        BigInt(previous.monotonic_milliseconds);
      const drift =
        wallDelta > monotonicDelta
          ? wallDelta - monotonicDelta
          : monotonicDelta - wallDelta;
      if (
        wallDelta < 0n ||
        monotonicDelta < 0n ||
        (mode === "staged" && drift > BigInt(STAGED_MAX_CLOCK_SKEW_MS)) ||
        (mode === "authority" && drift !== 0n)
      ) {
        return yield* Effect.fail(
          trustFailure(
            "truth.revocation.freshness",
            "SUSPENDED: clock rollback, jump, or snapshot restore detected",
          ),
        );
      }
    }
    const proof: RevocationFreshnessProof = Object.freeze({
      status: "FRESH",
      environment: unsigned.environment,
      generation: unsigned.generation,
      revocationEpoch: unsigned.revocation_epoch,
      revocationSequence: unsigned.revocation_sequence,
      revocationRecordSha256: unsigned.revocation_record_sha256,
      bootId: unsigned.boot_id,
      evaluatedAtMonotonicMilliseconds: observation.monotonicMilliseconds,
      expiresAtMonotonicMilliseconds: (
        BigInt(observation.monotonicMilliseconds) + BigInt(FRESHNESS_LEASE_MS)
      ).toString() as DecimalUint64,
    });
    verifiedFreshnessProofs.set(proof, {
      environment: proof.environment,
      generation: proof.generation,
      revocationEpoch: proof.revocationEpoch,
      revocationSequence: proof.revocationSequence,
      revocationRecordSha256: proof.revocationRecordSha256,
      evaluatedAtMonotonicMilliseconds:
        proof.evaluatedAtMonotonicMilliseconds,
      expiresAtMonotonicMilliseconds: proof.expiresAtMonotonicMilliseconds,
    });
    return proof;
  });
