import type { TrustEnvelopeSigner } from "../collection-resolver/trust-protocol.js";
import { verifyEd25519Signature } from "../collection-resolver/trust-protocol.js";

import type {
  DecimalUint64,
  Sha256Digest,
  TruthEnvironmentId,
} from "./schemas/common.js";

const encoder = new TextEncoder();
const TRUTH_ROOT_DOMAIN = "sonar.truth-contract.v1";

/**
 * The NUL-delimited domain binds one signature to this protocol, environment,
 * generation, and root digest. Do not reuse these bytes for another artifact.
 */
export const truthRootSigningBytes = (
  environment: TruthEnvironmentId,
  generation: DecimalUint64,
  rootHash: Sha256Digest,
): Uint8Array =>
  encoder.encode(`${TRUTH_ROOT_DOMAIN}\0${environment}\0${generation}\0${rootHash}`);

export const signTruthRoot = (
  signer: TrustEnvelopeSigner,
  environment: TruthEnvironmentId,
  generation: DecimalUint64,
  rootHash: Sha256Digest,
): string => signer.sign(truthRootSigningBytes(environment, generation, rootHash));

export const verifyTruthRootSignature = (
  publicKeyHex: string,
  environment: TruthEnvironmentId,
  generation: DecimalUint64,
  rootHash: Sha256Digest,
  signature: string,
): boolean =>
  verifyEd25519Signature(
    publicKeyHex,
    truthRootSigningBytes(environment, generation, rootHash),
    signature,
  );
