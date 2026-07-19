import { Effect, Schema } from "effect";

import { TruthRegistryError } from "./errors.js";
import {
  Sha256Digest,
  TruthIdentifier,
  TruthIsoTimestamp,
  decodeStrict,
} from "./schemas/common.js";

export class FilesystemPrimitiveProbeV1 extends Schema.Class<FilesystemPrimitiveProbeV1>(
  "FilesystemPrimitiveProbeV1",
)({
  exclusive_create: Schema.Boolean,
  advisory_lock: Schema.Boolean,
  same_directory_rename: Schema.Boolean,
  file_fsync: Schema.Boolean,
  directory_fsync: Schema.Boolean,
  stale_lock_recovery: Schema.Boolean,
  genesis_race: Schema.Boolean,
  process_crash_injection: Schema.Boolean,
  full_fsync: Schema.Boolean,
  block_layer_fault_injection: Schema.Boolean,
}) {}

export class FilesystemDeploymentFingerprintV1 extends Schema.Class<FilesystemDeploymentFingerprintV1>(
  "FilesystemDeploymentFingerprintV1",
)({
  os: TruthIdentifier,
  kernel: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  mount_point: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
  mount_identity: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512)),
  filesystem_type: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  mount_options: Schema.Array(TruthIdentifier).pipe(Schema.maxItems(128)),
  storage_topology: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048)),
}) {}

export class FilesystemCertificationV1 extends Schema.Class<FilesystemCertificationV1>(
  "FilesystemCertificationV1",
)({
  schema_version: Schema.Literal(1),
  status: Schema.Literal("QUALIFIED", "UNQUALIFIED"),
  validity: Schema.Literal("FIXTURE_VALID", "STAGED_VALID"),
  runner_id: TruthIdentifier,
  dedicated_runner: Schema.Boolean,
  fingerprint: FilesystemDeploymentFingerprintV1,
  adapter_sha256: Sha256Digest,
  probes: FilesystemPrimitiveProbeV1,
  qualified_at: TruthIsoTimestamp,
  reasons: Schema.Array(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024)),
  ).pipe(Schema.maxItems(64)),
}) {}

const unsafeFilesystemTypes = new Set([
  "9p",
  "autofs",
  "bind",
  "cifs",
  "fuse",
  "fuseblk",
  "nfs",
  "nfs4",
  "overlay",
  "smbfs",
  "sshfs",
  "tmpfs",
  "virtiofs",
]);

const allProcessPrimitivesPass = (probes: FilesystemPrimitiveProbeV1): boolean =>
  probes.exclusive_create &&
  probes.advisory_lock &&
  probes.same_directory_rename &&
  probes.file_fsync &&
  probes.directory_fsync &&
  probes.stale_lock_recovery &&
  probes.genesis_race &&
  probes.process_crash_injection;

export const evaluateFilesystemCertification = (
  input: unknown,
): Effect.Effect<FilesystemCertificationV1, TruthRegistryError> =>
  decodeStrict(FilesystemCertificationV1, "truth.registry.certification", input).pipe(
    Effect.mapError(
      () =>
        new TruthRegistryError({
          boundary: "truth.registry.certification",
          reason: "filesystem certification is schema-invalid",
          retryable: false,
        }),
    ),
    Effect.flatMap((certificate) => {
      const filesystem = certificate.fingerprint.filesystem_type.toLowerCase();
      const reasons: string[] = [...certificate.reasons];
      reasons.push(
        "self-attested certification input is only an untrusted candidate; authenticated dedicated-runner evidence is required",
      );
      if (unsafeFilesystemTypes.has(filesystem)) {
        reasons.push(`filesystem type ${filesystem} is never implicitly supported`);
      }
      if (!certificate.dedicated_runner) {
        reasons.push("dedicated durability runner evidence is absent");
      }
      if (certificate.validity !== "STAGED_VALID") {
        reasons.push("fixture-valid evidence cannot qualify a staged deployment");
      }
      if (!allProcessPrimitivesPass(certificate.probes)) {
        reasons.push("one or more process-crash primitives failed");
      }
      if (filesystem === "apfs" && !certificate.probes.full_fsync) {
        reasons.push("APFS requires F_FULLFSYNC at every durability boundary");
      } else if (
        filesystem === "ext4" &&
        !certificate.probes.block_layer_fault_injection
      ) {
        reasons.push("ext4 power-loss qualification requires block-layer fault injection");
      } else if (filesystem !== "apfs" && filesystem !== "ext4") {
        reasons.push(`filesystem type ${filesystem} is not an initial certification target`);
      }
      if (certificate.status !== "QUALIFIED" || reasons.length > 0) {
        return Effect.fail(
          new TruthRegistryError({
            boundary: "truth.registry.certification",
            reason: `STORE_UNAVAILABLE: ${[...new Set(reasons)].join("; ") || "certificate is unqualified"}`,
            retryable: false,
          }),
        );
      }
      return Effect.succeed(certificate);
    }),
  );

export const assertFilesystemCertificateBinding = (
  certificate: FilesystemCertificationV1,
  current: FilesystemDeploymentFingerprintV1,
  adapterSha256: string,
): Effect.Effect<void, TruthRegistryError> => {
  const expected = JSON.stringify(certificate.fingerprint);
  const actual = JSON.stringify(current);
  if (expected !== actual || certificate.adapter_sha256 !== adapterSha256) {
    return Effect.fail(
      new TruthRegistryError({
        boundary: "truth.registry.certification.binding",
        reason: "STORE_UNAVAILABLE: certification does not bind this exact deployment",
        retryable: false,
      }),
    );
  }
  return Effect.void;
};
