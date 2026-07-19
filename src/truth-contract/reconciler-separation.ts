import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { TrustEnvelopeSigner } from "../collection-resolver/trust-protocol.js";
import {
  jcsCanonicalize,
  sha256Hex,
  verifyEd25519Signature,
} from "../collection-resolver/trust-protocol.js";
import type { ReconciliationPrincipalV1 } from "./reconciliation.js";

const encoder = new TextEncoder();
const SEPARATION_DOMAIN = "sonar.staged-reconciler-separation.v1";

export interface StagedReconcilerSeparationBodyV1 {
  readonly schema_version: 1;
  readonly environment: "development" | "staging";
  readonly validity: "STAGED_VALID";
  readonly producer: ReconciliationPrincipalV1;
  readonly reconciler: ReconciliationPrincipalV1;
  readonly producer_pid: string;
  readonly reconciler_pid: string;
  readonly forbidden_authority_key_ids: readonly string[];
  readonly artifact_directory_realpath: string;
  readonly artifact_directory_mode: string;
  readonly launched_at: string;
  readonly expires_at: string;
  readonly production_authority: false;
}

export interface SignedStagedReconcilerSeparationV1 {
  readonly _tag: "StagedReconcilerSeparationV1";
  readonly body: StagedReconcilerSeparationBodyV1;
  readonly attestation_hash: string;
  readonly signer_key_id: string;
  readonly signature: string;
}

const UINT = /^(0|[1-9][0-9]*)$/;
const assert: (condition: unknown, reason: string) => asserts condition = (
  condition,
  reason,
) => {
  if (!condition) throw new Error(reason);
};

const assertDirectoryBoundary = (
  reconcilerDirectory: string,
  producerDirectory: string,
): { realpath: string; mode: string } => {
  assert(isAbsolute(reconcilerDirectory), "reconciler artifact directory must be absolute");
  assert(isAbsolute(producerDirectory), "producer artifact directory must be absolute");
  const reconcilerLink = lstatSync(reconcilerDirectory);
  const producerLink = lstatSync(producerDirectory);
  assert(reconcilerLink.isDirectory(), "reconciler artifact path is not a directory");
  assert(producerLink.isDirectory(), "producer artifact path is not a directory");
  assert(!reconcilerLink.isSymbolicLink(), "reconciler artifact directory is a symlink");
  assert(!producerLink.isSymbolicLink(), "producer artifact directory is a symlink");
  const reconcilerRealpath = realpathSync(reconcilerDirectory);
  const producerRealpath = realpathSync(producerDirectory);
  assert(reconcilerRealpath !== producerRealpath, "artifact directories are not separated");
  const stat = statSync(reconcilerRealpath);
  assert((stat.mode & 0o022) === 0, "reconciler artifact directory is group/world writable");
  if (typeof process.getuid === "function") {
    assert(stat.uid === process.getuid(), "reconciler artifact directory owner mismatch");
  }
  return {
    realpath: reconcilerRealpath,
    mode: (stat.mode & 0o777).toString(8).padStart(3, "0"),
  };
};

const assertExactKeys = (
  value: object,
  expected: readonly string[],
  boundary: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]),
    `${boundary} contains missing or unknown fields`,
  );
};

const signingBytes = (
  body: StagedReconcilerSeparationBodyV1,
  attestationHash: string,
): Uint8Array =>
  encoder.encode(
    `${SEPARATION_DOMAIN}\0${body.environment}\0${attestationHash}`,
  );

export const compileStagedReconcilerSeparationV1 = (
  input: Omit<
    StagedReconcilerSeparationBodyV1,
    | "schema_version"
    | "validity"
    | "artifact_directory_realpath"
    | "artifact_directory_mode"
    | "production_authority"
  >,
  signer: TrustEnvelopeSigner,
): SignedStagedReconcilerSeparationV1 => {
  assert(input.reconciler.key_id === signer.keyId, "reconciler signer key mismatch");
  assert(input.producer.key_id !== input.reconciler.key_id, "producer key reused by reconciler");
  assert(input.producer.service_id !== input.reconciler.service_id, "producer principal reused");
  assert(input.producer.process_id !== input.reconciler.process_id, "producer process reused");
  assert(
    input.producer.network_boundary !== input.reconciler.network_boundary,
    "producer network boundary reused",
  );
  assert(
    !input.forbidden_authority_key_ids.includes(input.reconciler.key_id),
    "reconciler key overlaps governance, recovery, or revocation authority",
  );
  assert(UINT.test(input.producer_pid) && UINT.test(input.reconciler_pid), "invalid process id");
  assert(input.producer_pid !== input.reconciler_pid, "reconciler was not separately launched");
  assert(Date.parse(input.expires_at) > Date.parse(input.launched_at), "invalid attestation interval");
  const directory = assertDirectoryBoundary(
    input.reconciler.artifact_directory,
    input.producer.artifact_directory,
  );
  const body: StagedReconcilerSeparationBodyV1 = {
    schema_version: 1,
    validity: "STAGED_VALID",
    ...input,
    artifact_directory_realpath: directory.realpath,
    artifact_directory_mode: directory.mode,
    production_authority: false,
  };
  const attestationHash = sha256Hex(jcsCanonicalize(body));
  return {
    _tag: "StagedReconcilerSeparationV1",
    body,
    attestation_hash: attestationHash,
    signer_key_id: signer.keyId,
    signature: signer.sign(signingBytes(body, attestationHash)),
  };
};

export const verifyStagedReconcilerSeparationV1 = (
  attestation: SignedStagedReconcilerSeparationV1,
  publicKeyHex: string,
  expectedProducer: ReconciliationPrincipalV1,
  expectedReconciler: ReconciliationPrincipalV1,
  expectedForbiddenAuthorityKeyIds: readonly string[],
  now: string,
): boolean => {
  try {
    assertExactKeys(
      attestation,
      ["_tag", "body", "attestation_hash", "signer_key_id", "signature"],
      "separation attestation",
    );
    assertExactKeys(
      attestation.body,
      [
        "schema_version",
        "environment",
        "validity",
        "producer",
        "reconciler",
        "producer_pid",
        "reconciler_pid",
        "forbidden_authority_key_ids",
        "artifact_directory_realpath",
        "artifact_directory_mode",
        "launched_at",
        "expires_at",
        "production_authority",
      ],
      "separation attestation body",
    );
    assert(attestation.body.schema_version === 1, "unsupported attestation schema");
    assert(attestation._tag === "StagedReconcilerSeparationV1", "wrong attestation tag");
    assert(attestation.body.validity === "STAGED_VALID", "wrong validity class");
    assert(attestation.body.production_authority === false, "authority laundering");
    assert(
      attestation.body.environment === "development" ||
        attestation.body.environment === "staging",
      "production separation attestation is forbidden",
    );
    assert(attestation.signer_key_id === expectedReconciler.key_id, "unexpected signer");
    assert(
      jcsCanonicalize(attestation.body.producer) === jcsCanonicalize(expectedProducer),
      "producer principal mismatch",
    );
    assert(
      jcsCanonicalize(attestation.body.reconciler) === jcsCanonicalize(expectedReconciler),
      "reconciler principal mismatch",
    );
    assert(
      attestation.body.producer_pid !== attestation.body.reconciler_pid,
      "producer and reconciler PID overlap",
    );
    assert(
      expectedProducer.process_id === `pid-${attestation.body.producer_pid}`,
      "producer PID does not bind principal process",
    );
    assert(
      expectedReconciler.process_id === `pid-${attestation.body.reconciler_pid}`,
      "reconciler PID does not bind principal process",
    );
    assert(
      new Set(expectedForbiddenAuthorityKeyIds).size ===
        expectedForbiddenAuthorityKeyIds.length,
      "trusted forbidden-authority set contains duplicates",
    );
    assert(
      [...attestation.body.forbidden_authority_key_ids].sort().join("\0") ===
        [...expectedForbiddenAuthorityKeyIds].sort().join("\0"),
      "forbidden-authority set is not verifier-authoritative",
    );
    assert(
      !expectedForbiddenAuthorityKeyIds.includes(expectedReconciler.key_id),
      "reconciler overlaps trusted forbidden authority",
    );
    assert(Date.parse(attestation.body.launched_at) <= Date.parse(now), "attestation from future");
    assert(Date.parse(attestation.body.expires_at) > Date.parse(now), "attestation expired");
    const directory = assertDirectoryBoundary(
      expectedReconciler.artifact_directory,
      expectedProducer.artifact_directory,
    );
    assert(
      directory.realpath === attestation.body.artifact_directory_realpath &&
        directory.mode === attestation.body.artifact_directory_mode,
      "artifact directory evidence changed",
    );
    const expectedHash = sha256Hex(jcsCanonicalize(attestation.body));
    assert(expectedHash === attestation.attestation_hash, "attestation hash mismatch");
    return verifyEd25519Signature(
      publicKeyHex,
      signingBytes(attestation.body, attestation.attestation_hash),
      attestation.signature,
    );
  } catch {
    return false;
  }
};
