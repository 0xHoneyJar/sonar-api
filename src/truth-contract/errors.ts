import { Schema } from "effect";

const SafeReason = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048));
const SafeBoundary = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9._:/-]+$/),
);

export class TruthDecodeError extends Schema.TaggedError<TruthDecodeError>()(
  "TruthDecodeError",
  {
    boundary: SafeBoundary,
    reason: SafeReason,
  },
) {}

export class TruthIntegrityError extends Schema.TaggedError<TruthIntegrityError>()(
  "TruthIntegrityError",
  {
    boundary: SafeBoundary,
    reason: SafeReason,
  },
) {}

export class TruthTrustError extends Schema.TaggedError<TruthTrustError>()(
  "TruthTrustError",
  {
    boundary: SafeBoundary,
    reason: SafeReason,
  },
) {}

export class TruthCompatibilityError extends Schema.TaggedError<TruthCompatibilityError>()(
  "TruthCompatibilityError",
  {
    boundary: SafeBoundary,
    reason: SafeReason,
  },
) {}

export class TruthRegistryError extends Schema.TaggedError<TruthRegistryError>()(
  "TruthRegistryError",
  {
    boundary: SafeBoundary,
    reason: SafeReason,
    retryable: Schema.Boolean,
  },
) {}

export class TruthTransportError extends Schema.TaggedError<TruthTransportError>()(
  "TruthTransportError",
  {
    boundary: SafeBoundary,
    reason: SafeReason,
    retryable: Schema.Boolean,
  },
) {}

export type TruthExpectedError =
  | TruthDecodeError
  | TruthIntegrityError
  | TruthTrustError
  | TruthCompatibilityError
  | TruthRegistryError
  | TruthTransportError;
