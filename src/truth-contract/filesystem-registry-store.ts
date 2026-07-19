import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
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
import { TruthIntegrityError, TruthRegistryError } from "./errors.js";
import {
  assertFilesystemCertificateBinding,
  evaluateFilesystemCertification,
  type FilesystemCertificationV1,
  type FilesystemDeploymentFingerprintV1,
} from "./filesystem-certification.js";
import type {
  DecimalUint64,
  TruthEnvironmentId,
} from "./schemas/common.js";
import {
  PositiveDecimalUint64,
  Sha256Digest,
} from "./schemas/common.js";
import {
  TruthAuditEventV1,
  TruthGenerationActivationV1,
  TruthRevocationRecordV1,
} from "./schemas/registry.js";
import type { TruthRegistryStoreService } from "./services.js";
import type { TruthActivationVerifier } from "./registry-store.js";
import type { TrustedGenerationStoreService } from "./trust-state-store.js";
import type { TruthAuditVerifier } from "./audit-control-plane.js";
import {
  assertFilesystemTruthAuditTailBaselineStore,
  type TruthAuditTailBaselineStore,
} from "./audit-baseline-store.js";

interface LockOwner {
  readonly pid: number;
  readonly created_at_ms: number;
  readonly nonce: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const registryError = (boundary: string, reason: string, retryable = false) =>
  new TruthRegistryError({ boundary, reason, retryable });

const filesystemEffect = <A>(
  boundary: string,
  operation: () => A,
): Effect.Effect<A, TruthRegistryError> =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      registryError(
        boundary,
        cause instanceof Error ? cause.message : "filesystem operation failed",
      ),
  });

const ensureDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true });
};

const fsyncDirectory = (path: string): void => {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const durableCreate = (path: string, bytes: Uint8Array): void => {
  ensureDirectory(dirname(path));
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
};

const durableReplace = (path: string, bytes: Uint8Array): void => {
  ensureDirectory(dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
};

const acquireLock = (lockPath: string): LockOwner => {
  ensureDirectory(dirname(lockPath));
  const owner: LockOwner = {
    pid: process.pid,
    created_at_ms: Date.now(),
    nonce: randomUUID(),
  };
  try {
    durableCreate(lockPath, encoder.encode(jcsCanonicalize(owner)));
    return owner;
  } catch (cause) {
    const code =
      cause instanceof Error && "code" in cause
        ? (cause as NodeJS.ErrnoException).code
        : undefined;
    if (code !== "EEXIST") throw cause;
    throw registryError(
      "truth.registry.filesystem.lock",
      "STORE_UNAVAILABLE: publisher lock is held or requires operator recovery",
      true,
    );
  }
};

const releaseLock = (lockPath: string, owner: LockOwner): void => {
  const current = JSON.parse(readFileSync(lockPath, "utf8")) as LockOwner;
  if (current.nonce !== owner.nonce || current.pid !== owner.pid) {
    throw registryError(
      "truth.registry.filesystem.lock",
      "lock ownership changed before release",
    );
  }
  unlinkSync(lockPath);
  fsyncDirectory(dirname(lockPath));
};

const withPublisherLock = <A>(root: string, operation: () => A): A => {
  const lockPath = join(root, "locks", "publisher.lock");
  const owner = acquireLock(lockPath);
  try {
    return operation();
  } finally {
    releaseLock(lockPath, owner);
  }
};

const parseJson = <A>(bytes: Uint8Array): A => JSON.parse(decoder.decode(bytes)) as A;

const activationPath = (
  root: string,
  environment: TruthEnvironmentId,
  generation: string,
): string => join(root, "environments", environment, "prepared", `${generation}.json`);

const pointerPath = (root: string, environment: TruthEnvironmentId): string =>
  join(root, "environments", environment, "current.json");

const auditHeadPath = (
  root: string,
  environment: TruthEnvironmentId,
): string => join(root, "environments", environment, "audit-head.json");

const revocationHeadPath = (
  root: string,
  environment: TruthEnvironmentId,
): string => join(root, "environments", environment, "revocation-head.json");

const DurableLogHeadV1 = Schema.Struct({
  sequence: PositiveDecimalUint64,
  record_sha256: Sha256Digest,
});

const readActivation = (
  root: string,
  environment: TruthEnvironmentId,
): TruthGenerationActivationV1 => {
  const pointerBytes = Uint8Array.from(readFileSync(pointerPath(root, environment)));
  const pointer = Schema.decodeUnknownSync(
    Schema.Struct({
      generation: PositiveDecimalUint64,
      activation_sha256: Sha256Digest,
    }),
    {
      errors: "all",
      onExcessProperty: "error",
    },
  )(parseJson<unknown>(pointerBytes));
  const bytes = Uint8Array.from(
    readFileSync(activationPath(root, environment, pointer.generation)),
  );
  if (sha256Hex(bytes) !== pointer.activation_sha256) {
    throw registryError(
      "truth.registry.filesystem.read_root",
      "active pointer activation digest mismatch",
    );
  }
  const activation = Schema.decodeUnknownSync(TruthGenerationActivationV1, {
    errors: "all",
    onExcessProperty: "error",
  })(parseJson<unknown>(bytes));
  if (
    activation.unsigned_activation.environment !== environment ||
    activation.unsigned_activation.generation !== pointer.generation
  ) {
    throw registryError(
      "truth.registry.filesystem.read_root",
      "active pointer and activation identity mismatch",
    );
  }
  return activation;
};

const readCurrentGeneration = (
  root: string,
  environment: TruthEnvironmentId,
): DecimalUint64 => {
  if (!existsSync(pointerPath(root, environment))) return "0" as DecimalUint64;
  return readActivation(root, environment).unsigned_activation.generation;
};

const numberedRecordPaths = (
  directory: string,
  boundary: string,
): ReadonlyArray<{ readonly sequence: bigint; readonly path: string }> => {
  if (!existsSync(directory)) return [];
  const records = readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const match = /^([1-9][0-9]*)\.json$/.exec(entry.name);
    if (!entry.isFile() || match === null) {
      throw registryError(
        boundary,
        `unexpected record entry ${entry.name}`,
      );
    }
    return {
      sequence: BigInt(match[1]!),
      path: join(directory, entry.name),
    };
  });
  records.sort((left, right) =>
    left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0,
  );
  records.forEach((record, index) => {
    const expected = BigInt(index + 1);
    if (record.sequence !== expected) {
      throw registryError(
        boundary,
        `record sequence gap: expected ${expected}, found ${record.sequence}`,
      );
    }
  });
  return records;
};

const readAuditRecords = (
  root: string,
  environment: TruthEnvironmentId,
  verifyAudit: TruthAuditVerifier,
  auditBaseline: TruthAuditTailBaselineStore,
  afterChainVerified?: () => void,
): ReadonlyArray<TruthAuditEventV1> => {
  const paths = numberedRecordPaths(
    join(root, "environments", environment, "audit"),
    "truth.registry.filesystem.read_audit",
  );
  const snapshots = paths.map(({ sequence, path }) => {
    const bytes = Uint8Array.from(readFileSync(path));
    const event = Schema.decodeUnknownSync(TruthAuditEventV1, {
      errors: "all",
      onExcessProperty: "error",
    })(parseJson<unknown>(bytes));
    if (
      event.environment !== environment ||
      BigInt(event.sequence) !== sequence
    ) {
      throw registryError(
        "truth.registry.filesystem.read_audit",
        "audit filename and record identity differ",
      );
    }
    Effect.runSync(verifyAudit(event));
    return {
      sequence,
      path,
      bytes,
      digest: sha256Hex(bytes),
      event,
    };
  });
  snapshots.forEach((snapshot, index) => {
    const expectedPrior =
      index === 0
        ? null
        : snapshots[index - 1]!.digest;
    if (snapshot.event.prior_record_sha256 !== expectedPrior) {
      throw registryError(
        "truth.registry.filesystem.read_audit",
        "audit prior-record digest chain is invalid",
      );
    }
  });
  afterChainVerified?.();
  const headPath = auditHeadPath(root, environment);
  if (snapshots.length === 0) {
    if (existsSync(headPath)) {
      throw registryError(
        "truth.registry.filesystem.read_audit",
        "audit log head exists without any records",
      );
    }
    const baseline = auditBaseline.read();
    if (
      baseline.environment !== environment ||
      baseline.sequence !== "0" ||
      baseline.recordSha256 !== null
    ) {
      throw registryError(
        "truth.registry.filesystem.read_audit",
        "audit log was truncated behind its independent baseline",
      );
    }
    return [];
  }
  if (!existsSync(headPath)) {
    throw registryError(
      "truth.registry.filesystem.read_audit",
      "audit log head is absent",
    );
  }
  const head = Schema.decodeUnknownSync(DurableLogHeadV1, {
    errors: "all",
    onExcessProperty: "error",
  })(parseJson<unknown>(Uint8Array.from(readFileSync(headPath))));
  const tail = snapshots[snapshots.length - 1]!;
  if (
    BigInt(head.sequence) !== tail.sequence ||
    head.record_sha256 !== tail.digest
  ) {
    throw registryError(
      "truth.registry.filesystem.read_audit",
      "audit log head does not bind the current tail",
    );
  }
  const baseline = auditBaseline.read();
  const baselinePrefix = snapshots.find(
    (snapshot) => snapshot.sequence === BigInt(baseline.sequence),
  );
  const baselinePrefixMatches =
    baseline.sequence === "0"
      ? baseline.recordSha256 === null
      : baselinePrefix?.digest === baseline.recordSha256;
  if (
    baseline.environment !== environment ||
    BigInt(baseline.sequence) > tail.sequence ||
    !baselinePrefixMatches ||
    (BigInt(baseline.sequence) === tail.sequence &&
      baseline.recordSha256 !== tail.digest)
  ) {
    throw registryError(
      "truth.registry.filesystem.read_audit",
      "audit log was truncated or replaced behind its independent baseline",
    );
  }
  if (BigInt(baseline.sequence) < tail.sequence) {
    auditBaseline.advance({
      environment,
      sequence: tail.sequence.toString() as DecimalUint64,
      recordSha256: tail.digest as Sha256Digest,
    });
  }
  return snapshots.map((snapshot) => snapshot.event);
};

const readRevocationRecords = (
  root: string,
  environment: TruthEnvironmentId,
): ReadonlyArray<TruthRevocationRecordV1> => {
  const paths = numberedRecordPaths(
    join(root, "environments", environment, "revocations"),
    "truth.registry.filesystem.read_revocations",
  );
  const records = paths.map(({ sequence, path }) => {
    const record = Schema.decodeUnknownSync(TruthRevocationRecordV1, {
      errors: "all",
      onExcessProperty: "error",
    })(parseJson<unknown>(Uint8Array.from(readFileSync(path))));
    if (
      record.environment !== environment ||
      BigInt(record.sequence) !== sequence
    ) {
      throw registryError(
        "truth.registry.filesystem.read_revocations",
        "revocation filename and record identity differ",
      );
    }
    return record;
  });
  records.forEach((record, index) => {
    const expectedPrior =
      index === 0
        ? null
        : sha256Hex(
            Uint8Array.from(readFileSync(paths[index - 1]!.path)),
          );
    if (record.prior_record_sha256 !== expectedPrior) {
      throw registryError(
        "truth.registry.filesystem.read_revocations",
        "revocation prior-record digest chain is invalid",
      );
    }
  });
  const headPath = revocationHeadPath(root, environment);
  if (paths.length === 0) {
    if (existsSync(headPath)) {
      throw registryError(
        "truth.registry.filesystem.read_revocations",
        "revocation log head exists without any records",
      );
    }
    return records;
  }
  if (!existsSync(headPath)) {
    throw registryError(
      "truth.registry.filesystem.read_revocations",
      "revocation log head is absent",
    );
  }
  const head = Schema.decodeUnknownSync(DurableLogHeadV1, {
    errors: "all",
    onExcessProperty: "error",
  })(parseJson<unknown>(Uint8Array.from(readFileSync(headPath))));
  const tail = paths[paths.length - 1]!;
  const tailBytes = Uint8Array.from(readFileSync(tail.path));
  if (
    BigInt(head.sequence) !== tail.sequence ||
    head.record_sha256 !== sha256Hex(tailBytes)
  ) {
    throw registryError(
      "truth.registry.filesystem.read_revocations",
      "revocation log head does not bind the current tail",
    );
  }
  return records;
};

const validateContiguousActivation = (
  environment: TruthEnvironmentId,
  expected: DecimalUint64,
  activation: TruthGenerationActivationV1,
): void => {
  const unsigned = activation.unsigned_activation;
  const next = (BigInt(expected) + 1n).toString();
  if (
    unsigned.environment !== environment ||
    unsigned.root.unsigned_root.environment !== environment ||
    unsigned.prior_generation !== expected ||
    unsigned.generation !== next ||
    unsigned.root.unsigned_root.generation !== next
  ) {
    throw new TruthIntegrityError({
      boundary: "truth.registry.filesystem.compare_and_swap_root",
      reason: `activation must advance exactly from ${expected} to ${next}`,
    });
  }
  const supersedes = unsigned.root.unsigned_root.supersedes_generation;
  if ((expected === "0" && supersedes !== null) || (expected !== "0" && supersedes !== expected)) {
    throw new TruthIntegrityError({
      boundary: "truth.registry.filesystem.compare_and_swap_root",
      reason: "root supersession does not match the activation precondition",
    });
  }
};

const verifyActivationMaterial = (
  root: string,
  environment: TruthEnvironmentId,
  activation: TruthGenerationActivationV1,
  verifyAudit: TruthAuditVerifier,
  auditBaseline: TruthAuditTailBaselineStore,
  afterChainVerified?: () => void,
): void => {
  for (const object of activation.unsigned_activation.root.unsigned_root.objects) {
    const objectPath = join(
      root,
      "environments",
      environment,
      "objects",
      object.sha256,
    );
    if (!existsSync(objectPath)) {
      throw registryError(
        "truth.registry.filesystem.activation_material",
        `activation closure object ${object.sha256} is absent`,
      );
    }
    const objectBytes = Uint8Array.from(readFileSync(objectPath));
    if (
      sha256Hex(objectBytes) !== object.sha256 ||
      BigInt(objectBytes.byteLength) !== BigInt(object.byte_length)
    ) {
      throw registryError(
        "truth.registry.filesystem.activation_material",
        `activation closure object ${object.sha256} is corrupt`,
      );
    }
  }
  const audits = readAuditRecords(
    root,
    environment,
    verifyAudit,
    auditBaseline,
    afterChainVerified,
  );
  const audit = audits.find(
    (event) =>
      event.sequence === activation.unsigned_activation.audit_sequence,
  );
  if (
    audit === undefined ||
    audit.kind !== "GENERATION_ACTIVATED" ||
    audit.environment !== environment ||
    audit.generation !== activation.unsigned_activation.generation ||
    audit.subject_hash !== activation.activation_hash ||
    audit.prior_record_sha256 !==
      activation.unsigned_activation.audit_prior_record_sha256 ||
    audit.recorded_at !==
      activation.unsigned_activation.audit_recorded_at
  ) {
    throw registryError(
      "truth.registry.filesystem.activation_material",
      "complete activation audit does not bind the prepared generation",
    );
  }
};

const makeFilesystemService = (
  root: string,
  verifyActivation: TruthActivationVerifier,
  trustedGenerations: TrustedGenerationStoreService,
  verifyAudit: TruthAuditVerifier,
  auditBaseline: TruthAuditTailBaselineStore,
  afterAuditChainVerified?: () => void,
): TruthRegistryStoreService => {
  const readVerifiedActivation = (
    environment: TruthEnvironmentId,
  ): Effect.Effect<TruthGenerationActivationV1, TruthRegistryError> =>
    Effect.gen(function* () {
      const activation = yield* filesystemEffect(
        "truth.registry.filesystem.read_root",
        () => readActivation(root, environment),
      );
      yield* verifyActivation(
        environment,
        activation.unsigned_activation.prior_generation,
        activation,
      ).pipe(
        Effect.mapError((cause) =>
          registryError(
            "truth.registry.filesystem.read_root",
            `active activation verification failed: ${cause.reason}`,
          ),
        ),
      );
      const trusted = yield* trustedGenerations.read(environment).pipe(
        Effect.mapError((cause) =>
          registryError(
            "truth.registry.filesystem.read_root",
            `trusted-generation verification failed: ${cause.reason}`,
          ),
        ),
      );
      const unsignedRoot = activation.unsigned_activation.root.unsigned_root;
      if (
        trusted.unsigned_record.generation !==
          activation.unsigned_activation.generation ||
        trusted.unsigned_record.trusted_root_hash !==
          activation.unsigned_activation.root.root_hash ||
        unsignedRoot.generation !== trusted.unsigned_record.generation ||
        unsignedRoot.environment !== environment
      ) {
        return yield* Effect.fail(
          registryError(
            "truth.registry.filesystem.read_root",
            "active pointer does not match the trusted generation and root",
          ),
        );
      }
      yield* filesystemEffect(
        "truth.registry.filesystem.read_root",
        () =>
          verifyActivationMaterial(
            root,
            environment,
            activation,
            verifyAudit,
            auditBaseline,
            afterAuditChainVerified,
          ),
      );
      return activation;
    });

  return {
  putObjectIfAbsent: (environment, digest, canonicalBytes) => {
    if (sha256Hex(canonicalBytes) !== digest) {
      return Effect.fail(
        new TruthIntegrityError({
          boundary: "truth.registry.filesystem.put_object",
          reason: "content digest mismatch",
        }),
      );
    }
    return filesystemEffect("truth.registry.filesystem.put_object", () => {
      const path = join(root, "environments", environment, "objects", digest);
      if (existsSync(path)) {
        const existing = Uint8Array.from(readFileSync(path));
        if (sha256Hex(existing) !== digest) {
          throw new Error("immutable object path contains corrupt bytes");
        }
        return;
      }
      try {
        durableCreate(path, canonicalBytes);
      } catch (cause) {
        const code =
          cause instanceof Error && "code" in cause
            ? (cause as NodeJS.ErrnoException).code
            : undefined;
        if (code !== "EEXIST") throw cause;
        const concurrent = Uint8Array.from(readFileSync(path));
        if (sha256Hex(concurrent) !== digest) {
          throw new Error("immutable object race produced corrupt bytes");
        }
        return;
      }
      const readBack = Uint8Array.from(readFileSync(path));
      if (sha256Hex(readBack) !== digest) throw new Error("object read-back failed");
    });
  },

  readObject: (environment, digest) =>
    filesystemEffect("truth.registry.filesystem.read_object", () => {
      const bytes = Uint8Array.from(
        readFileSync(join(root, "environments", environment, "objects", digest)),
      );
      if (sha256Hex(bytes) !== digest) throw new Error("content digest mismatch");
      return bytes;
    }),

  appendAuditEvent: (event) =>
    verifyAudit(event).pipe(
      Effect.mapError((cause) =>
        registryError(
          "truth.registry.filesystem.append_audit",
          `audit signature verification failed: ${cause.reason}`,
        ),
      ),
      Effect.flatMap(() =>
        filesystemEffect("truth.registry.filesystem.append_audit", () =>
      withPublisherLock(root, () => {
        const decodedEvent = Schema.decodeUnknownSync(TruthAuditEventV1, {
          errors: "all",
          onExcessProperty: "error",
        })(event);
        const existing = readAuditRecords(
          root,
          decodedEvent.environment,
          verifyAudit,
          auditBaseline,
          afterAuditChainVerified,
        );
        const expected = BigInt(existing.length + 1).toString();
        if (decodedEvent.sequence !== expected) {
          throw new Error(`audit sequence must be contiguous: expected ${expected}`);
        }
        const expectedPrior =
          existing.length === 0
            ? null
            : sha256Hex(
                encoder.encode(jcsCanonicalize(existing.at(-1)!)),
              );
        if (decodedEvent.prior_record_sha256 !== expectedPrior) {
          throw new Error(
            "audit prior-record digest does not bind the current tail",
          );
        }
        const path = join(
          root,
          "environments",
          decodedEvent.environment,
          "audit",
          `${decodedEvent.sequence}.json`,
        );
        const prior =
          BigInt(decodedEvent.sequence) === 1n
            ? null
            : join(
                root,
                "environments",
                decodedEvent.environment,
                "audit",
                `${BigInt(decodedEvent.sequence) - 1n}.json`,
              );
        if (prior !== null && !existsSync(prior)) {
          throw new Error("audit sequence is not contiguous");
        }
        const bytes = encoder.encode(jcsCanonicalize(decodedEvent));
        durableCreate(path, bytes);
        const headBytes = encoder.encode(
          jcsCanonicalize({
            sequence: decodedEvent.sequence,
            record_sha256: sha256Hex(bytes),
          }),
        );
        const headPath = auditHeadPath(root, decodedEvent.environment);
        if (existing.length === 0) durableCreate(headPath, headBytes);
        else durableReplace(headPath, headBytes);
        auditBaseline.advance({
          environment: decodedEvent.environment,
          sequence: decodedEvent.sequence,
          recordSha256: sha256Hex(bytes) as Sha256Digest,
        });
      }),
        ),
      ),
    ),

  readAuditEvents: (environment) =>
    filesystemEffect("truth.registry.filesystem.read_audit", () =>
      readAuditRecords(
        root,
        environment,
        verifyAudit,
        auditBaseline,
        afterAuditChainVerified,
      ),
    ),

  readRoot: readVerifiedActivation,

  compareAndSwapRoot: (environment, expectedGeneration, activation) =>
    verifyActivation(environment, expectedGeneration, activation).pipe(
      Effect.flatMap(() =>
        filesystemEffect("truth.registry.filesystem.compare_and_swap_root", () =>
          withPublisherLock(root, () => {
        const decodedActivation = Schema.decodeUnknownSync(
          TruthGenerationActivationV1,
          {
            errors: "all",
            onExcessProperty: "error",
          },
        )(activation);
        const actual = readCurrentGeneration(root, environment);
        if (actual !== expectedGeneration) {
          throw registryError(
            "truth.registry.filesystem.compare_and_swap_root",
            `generation contention: expected ${expectedGeneration}, found ${actual}`,
            true,
          );
        }
        validateContiguousActivation(
          environment,
          expectedGeneration,
          decodedActivation,
        );
        verifyActivationMaterial(
          root,
          environment,
          decodedActivation,
          verifyAudit,
          auditBaseline,
          afterAuditChainVerified,
        );
        const activationBytes = encoder.encode(jcsCanonicalize(decodedActivation));
        const prepared = activationPath(
          root,
          environment,
          decodedActivation.unsigned_activation.generation,
        );
        if (existsSync(prepared)) {
          const existing = Uint8Array.from(readFileSync(prepared));
          if (sha256Hex(existing) !== sha256Hex(activationBytes)) {
            throw new Error("prepared generation already contains different bytes");
          }
        } else {
          durableCreate(prepared, activationBytes);
        }
        const pointerBytes = encoder.encode(
          jcsCanonicalize({
            activation_sha256: sha256Hex(activationBytes),
            generation: decodedActivation.unsigned_activation.generation,
          }),
        );
        const pointer = pointerPath(root, environment);
        if (expectedGeneration === "0") durableCreate(pointer, pointerBytes);
        else durableReplace(pointer, pointerBytes);
          }),
        ),
      ),
    ),

  readActiveGeneration: (environment) =>
    readVerifiedActivation(environment).pipe(
      Effect.map((activation) => activation.unsigned_activation.generation),
    ),

  appendRevocation: (revocation) =>
    filesystemEffect("truth.registry.filesystem.append_revocation", () =>
      withPublisherLock(root, () => {
        const decodedRevocation = Schema.decodeUnknownSync(
          TruthRevocationRecordV1,
          {
            errors: "all",
            onExcessProperty: "error",
          },
        )(revocation);
        const existing = readRevocationRecords(
          root,
          decodedRevocation.environment,
        );
        const expected = BigInt(existing.length + 1).toString();
        if (decodedRevocation.sequence !== expected) {
          throw new Error(
            `revocation sequence must be contiguous: expected ${expected}`,
          );
        }
        const expectedPrior =
          existing.length === 0
            ? null
            : sha256Hex(
                encoder.encode(jcsCanonicalize(existing.at(-1)!)),
              );
        if (decodedRevocation.prior_record_sha256 !== expectedPrior) {
          throw new Error(
            "revocation prior-record digest does not bind the current tail",
          );
        }
        if (
          existing.some(
            (record) => record.event_id === decodedRevocation.event_id,
          )
        ) {
          throw new Error("revocation event ID must be unique");
        }
        const directory = join(
          root,
          "environments",
          decodedRevocation.environment,
          "revocations",
        );
        const path = join(directory, `${decodedRevocation.sequence}.json`);
        const prior =
          BigInt(decodedRevocation.sequence) === 1n
            ? null
            : join(
                directory,
                `${BigInt(decodedRevocation.sequence) - 1n}.json`,
              );
        if (prior !== null && !existsSync(prior)) {
          throw new Error("revocation sequence is not contiguous");
        }
        const bytes = encoder.encode(jcsCanonicalize(decodedRevocation));
        durableCreate(path, bytes);
        const headBytes = encoder.encode(
          jcsCanonicalize({
            sequence: decodedRevocation.sequence,
            record_sha256: sha256Hex(bytes),
          }),
        );
        const headPath = revocationHeadPath(
          root,
          decodedRevocation.environment,
        );
        if (existing.length === 0) durableCreate(headPath, headBytes);
        else durableReplace(headPath, headBytes);
      }),
    ),

  readRevocations: (environment) =>
    filesystemEffect("truth.registry.filesystem.read_revocations", () =>
      readRevocationRecords(root, environment),
    ),
  };
};

/**
 * Test-only adapter. It provides local filesystem behavior fixtures and
 * deliberately carries no process-crash or deployment qualification authority.
 */
export const makeUnqualifiedLocalFilesystemTruthRegistryStore = (
  root: string,
  verifyActivation: TruthActivationVerifier,
  trustedGenerations: TrustedGenerationStoreService,
  verifyAudit: TruthAuditVerifier,
  auditBaseline: TruthAuditTailBaselineStore,
  afterAuditChainVerified?: () => void,
): TruthRegistryStoreService => {
  ensureDirectory(root);
  assertFilesystemTruthAuditTailBaselineStore(auditBaseline, root);
  return makeFilesystemService(
    root,
    verifyActivation,
    trustedGenerations,
    verifyAudit,
    auditBaseline,
    afterAuditChainVerified,
  );
};

export const openCertifiedFilesystemTruthRegistryStore = (
  root: string,
  certificateInput: unknown,
  currentFingerprint: FilesystemDeploymentFingerprintV1,
  adapterSha256: string,
  verifyActivation: TruthActivationVerifier,
  trustedGenerations: TrustedGenerationStoreService,
  _verifyAudit: TruthAuditVerifier,
  _auditBaseline: TruthAuditTailBaselineStore,
): Effect.Effect<TruthRegistryStoreService, TruthRegistryError> =>
  Effect.gen(function* () {
    const certificate: FilesystemCertificationV1 =
      yield* evaluateFilesystemCertification(certificateInput);
    yield* assertFilesystemCertificateBinding(
      certificate,
      currentFingerprint,
      adapterSha256,
    );
    if (
      certificate.fingerprint.filesystem_type.toLowerCase() === "apfs"
    ) {
      return yield* Effect.fail(
        registryError(
          "truth.registry.certification",
          "STORE_UNAVAILABLE: Node adapter has no F_FULLFSYNC primitive",
        ),
      );
    }
    return yield* Effect.fail(
      registryError(
        "truth.registry.certification",
        "STORE_UNAVAILABLE: authenticated dedicated-runner certification integration is not implemented",
      ),
    );
  });
