/**
 * Structural preflight — fail before search, cache, rate-limit debit, or adapter.
 */
import { Effect } from "effect";
import {
  classifyCollectionIdentifier,
  InvalidCollectionIdentifierError,
  type ClassifiedCollectionIdentifier,
} from "../identifier.js";
import { sha256Canonical } from "./caching/keys.js";
import { StructuralPreflightError } from "./errors.js";

export interface PreflightSuccess {
  readonly classified: ClassifiedCollectionIdentifier;
  /** Convenience: CR-001 identifier (address / pubkey only). */
  readonly identifier: ClassifiedCollectionIdentifier["identifier"];
}

/**
 * Classify a structurally complete identifier. Incomplete / invalid inputs fail
 * here and MUST NOT touch cache, rate limiter, coalesce, or adapters.
 * Public errors carry a digest only — never the raw identifier.
 *
 * CAIP-10 / chain-qualified inputs are accepted; the address portion is
 * CR-001-decoded and the network qualifier is retained for fanout selection.
 */
export const structuralPreflight = (
  raw: string,
): Effect.Effect<PreflightSuccess, StructuralPreflightError> =>
  classifyCollectionIdentifier(raw).pipe(
    Effect.map((classified) => ({
      classified,
      identifier: classified.identifier,
    })),
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
