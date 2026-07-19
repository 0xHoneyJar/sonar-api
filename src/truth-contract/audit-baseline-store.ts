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
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";

import {
  jcsCanonicalize,
  sha256Hex,
} from "../collection-resolver/trust-protocol.js";
import type {
  DecimalUint64,
  Sha256Digest,
  TruthEnvironmentId,
} from "./schemas/common.js";
import {
  DecimalUint64 as DecimalUint64Schema,
  Sha256Digest as Sha256DigestSchema,
  TruthEnvironmentId as TruthEnvironmentIdSchema,
} from "./schemas/common.js";

export interface TruthAuditTailBaseline {
  readonly environment: TruthEnvironmentId;
  readonly sequence: DecimalUint64;
  readonly recordSha256: Sha256Digest | null;
}

export interface TruthAuditTailBaselineStore {
  readonly read: () => TruthAuditTailBaseline;
  readonly advance: (next: TruthAuditTailBaseline) => void;
}

const BaselineV1 = Schema.Struct({
  environment: TruthEnvironmentIdSchema,
  sequence: DecimalUint64Schema,
  recordSha256: Schema.NullOr(Sha256DigestSchema),
});

const PersistedBaselineV1 = Schema.Struct({
  schema_version: Schema.Literal(1),
  baseline: BaselineV1,
  record_digest: Sha256DigestSchema,
});

const filesystemStores = new WeakMap<
  TruthAuditTailBaselineStore,
  string
>();

const fsyncDirectory = (path: string): void => {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const validate = (baseline: TruthAuditTailBaseline): void => {
  if (
    (baseline.sequence === "0" && baseline.recordSha256 !== null) ||
    (baseline.sequence !== "0" && baseline.recordSha256 === null)
  ) {
    throw new Error("audit baseline tail digest does not match its sequence");
  }
};

const recordFor = (baseline: TruthAuditTailBaseline) => ({
  schema_version: 1 as const,
  baseline,
  record_digest: sha256Hex(jcsCanonicalize(baseline)),
});

const readBaseline = (
  path: string,
  environment: TruthEnvironmentId,
): TruthAuditTailBaseline => {
  if (!existsSync(path)) {
    throw new Error(
      "audit baseline is missing; explicit reprovisioning is required",
    );
  }
  const record = Schema.decodeUnknownSync(PersistedBaselineV1, {
    errors: "all",
    onExcessProperty: "error",
  })(JSON.parse(readFileSync(path, "utf8")));
  if (
    record.baseline.environment !== environment ||
    record.record_digest !== sha256Hex(jcsCanonicalize(record.baseline))
  ) {
    throw new Error("audit baseline is invalid");
  }
  validate(record.baseline);
  return record.baseline;
};

const writeReplace = (
  path: string,
  baseline: TruthAuditTailBaseline,
): void => {
  validate(baseline);
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

export const provisionFilesystemTruthAuditTailBaseline = (
  root: string,
  initial: TruthAuditTailBaseline,
): void => {
  validate(initial);
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
};

export const makeFilesystemTruthAuditTailBaselineStore = (
  root: string,
  environment: TruthEnvironmentId,
): TruthAuditTailBaselineStore => {
  const resolvedRoot = resolve(root);
  const path = join(resolvedRoot, "baseline.json");
  const store: TruthAuditTailBaselineStore = {
    read: () => readBaseline(path, environment),
    advance: (next) =>
      withLock(resolvedRoot, () => {
        const current = readBaseline(path, environment);
        if (
          next.environment !== environment ||
          BigInt(next.sequence) < BigInt(current.sequence) ||
          (next.sequence === current.sequence &&
            next.recordSha256 !== current.recordSha256)
        ) {
          throw new Error(
            "audit baseline rollback or same-sequence replacement rejected",
          );
        }
        writeReplace(path, next);
      }),
  };
  filesystemStores.set(store, resolvedRoot);
  return store;
};

export const assertFilesystemTruthAuditTailBaselineStore = (
  store: TruthAuditTailBaselineStore,
  registryRoot: string,
): void => {
  // This nominal capability proves factory provenance, not deployment
  // authority. STAGED/production wiring must separately permission this root
  // from the registry writer, as required by the Sprint 2 threat model.
  const baselineRoot = filesystemStores.get(store);
  if (baselineRoot === undefined) {
    throw new Error(
      "audit baseline requires a module-provisioned filesystem capability",
    );
  }
  const registry = resolve(registryRoot);
  const relation = relative(registry, baselineRoot);
  if (relation === "" || (!relation.startsWith("..") && relation !== "..")) {
    throw new Error(
      "audit baseline must be outside the registry storage tree",
    );
  }
};
