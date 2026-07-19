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
import { Effect, Schema } from "effect";

import {
  jcsCanonicalize,
  sha256Hex,
} from "../collection-resolver/trust-protocol.js";
import { TruthTrustError } from "./errors.js";
import {
  DecimalUint64,
  Sha256Digest,
  TruthEnvironmentId,
} from "./schemas/common.js";
import type {
  RevocationConsumerBaseline,
  RevocationConsumerBaselineStore,
} from "./revocation-control-plane.js";

const filesystemStores = new WeakSet<RevocationConsumerBaselineStore>();

const BaselineV1 = Schema.Struct({
  environment: TruthEnvironmentId,
  generation: DecimalUint64,
  revocationEpoch: DecimalUint64,
  revocationSequence: DecimalUint64,
  revocationRecordSha256: Schema.NullOr(Sha256Digest),
});

const PersistedBaselineV1 = Schema.Struct({
  schema_version: Schema.Literal(1),
  baseline: BaselineV1,
  record_digest: Sha256Digest,
});

const failure = (reason: string) =>
  new TruthTrustError({
    boundary: "truth.revocation.baseline",
    reason,
  });

const fsyncDirectory = (path: string): void => {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const recordFor = (baseline: RevocationConsumerBaseline) => ({
  schema_version: 1 as const,
  baseline,
  record_digest: sha256Hex(jcsCanonicalize(baseline)),
});

const validateBaseline = (baseline: RevocationConsumerBaseline): void => {
  const sequenceIsZero = baseline.revocationSequence === "0";
  if (
    (sequenceIsZero && baseline.revocationRecordSha256 !== null) ||
    (!sequenceIsZero && baseline.revocationRecordSha256 === null)
  ) {
    throw new Error(
      "revocation baseline tail digest does not match its sequence",
    );
  }
};

const writeReplace = (
  path: string,
  baseline: RevocationConsumerBaseline,
): void => {
  validateBaseline(baseline);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, jcsCanonicalize(recordFor(baseline)));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
};

const readBaseline = (
  path: string,
  expectedEnvironment: TruthEnvironmentId,
): RevocationConsumerBaseline => {
  if (!existsSync(path)) {
    throw new Error(
      "SUSPENDED: persisted revocation baseline is missing; explicit reprovisioning is required",
    );
  }
  const record = Schema.decodeUnknownSync(PersistedBaselineV1, {
    errors: "all",
    onExcessProperty: "error",
  })(JSON.parse(readFileSync(path, "utf8")));
  if (
    record.baseline.environment !== expectedEnvironment ||
    record.record_digest !== sha256Hex(jcsCanonicalize(record.baseline))
  ) {
    throw new Error("SUSPENDED: persisted revocation baseline is invalid");
  }
  validateBaseline(record.baseline);
  return record.baseline;
};

const withLock = <A>(root: string, operation: () => A): A => {
  const lockPath = join(root, "baseline.lock");
  const descriptor = openSync(lockPath, "wx", 0o600);
  closeSync(descriptor);
  fsyncDirectory(root);
  try {
    return operation();
  } finally {
    unlinkSync(lockPath);
    fsyncDirectory(root);
  }
};

export const provisionFilesystemRevocationConsumerBaseline = (
  root: string,
  initial: RevocationConsumerBaseline,
): Effect.Effect<void, TruthTrustError> =>
  Effect.try({
    try: () => {
      validateBaseline(initial);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const path = join(root, "baseline.json");
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, jcsCanonicalize(recordFor(initial)));
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
          : "revocation baseline provisioning failed",
      ),
  });

export const makeFilesystemRevocationConsumerBaselineStore = (
  root: string,
  environment: TruthEnvironmentId,
): RevocationConsumerBaselineStore => {
  const path = join(root, "baseline.json");
  const store: RevocationConsumerBaselineStore = {
    read: Effect.try({
      try: () => readBaseline(path, environment),
      catch: (cause) =>
        failure(
          cause instanceof Error
            ? cause.message
            : "revocation baseline read failed",
        ),
    }),
    write: (next) =>
      Effect.try({
        try: () =>
          withLock(root, () => {
            const current = readBaseline(path, environment);
            if (
              next.environment !== environment ||
              BigInt(next.generation) < BigInt(current.generation) ||
              BigInt(next.revocationEpoch) < BigInt(current.revocationEpoch) ||
              BigInt(next.revocationSequence) <
                BigInt(current.revocationSequence) ||
              (next.revocationSequence === current.revocationSequence &&
                (next.revocationEpoch !== current.revocationEpoch ||
                  next.revocationRecordSha256 !==
                    current.revocationRecordSha256))
            ) {
              throw new Error(
                "SUSPENDED: revocation baseline rollback or same-sequence replacement rejected",
              );
            }
            writeReplace(path, next);
          }),
        catch: (cause) =>
          failure(
            cause instanceof Error
              ? cause.message
              : "revocation baseline write failed",
          ),
      }),
  };
  filesystemStores.add(store);
  return store;
};

export const isFilesystemRevocationConsumerBaselineStore = (
  store: RevocationConsumerBaselineStore,
): boolean =>
  // Factory provenance replaces caller-controlled persistence labels.
  // Separate service credentials remain a deployment-attestation precondition.
  filesystemStores.has(store);
