/**
 * Contiguous registry-sequence and cross-snapshot source_sequence rules (CR-101).
 *
 * Canonical contracts (fail closed):
 *
 * 1. Registry sequence (same epoch): candidate MUST equal current + 1 via
 *    strict uint64 arithmetic. Gaps, reuse, regression, overflow, and
 *    malformed lexical forms are refused.
 *
 * 2. Per-(network, operation) source_sequence across sequence_advance:
 *    - Iterate the union of predecessor and candidate (network, operation) keys.
 *    - Predecessor key missing from the candidate ⇒ typed transition integrity
 *      error (physical deletion refused). Retirement requires an explicit
 *      versioned disabled/tombstone row with drain/revocation effects and the
 *      exact next source_sequence — never remove/re-add at INITIAL.
 *    - Material change (state/policy/effect/evidence/availability/reason fields,
 *      excluding source_sequence) ⇒ candidate MUST be predecessor + 1.
 *    - Unchanged operation material ⇒ candidate MUST retain the identical
 *      source_sequence (silent advance / inconsistent reuse / regression /
 *      skip are refused).
 *    - Newly introduced (network, operation) ⇒ source_sequence MUST equal
 *      INITIAL_SOURCE_SEQUENCE ("1").
 *    - Epoch reset does not compare against the predecessor epoch; each
 *      operation is treated as newly introduced and must use INITIAL_SOURCE_SEQUENCE.
 */
import { Effect } from "effect";
import type { CapabilityRegistryVersion } from "../protocol.js";
import { CapabilityRegistryTransitionError, CapabilityRegistryValidationError } from "./errors.js";
import { compareDecimalUint64, networkIdentityKey, operationKinds, UINT64_MAX } from "./keys.js";
import {
  INITIAL_SOURCE_SEQUENCE,
  type NetworkCapability,
  type OperationCapability,
  type OperationKind,
} from "./schemas.js";

const UINT64_MAX_BI = BigInt(UINT64_MAX);

export const nextUint64Decimal = (
  current: string,
): Effect.Effect<string, CapabilityRegistryTransitionError> => {
  try {
    if (!/^(0|[1-9][0-9]*)$/.test(current)) {
      return Effect.fail(
        new CapabilityRegistryTransitionError({
          path: "registry_sequence",
          reason: `malformed uint64 lexical form: ${current}`,
        }),
      );
    }
    const value = BigInt(current);
    if (value > UINT64_MAX_BI) {
      return Effect.fail(
        new CapabilityRegistryTransitionError({
          path: "registry_sequence",
          reason: `uint64 overflow risk: current=${current}`,
        }),
      );
    }
    if (value === UINT64_MAX_BI) {
      return Effect.fail(
        new CapabilityRegistryTransitionError({
          path: "registry_sequence",
          reason: `contiguous advance overflows uint64 from ${current}`,
        }),
      );
    }
    return Effect.succeed((value + 1n).toString());
  } catch {
    return Effect.fail(
      new CapabilityRegistryTransitionError({
        path: "registry_sequence",
        reason: `malformed uint64 lexical form: ${current}`,
      }),
    );
  }
};

/**
 * Same-epoch registry sequences must be exactly contiguous (current + 1).
 * CR-001 allows any strictly increasing sequence; CR-101 tightens to contiguous.
 */
export const assertContiguousRegistrySequence = (input: {
  readonly current: CapabilityRegistryVersion;
  readonly candidate: CapabilityRegistryVersion;
}): Effect.Effect<void, CapabilityRegistryTransitionError> =>
  Effect.gen(function* () {
    if (input.current.registry_epoch !== input.candidate.registry_epoch) {
      return yield* Effect.fail(
        new CapabilityRegistryTransitionError({
          path: "transition.to",
          reason: "contiguous sequence check requires same registry_epoch",
        }),
      );
    }
    const expected = yield* nextUint64Decimal(input.current.registry_sequence);
    if (input.candidate.registry_sequence !== expected) {
      return yield* Effect.fail(
        new CapabilityRegistryTransitionError({
          path: "transition.to.registry_sequence",
          reason: `registry sequence must be contiguous: current=${input.current.registry_sequence} expected=${expected} candidate=${input.candidate.registry_sequence}`,
        }),
      );
    }
  });

/** Material fields that trigger a source_sequence advance when changed. */
const operationMaterialFingerprint = (operation: OperationCapability): string =>
  JSON.stringify({
    deadline: operation.deadline,
    drain_policy: operation.drain_policy,
    effective_at: operation.effective_at,
    enabled: operation.enabled,
    normative_effects: operation.normative_effects,
    prior_evidence_revocation_policy: operation.prior_evidence_revocation_policy,
    reason: operation.reason,
    reason_class: operation.reason_class,
    state: operation.state,
  });

const pathFor = (networkKey: string, kind: OperationKind, suffix: string): string =>
  `networks[${networkKey}].operations.${kind}.${suffix}`;

const requireExactNextSourceSequence = (
  previous: string,
  candidate: string,
  path: string,
): Effect.Effect<void, CapabilityRegistryValidationError> =>
  Effect.gen(function* () {
    if (!/^(0|[1-9][0-9]*)$/.test(previous) || !/^(0|[1-9][0-9]*)$/.test(candidate)) {
      return yield* Effect.fail(
        new CapabilityRegistryValidationError({
          path,
          reason: "malformed source_sequence lexical form",
        }),
      );
    }
    const prev = BigInt(previous);
    if (prev === UINT64_MAX_BI) {
      return yield* Effect.fail(
        new CapabilityRegistryValidationError({
          path,
          reason: `source_sequence contiguous advance overflows uint64 from ${previous}`,
        }),
      );
    }
    const expected = (prev + 1n).toString();
    if (candidate !== expected) {
      return yield* Effect.fail(
        new CapabilityRegistryValidationError({
          path,
          reason: `material change requires exact next source_sequence: previous=${previous} expected=${expected} candidate=${candidate}`,
        }),
      );
    }
  });

/**
 * Validate cross-snapshot source sequencing for a sequence_advance candidate set.
 * Walks the union of predecessor and candidate keys so deletions cannot slip through.
 */
export const validateCrossSnapshotSourceSequences = (input: {
  readonly previousNetworks: ReadonlyArray<NetworkCapability>;
  readonly candidateNetworks: ReadonlyArray<NetworkCapability>;
}): Effect.Effect<
  void,
  CapabilityRegistryValidationError | CapabilityRegistryTransitionError
> =>
  Effect.gen(function* () {
    const previousByKey = new Map<string, NetworkCapability>();
    for (const network of input.previousNetworks) {
      previousByKey.set(networkIdentityKey(network.network), network);
    }
    const candidateByKey = new Map<string, NetworkCapability>();
    for (const network of input.candidateNetworks) {
      candidateByKey.set(networkIdentityKey(network.network), network);
    }

    const unionKeys = [...new Set([...previousByKey.keys(), ...candidateByKey.keys()])].sort();

    for (const netKey of unionKeys) {
      const previousNetwork = previousByKey.get(netKey);
      const candidateNetwork = candidateByKey.get(netKey);

      if (previousNetwork !== undefined && candidateNetwork === undefined) {
        return yield* Effect.fail(
          new CapabilityRegistryTransitionError({
            path: `networks[${netKey}]`,
            reason:
              "predecessor network missing from candidate: physical deletion refused; retire via versioned disabled/tombstone with drain/revocation effects and exact next source_sequence",
          }),
        );
      }

      for (const kind of operationKinds) {
        const previousOp = previousNetwork?.operations[kind];
        const candidateOp = candidateNetwork?.operations[kind];

        if (previousOp !== undefined && candidateOp === undefined) {
          return yield* Effect.fail(
            new CapabilityRegistryTransitionError({
              path: pathFor(netKey, kind, "state"),
              reason:
                "predecessor operation missing from candidate: physical deletion refused; retire via versioned disabled/tombstone with drain/revocation effects and exact next source_sequence",
            }),
          );
        }

        if (candidateOp === undefined) {
          continue;
        }

        if (previousOp === undefined) {
          if (candidateOp.source_sequence !== INITIAL_SOURCE_SEQUENCE) {
            return yield* Effect.fail(
              new CapabilityRegistryValidationError({
                path: pathFor(netKey, kind, "source_sequence"),
                reason: `newly introduced operation must use INITIAL_SOURCE_SEQUENCE=${INITIAL_SOURCE_SEQUENCE}`,
              }),
            );
          }
          continue;
        }

        const materialChanged =
          operationMaterialFingerprint(previousOp) !==
          operationMaterialFingerprint(candidateOp);

        if (materialChanged) {
          yield* requireExactNextSourceSequence(
            previousOp.source_sequence,
            candidateOp.source_sequence,
            pathFor(netKey, kind, "source_sequence"),
          );
        } else if (
          compareDecimalUint64(previousOp.source_sequence, candidateOp.source_sequence) !== 0
        ) {
          return yield* Effect.fail(
            new CapabilityRegistryValidationError({
              path: pathFor(netKey, kind, "source_sequence"),
              reason: `unchanged operation must retain identical source_sequence: previous=${previousOp.source_sequence} candidate=${candidateOp.source_sequence}`,
            }),
          );
        }
      }
    }
  });

/** Exported for transition audit binding — material fields excluding source_sequence. */
export const operationMaterialChanged = (
  previous: OperationCapability,
  candidate: OperationCapability,
): boolean =>
  operationMaterialFingerprint(previous) !== operationMaterialFingerprint(candidate);

/**
 * On epoch reset, every operation is newly introduced relative to the new epoch
 * and must use INITIAL_SOURCE_SEQUENCE.
 */
export const validateEpochResetSourceSequences = (
  networks: ReadonlyArray<NetworkCapability>,
): Effect.Effect<void, CapabilityRegistryValidationError> =>
  Effect.gen(function* () {
    for (const network of networks) {
      const netKey = networkIdentityKey(network.network);
      for (const kind of operationKinds) {
        const seq = network.operations[kind].source_sequence;
        if (seq !== INITIAL_SOURCE_SEQUENCE) {
          return yield* Effect.fail(
            new CapabilityRegistryValidationError({
              path: pathFor(netKey, kind, "source_sequence"),
              reason: `epoch reset operations must use INITIAL_SOURCE_SEQUENCE=${INITIAL_SOURCE_SEQUENCE}`,
            }),
          );
        }
      }
    }
  });
