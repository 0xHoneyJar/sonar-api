import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { ParseOptions } from "effect/SchemaAST";
import { BoundedResolverDecodeError } from "../errors.js";
import { safeErrorLabel } from "../redaction.js";
import {
  NegativeCacheBinding,
  PositiveCacheBinding,
  ReadinessCacheBinding,
  type NegativeCacheBinding as NegativeCacheBindingType,
  type PositiveCacheBinding as PositiveCacheBindingType,
  type ReadinessCacheBinding as ReadinessCacheBindingType,
} from "../schemas.js";
import { cloneFreeze } from "../../capability-registry/immutable.js";

const strictOptions: ParseOptions = {
  errors: "all",
  onExcessProperty: "error",
};

const decodePositive = Schema.decodeUnknown(PositiveCacheBinding, strictOptions);
const decodeReadiness = Schema.decodeUnknown(ReadinessCacheBinding, strictOptions);
const decodeNegative = Schema.decodeUnknown(NegativeCacheBinding, strictOptions);

/** Deterministic sha-256 hex over canonical JSON (sorted keys). */
export const sha256Canonical = (value: unknown): string => {
  const canonical = JSON.stringify(sortKeys(value));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
};

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortKeys(v);
    return out;
  }
  return value;
};

export const digestPositiveBinding = (
  binding: PositiveCacheBindingType,
): Effect.Effect<string, BoundedResolverDecodeError> =>
  decodePositive(binding).pipe(
    Effect.mapError(
      (cause) =>
        new BoundedResolverDecodeError({
          reason: "positive cache binding failed strict decode",
          safe_cause: safeErrorLabel(cause),
          cause_digest: sha256Canonical(safeErrorLabel(cause)),
        }),
    ),
    Effect.map((decoded) => sha256Canonical(cloneFreeze(decoded))),
  );

export const digestReadinessBinding = (
  binding: ReadinessCacheBindingType,
): Effect.Effect<string, BoundedResolverDecodeError> =>
  decodeReadiness(binding).pipe(
    Effect.mapError(
      (cause) =>
        new BoundedResolverDecodeError({
          reason: "readiness cache binding failed strict decode",
          safe_cause: safeErrorLabel(cause),
          cause_digest: sha256Canonical(safeErrorLabel(cause)),
        }),
    ),
    Effect.map((decoded) => sha256Canonical(cloneFreeze(decoded))),
  );

export const digestNegativeBinding = (
  binding: NegativeCacheBindingType,
): Effect.Effect<string, BoundedResolverDecodeError> =>
  decodeNegative(binding).pipe(
    Effect.mapError(
      (cause) =>
        new BoundedResolverDecodeError({
          reason: "negative cache binding failed strict decode",
          safe_cause: safeErrorLabel(cause),
          cause_digest: sha256Canonical(safeErrorLabel(cause)),
        }),
    ),
    Effect.map((decoded) => sha256Canonical(cloneFreeze(decoded))),
  );
export const structuralIdentifierDigest = (input: {
  readonly format: "evm_address" | "solana_public_key";
  readonly raw: string;
}): string =>
  sha256Canonical({
    format: input.format,
    raw: input.format === "evm_address" ? input.raw.toLowerCase() : input.raw,
  });
