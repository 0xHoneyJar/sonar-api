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

export class SignedTimeCheckpointUnsignedV1 extends Schema.Class<SignedTimeCheckpointUnsignedV1>(
  "SignedTimeCheckpointUnsignedV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  protocol: Schema.Literal(TRUTH_CONTRACT_PROTOCOL),
  environment: TruthEnvironmentId,
  boot_id: TruthIdentifier,
  generation: PositiveDecimalUint64,
  revocation_epoch: PositiveDecimalUint64,
  revocation_sequence: DecimalUint64,
  revocation_record_sha256: Schema.NullOr(Sha256Digest),
  wall_clock_milliseconds: DecimalUint64,
  monotonic_milliseconds: DecimalUint64,
  recorded_at: TruthIsoTimestamp,
}) {}

export class SignedTimeSourceObservationV1 extends Schema.Class<SignedTimeSourceObservationV1>(
  "SignedTimeSourceObservationV1",
)({
  source_id: TruthIdentifier,
  channel_id: TruthIdentifier,
  key_id: TruthIdentifier,
  unix_milliseconds: DecimalUint64,
  signature: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{86}$/)),
}) {}

export class SignedTimeCheckpointV1 extends Schema.Class<SignedTimeCheckpointV1>(
  "SignedTimeCheckpointV1",
)({
  unsigned_checkpoint: SignedTimeCheckpointUnsignedV1,
  observations: Schema.Array(SignedTimeSourceObservationV1).pipe(
    Schema.minItems(2),
    Schema.maxItems(2),
  ),
}) {}
