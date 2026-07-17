import { Effect, Schema } from "effect";
import type { ParseOptions } from "effect/SchemaAST";
import {
  advanceCapabilityRegistryVersion,
  compareCapabilityRegistryVersions,
  decodeCapabilityRegistryBaseline,
  digestVersioned,
  type CapabilityRegistryBaseline,
  type CapabilityRegistryVersion,
  type VersionedDigest,
} from "../protocol.js";
import {
  CapabilityRegistryDecodeError,
  CapabilityRegistrySignatureError,
  CapabilityRegistryTransitionError,
  CapabilityRegistryValidationError,
} from "./errors.js";
import { cloneFreeze } from "./immutable.js";
import { networkIdentityKey, operationKinds } from "./keys.js";
import {
  CAPABILITY_REGISTRY_BASELINE_BINDING_DIGEST_DOMAIN,
  CAPABILITY_REGISTRY_DIGEST_DOMAIN,
  CAPABILITY_REGISTRY_SCHEMA_VERSION,
  CAPABILITY_REGISTRY_TRANSITION_DIGEST_DOMAIN,
  CapabilityRegistryBaselineMaterial,
  CapabilityRegistryTransition as CapabilityRegistryTransitionSchema,
  type CapabilityRegistryTransition,
  type CapabilityRegistryTransitionAudit as TransitionAudit,
  type NetworkCapability,
} from "./schemas.js";
import {
  assertContiguousRegistrySequence,
  operationMaterialChanged,
  validateCrossSnapshotSourceSequences,
  validateEpochResetSourceSequences,
} from "./sequencing.js";
import {
  createHermeticBaselineSignatureVerifier,
  hermeticBaselineSignatureHex,
  rejectAllBaselineSignatures,
  type CapabilityRegistrySignatureVerifier,
} from "./signature-port.js";
import {
  decodeCapabilityRegistrySnapshot,
  type CapabilityRegistrySnapshot,
} from "./snapshot.js";
import { validateNetworkSet } from "./validation.js";

const strictOptions: ParseOptions = {
  errors: "all",
  onExcessProperty: "error",
};

const decodeBaselineMaterial = Schema.decodeUnknown(
  CapabilityRegistryBaselineMaterial,
  strictOptions,
);

const decodeTransitionEnvelope = Schema.decodeUnknown(
  CapabilityRegistryTransitionSchema,
  strictOptions,
);

export type { CapabilityRegistryTransition };

export interface CapabilityRegistryTransitionResult {
  readonly snapshot: CapabilityRegistrySnapshot;
  readonly transition_digest: VersionedDigest;
}

const bindingDigestMaterial = (input: {
  readonly previous_version: CapabilityRegistryVersion;
  readonly version: CapabilityRegistryVersion;
  readonly snapshot_digest: string;
}): unknown => ({
  previous_version: input.previous_version,
  snapshot_digest: {
    algorithm: "sha-256",
    domain: CAPABILITY_REGISTRY_DIGEST_DOMAIN,
    major_version: 1,
    digest: input.snapshot_digest,
  },
  version: input.version,
});

const transitionDigestMaterial = (input: {
  readonly audit: TransitionAudit;
  readonly kind: CapabilityRegistryTransition["kind"];
  readonly from: CapabilityRegistryVersion;
  readonly to: CapabilityRegistryVersion;
  readonly snapshot_digest: string;
}): unknown => ({
  actor: input.audit.actor,
  effective_at: input.audit.effective_at,
  from: input.from,
  kind: input.kind,
  reason_class: input.audit.reason_class,
  snapshot_digest: input.snapshot_digest,
  to: input.to,
});

/**
 * Deterministic operation↔transition reason binding rule:
 * 1. Equal reason_class always binds.
 * 2. On epoch_reset only, a disabled tombstone may retain a disabled-class reason
 *    (capability_unsupported|operator_policy|catalog_update|kill_switch|integrity_compromise)
 *    so integrity/policy retirement rows are not forced to rewrite their disable class.
 */
export const isOperationReasonBoundToTransition = (
  operationReason: TransitionAudit["reason_class"],
  transitionReason: TransitionAudit["reason_class"],
  operationState: "available" | "degraded" | "disabled",
  transitionKind: CapabilityRegistryTransition["kind"],
): boolean => {
  if (operationReason === transitionReason) return true;
  if (
    transitionKind !== "epoch_reset" ||
    transitionReason !== "epoch_reset" ||
    operationState !== "disabled"
  ) {
    return false;
  }
  const retainedDisableReasons: ReadonlyArray<TransitionAudit["reason_class"]> = [
    "capability_unsupported",
    "operator_policy",
    "catalog_update",
    "kill_switch",
    "integrity_compromise",
  ];
  return retainedDisableReasons.includes(operationReason);
};

const validateTransitionOperationAuditBinding = (input: {
  readonly previousNetworks: ReadonlyArray<NetworkCapability>;
  readonly candidateNetworks: ReadonlyArray<NetworkCapability>;
  readonly audit: TransitionAudit;
  readonly transitionKind: CapabilityRegistryTransition["kind"];
}): Effect.Effect<void, CapabilityRegistryTransitionError> =>
  Effect.gen(function* () {
    const previousByKey = new Map<string, NetworkCapability>();
    for (const network of input.previousNetworks) {
      previousByKey.set(networkIdentityKey(network.network), network);
    }

    for (const network of input.candidateNetworks) {
      const netKey = networkIdentityKey(network.network);
      const previousNetwork = previousByKey.get(netKey);

      for (const kind of operationKinds) {
        const candidateOp = network.operations[kind];
        const previousOp = previousNetwork?.operations[kind];
        const path = `networks[${netKey}].operations.${kind}`;

        if (previousOp === undefined) {
          if (candidateOp.effective_at !== input.audit.effective_at) {
            return yield* Effect.fail(
              new CapabilityRegistryTransitionError({
                path: `${path}.effective_at`,
                reason: `newly introduced operation effective_at must equal transition effective_at=${input.audit.effective_at}`,
              }),
            );
          }
          if (
            !isOperationReasonBoundToTransition(
              candidateOp.reason_class,
              input.audit.reason_class,
              candidateOp.state,
              input.transitionKind,
            )
          ) {
            return yield* Effect.fail(
              new CapabilityRegistryTransitionError({
                path: `${path}.reason_class`,
                reason: `newly introduced operation reason_class must bind to transition reason_class=${input.audit.reason_class}`,
              }),
            );
          }
          continue;
        }

        const changed = operationMaterialChanged(previousOp, candidateOp);
        if (changed) {
          if (candidateOp.effective_at !== input.audit.effective_at) {
            return yield* Effect.fail(
              new CapabilityRegistryTransitionError({
                path: `${path}.effective_at`,
                reason: `materially changed operation effective_at must equal transition effective_at=${input.audit.effective_at}`,
              }),
            );
          }
          if (
            !isOperationReasonBoundToTransition(
              candidateOp.reason_class,
              input.audit.reason_class,
              candidateOp.state,
              input.transitionKind,
            )
          ) {
            return yield* Effect.fail(
              new CapabilityRegistryTransitionError({
                path: `${path}.reason_class`,
                reason: `materially changed operation reason_class must bind to transition reason_class=${input.audit.reason_class}`,
              }),
            );
          }
        } else if (
          candidateOp.effective_at !== previousOp.effective_at ||
          candidateOp.reason_class !== previousOp.reason_class
        ) {
          return yield* Effect.fail(
            new CapabilityRegistryTransitionError({
              path: `${path}.audit`,
              reason:
                "unchanged operation must retain previous effective_at and reason_class (silent audit rewrite refused)",
            }),
          );
        }
      }
    }
  });

export const buildBaselineMaterial = (
  snapshot: CapabilityRegistrySnapshot,
  previousVersion: CapabilityRegistryVersion,
): Effect.Effect<
  Schema.Schema.Type<typeof CapabilityRegistryBaselineMaterial>,
  CapabilityRegistryDecodeError
> =>
  Effect.gen(function* () {
    const binding_digest = yield* digestVersioned(
      CAPABILITY_REGISTRY_BASELINE_BINDING_DIGEST_DOMAIN,
      1,
      bindingDigestMaterial({
        previous_version: previousVersion,
        version: snapshot.version,
        snapshot_digest: snapshot.snapshot_digest.digest,
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityRegistryDecodeError({
            reason: "failed to compute baseline binding digest",
            cause,
          }),
      ),
    );

    const raw = {
      schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
      previous_version: previousVersion,
      version: snapshot.version,
      snapshot_digest: {
        algorithm: "sha-256" as const,
        domain: CAPABILITY_REGISTRY_DIGEST_DOMAIN,
        major_version: 1 as const,
        digest: snapshot.snapshot_digest.digest,
      },
      binding_digest,
    };

    return yield* decodeBaselineMaterial(raw).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityRegistryDecodeError({
            reason: "baseline material failed strict decode",
            cause,
          }),
      ),
      Effect.map((material) => cloneFreeze(material)),
    );
  });

const digestTransition = (
  audit: TransitionAudit,
  transition: CapabilityRegistryTransition,
  snapshot: CapabilityRegistrySnapshot,
): Effect.Effect<VersionedDigest, CapabilityRegistryDecodeError> =>
  digestVersioned(
    CAPABILITY_REGISTRY_TRANSITION_DIGEST_DOMAIN,
    1,
    transitionDigestMaterial({
      audit,
      kind: transition.kind,
      from: transition.from,
      to: transition.to,
      snapshot_digest: snapshot.snapshot_digest.digest,
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new CapabilityRegistryDecodeError({
          reason: "failed to compute capability registry transition digest",
          cause,
        }),
    ),
  );

/**
 * Apply an append-only / versioned transition.
 *
 * The complete discriminated transition envelope is strict-decoded first
 * (excess top-level properties refused). Audit fields, digests, sequence /
 * signature verification, and transition logic operate only on decoded values.
 *
 * Same-epoch sequences must be exactly contiguous (current + 1).
 * New epochs require a verified signature over the complete baseline binding digest.
 */
export const applyCapabilityRegistryTransition = (input: {
  readonly current: CapabilityRegistrySnapshot;
  readonly transition: unknown;
  readonly signatureVerifier?: CapabilityRegistrySignatureVerifier;
}): Effect.Effect<
  CapabilityRegistryTransitionResult,
  | CapabilityRegistryDecodeError
  | CapabilityRegistryValidationError
  | CapabilityRegistryTransitionError
  | CapabilityRegistrySignatureError
> =>
  Effect.gen(function* () {
    const verifier = input.signatureVerifier ?? rejectAllBaselineSignatures;
    const { current } = input;

    // Strict-decode the complete discriminated envelope before any projection,
    // digest, sequence/signature verification, or transition logic.
    const transition = yield* decodeTransitionEnvelope(input.transition).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityRegistryDecodeError({
            reason:
              "transition envelope failed strict decode (excess properties and undeclared top-level fields refused)",
            cause,
          }),
      ),
      Effect.map((decoded) => cloneFreeze(decoded)),
    );

    // Audit event is derived only from the fully decoded transition.
    const audit: TransitionAudit = cloneFreeze({
      reason_class: transition.reason_class,
      effective_at: transition.effective_at,
      actor: transition.actor,
    });

    if (
      transition.from.registry_epoch !== current.version.registry_epoch ||
      transition.from.registry_sequence !== current.version.registry_sequence
    ) {
      return yield* Effect.fail(
        new CapabilityRegistryTransitionError({
          path: "transition.from",
          reason: "transition.from must equal the current snapshot identity",
        }),
      );
    }

    yield* validateNetworkSet(transition.networks);

    if (transition.kind === "sequence_advance") {
      yield* assertContiguousRegistrySequence({
        current: current.version,
        candidate: transition.to,
      });

      yield* validateCrossSnapshotSourceSequences({
        previousNetworks: current.networks,
        candidateNetworks: transition.networks,
      });

      yield* validateTransitionOperationAuditBinding({
        previousNetworks: current.networks,
        candidateNetworks: transition.networks,
        audit,
        transitionKind: transition.kind,
      });

      const advance = yield* advanceCapabilityRegistryVersion(
        current.version,
        transition.to,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CapabilityRegistryTransitionError({
              path: "transition.to",
              reason:
                cause._tag === "RegistrySequenceRegressionError"
                  ? `stale or out-of-order sequence: current=${cause.current_sequence} candidate=${cause.candidate_sequence}`
                  : `sequence advance rejected: ${cause._tag}`,
            }),
        ),
      );
      if (advance !== "sequence") {
        return yield* Effect.fail(
          new CapabilityRegistryTransitionError({
            path: "transition.kind",
            reason: "expected sequence advance",
          }),
        );
      }

      const snapshot = yield* decodeCapabilityRegistrySnapshot({
        schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
        version: transition.to,
        networks: transition.networks,
      });
      const transition_digest = yield* digestTransition(audit, transition, snapshot);
      return { snapshot, transition_digest };
    }

    // epoch_reset — baseline + signature already required by the envelope schema.
    yield* validateEpochResetSourceSequences(transition.networks);

    // Epoch reset treats every operation as newly introduced relative to the new epoch.
    yield* validateTransitionOperationAuditBinding({
      previousNetworks: [],
      candidateNetworks: transition.networks,
      audit,
      transitionKind: transition.kind,
    });

    const verifiedBaseline = yield* decodeCapabilityRegistryBaseline(
      transition.baseline,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityRegistryTransitionError({
            path: "transition.baseline",
            reason: `baseline integrity failed: ${String(cause)}`,
          }),
      ),
    );

    const next = yield* decodeCapabilityRegistrySnapshot({
      schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
      version: transition.to,
      networks: transition.networks,
    });

    const material = yield* buildBaselineMaterial(next, current.version);

    if (material.snapshot_digest.digest !== next.snapshot_digest.digest) {
      return yield* Effect.fail(
        new CapabilityRegistryTransitionError({
          path: "transition.baseline_material",
          reason: "baseline material digest does not match candidate snapshot",
        }),
      );
    }

    if (
      material.previous_version.registry_epoch !== current.version.registry_epoch ||
      material.previous_version.registry_sequence !== current.version.registry_sequence
    ) {
      return yield* Effect.fail(
        new CapabilityRegistryTransitionError({
          path: "transition.baseline_material",
          reason: "baseline material must bind the exact predecessor snapshot identity",
        }),
      );
    }

    if (
      verifiedBaseline.previous_registry_epoch !== current.version.registry_epoch ||
      verifiedBaseline.version.registry_epoch !== transition.to.registry_epoch ||
      verifiedBaseline.version.registry_sequence !== transition.to.registry_sequence
    ) {
      return yield* Effect.fail(
        new CapabilityRegistryTransitionError({
          path: "transition.baseline",
          reason: "baseline does not authorize this exact epoch reset identity",
        }),
      );
    }

    // Signature covers the complete binding digest — predecessor identity included.
    yield* verifier.verifyBaseline({
      material,
      envelope: transition.signature,
    });

    yield* advanceCapabilityRegistryVersion(
      current.version,
      transition.to,
      verifiedBaseline,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityRegistryTransitionError({
            path: "transition.to",
            reason: `epoch reset advance rejected: ${cause._tag}`,
          }),
      ),
    );

    const transition_digest = yield* digestTransition(audit, transition, next);
    return { snapshot: next, transition_digest };
  });

export const compareSnapshotIdentities = (
  left: CapabilityRegistryVersion,
  right: CapabilityRegistryVersion,
) => compareCapabilityRegistryVersions(left, right);

export {
  createHermeticBaselineSignatureVerifier,
  hermeticBaselineSignatureHex,
  rejectAllBaselineSignatures,
};

/** Helper for tests: build a CR-001 baseline for an epoch reset candidate. */
export const makeEpochResetBaseline = (input: {
  readonly previousEpoch: string;
  readonly next: CapabilityRegistryVersion;
}): Effect.Effect<CapabilityRegistryBaseline, CapabilityRegistryDecodeError> =>
  Effect.gen(function* () {
    const baselineDigest = yield* digestVersioned(
      "capability.registry-baseline",
      1,
      {
        previous_registry_epoch: input.previousEpoch,
        version: input.next,
      },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityRegistryDecodeError({
            reason: "failed to digest epoch reset baseline",
            cause,
          }),
      ),
    );
    return {
      schema_version: 1 as const,
      previous_registry_epoch: input.previousEpoch,
      version: input.next,
      baseline_digest: baselineDigest,
    };
  });

/** Remap every operation source_sequence to INITIAL for epoch-reset candidates. */
export const withInitialSourceSequences = (
  network: NetworkCapability,
  effectiveAt: string,
): NetworkCapability => ({
  ...network,
  operations: {
    recognize: {
      ...network.operations.recognize,
      source_sequence: "1",
      effective_at: effectiveAt,
      reason_class:
        network.operations.recognize.state === "disabled"
          ? network.operations.recognize.reason_class
          : "epoch_reset",
    },
    prepare: {
      ...network.operations.prepare,
      source_sequence: "1",
      effective_at: effectiveAt,
      reason_class:
        network.operations.prepare.state === "disabled"
          ? network.operations.prepare.reason_class
          : "epoch_reset",
    },
    read_evidence: {
      ...network.operations.read_evidence,
      source_sequence: "1",
      effective_at: effectiveAt,
      reason_class:
        network.operations.read_evidence.state === "disabled"
          ? network.operations.read_evidence.reason_class
          : "epoch_reset",
    },
  },
});
