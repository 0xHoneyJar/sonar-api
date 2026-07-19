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
  TruthObjectRef,
} from "./common.js";

export const TRUTH_NORMATIVE_OBJECT_KINDS = [
  "bundle_schema",
  "identity_snapshot",
  "event_vocabulary",
  "provenance_rules",
  "behavioral_invariants",
  "compatibility_matrix",
  "authority_matrix",
  "security_profile",
  "network_finality_policy",
  "activity_profiles",
  "statistical_policy",
  "serving_policy",
  "issuer_metadata",
] as const;

export class TruthIssuer extends Schema.Class<TruthIssuer>("TruthIssuer")({
  service_id: TruthIdentifier,
  key_id: TruthIdentifier,
}) {}

export class TruthBundleRootUnsignedV1 extends Schema.Class<TruthBundleRootUnsignedV1>(
  "TruthBundleRootUnsignedV1",
)({
  schema_version: Schema.Literal(TRUTH_CONTRACT_SCHEMA_VERSION),
  protocol: Schema.Literal(TRUTH_CONTRACT_PROTOCOL),
  environment: TruthEnvironmentId,
  generation: PositiveDecimalUint64,
  supersedes_generation: Schema.NullOr(DecimalUint64),
  objects: Schema.Array(TruthObjectRef).pipe(
    Schema.minItems(TRUTH_NORMATIVE_OBJECT_KINDS.length),
    Schema.maxItems(128),
  ),
  issuer: TruthIssuer,
  issued_at: TruthIsoTimestamp,
  valid_from: TruthIsoTimestamp,
  compatibility_version: TruthIdentifier,
  authority_matrix_hash: Sha256Digest,
  security_profile_hash: Sha256Digest,
}) {}

export const TruthEd25519Signature = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{86}$/),
  Schema.brand("TruthEd25519Signature"),
).annotations({ identifier: "TruthEd25519Signature" });
export type TruthEd25519Signature = Schema.Schema.Type<typeof TruthEd25519Signature>;

export class TruthBundleRootV1 extends Schema.Class<TruthBundleRootV1>(
  "TruthBundleRootV1",
)({
  unsigned_root: TruthBundleRootUnsignedV1,
  root_hash: Sha256Digest,
  signature: TruthEd25519Signature,
}) {}
