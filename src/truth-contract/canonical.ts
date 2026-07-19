import { Effect } from "effect";

import { jcsCanonicalize, sha256Hex } from "../collection-resolver/trust-protocol.js";
import { TruthIntegrityError } from "./errors.js";

const canonicalFailure = (boundary: string): TruthIntegrityError =>
  new TruthIntegrityError({
    boundary,
    reason: "value cannot be represented as RFC 8785 canonical JSON",
  });

export const assertAcyclicJson = (
  value: unknown,
  boundary: string,
): Effect.Effect<void, TruthIntegrityError> =>
  Effect.try({
    try: () => {
      const ancestors = new WeakSet<object>();
      const visit = (candidate: unknown, depth: number): void => {
        if (candidate === null || typeof candidate !== "object") return;
        if (depth > 64) throw new Error("maximum JSON nesting depth exceeded");
        if (ancestors.has(candidate)) throw new Error("circular JSON value");
        ancestors.add(candidate);
        if (Array.isArray(candidate)) {
          for (const entry of candidate) visit(entry, depth + 1);
        } else {
          for (const entry of Object.values(candidate)) visit(entry, depth + 1);
        }
        ancestors.delete(candidate);
      };
      visit(value, 0);
    },
    catch: () => canonicalFailure(boundary),
  });

export const canonicalizeTruthJson = (
  value: unknown,
  boundary = "truth.canonicalize",
): Effect.Effect<string, TruthIntegrityError> =>
  assertAcyclicJson(value, boundary).pipe(
    Effect.flatMap(() =>
      Effect.try({
        try: () => jcsCanonicalize(value),
        catch: () => canonicalFailure(boundary),
      }),
    ),
  );

export const hashCanonicalTruthJson = (
  value: unknown,
  boundary = "truth.hash",
): Effect.Effect<string, TruthIntegrityError> =>
  canonicalizeTruthJson(value, boundary).pipe(Effect.map(sha256Hex));
