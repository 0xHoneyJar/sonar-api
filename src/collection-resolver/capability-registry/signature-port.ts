/**
 * Signature verification port for capability-registry baselines.
 *
 * Sonar does not own production signing infrastructure in CR-101. Callers
 * inject a verifier; tests use a hermetic verifier. Never invent a production
 * signature or treat an unsigned digest as attested.
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

/**
 * Hermetic test verifier: accepts only when signature_hex equals
 * `test:${binding_digest}:${public_key_hex}` — never a production algorithm.
 */
export const createHermeticBaselineSignatureVerifier = (): CapabilityRegistrySignatureVerifier => ({
  verifyBaseline: ({ material, envelope }) => {
    if (envelope.algorithm !== "ed25519") {
      return Effect.fail(
        new CapabilityRegistrySignatureError({
          reason: `unsupported baseline signature algorithm: ${envelope.algorithm}`,
        }),
      );
    }
    const expected = `test:${material.binding_digest.digest}:${envelope.public_key_hex}`;
    if (envelope.signature_hex !== expected) {
      return Effect.fail(
        new CapabilityRegistrySignatureError({
          reason: "hermetic baseline signature mismatch",
        }),
      );
    }
    return Effect.succeed(true as const);
  },
});

export const hermeticBaselineSignatureHex = (
  bindingDigestHex: string,
  publicKeyHex: string,
): string => `test:${bindingDigestHex}:${publicKeyHex}`;
