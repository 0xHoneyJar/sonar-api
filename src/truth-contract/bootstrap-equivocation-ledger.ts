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
import { Effect } from "effect";

import {
  jcsCanonicalize,
  sha256Hex,
} from "../collection-resolver/trust-protocol.js";
import { TruthTrustError } from "./errors.js";
import type {
  BootstrapEquivocation,
  BootstrapEquivocationLedger,
} from "./trust-control-plane.js";
import type { TrustBootstrapReceiptV1 } from "./schemas/trust.js";
import {
  anchorAuthorizedBootstrapEquivocation,
  type TrustedGenerationStoreService,
} from "./trust-state-store.js";

interface LedgerState {
  readonly bindings: Readonly<Record<string, string>>;
  readonly equivocations: ReadonlyArray<BootstrapEquivocation>;
}

const emptyState = (): LedgerState => ({
  bindings: {},
  equivocations: [],
});

export const bootstrapIdentityBindingDigest = (
  receipt: TrustBootstrapReceiptV1,
): string => {
  const bindings = receiptBindings(receipt);
  return sha256Hex(
    jcsCanonicalize({
      environment: receipt.environment,
      bindings,
    }),
  );
};

const receiptBindings = (
  receipt: TrustBootstrapReceiptV1,
): Record<string, string> => {
  const bindings: Record<string, string> = {};
  for (const observation of receipt.observations) {
    for (const [kind, identity] of [
      ["channel", observation.channel_id],
      ["operator", observation.operator_id],
      ["credential", observation.credential_id],
    ] as const) {
      bindings[`${receipt.environment}\0${kind}\0${identity}`] =
        observation.bundle_digest;
    }
  }
  return bindings;
};

const stateBindingDigest = (
  environment: string,
  state: LedgerState,
): string =>
  sha256Hex(
    jcsCanonicalize({
      environment,
      bindings: state.bindings,
    }),
  );

const stateEquivocationAnchor = (
  state: LedgerState,
): { readonly sequence: string; readonly digest: string | null } => {
  let digest: string | null = null;
  state.equivocations.forEach((conflict, index) => {
    digest = sha256Hex(
      jcsCanonicalize({
        sequence: String(index + 1),
        prior_digest: digest,
        conflict,
      }),
    );
  });
  return {
    sequence: String(state.equivocations.length),
    digest,
  };
};

const sameKeys = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
};

const failure = (reason: string) =>
  new TruthTrustError({
    boundary: "truth.trust.bootstrap.equivocation",
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

const readState = (path: string): LedgerState => {
  if (!existsSync(path)) return emptyState();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LedgerState>;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.bindings === null ||
    typeof parsed.bindings !== "object" ||
    !Array.isArray(parsed.equivocations) ||
    Object.values(parsed.bindings).some(
      (digest) => !/^[0-9a-f]{64}$/.test(String(digest)),
    )
  ) {
    throw new Error("equivocation ledger state is invalid");
  }
  return {
    bindings: { ...parsed.bindings } as Record<string, string>,
    equivocations: [...parsed.equivocations] as BootstrapEquivocation[],
  };
};

const writeState = (path: string, state: LedgerState): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, jcsCanonicalize(state));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
};

const recordReceipt = (
  current: LedgerState,
  receipt: TrustBootstrapReceiptV1,
): {
  readonly state: LedgerState;
  readonly conflict: BootstrapEquivocation | null;
} => {
  const bindings = { ...current.bindings };
  let conflict: BootstrapEquivocation | null = null;
  for (const observation of receipt.observations) {
    const identities = [
      ["channel", observation.channel_id],
      ["operator", observation.operator_id],
      ["credential", observation.credential_id],
    ] as const;
    for (const [kind, identity] of identities) {
      const key = `${receipt.environment}\0${kind}\0${identity}`;
      const prior = bindings[key];
      if (
        prior !== undefined &&
        prior !== observation.bundle_digest &&
        conflict === null
      ) {
        conflict = {
          environment: receipt.environment,
          identity_kind: kind,
          identity_id: identity,
          prior_digest: prior,
          conflicting_digest: observation.bundle_digest,
        };
      } else if (prior === undefined) {
        bindings[key] = observation.bundle_digest;
      }
    }
  }
  return {
    conflict,
    state: {
      bindings,
      equivocations:
        conflict === null
          ? current.equivocations
          : [...current.equivocations, conflict],
    },
  };
};

export const makeFilesystemBootstrapEquivocationLedger = (
  root: string,
  environment: TrustBootstrapReceiptV1["environment"],
  trustedGenerations: TrustedGenerationStoreService,
): BootstrapEquivocationLedger => {
  const environmentRoot = join(root, environment);
  const statePath = join(environmentRoot, "bootstrap-equivocation-ledger.json");
  const lockPath = join(environmentRoot, "bootstrap-equivocation-ledger.lock");
  return {
    record: (receipt, acceptedAt) =>
      Effect.gen(function* () {
        if (receipt.environment !== environment) {
          return yield* Effect.fail(
            failure("bootstrap receipt environment does not match ledger"),
          );
        }
        const bootstrapStatus =
          yield* trustedGenerations.bootstrapStatus(environment);
        if (!existsSync(statePath)) {
          if (bootstrapStatus !== "EMPTY") {
            return yield* Effect.fail(
              failure(
                "UNKNOWN: bootstrap equivocation ledger is missing after trust initialization",
              ),
            );
          }
        } else if (bootstrapStatus === "ACTIVE") {
          const state = yield* Effect.try({
            try: () => readState(statePath),
            catch: (cause) =>
              failure(
                cause instanceof Error
                  ? cause.message
                  : "equivocation ledger read failed",
              ),
          });
          const trusted = yield* trustedGenerations.read(environment);
          const anchor = stateEquivocationAnchor(state);
          if (
            stateBindingDigest(environment, state) !==
              trusted.unsigned_record.bootstrap_binding_digest ||
            anchor.sequence !==
              trusted.unsigned_record.bootstrap_equivocation_sequence ||
            anchor.digest !==
              trusted.unsigned_record.bootstrap_equivocation_digest
          ) {
            return yield* Effect.fail(
              failure(
                "UNKNOWN: bootstrap identity bindings do not match trusted high-water",
              ),
            );
          }
          if (!sameKeys(state.bindings, receiptBindings(receipt))) {
            return yield* Effect.fail(
              failure(
                "active bootstrap identity set is immutable; rotation ceremony required",
              ),
            );
          }
        }
        const written = yield* Effect.try({
          try: () => {
          mkdirSync(environmentRoot, { recursive: true, mode: 0o700 });
          const lock = openSync(lockPath, "wx", 0o600);
          closeSync(lock);
          try {
            const before = readState(statePath);
            const result = recordReceipt(before, receipt);
            writeState(statePath, result.state);
            return {
              result,
              priorAnchor: stateEquivocationAnchor(before),
              nextAnchor: stateEquivocationAnchor(result.state),
            };
          } finally {
            unlinkSync(lockPath);
            fsyncDirectory(environmentRoot);
          }
          },
          catch: (cause) =>
            cause instanceof TruthTrustError
              ? cause
              : failure(
                  cause instanceof Error
                    ? cause.message
                    : "equivocation ledger write failed",
                ),
        });
        if (written.result.conflict !== null) {
          if (bootstrapStatus === "ACTIVE") {
            yield* anchorAuthorizedBootstrapEquivocation(
              trustedGenerations,
              environment,
              written.priorAnchor.sequence,
              written.priorAnchor.digest,
              written.nextAnchor.sequence,
              written.nextAnchor.digest!,
              acceptedAt,
            );
          }
          return yield* Effect.fail(
            failure(
              `bootstrap equivocation recorded for ${written.result.conflict.identity_kind} ${written.result.conflict.identity_id}`,
            ),
          );
        }
      }),
    equivocations: Effect.gen(function* () {
      const bootstrapStatus =
        yield* trustedGenerations.bootstrapStatus(environment);
      if (!existsSync(statePath)) {
        return bootstrapStatus === "EMPTY"
          ? []
          : yield* Effect.fail(
              failure(
                "UNKNOWN: bootstrap equivocation ledger is missing after trust initialization",
              ),
            );
      }
      const state = yield* Effect.try({
        try: () => readState(statePath),
        catch: (cause) =>
          failure(
            cause instanceof Error
              ? cause.message
              : "equivocation ledger read failed",
          ),
      });
      if (bootstrapStatus === "ACTIVE") {
        const trusted = yield* trustedGenerations.read(environment);
        const anchor = stateEquivocationAnchor(state);
        if (
          stateBindingDigest(environment, state) !==
            trusted.unsigned_record.bootstrap_binding_digest ||
          anchor.sequence !==
            trusted.unsigned_record.bootstrap_equivocation_sequence ||
          anchor.digest !==
            trusted.unsigned_record.bootstrap_equivocation_digest
        ) {
          return yield* Effect.fail(
            failure(
              "UNKNOWN: bootstrap identity bindings do not match trusted high-water",
            ),
          );
        }
      }
      return [...state.equivocations];
    }),
    anchor: Effect.gen(function* () {
      const bootstrapStatus =
        yield* trustedGenerations.bootstrapStatus(environment);
      const state = yield* Effect.try({
        try: () => readState(statePath),
        catch: (cause) =>
          failure(
            cause instanceof Error
              ? cause.message
              : "equivocation ledger read failed",
          ),
      });
      const anchor = stateEquivocationAnchor(state);
      if (bootstrapStatus === "ACTIVE") {
        const trusted = yield* trustedGenerations.read(environment);
        if (
          stateBindingDigest(environment, state) !==
            trusted.unsigned_record.bootstrap_binding_digest ||
          anchor.sequence !==
            trusted.unsigned_record.bootstrap_equivocation_sequence ||
          anchor.digest !==
            trusted.unsigned_record.bootstrap_equivocation_digest
        ) {
          return yield* Effect.fail(
            failure(
              "UNKNOWN: bootstrap ledger does not match trusted high-water",
            ),
          );
        }
      }
      return {
        sequence: anchor.sequence as never,
        digest: anchor.digest,
      };
    }),
  };
};
