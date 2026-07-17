/**
 * CR-107 live capability snapshot provider + atomic last-known-good store.
 *
 * CR-101 remains the sole per-network-disable authority. This store accepts
 * an initial validated snapshot at construction/bootstrap only. Every later
 * advance MUST go through `applyCapabilityRegistryTransition`. Invalid,
 * noncontiguous, or downgrade transitions retain the prior snapshot and return
 * a typed safe error — never reconstructing resolver deps for a valid disable.
 *
 * There is intentionally no public post-bootstrap snapshot replacement API.
 */
import { Data, Effect } from "effect";
import {
  applyCapabilityRegistryTransition,
  type CapabilityRegistryTransitionResult,
} from "../../capability-registry/transitions.js";
import type { CapabilityRegistryTransition } from "../../capability-registry/schemas.js";
import type { CapabilityRegistrySnapshot } from "../../capability-registry/snapshot.js";
import type { CapabilityRegistrySignatureVerifier } from "../../capability-registry/signature-port.js";
import { cloneFreeze } from "../../capability-registry/immutable.js";

/**
 * Read-only provider — snapshot once at request start and pin that version for
 * the entire request even if the underlying store advances concurrently.
 */
export interface CapabilitySnapshotProviderPort {
  readonly current: () => CapabilityRegistrySnapshot;
}

export class CapabilitySnapshotStoreError extends Data.TaggedError(
  "CapabilitySnapshotStoreError",
)<{
  /** Safe reason code — never raw transition/parse trees or actor identity. */
  readonly reason: string;
  readonly safe_code:
    | "transition_rejected"
    | "decode_failed"
    | "validation_failed"
    | "signature_failed"
    | "unexpected";
}> {}

export type CapabilitySnapshotApplyError = CapabilitySnapshotStoreError;

export interface CapabilitySnapshotRuntimeStore extends CapabilitySnapshotProviderPort {
  /**
   * Apply a versioned CR-101 transition against the current LKG.
   * On failure the prior snapshot is retained unchanged.
   */
  readonly applyTransition: (input: {
    readonly transition: unknown;
    readonly signatureVerifier?: CapabilityRegistrySignatureVerifier;
  }) => Effect.Effect<
    CapabilityRegistryTransitionResult,
    CapabilitySnapshotApplyError
  >;
  readonly version: () => CapabilityRegistrySnapshot["version"];
}

/**
 * Static compatibility adapter — wraps an immutable snapshot so existing
 * callsites keep working without a live store.
 */
export const staticCapabilitySnapshotProvider = (
  snapshot: CapabilityRegistrySnapshot,
): CapabilitySnapshotProviderPort => {
  const frozen = cloneFreeze(snapshot);
  return {
    current: () => frozen,
  };
};

const toStoreError = (cause: unknown): CapabilitySnapshotStoreError => {
  if (
    cause !== null &&
    typeof cause === "object" &&
    "_tag" in cause &&
    typeof (cause as { _tag: unknown })._tag === "string"
  ) {
    const tag = (cause as { _tag: string })._tag;
    if (tag === "CapabilityRegistryTransitionError") {
      return new CapabilitySnapshotStoreError({
        reason: "capability registry transition rejected; last-known-good retained",
        safe_code: "transition_rejected",
      });
    }
    if (tag === "CapabilityRegistryDecodeError") {
      return new CapabilitySnapshotStoreError({
        reason: "capability registry transition decode failed; last-known-good retained",
        safe_code: "decode_failed",
      });
    }
    if (tag === "CapabilityRegistryValidationError") {
      return new CapabilitySnapshotStoreError({
        reason: "capability registry transition validation failed; last-known-good retained",
        safe_code: "validation_failed",
      });
    }
    if (tag === "CapabilityRegistrySignatureError") {
      return new CapabilitySnapshotStoreError({
        reason: "capability registry baseline signature failed; last-known-good retained",
        safe_code: "signature_failed",
      });
    }
  }
  return new CapabilitySnapshotStoreError({
    reason: "capability snapshot store update failed; last-known-good retained",
    safe_code: "unexpected",
  });
};

/**
 * Atomic in-memory LKG store. Bootstrap with a validated snapshot; every later
 * advance goes through `applyTransition`. `current()` returns the immutable
 * snapshot reference present at call time — a request that captured it earlier
 * is unaffected by later successful applies.
 */
export const createMemoryCapabilitySnapshotStore = (
  initial: CapabilityRegistrySnapshot,
): CapabilitySnapshotRuntimeStore => {
  let lkg: CapabilityRegistrySnapshot = cloneFreeze(initial);

  return {
    current: () => lkg,
    version: () => lkg.version,
    applyTransition: Effect.fn("recognition.capabilitySnapshot.applyTransition")(
      function* (input: {
        readonly transition: unknown;
        readonly signatureVerifier?: CapabilityRegistrySignatureVerifier;
      }) {
        const result = yield* applyCapabilityRegistryTransition({
          current: lkg,
          transition: input.transition as CapabilityRegistryTransition,
          signatureVerifier: input.signatureVerifier,
        }).pipe(Effect.mapError((cause) => toStoreError(cause)));

        // Atomic publish only after a valid transition result.
        lkg = result.snapshot;
        return result;
      },
    ),
  };
};

/**
 * Resolve the snapshot for one request: prefer live provider, else static dep.
 * Caller MUST capture the return value once and reuse it for the request.
 */
export const resolveRequestCapabilitySnapshot = (input: {
  readonly capabilitySnapshot: CapabilityRegistrySnapshot;
  readonly capabilitySnapshotProvider?: CapabilitySnapshotProviderPort;
}): CapabilityRegistrySnapshot =>
  input.capabilitySnapshotProvider?.current() ?? input.capabilitySnapshot;
