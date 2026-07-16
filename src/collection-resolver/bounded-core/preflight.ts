/**
 * Structural preflight — fail before search, cache, rate-limit debit, or adapter.
 */
import { Effect } from "effect";
import {
  classifyCollectionIdentifier,
  InvalidCollectionIdentifierError,
} from "../identifier.js";
import type { CollectionIdentifier } from "../protocol.js";
import { sha256Canonical } from "./caching/keys.js";
import { StructuralPreflightError } from "./errors.js";

export interface PreflightSuccess {
  readonly identifier: CollectionIdentifier;
}

/**
 * Classify a structurally complete identifier. Incomplete / invalid inputs fail
 * here and MUST NOT touch cache, rate limiter, coalesce, or adapters.
 * Public errors carry a digest only — never the raw identifier.
 */
export const structuralPreflight = (
  raw: string,
): Effect.Effect<PreflightSuccess, StructuralPreflightError> =>
  classifyCollectionIdentifier(raw).pipe(
    Effect.map((identifier) => ({ identifier })),
    Effect.mapError((err: InvalidCollectionIdentifierError) => {
      const identifier_digest = sha256Canonical(typeof raw === "string" ? raw : "invalid");
      if (err instanceof InvalidCollectionIdentifierError) {
        return new StructuralPreflightError({
          identifier_digest,
          reason: err.reason,
        });
      }
      return new StructuralPreflightError({
        identifier_digest,
        reason: "identifier failed structural preflight",
      });
    }),
  );
