/**
 * Hermetic baseline signature helpers — test-only.
 *
 * Uses a distinct algorithm label (`hermetic_sha512_v1`) so it cannot be
 * mistaken for production ed25519 verification.
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { CapabilityRegistrySignatureError } from "./errors.js";
import type { BaselineSignatureEnvelope } from "./schemas.js";
import type { CapabilityRegistrySignatureVerifier } from "./signature-port.js";

export const HERMETIC_BASELINE_SIGNATURE_ALGORITHM = "hermetic_sha512_v1" as const;

export const createHermeticBaselineSignatureVerifier = (): CapabilityRegistrySignatureVerifier => ({
  verifyBaseline: ({ material, envelope }) => {
    if (envelope.algorithm !== HERMETIC_BASELINE_SIGNATURE_ALGORITHM) {
      return Effect.fail(
        new CapabilityRegistrySignatureError({
          reason: `unsupported baseline signature algorithm: ${envelope.algorithm}`,
        }),
      );
    }
    const expected = hermeticBaselineSignatureHex(
      material.binding_digest.digest,
      envelope.public_key_hex,
    );
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
): string =>
  createHash("sha512")
    .update(`test:${bindingDigestHex}:${publicKeyHex}`, "utf8")
    .digest("hex");

export const hermeticBaselineSignatureEnvelope = (input: {
  readonly bindingDigestHex: string;
  readonly publicKeyHex: string;
}): Extract<BaselineSignatureEnvelope, { algorithm: typeof HERMETIC_BASELINE_SIGNATURE_ALGORITHM }> => ({
  algorithm: HERMETIC_BASELINE_SIGNATURE_ALGORITHM,
  public_key_hex: input.publicKeyHex,
  signature_hex: hermeticBaselineSignatureHex(input.bindingDigestHex, input.publicKeyHex),
});
