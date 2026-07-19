import { Effect } from "effect";

import { hashCanonicalTruthJson } from "./canonical.js";
import { TruthIntegrityError } from "./errors.js";
import type {
  DecimalUint64,
  TruthEnvironmentId,
} from "./schemas/common.js";
import type { TruthRevocationRecordV1 } from "./schemas/registry.js";
import type { TruthRegistryStoreService } from "./services.js";
import type {
  RevocationConsumerBaselineStore,
} from "./revocation-control-plane.js";
import { isFilesystemRevocationConsumerBaselineStore } from "./revocation-baseline-store.js";
import { jcsCanonicalize, sha256Hex } from "../collection-resolver/trust-protocol.js";

const failure = (reason: string): TruthIntegrityError =>
  new TruthIntegrityError({
    boundary: "truth.registry.projection",
    reason,
  });

export interface TruthRegistryStatusProjectionV1 {
  readonly schema_version: 1;
  readonly environment: TruthEnvironmentId;
  readonly generation: string;
  readonly root_hash: string;
  readonly activation_hash: string;
  readonly object_count: number;
  readonly closure_bytes: string;
  readonly activation_audit_sequence: string;
  readonly revocation_epoch: string;
  readonly revocation_sequence: string;
  readonly revoked_targets: ReadonlyArray<string>;
}

export interface HashedTruthRegistryStatusProjectionV1 {
  readonly projection: TruthRegistryStatusProjectionV1;
  readonly projection_sha256: string;
}

export type TruthProjectionRevocationVerifier<E> = (
  record: unknown,
  expectedSequence: DecimalUint64,
  expectedPriorRecordSha256: string | null,
  minimumEpoch: DecimalUint64,
) => Effect.Effect<TruthRevocationRecordV1, E>;

export const rebuildTruthRegistryStatusProjection = <E>(
  store: TruthRegistryStoreService,
  environment: TruthEnvironmentId,
  revocationBaselineStore: RevocationConsumerBaselineStore,
  verifyRevocation: TruthProjectionRevocationVerifier<E>,
  executionMode: "RUNTIME" | "FIXTURE" = "RUNTIME",
): Effect.Effect<
  HashedTruthRegistryStatusProjectionV1,
  | import("./errors.js").TruthRegistryError
  | import("./errors.js").TruthTrustError
  | TruthIntegrityError
  | E
> =>
  Effect.gen(function* () {
    if (
      !isFilesystemRevocationConsumerBaselineStore(revocationBaselineStore) &&
      executionMode !== "FIXTURE"
    ) {
      return yield* Effect.fail(
        failure(
          "runtime projection requires an independently persistent revocation baseline",
        ),
      );
    }
    const expectedRevocationBaseline =
      yield* revocationBaselineStore.read;
    if (expectedRevocationBaseline === null) {
      return yield* Effect.fail(
        failure("independent revocation baseline is absent"),
      );
    }
    const activation = yield* store.readRoot(environment);
    const unsigned = activation.unsigned_activation;
    let closureBytes = 0n;
    for (const object of unsigned.root.unsigned_root.objects) {
      const bytes = yield* store.readObject(environment, object.sha256);
      if (BigInt(bytes.byteLength) !== BigInt(object.byte_length)) {
        return yield* Effect.fail(failure("closure object byte length mismatch"));
      }
      closureBytes += BigInt(bytes.byteLength);
    }
    const audits = yield* store.readAuditEvents(environment);
    const activationAudit = audits.find(
      (event) =>
        event.kind === "GENERATION_ACTIVATED" &&
        event.sequence === unsigned.audit_sequence &&
        event.generation === unsigned.generation &&
        event.subject_hash === activation.activation_hash &&
        event.prior_record_sha256 ===
          unsigned.audit_prior_record_sha256 &&
        event.recorded_at === unsigned.audit_recorded_at,
    );
    if (activationAudit === undefined) {
      return yield* Effect.fail(
        failure("complete signed activation audit is not observable"),
      );
    }
    const storedRevocations = yield* store.readRevocations(environment);
    const revocations: TruthRevocationRecordV1[] = [];
    let expectedSequence = "1" as DecimalUint64;
    let minimumEpoch = "0" as DecimalUint64;
    let priorRecordSha256: string | null = null;
    for (const stored of storedRevocations) {
      const verified = yield* verifyRevocation(
        stored,
        expectedSequence,
        priorRecordSha256,
        minimumEpoch,
      );
      revocations.push(verified);
      expectedSequence = (BigInt(expectedSequence) + 1n).toString() as DecimalUint64;
      minimumEpoch = verified.epoch;
      priorRecordSha256 = sha256Hex(jcsCanonicalize(verified));
    }
    const latest = revocations.at(-1);
    const latestRecordSha256 =
      latest === undefined ? null : sha256Hex(jcsCanonicalize(latest));
    if (
      expectedRevocationBaseline.environment !== environment ||
      expectedRevocationBaseline.generation !== unsigned.generation ||
      expectedRevocationBaseline.revocationEpoch !==
        (latest?.epoch ?? "0") ||
      expectedRevocationBaseline.revocationSequence !==
        (latest?.sequence ?? "0") ||
      expectedRevocationBaseline.revocationRecordSha256 !==
        latestRecordSha256
    ) {
      return yield* Effect.fail(
        failure(
          "revocation log tail does not match the independently persisted baseline",
        ),
      );
    }
    const projection: TruthRegistryStatusProjectionV1 = {
      schema_version: 1,
      environment,
      generation: unsigned.generation,
      root_hash: unsigned.root.root_hash,
      activation_hash: activation.activation_hash,
      object_count: unsigned.root.unsigned_root.objects.length,
      closure_bytes: closureBytes.toString(),
      activation_audit_sequence: activationAudit.sequence,
      revocation_epoch: latest?.epoch ?? "0",
      revocation_sequence: latest?.sequence ?? "0",
      revoked_targets: [
        ...new Set(revocations.map((revocation) => String(revocation.target_id))),
      ].sort(),
    };
    return {
      projection,
      projection_sha256: yield* hashCanonicalTruthJson(
        projection,
        "truth.registry.projection.digest",
      ),
    };
  });
