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

export const TruthEd25519PublicKeyHex = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{64}$/),
  Schema.brand("TruthEd25519PublicKeyHex"),
);

export class TruthTrustKeyV1 extends Schema.Class<TruthTrustKeyV1>(
  "TruthTrustKeyV1",
)({
  key_id: TruthIdentifier,
  algorithm: Schema.Literal("Ed25519"),
  public_key_hex: TruthEd25519PublicKeyHex,
  valid_from: TruthIsoTimestamp,
  valid_until: Schema.NullOr(TruthIsoTimestamp),
}) {}

export class TruthQuorumV1 extends Schema.Class<TruthQuorumV1>("TruthQuorumV1")({
  threshold: PositiveDecimalUint64,
  keys: Schema.Array(TruthTrustKeyV1).pipe(
    Schema.minItems(1),
    Schema.maxItems(32),
  ),
}) {}

export class TrustBootstrapUnsignedV1 extends Schema.Class<TrustBootstrapUnsignedV1>(
  "TrustBootstrapUnsignedV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  protocol: Schema.Literal(TRUTH_CONTRACT_PROTOCOL),
  environment: TruthEnvironmentId,
  bootstrap_generation: Schema.Literal("1"),
  producer_root: TruthTrustKeyV1,
  governance_quorum: TruthQuorumV1,
  recovery_quorum: TruthQuorumV1,
  issued_at: TruthIsoTimestamp,
}) {}

export class TrustBootstrapV1 extends Schema.Class<TrustBootstrapV1>(
  "TrustBootstrapV1",
)({
  unsigned_bootstrap: TrustBootstrapUnsignedV1,
  bundle_digest: Sha256Digest,
}) {}

export class TrustBootstrapChannelObservationV1 extends Schema.Class<TrustBootstrapChannelObservationV1>(
  "TrustBootstrapChannelObservationV1",
)({
  channel_id: TruthIdentifier,
  operator_id: TruthIdentifier,
  credential_id: TruthIdentifier,
  bundle_digest: Sha256Digest,
  observed_at: TruthIsoTimestamp,
  signature: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{86}$/)),
}) {}

export class TrustBootstrapReceiptV1 extends Schema.Class<TrustBootstrapReceiptV1>(
  "TrustBootstrapReceiptV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  environment: TruthEnvironmentId,
  observations: Schema.Array(TrustBootstrapChannelObservationV1).pipe(
    Schema.minItems(2),
    Schema.maxItems(2),
  ),
}) {}

export class TruthThresholdSignatureV1 extends Schema.Class<TruthThresholdSignatureV1>(
  "TruthThresholdSignatureV1",
)({
  key_id: TruthIdentifier,
  signature: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{86}$/)),
}) {}

export class TruthQuorumApprovalUnsignedV1 extends Schema.Class<TruthQuorumApprovalUnsignedV1>(
  "TruthQuorumApprovalUnsignedV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  protocol: Schema.Literal(TRUTH_CONTRACT_PROTOCOL),
  environment: TruthEnvironmentId,
  action: Schema.Literal("ROTATE", "RECOVER"),
  generation: PositiveDecimalUint64,
  nonce: PositiveDecimalUint64,
  payload_hash: Sha256Digest,
  approved_at: TruthIsoTimestamp,
}) {}

export class TruthQuorumApprovalV1 extends Schema.Class<TruthQuorumApprovalV1>(
  "TruthQuorumApprovalV1",
)({
  unsigned_approval: TruthQuorumApprovalUnsignedV1,
  signatures: Schema.Array(TruthThresholdSignatureV1).pipe(
    Schema.minItems(1),
    Schema.maxItems(32),
  ),
}) {}

export class TrustRecoveryRequestV1 extends Schema.Class<TrustRecoveryRequestV1>(
  "TrustRecoveryRequestV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  challenge_id: TruthIdentifier,
  environment: TruthEnvironmentId,
  prior_generation: PositiveDecimalUint64,
  generation: PositiveDecimalUint64,
  prior_nonce: DecimalUint64,
  nonce: PositiveDecimalUint64,
  current_root_hash: Sha256Digest,
  next_root_hash: Sha256Digest,
  evidence_hash: Sha256Digest,
  challenge_started_at: TruthIsoTimestamp,
  challenge_ends_at: TruthIsoTimestamp,
  governance_approval: TruthQuorumApprovalV1,
  recovery_approval: TruthQuorumApprovalV1,
}) {}

export class TrustRecoveryChallengeUnsignedV1 extends Schema.Class<TrustRecoveryChallengeUnsignedV1>(
  "TrustRecoveryChallengeUnsignedV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  challenge_id: TruthIdentifier,
  environment: TruthEnvironmentId,
  prior_generation: PositiveDecimalUint64,
  generation: PositiveDecimalUint64,
  prior_nonce: DecimalUint64,
  nonce: PositiveDecimalUint64,
  current_root_hash: Sha256Digest,
  next_root_hash: Sha256Digest,
  evidence_hash: Sha256Digest,
  challenge_started_at: TruthIsoTimestamp,
  challenge_ends_at: TruthIsoTimestamp,
  initiation_approval: TruthQuorumApprovalV1,
  consumed_at: Schema.NullOr(TruthIsoTimestamp),
}) {}

export class TrustRecoveryChallengeV1 extends Schema.Class<TrustRecoveryChallengeV1>(
  "TrustRecoveryChallengeV1",
)({
  unsigned_challenge: TrustRecoveryChallengeUnsignedV1,
  record_digest: Sha256Digest,
}) {}

export class TrustedGenerationHighWaterUnsignedV1 extends Schema.Class<TrustedGenerationHighWaterUnsignedV1>(
  "TrustedGenerationHighWaterUnsignedV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  environment: TruthEnvironmentId,
  generation: PositiveDecimalUint64,
  recovery_nonce: DecimalUint64,
  trusted_root_hash: Sha256Digest,
  bootstrap_digest: Sha256Digest,
  bootstrap_binding_digest: Sha256Digest,
  bootstrap_equivocation_sequence: DecimalUint64,
  bootstrap_equivocation_digest: Schema.NullOr(Sha256Digest),
  updated_at: TruthIsoTimestamp,
}) {}

export class TrustedGenerationHighWaterV1 extends Schema.Class<TrustedGenerationHighWaterV1>(
  "TrustedGenerationHighWaterV1",
)({
  unsigned_record: TrustedGenerationHighWaterUnsignedV1,
  record_digest: Sha256Digest,
}) {}
