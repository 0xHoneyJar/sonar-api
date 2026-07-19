import { Schema } from "effect";

import {
  DecimalUint64,
  Sha256Digest,
  TruthIdentifier,
  TruthIsoTimestamp,
} from "./common.js";

export class TruthEvidenceRef extends Schema.Class<TruthEvidenceRef>("TruthEvidenceRef")({
  evidence_id: TruthIdentifier,
  sha256: Sha256Digest,
}) {}

const StatusFields = {
  reasons: Schema.Array(TruthIdentifier).pipe(Schema.minItems(1), Schema.maxItems(64)),
  evidence: Schema.Array(TruthEvidenceRef).pipe(Schema.maxItems(128)),
  evaluated_at: TruthIsoTimestamp,
  expires_at: TruthIsoTimestamp,
  invalidation_epoch: DecimalUint64,
};

export class ReadyStatus extends Schema.TaggedClass<ReadyStatus>()("READY", StatusFields) {}

export class DegradedStatus extends Schema.TaggedClass<DegradedStatus>()(
  "DEGRADED",
  StatusFields,
) {}

export class NotReadyStatus extends Schema.TaggedClass<NotReadyStatus>()(
  "NOT_READY",
  StatusFields,
) {}

export class UnknownStatus extends Schema.TaggedClass<UnknownStatus>()(
  "UNKNOWN",
  StatusFields,
) {}

export class SuspendedStatus extends Schema.TaggedClass<SuspendedStatus>()(
  "SUSPENDED",
  StatusFields,
) {}

export class ExpiredStatus extends Schema.TaggedClass<ExpiredStatus>()(
  "EXPIRED",
  StatusFields,
) {}

export const TruthEffectiveStatus = Schema.Union(
  ReadyStatus,
  DegradedStatus,
  NotReadyStatus,
  UnknownStatus,
  SuspendedStatus,
  ExpiredStatus,
).pipe(
  Schema.filter(
    (status) =>
      new Date(status.expires_at).getTime() >
        new Date(status.evaluated_at).getTime() ||
      "effective status expiry must follow evaluation",
  ),
).annotations({ identifier: "TruthEffectiveStatus" });
export type TruthEffectiveStatus = Schema.Schema.Type<typeof TruthEffectiveStatus>;
