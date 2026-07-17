/**
 * Signature verification port for capability-registry baselines.
 *
 * Sonar does not own production signing infrastructure in CR-101. Callers
 * inject a production verifier. Never invent a production signature or treat an
 * unsigned digest as attested. Hermetic test helpers live in testing.ts only.
 *
 * Epoch-reset signatures bind the complete baseline material via
 * `material.binding_digest` (previous version identity + candidate version
 * identity + candidate snapshot digest). A signature for one predecessor
 * epoch cannot authorize a reset from another.
 */
import { Effect } from "effect";
import { CapabilityRegistrySignatureError } from "./errors.js";
import type {
  BaselineSignatureEnvelope,
  CapabilityRegistryBaselineMaterial,
} from "./schemas.js";

export type { BaselineSignatureEnvelope };

/**
 * Port: verify that `envelope` is a valid signature over `material.binding_digest`.
 * Implementations must fail closed on unknown algorithms / key ids.
 */
export interface CapabilityRegistrySignatureVerifier {
  readonly verifyBaseline: (input: {
    readonly material: CapabilityRegistryBaselineMaterial;
    readonly envelope: BaselineSignatureEnvelope;
  }) => Effect.Effect<true, CapabilityRegistrySignatureError>;
}

/** Explicit reject-all verifier for environments without signing infrastructure. */
export const rejectAllBaselineSignatures: CapabilityRegistrySignatureVerifier = {
  verifyBaseline: () =>
    Effect.fail(
      new CapabilityRegistrySignatureError({
        reason:
          "capability registry baseline signing infrastructure is not installed in this worktree; refusing unsigned epoch reset",
      }),
    ),
};

