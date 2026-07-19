import { Schema } from "effect";

import {
  DecimalUint64,
  PositiveDecimalUint64,
  Sha256Digest,
  TRUTH_CONTRACT_PROTOCOL,
  TRUTH_CONTRACT_SCHEMA_VERSION,
  TruthEnvironmentId,
  TruthIdentifier,
  TruthIsoTimestamp,
} from "./common.js";
import { TruthBundleRootV1, TruthIssuer } from "./bundle.js";

export class TruthAuditEventUnsignedV1 extends Schema.Class<TruthAuditEventUnsignedV1>(
  "TruthAuditEventUnsignedV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  protocol: Schema.Literal(TRUTH_CONTRACT_PROTOCOL),
  environment: TruthEnvironmentId,
  sequence: PositiveDecimalUint64,
  kind: Schema.Literal(
    "GENERATION_PREPARED",
    "GENERATION_ACTIVATED",
    "TRUST_UPDATED",
    "REVOCATION_APPENDED",
  ),
  generation: DecimalUint64,
  subject_hash: Sha256Digest,
  prior_record_sha256: Schema.NullOr(Sha256Digest),
  recorded_at: TruthIsoTimestamp,
  issuer_key_id: TruthIdentifier,
}) {}

export class TruthAuditEventV1 extends Schema.Class<TruthAuditEventV1>(
  "TruthAuditEventV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  protocol: Schema.Literal(TRUTH_CONTRACT_PROTOCOL),
  environment: TruthEnvironmentId,
  sequence: PositiveDecimalUint64,
  kind: Schema.Literal(
    "GENERATION_PREPARED",
    "GENERATION_ACTIVATED",
    "TRUST_UPDATED",
    "REVOCATION_APPENDED",
  ),
  generation: DecimalUint64,
  subject_hash: Sha256Digest,
  prior_record_sha256: Schema.NullOr(Sha256Digest),
  recorded_at: TruthIsoTimestamp,
  issuer_key_id: TruthIdentifier,
  body_hash: Sha256Digest,
  signature: Schema.String.pipe(
    Schema.pattern(/^[A-Za-z0-9_-]{86}$/),
    Schema.brand("TruthAuditEd25519Signature"),
  ),
}) {}

export class TruthGenerationActivationUnsignedV1 extends Schema.Class<TruthGenerationActivationUnsignedV1>(
  "TruthGenerationActivationUnsignedV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  protocol: Schema.Literal(TRUTH_CONTRACT_PROTOCOL),
  environment: TruthEnvironmentId,
  prior_generation: DecimalUint64,
  generation: PositiveDecimalUint64,
  root: TruthBundleRootV1,
  audit_sequence: PositiveDecimalUint64,
  audit_prior_record_sha256: Schema.NullOr(Sha256Digest),
  audit_recorded_at: TruthIsoTimestamp,
  prepared_at: TruthIsoTimestamp,
  issuer: TruthIssuer,
}) {}

export class TruthGenerationActivationV1 extends Schema.Class<TruthGenerationActivationV1>(
  "TruthGenerationActivationV1",
)({
  unsigned_activation: TruthGenerationActivationUnsignedV1,
  activation_hash: Sha256Digest,
  signature: Schema.String.pipe(
    Schema.pattern(/^[A-Za-z0-9_-]{86}$/),
    Schema.brand("TruthActivationEd25519Signature"),
  ),
}) {}

export class TruthRevocationUnsignedV1 extends Schema.Class<TruthRevocationUnsignedV1>(
  "TruthRevocationUnsignedV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  protocol: Schema.Literal(TRUTH_CONTRACT_PROTOCOL),
  environment: TruthEnvironmentId,
  sequence: PositiveDecimalUint64,
  prior_record_sha256: Schema.NullOr(Sha256Digest),
  event_id: TruthIdentifier,
  target_kind: Schema.Literal("key", "artifact"),
  target_id: TruthIdentifier,
  compromised_from: TruthIsoTimestamp,
  revoked_at: TruthIsoTimestamp,
  reason: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048)),
  issuer_key_id: TruthIdentifier,
  epoch: PositiveDecimalUint64,
}) {}

export class TruthRevocationRecordV1 extends Schema.Class<TruthRevocationRecordV1>(
  "TruthRevocationRecordV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  protocol: Schema.Literal(TRUTH_CONTRACT_PROTOCOL),
  environment: TruthEnvironmentId,
  sequence: PositiveDecimalUint64,
  prior_record_sha256: Schema.NullOr(Sha256Digest),
  event_id: TruthIdentifier,
  target_kind: Schema.Literal("key", "artifact"),
  target_id: TruthIdentifier,
  compromised_from: TruthIsoTimestamp,
  revoked_at: TruthIsoTimestamp,
  reason: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048)),
  issuer_key_id: TruthIdentifier,
  epoch: PositiveDecimalUint64,
  body_hash: Sha256Digest,
  signature: Schema.String.pipe(
    Schema.pattern(/^[A-Za-z0-9_-]{86}$/),
    Schema.brand("TruthRevocationEd25519Signature"),
  ),
}) {}
