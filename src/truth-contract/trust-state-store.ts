import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Context, Effect, Schema, SynchronizedRef } from "effect";

import { jcsCanonicalize, sha256Hex } from "../collection-resolver/trust-protocol.js";
import { TruthTrustError } from "./errors.js";
import type {
  TruthEnvironmentId,
  TruthIsoTimestamp,
} from "./schemas/common.js";
import {
  TrustedGenerationHighWaterV1,
  TrustRecoveryChallengeUnsignedV1,
  TrustRecoveryChallengeV1,
} from "./schemas/trust.js";

export interface TrustedGenerationStoreService {
  readonly bootstrapStatus: (
    environment: TruthEnvironmentId,
  ) => Effect.Effect<"EMPTY" | "ACTIVE", TruthTrustError>;
  readonly read: (
    environment: TruthEnvironmentId,
  ) => Effect.Effect<TrustedGenerationHighWaterV1, TruthTrustError>;
}

interface TrustedGenerationBootstrapInput {
  readonly environment: TruthEnvironmentId;
  readonly generation: string;
  readonly recoveryNonce: string;
  readonly trustedRootHash: string;
  readonly bootstrapDigest: string;
  readonly bootstrapBindingDigest: string;
  readonly bootstrapEquivocationSequence: string;
  readonly bootstrapEquivocationDigest: string | null;
  readonly updatedAt: TruthIsoTimestamp;
}

interface TrustedGenerationAdvanceInput {
  readonly environment: TruthEnvironmentId;
  readonly expectedGeneration: string;
  readonly nextGeneration: string;
  readonly expectedRecoveryNonce: string;
  readonly nextRecoveryNonce: string;
  readonly expectedRootHash: string;
  readonly nextRootHash: string;
  readonly bootstrapDigest: string;
  readonly bootstrapBindingDigest: string;
  readonly bootstrapEquivocationSequence: string;
  readonly bootstrapEquivocationDigest: string | null;
  readonly updatedAt: TruthIsoTimestamp;
}

export const TrustedGenerationStore =
  Context.GenericTag<TrustedGenerationStoreService>(
    "sonar/truth-contract/TrustedGenerationStore",
  );

export interface RecoveryChallengeStoreService {
  readonly create: (
    challenge: TrustRecoveryChallengeUnsignedV1,
  ) => Effect.Effect<TrustRecoveryChallengeV1, TruthTrustError>;
  readonly read: (
    environment: TruthEnvironmentId,
    challengeId: string,
  ) => Effect.Effect<TrustRecoveryChallengeV1, TruthTrustError>;
  readonly consume: (
    environment: TruthEnvironmentId,
    challengeId: string,
    expectedDigest: string,
    consumedAt: TruthIsoTimestamp,
  ) => Effect.Effect<TrustRecoveryChallengeV1, TruthTrustError>;
}

interface TrustedGenerationMutationPort {
  readonly bootstrap: (
    input: TrustedGenerationBootstrapInput,
  ) => Effect.Effect<TrustedGenerationHighWaterV1, TruthTrustError>;
  readonly advance: (
    input: TrustedGenerationAdvanceInput,
  ) => Effect.Effect<TrustedGenerationHighWaterV1, TruthTrustError>;
  readonly anchorBootstrapEquivocation: (
    environment: TruthEnvironmentId,
    expectedSequence: string,
    expectedDigest: string | null,
    nextSequence: string,
    nextDigest: string,
    updatedAt: TruthIsoTimestamp,
  ) => Effect.Effect<TrustedGenerationHighWaterV1, TruthTrustError>;
}

const mutationPorts = new WeakMap<
  TrustedGenerationStoreService,
  TrustedGenerationMutationPort
>();

const mutationPort = (
  store: TrustedGenerationStoreService,
): Effect.Effect<TrustedGenerationMutationPort, TruthTrustError> => {
  const port = mutationPorts.get(store);
  return port === undefined
    ? Effect.fail(failure("trusted-generation mutation port is unavailable"))
    : Effect.succeed(port);
};

/**
 * Internal transition hook. It is intentionally not exported from the package
 * facade; trust-control-plane is the only caller and must first verify the
 * complete bootstrap receipt.
 */
export const applyAuthorizedTrustedGenerationBootstrap = (
  store: TrustedGenerationStoreService,
  input: TrustedGenerationBootstrapInput,
): Effect.Effect<TrustedGenerationHighWaterV1, TruthTrustError> =>
  mutationPort(store).pipe(Effect.flatMap((port) => port.bootstrap(input)));

/**
 * Internal transition hook. Public callers advance through verified rotation
 * or recovery ceremonies in trust-control-plane.
 */
export const applyAuthorizedTrustedGenerationAdvance = (
  store: TrustedGenerationStoreService,
  input: TrustedGenerationAdvanceInput,
): Effect.Effect<TrustedGenerationHighWaterV1, TruthTrustError> =>
  mutationPort(store).pipe(Effect.flatMap((port) => port.advance(input)));

/**
 * Internal append-only anchor hook used by the durable equivocation ledger.
 * It cannot change generation, roots, quorums, or recovery nonce.
 */
export const anchorAuthorizedBootstrapEquivocation = (
  store: TrustedGenerationStoreService,
  environment: TruthEnvironmentId,
  expectedSequence: string,
  expectedDigest: string | null,
  nextSequence: string,
  nextDigest: string,
  updatedAt: TruthIsoTimestamp,
): Effect.Effect<TrustedGenerationHighWaterV1, TruthTrustError> =>
  mutationPort(store).pipe(
    Effect.flatMap((port) =>
      port.anchorBootstrapEquivocation(
        environment,
        expectedSequence,
        expectedDigest,
        nextSequence,
        nextDigest,
        updatedAt,
      ),
    ),
  );

const failure = (reason: string): TruthTrustError =>
  new TruthTrustError({ boundary: "truth.trust.high_water", reason });

const makeRecord = (
  environment: TruthEnvironmentId,
  generation: string,
  recoveryNonce: string,
  trustedRootHash: string,
  bootstrapDigest: string,
  bootstrapBindingDigest: string,
  bootstrapEquivocationSequence: string,
  bootstrapEquivocationDigest: string | null,
  updatedAt: TruthIsoTimestamp,
): TrustedGenerationHighWaterV1 => {
  const unsigned = {
    schema_version: 1,
    environment,
    generation,
    recovery_nonce: recoveryNonce,
    trusted_root_hash: trustedRootHash,
    bootstrap_digest: bootstrapDigest,
    bootstrap_binding_digest: bootstrapBindingDigest,
    bootstrap_equivocation_sequence: bootstrapEquivocationSequence,
    bootstrap_equivocation_digest: bootstrapEquivocationDigest,
    updated_at: updatedAt,
  };
  return {
    unsigned_record: unsigned,
    record_digest: sha256Hex(jcsCanonicalize(unsigned)),
  } as never;
};

const verifyRecord = (
  record: TrustedGenerationHighWaterV1,
  environment: TruthEnvironmentId,
): Effect.Effect<TrustedGenerationHighWaterV1, TruthTrustError> =>
  record.unsigned_record.environment === environment &&
  sha256Hex(jcsCanonicalize(record.unsigned_record)) === record.record_digest
    ? Effect.succeed(record)
    : Effect.fail(failure("UNKNOWN: high-water binding or digest is invalid"));

const makeChallengeRecord = (
  unsigned: TrustRecoveryChallengeUnsignedV1,
): TrustRecoveryChallengeV1 =>
  ({
    unsigned_challenge: unsigned,
    record_digest: sha256Hex(jcsCanonicalize(unsigned)),
  }) as never;

const verifyChallengeRecord = (
  record: TrustRecoveryChallengeV1,
  environment: TruthEnvironmentId,
  challengeId: string,
): Effect.Effect<TrustRecoveryChallengeV1, TruthTrustError> =>
  record.unsigned_challenge.environment === environment &&
  record.unsigned_challenge.challenge_id === challengeId &&
  sha256Hex(jcsCanonicalize(record.unsigned_challenge)) === record.record_digest
    ? Effect.succeed(record)
    : Effect.fail(failure("UNKNOWN: recovery challenge binding is invalid"));

export const makeInMemoryRecoveryChallengeStore =
  (): RecoveryChallengeStoreService => {
    const state = SynchronizedRef.unsafeMake(
      new Map<string, TrustRecoveryChallengeV1>(),
    );
    const key = (environment: TruthEnvironmentId, challengeId: string) =>
      `${environment}\0${challengeId}`;
    return {
      create: (challenge) =>
        SynchronizedRef.modifyEffect(state, (current) => {
          const challengeKey = key(
            challenge.environment,
            challenge.challenge_id,
          );
          if (current.has(challengeKey)) {
            return Effect.fail(failure("recovery challenge already exists"));
          }
          const record = makeChallengeRecord(challenge);
          const next = new Map(current);
          next.set(challengeKey, record);
          return Effect.succeed([record, next] as const);
        }),
      read: (environment, challengeId) =>
        SynchronizedRef.get(state).pipe(
          Effect.flatMap((current) => {
            const record = current.get(key(environment, challengeId));
            return record === undefined
              ? Effect.fail(failure("UNKNOWN: recovery challenge is missing"))
              : verifyChallengeRecord(record, environment, challengeId);
          }),
        ),
      consume: (environment, challengeId, expectedDigest, consumedAt) =>
        SynchronizedRef.modifyEffect(state, (current) => {
          const challengeKey = key(environment, challengeId);
          const record = current.get(challengeKey);
          if (
            record === undefined ||
            record.record_digest !== expectedDigest ||
            record.unsigned_challenge.consumed_at !== null
          ) {
            return Effect.fail(
              failure("recovery challenge missing, changed, or consumed"),
            );
          }
          const nextRecord = makeChallengeRecord(
            new TrustRecoveryChallengeUnsignedV1({
              ...record.unsigned_challenge,
              consumed_at: consumedAt,
            }),
          );
          const next = new Map(current);
          next.set(challengeKey, nextRecord);
          return Effect.succeed([nextRecord, next] as const);
        }),
    };
  };

export const makeInMemoryTrustedGenerationStore =
  (): TrustedGenerationStoreService => {
    const state = SynchronizedRef.unsafeMake(
      new Map<TruthEnvironmentId, TrustedGenerationHighWaterV1>(),
    );
    const port: TrustedGenerationMutationPort = {
      bootstrap: (input) =>
        SynchronizedRef.modifyEffect(state, (current) => {
          if (current.has(input.environment)) {
            return Effect.fail(failure("bootstrap high-water already exists"));
          }
          if (input.generation !== "1" || input.recoveryNonce !== "0") {
            return Effect.fail(failure("bootstrap high-water must start at generation 1"));
          }
          const record = makeRecord(
            input.environment,
            input.generation,
            input.recoveryNonce,
            input.trustedRootHash,
            input.bootstrapDigest,
            input.bootstrapBindingDigest,
            input.bootstrapEquivocationSequence,
            input.bootstrapEquivocationDigest,
            input.updatedAt,
          );
          const next = new Map(current);
          next.set(input.environment, record);
          return Effect.succeed([record, next] as const);
        }),
      advance: (input) =>
        SynchronizedRef.modifyEffect(state, (current) => {
          const record = current.get(input.environment);
          if (record === undefined) {
            return Effect.fail(
              failure("UNKNOWN: trusted-generation high-water is missing"),
            );
          }
          if (
            record.unsigned_record.generation !== input.expectedGeneration ||
            record.unsigned_record.recovery_nonce !== input.expectedRecoveryNonce ||
            record.unsigned_record.trusted_root_hash !== input.expectedRootHash ||
            record.unsigned_record.bootstrap_digest !== input.bootstrapDigest ||
            record.unsigned_record.bootstrap_binding_digest !==
              input.bootstrapBindingDigest ||
            record.unsigned_record.bootstrap_equivocation_sequence !==
              input.bootstrapEquivocationSequence ||
            record.unsigned_record.bootstrap_equivocation_digest !==
              input.bootstrapEquivocationDigest ||
            input.nextGeneration !==
              (BigInt(input.expectedGeneration) + 1n).toString() ||
            BigInt(input.nextRecoveryNonce) < BigInt(input.expectedRecoveryNonce)
          ) {
            return Effect.fail(failure("rollback, contention, or generation gap"));
          }
          const nextRecord = makeRecord(
            input.environment,
            input.nextGeneration,
            input.nextRecoveryNonce,
            input.nextRootHash,
            input.bootstrapDigest,
            input.bootstrapBindingDigest,
            input.bootstrapEquivocationSequence,
            input.bootstrapEquivocationDigest,
            input.updatedAt,
          );
          const next = new Map(current);
          next.set(input.environment, nextRecord);
          return Effect.succeed([nextRecord, next] as const);
        }),
      anchorBootstrapEquivocation: (
        environment,
        expectedSequence,
        expectedDigest,
        nextSequence,
        nextDigest,
        updatedAt,
      ) =>
        SynchronizedRef.modifyEffect(state, (current) => {
          const record = current.get(environment);
          if (
            record === undefined ||
            record.unsigned_record.bootstrap_equivocation_sequence !==
              expectedSequence ||
            record.unsigned_record.bootstrap_equivocation_digest !==
              expectedDigest ||
            nextSequence !== (BigInt(expectedSequence) + 1n).toString()
          ) {
            return Effect.fail(
              failure("bootstrap equivocation anchor contention or gap"),
            );
          }
          const unsigned = record.unsigned_record;
          const nextRecord = makeRecord(
            environment,
            unsigned.generation,
            unsigned.recovery_nonce,
            unsigned.trusted_root_hash,
            unsigned.bootstrap_digest,
            unsigned.bootstrap_binding_digest,
            nextSequence,
            nextDigest,
            updatedAt,
          );
          const next = new Map(current);
          next.set(environment, nextRecord);
          return Effect.succeed([nextRecord, next] as const);
        }),
    };
    const service: TrustedGenerationStoreService = {
      bootstrapStatus: (environment) =>
        SynchronizedRef.get(state).pipe(
          Effect.map((current) =>
            current.has(environment) ? "ACTIVE" as const : "EMPTY" as const,
          ),
        ),
      read: (environment) =>
        SynchronizedRef.get(state).pipe(
          Effect.flatMap((current) => {
            const record = current.get(environment);
            return record === undefined
              ? Effect.fail(
                  failure(
                    "UNKNOWN: trusted-generation high-water is missing; fresh ceremony required",
                  ),
                )
              : verifyRecord(record, environment);
          }),
        ),
    };
    mutationPorts.set(service, port);
    return service;
  };

const fsyncDirectory = (path: string): void => {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const writeState = (path: string, record: TrustedGenerationHighWaterV1): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, jcsCanonicalize(record));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
};

const readState = (
  path: string,
  environment: TruthEnvironmentId,
): TrustedGenerationHighWaterV1 => {
  if (!existsSync(path)) {
    throw new Error(
      "UNKNOWN: trusted-generation high-water is missing; fresh ceremony required",
    );
  }
  const record = Schema.decodeUnknownSync(TrustedGenerationHighWaterV1, {
    errors: "all",
    onExcessProperty: "error",
  })(JSON.parse(readFileSync(path, "utf8")));
  if (
    record.unsigned_record.environment !== environment ||
    sha256Hex(jcsCanonicalize(record.unsigned_record)) !== record.record_digest
  ) {
    throw new Error("UNKNOWN: high-water binding or digest is invalid");
  }
  return record;
};

const withStateLock = <A>(
  root: string,
  environment: TruthEnvironmentId,
  operation: () => A,
): A => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, `${environment}.high-water.lock`);
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (cause) {
    const code =
      cause instanceof Error && "code" in cause
        ? (cause as NodeJS.ErrnoException).code
        : undefined;
    if (code === "EEXIST") {
      throw new Error("STORE_UNAVAILABLE: high-water mutation lock is held");
    }
    throw cause;
  }
  try {
    writeFileSync(
      descriptor,
      jcsCanonicalize({ pid: process.pid, nonce: randomUUID() }),
    );
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(root);
  try {
    return operation();
  } finally {
    unlinkSync(lockPath);
    fsyncDirectory(root);
  }
};

const provisionPath = (
  root: string,
  environment: TruthEnvironmentId,
): string => join(root, `${environment}.provision.json`);

const readProvision = (
  root: string,
  environment: TruthEnvironmentId,
): { readonly state: "EMPTY" | "ACTIVE"; readonly installation_id: string } => {
  const path = provisionPath(root, environment);
  if (!existsSync(path)) {
    throw new Error(
      "UNKNOWN: trusted-generation environment is not provisioned; explicit operator ceremony required",
    );
  }
  return Schema.decodeUnknownSync(
    Schema.Struct({
      schema_version: Schema.Literal(1),
      environment: Schema.Literal(environment),
      state: Schema.Literal("EMPTY", "ACTIVE"),
      installation_id: Schema.String.pipe(Schema.minLength(1)),
    }),
    { errors: "all", onExcessProperty: "error" },
  )(JSON.parse(readFileSync(path, "utf8")));
};

export const provisionFilesystemTrustedGenerationEnvironment = (
  root: string,
  environment: TruthEnvironmentId,
): Effect.Effect<void, TruthTrustError> =>
  Effect.try({
    try: () => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const descriptor = openSync(
        provisionPath(root, environment),
        "wx",
        0o600,
      );
      try {
        writeFileSync(
          descriptor,
          jcsCanonicalize({
            schema_version: 1,
            environment,
            state: "EMPTY",
            installation_id: randomUUID(),
          }),
        );
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      fsyncDirectory(root);
    },
    catch: (cause) =>
      failure(
        cause instanceof Error
          ? cause.message
          : "trusted-generation provisioning failed",
      ),
  });

export const makeFilesystemTrustedGenerationStore = (
  root: string,
): TrustedGenerationStoreService => {
  const pathFor = (environment: TruthEnvironmentId): string =>
    join(root, `${environment}.high-water.json`);
  const port: TrustedGenerationMutationPort = {
    bootstrap: (input) =>
      Effect.try({
        try: () =>
          withStateLock(root, input.environment, () => {
            const path = pathFor(input.environment);
            const provision = readProvision(root, input.environment);
            if (provision.state !== "EMPTY") {
              throw new Error(
                "bootstrap requires a freshly provisioned empty environment",
              );
            }
            if (existsSync(path)) throw new Error("bootstrap high-water already exists");
            if (input.generation !== "1" || input.recoveryNonce !== "0") {
              throw new Error("bootstrap must start at generation 1 and nonce 0");
            }
            const record = makeRecord(
              input.environment,
              input.generation,
              input.recoveryNonce,
              input.trustedRootHash,
              input.bootstrapDigest,
              input.bootstrapBindingDigest,
              input.bootstrapEquivocationSequence,
              input.bootstrapEquivocationDigest,
              input.updatedAt,
            );
            writeState(path, record);
            writeState(
              provisionPath(root, input.environment),
              {
                schema_version: 1,
                environment: input.environment,
                state: "ACTIVE",
                installation_id: provision.installation_id,
              } as never,
            );
            return record;
          }),
        catch: (cause) =>
          failure(cause instanceof Error ? cause.message : "write failed"),
      }),
    advance: (input) =>
      Effect.try({
        try: () =>
          withStateLock(root, input.environment, () => {
            if (readProvision(root, input.environment).state !== "ACTIVE") {
              throw new Error(
                "UNKNOWN: trusted-generation environment is not active",
              );
            }
            const current = readState(
              pathFor(input.environment),
              input.environment,
            );
            if (
              current.unsigned_record.generation !== input.expectedGeneration ||
              current.unsigned_record.recovery_nonce !==
                input.expectedRecoveryNonce ||
              current.unsigned_record.trusted_root_hash !== input.expectedRootHash ||
              current.unsigned_record.bootstrap_digest !== input.bootstrapDigest ||
              current.unsigned_record.bootstrap_binding_digest !==
                input.bootstrapBindingDigest ||
              current.unsigned_record.bootstrap_equivocation_sequence !==
                input.bootstrapEquivocationSequence ||
              current.unsigned_record.bootstrap_equivocation_digest !==
                input.bootstrapEquivocationDigest ||
              input.nextGeneration !==
                (BigInt(input.expectedGeneration) + 1n).toString() ||
              BigInt(input.nextRecoveryNonce) <
                BigInt(input.expectedRecoveryNonce)
            ) {
              throw new Error("rollback, contention, or generation gap");
            }
            const next = makeRecord(
              input.environment,
              input.nextGeneration,
              input.nextRecoveryNonce,
              input.nextRootHash,
              input.bootstrapDigest,
              input.bootstrapBindingDigest,
              input.bootstrapEquivocationSequence,
              input.bootstrapEquivocationDigest,
              input.updatedAt,
            );
            writeState(pathFor(input.environment), next);
            return next;
          }),
        catch: (cause) =>
          failure(cause instanceof Error ? cause.message : "write failed"),
      }),
    anchorBootstrapEquivocation: (
      environment,
      expectedSequence,
      expectedDigest,
      nextSequence,
      nextDigest,
      updatedAt,
    ) =>
      Effect.try({
        try: () =>
          withStateLock(root, environment, () => {
            if (readProvision(root, environment).state !== "ACTIVE") {
              throw new Error(
                "UNKNOWN: trusted-generation environment is not active",
              );
            }
            const current = readState(pathFor(environment), environment);
            if (
              current.unsigned_record.bootstrap_equivocation_sequence !==
                expectedSequence ||
              current.unsigned_record.bootstrap_equivocation_digest !==
                expectedDigest ||
              nextSequence !== (BigInt(expectedSequence) + 1n).toString()
            ) {
              throw new Error(
                "bootstrap equivocation anchor contention or gap",
              );
            }
            const unsigned = current.unsigned_record;
            const next = makeRecord(
              environment,
              unsigned.generation,
              unsigned.recovery_nonce,
              unsigned.trusted_root_hash,
              unsigned.bootstrap_digest,
              unsigned.bootstrap_binding_digest,
              nextSequence,
              nextDigest,
              updatedAt,
            );
            writeState(pathFor(environment), next);
            return next;
          }),
        catch: (cause) =>
          failure(cause instanceof Error ? cause.message : "write failed"),
      }),
  };
  const service: TrustedGenerationStoreService = {
    bootstrapStatus: (environment) =>
      Effect.try({
        try: () => {
          const provision = readProvision(root, environment);
          const stateExists = existsSync(pathFor(environment));
          if (provision.state === "EMPTY" && !stateExists) return "EMPTY" as const;
          if (provision.state === "ACTIVE" && stateExists) {
            readState(pathFor(environment), environment);
            return "ACTIVE" as const;
          }
          throw new Error(
            "UNKNOWN: trusted-generation provision/high-water state is inconsistent",
          );
        },
        catch: (cause) =>
          failure(cause instanceof Error ? cause.message : "read failed"),
      }),
    read: (environment) =>
      Effect.try({
        try: () => {
          if (readProvision(root, environment).state !== "ACTIVE") {
            throw new Error(
              "UNKNOWN: trusted-generation environment is not active",
            );
          }
          return readState(pathFor(environment), environment);
        },
        catch: (cause) =>
          failure(cause instanceof Error ? cause.message : "read failed"),
      }),
  };
  mutationPorts.set(service, port);
  return service;
};

export const makeFilesystemRecoveryChallengeStore = (
  root: string,
): RecoveryChallengeStoreService => {
  const pathFor = (
    environment: TruthEnvironmentId,
    challengeId: string,
  ): string => join(root, environment, "challenges", `${challengeId}.json`);
  const readChallenge = (
    environment: TruthEnvironmentId,
    challengeId: string,
  ): TrustRecoveryChallengeV1 => {
    const path = pathFor(environment, challengeId);
    if (!existsSync(path)) {
      throw new Error("UNKNOWN: recovery challenge is missing");
    }
    const record = Schema.decodeUnknownSync(TrustRecoveryChallengeV1, {
      errors: "all",
      onExcessProperty: "error",
    })(JSON.parse(readFileSync(path, "utf8")));
    if (
      record.unsigned_challenge.environment !== environment ||
      record.unsigned_challenge.challenge_id !== challengeId ||
      sha256Hex(jcsCanonicalize(record.unsigned_challenge)) !==
        record.record_digest
    ) {
      throw new Error("UNKNOWN: recovery challenge binding is invalid");
    }
    return record;
  };
  return {
    create: (challenge) =>
      Effect.try({
        try: () =>
          withStateLock(root, challenge.environment, () => {
            const path = pathFor(
              challenge.environment,
              challenge.challenge_id,
            );
            if (existsSync(path)) {
              throw new Error("recovery challenge already exists");
            }
            const record = makeChallengeRecord(challenge);
            writeState(path, record as never);
            return record;
          }),
        catch: (cause) =>
          failure(cause instanceof Error ? cause.message : "challenge write failed"),
      }),
    read: (environment, challengeId) =>
      Effect.try({
        try: () => readChallenge(environment, challengeId),
        catch: (cause) =>
          failure(cause instanceof Error ? cause.message : "challenge read failed"),
      }),
    consume: (environment, challengeId, expectedDigest, consumedAt) =>
      Effect.try({
        try: () =>
          withStateLock(root, environment, () => {
            const record = readChallenge(environment, challengeId);
            if (
              record.record_digest !== expectedDigest ||
              record.unsigned_challenge.consumed_at !== null
            ) {
              throw new Error("recovery challenge changed or consumed");
            }
            const next = makeChallengeRecord(
              new TrustRecoveryChallengeUnsignedV1({
                ...record.unsigned_challenge,
                consumed_at: consumedAt,
              }),
            );
            writeState(pathFor(environment, challengeId), next as never);
            return next;
          }),
        catch: (cause) =>
          failure(
            cause instanceof Error ? cause.message : "challenge consume failed",
          ),
      }),
  };
};
