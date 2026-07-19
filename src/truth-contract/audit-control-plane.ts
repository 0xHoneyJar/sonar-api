import { Effect, Schema } from "effect";

import { hashCanonicalTruthJson } from "./canonical.js";
import { TruthIntegrityError, TruthTrustError } from "./errors.js";
import type {
  DecimalUint64,
  Sha256Digest,
  TruthEnvironmentId,
} from "./schemas/common.js";
import {
  TruthAuditEventUnsignedV1,
  TruthAuditEventV1,
} from "./schemas/registry.js";
import type { TruthSignerService } from "./services.js";

const encoder = new TextEncoder();

const failure = (reason: string): TruthTrustError =>
  new TruthTrustError({ boundary: "truth.audit", reason });

export const truthAuditEventSigningBytes = (
  environment: TruthEnvironmentId,
  sequence: DecimalUint64,
  bodyHash: Sha256Digest,
): Uint8Array =>
  encoder.encode(
    `sonar.truth-audit-event.v1\0${environment}\0${sequence}\0${bodyHash}`,
  );

const unsignedAuditEvent = (event: TruthAuditEventV1) => ({
  schema_version: event.schema_version,
  protocol: event.protocol,
  environment: event.environment,
  sequence: event.sequence,
  kind: event.kind,
  generation: event.generation,
  subject_hash: event.subject_hash,
  prior_record_sha256: event.prior_record_sha256,
  recorded_at: event.recorded_at,
  issuer_key_id: event.issuer_key_id,
});

export const compileTruthAuditEvent = (
  input: unknown,
  signer: TruthSignerService,
): Effect.Effect<
  TruthAuditEventV1,
  TruthTrustError | TruthIntegrityError
> =>
  Effect.gen(function* () {
    const unsigned = yield* Schema.decodeUnknown(TruthAuditEventUnsignedV1, {
      errors: "all",
      onExcessProperty: "error",
    })(input).pipe(
      Effect.mapError(() => failure("unsigned audit event is invalid")),
    );
    if (unsigned.issuer_key_id !== signer.keyId) {
      return yield* Effect.fail(
        failure("audit issuer does not match the authorized signer"),
      );
    }
    const bodyHash = (yield* hashCanonicalTruthJson(unsigned)) as Sha256Digest;
    const signature = yield* signer.sign(
      unsigned.environment,
      truthAuditEventSigningBytes(
        unsigned.environment,
        unsigned.sequence,
        bodyHash,
      ),
    );
    return yield* Schema.decodeUnknown(TruthAuditEventV1, {
      errors: "all",
      onExcessProperty: "error",
    })({
      ...unsigned,
      body_hash: bodyHash,
      signature,
    }).pipe(Effect.mapError(() => failure("signed audit event is invalid")));
  });

export type TruthAuditVerifier = (
  event: TruthAuditEventV1,
) => Effect.Effect<void, TruthTrustError | TruthIntegrityError>;

export const makeTruthAuditVerifier = (
  ...signers: ReadonlyArray<TruthSignerService>
): TruthAuditVerifier => {
  const authorizedSigners = new Map(
    signers.map((signer) => [signer.keyId, signer]),
  );
  return (event) =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknown(TruthAuditEventV1, {
        errors: "all",
        onExcessProperty: "error",
      })(event).pipe(
        Effect.mapError(
          () =>
            new TruthIntegrityError({
              boundary: "truth.audit.verify",
              reason: "audit event schema is invalid",
            }),
        ),
      );
      const signer = authorizedSigners.get(decoded.issuer_key_id);
      if (signer === undefined) {
        return yield* Effect.fail(failure("audit issuer is not authorized"));
      }
      const expectedBodyHash = yield* hashCanonicalTruthJson(
        unsignedAuditEvent(decoded),
      );
      if (decoded.body_hash !== expectedBodyHash) {
        return yield* Effect.fail(
          new TruthIntegrityError({
            boundary: "truth.audit.verify",
            reason: "audit body digest is invalid",
          }),
        );
      }
      yield* signer.verify(
        decoded.environment,
        truthAuditEventSigningBytes(
          decoded.environment,
          decoded.sequence,
          decoded.body_hash,
        ),
        decoded.signature,
      );
    });
};
