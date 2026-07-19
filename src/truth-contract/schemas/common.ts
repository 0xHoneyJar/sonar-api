import { Effect, Schema } from "effect";
import type { ParseOptions } from "effect/SchemaAST";

import { TruthDecodeError } from "../errors.js";

export const TRUTH_CONTRACT_SCHEMA_VERSION = 1 as const;
export const TRUTH_CONTRACT_PROTOCOL = "sonar-score-truth-contract/v1" as const;
export const TRUTH_MAX_FUTURE_SKEW_MILLISECONDS = 60_000 as const;

export const TRUTH_RESOURCE_LIMITS = Object.freeze({
  signedRootBytes: 256 * 1024,
  normativeObjectsPerRoot: 128,
  objectBytes: 4 * 1024 * 1024,
  totalClosureBytes: 32 * 1024 * 1024,
  dependencyEdgesPerArtifact: 128,
  graphNodes: 10_000,
  graphEdges: 50_000,
  dependencyDepth: 64,
  freeTextBytes: 8 * 1024,
} as const);

export const strictDecodeOptions: ParseOptions = {
  errors: "all",
  onExcessProperty: "error",
};

const UINT64_MAX = 18_446_744_073_709_551_615n;
const isUint64 = (value: string): boolean => BigInt(value) <= UINT64_MAX;

export const DecimalUint64 = Schema.String.pipe(
  Schema.pattern(/^(0|[1-9][0-9]*)$/),
  Schema.filter((value) => isUint64(value) || "value exceeds unsigned 64-bit range"),
  Schema.brand("TruthDecimalUint64"),
).annotations({ identifier: "TruthDecimalUint64" });
export type DecimalUint64 = Schema.Schema.Type<typeof DecimalUint64>;

export const PositiveDecimalUint64 = DecimalUint64.pipe(
  Schema.filter((value) => BigInt(value) > 0n || "value must be greater than zero"),
  Schema.brand("TruthPositiveDecimalUint64"),
).annotations({ identifier: "TruthPositiveDecimalUint64" });
export type PositiveDecimalUint64 = Schema.Schema.Type<typeof PositiveDecimalUint64>;

export const Sha256Digest = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{64}$/),
  Schema.brand("TruthSha256Digest"),
).annotations({ identifier: "TruthSha256Digest" });
export type Sha256Digest = Schema.Schema.Type<typeof Sha256Digest>;

export const TruthEnvironmentId = Schema.Literal(
  "development",
  "staging",
  "production",
).annotations({ identifier: "TruthEnvironmentId" });
export type TruthEnvironmentId = Schema.Schema.Type<typeof TruthEnvironmentId>;

export const TruthIdentifier = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/),
  Schema.brand("TruthIdentifier"),
).annotations({ identifier: "TruthIdentifier" });
export type TruthIdentifier = Schema.Schema.Type<typeof TruthIdentifier>;

const encoder = new TextEncoder();
export const TruthFreeText = Schema.String.pipe(
  Schema.minLength(1),
  Schema.filter(
    (value) =>
      encoder.encode(value).byteLength <= TRUTH_RESOURCE_LIMITS.freeTextBytes ||
      "free text exceeds UTF-8 byte limit",
  ),
  Schema.brand("TruthFreeText"),
).annotations({ identifier: "TruthFreeText" });
export type TruthFreeText = Schema.Schema.Type<typeof TruthFreeText>;

const isRealIsoTimestamp = (value: string): boolean => {
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
};

export const TruthIsoTimestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.filter((value) => isRealIsoTimestamp(value) || "invalid UTC timestamp"),
  Schema.brand("TruthIsoTimestamp"),
).annotations({ identifier: "TruthIsoTimestamp" });
export type TruthIsoTimestamp = Schema.Schema.Type<typeof TruthIsoTimestamp>;

export class TruthObjectRef extends Schema.Class<TruthObjectRef>("TruthObjectRef")({
  kind: TruthIdentifier,
  media_type: Schema.Literal("application/json"),
  sha256: Sha256Digest,
  byte_length: PositiveDecimalUint64,
}) {}

export const decodeStrict = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  boundary: string,
  input: unknown,
): Effect.Effect<A, TruthDecodeError, R> =>
  Schema.decodeUnknown(schema, strictDecodeOptions)(input).pipe(
    Effect.mapError(
      () =>
        new TruthDecodeError({
          boundary,
          reason: "input failed strict Effect Schema decoding",
        }),
    ),
  );

export const requireByteLimit = (
  boundary: string,
  actual: number,
  maximum: number,
): Effect.Effect<void, TruthDecodeError> =>
  Number.isSafeInteger(actual) && actual >= 0 && actual <= maximum
    ? Effect.void
    : Effect.fail(
        new TruthDecodeError({
          boundary,
          reason: `resource limit exceeded: maximum ${maximum} bytes`,
        }),
      );
