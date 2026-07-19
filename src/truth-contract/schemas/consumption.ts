import { Schema } from "effect";

import {
  DecimalUint64,
  PositiveDecimalUint64,
  Sha256Digest,
  TRUTH_CONTRACT_SCHEMA_VERSION,
  TruthEnvironmentId,
  TruthIdentifier,
  TruthIsoTimestamp,
} from "./common.js";
import { TruthThresholdSignatureV1 } from "./trust.js";

export const SONAR_NOT_CONSUMED_RECEIPT_DOMAIN =
  "sonar.score-not-consumed-receipt.v1" as const;
export const SCORE_CONSUMED_RECEIPT_DOMAIN =
  "score.sonar-consumed-receipt.v1" as const;
export const SCORE_AUTHORITY_ANCHOR_DOMAIN =
  "sonar.score-receipt-authority-anchor.v1" as const;
export const SCORE_NOT_CONSUMED_OWNER = "bd-v54z.1" as const;

export const ScoreReceiptAuthorityKindV1 = Schema.Literal(
  "SONAR_HANDOFF",
  "SCORE_CONSUMER",
);
export type ScoreReceiptAuthorityKindV1 = Schema.Schema.Type<
  typeof ScoreReceiptAuthorityKindV1
>;

export class ScoreReceiptTargetV1 extends Schema.Class<ScoreReceiptTargetV1>(
  "ScoreReceiptTargetV1",
)({
  collection_id: TruthIdentifier,
  target_identity_hash: Sha256Digest,
  producer_root_hash: Sha256Digest,
  producer_generation: PositiveDecimalUint64,
  invalidation_epoch: DecimalUint64,
  environment: TruthEnvironmentId,
}) {}

const ScoreReceiptCommon = {
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  target: ScoreReceiptTargetV1,
  sequence: PositiveDecimalUint64,
  issued_at: TruthIsoTimestamp,
  producer_contract_version: Schema.Literal("sonar-score-truth-contract/v1"),
  consumer_contract_version: Schema.Literal("score-consumption/v1"),
  authority_generation: PositiveDecimalUint64,
  authority_keyset_hash: Sha256Digest,
  revocation_sequence: DecimalUint64,
  prior_receipt_hash: Schema.NullOr(Sha256Digest),
};

export class NotConsumedReceiptBodyV1 extends Schema.TaggedClass<NotConsumedReceiptBodyV1>()(
  "NotConsumedReceiptV1",
  {
    ...ScoreReceiptCommon,
    domain: Schema.Literal(SONAR_NOT_CONSUMED_RECEIPT_DOMAIN),
    authority_kind: Schema.Literal("SONAR_HANDOFF"),
    owner: Schema.Literal(SCORE_NOT_CONSUMED_OWNER),
    handoff_receipt_hash: Sha256Digest,
    handoff_sealed_at: TruthIsoTimestamp,
    deadline: TruthIsoTimestamp,
    expires_at: Schema.Null,
    reason: Schema.Literal("SCORE_IMPLEMENTATION_PENDING"),
    supersedes_receipt_hash: Schema.Null,
  },
) {}

export class ConsumedReceiptBodyV1 extends Schema.TaggedClass<ConsumedReceiptBodyV1>()(
  "ConsumedReceiptV1",
  {
    ...ScoreReceiptCommon,
    domain: Schema.Literal(SCORE_CONSUMED_RECEIPT_DOMAIN),
    authority_kind: Schema.Literal("SCORE_CONSUMER"),
    consumer_snapshot_hash: Sha256Digest,
    projection_checkpoint_hash: Sha256Digest,
    assertion_set_hash: Sha256Digest,
    serving_query_hash: Sha256Digest,
    compatibility_result: Schema.Literal("COMPATIBLE"),
    consumed_at: TruthIsoTimestamp,
    expires_at: TruthIsoTimestamp,
    supersedes_receipt_hash: Sha256Digest,
  },
) {}

export class NotConsumedReceiptV1 extends Schema.Class<NotConsumedReceiptV1>(
  "NotConsumedReceiptV1Envelope",
)({
  body: NotConsumedReceiptBodyV1,
  body_hash: Sha256Digest,
  signatures: Schema.Array(TruthThresholdSignatureV1).pipe(
    Schema.minItems(2),
    Schema.maxItems(2),
  ),
}) {}

export class ConsumedReceiptV1 extends Schema.Class<ConsumedReceiptV1>(
  "ConsumedReceiptV1Envelope",
)({
  body: ConsumedReceiptBodyV1,
  body_hash: Sha256Digest,
  signatures: Schema.Array(TruthThresholdSignatureV1).pipe(
    Schema.minItems(2),
    Schema.maxItems(2),
  ),
}) {}

export const ScoreReceiptV1 = Schema.Union(
  NotConsumedReceiptV1,
  ConsumedReceiptV1,
);
export type ScoreReceiptV1 = Schema.Schema.Type<typeof ScoreReceiptV1>;

export class ScoreAuthorityKeyV1 extends Schema.Class<ScoreAuthorityKeyV1>(
  "ScoreAuthorityKeyV1",
)({
  key_id: TruthIdentifier,
  public_key_hex: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  valid_from_sequence: PositiveDecimalUint64,
  valid_through_sequence: Schema.NullOr(PositiveDecimalUint64),
  compromised_from_sequence: Schema.NullOr(PositiveDecimalUint64),
}) {}

export class ScoreAuthorityPolicyV1 extends Schema.Class<ScoreAuthorityPolicyV1>(
  "ScoreAuthorityPolicyV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  authority_kind: ScoreReceiptAuthorityKindV1,
  environment: TruthEnvironmentId,
  generation: PositiveDecimalUint64,
  keyset_hash: Sha256Digest,
  threshold: Schema.Literal("2"),
  keys: Schema.Array(ScoreAuthorityKeyV1).pipe(
    Schema.minItems(2),
    Schema.maxItems(2),
  ),
}) {}

export class ScoreTrustedAuthorityAnchorV1 extends Schema.Class<ScoreTrustedAuthorityAnchorV1>(
  "ScoreTrustedAuthorityAnchorV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  domain: Schema.Literal(SCORE_AUTHORITY_ANCHOR_DOMAIN),
  environment: TruthEnvironmentId,
  generation: PositiveDecimalUint64,
  digest: Sha256Digest,
}) {}
