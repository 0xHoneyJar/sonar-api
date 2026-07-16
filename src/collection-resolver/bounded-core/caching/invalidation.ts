import { Effect, Schema } from "effect";
import type { ParseOptions } from "effect/SchemaAST";
import { cloneFreeze } from "../../capability-registry/immutable.js";
import {
  BoundedResolverDecodeError,
  InvalidationEdgeStoreError,
} from "../errors.js";
import type { InvalidationEdgePort, ResolverCachePort } from "../ports.js";
import { safeErrorLabel } from "../redaction.js";
import { sha256Canonical } from "./keys.js";
import {
  EquivalenceRevocationImpact,
  type CacheInvalidationCause,
  type EquivalenceRevocationImpact as EquivalenceRevocationImpactType,
} from "../schemas.js";

const strictOptions: ParseOptions = {
  errors: "all",
  onExcessProperty: "error",
};

const decodeImpact = Schema.decodeUnknown(EquivalenceRevocationImpact, strictOptions);

export const createMemoryInvalidationEdgePort = (options?: {
  /** When true, persist/ack fails after successful decode (fail-closed probe). */
  readonly failStore?: boolean;
}): InvalidationEdgePort => {
  const emitted: EquivalenceRevocationImpactType[] = [];
  return {
    emitEquivalenceRevocation: (impact) =>
      Effect.gen(function* () {
        const decoded = yield* decodeImpact(impact).pipe(
          Effect.mapError(
            (cause) =>
              new BoundedResolverDecodeError({
                reason: "equivalence revocation impact failed strict decode",
                safe_cause: safeErrorLabel(cause),
                cause_digest: sha256Canonical(safeErrorLabel(cause)),
              }),
          ),
        );
        if (options?.failStore === true) {
          return yield* Effect.fail(
            new InvalidationEdgeStoreError({
              reason: "equivalence revocation impact store acknowledgement failed",
              safe_cause: "edge_store_rejected",
            }),
          );
        }
        emitted.push(cloneFreeze(decoded));
        return { acknowledged: true as const };
      }),
    listEmitted: () => emitted.map((e) => cloneFreeze(e)),
  };
};

/**
 * Apply a cache invalidation cause.
 *
 * Equivalence revocation is transactional / fail-closed:
 * 1. Strict-build/decode the canonical CR-012A impact
 * 2. Persist/acknowledge the impact edge first
 * 3. Only then evict
 *
 * If decode/store fails: report failure, do not claim edge_emitted, do not evict.
 * `eviction_alone_insufficient` remains true on the impact schema.
 */
export const applyInvalidation = (input: {
  readonly cache: ResolverCachePort;
  readonly edges: InvalidationEdgePort;
  readonly cause: CacheInvalidationCause;
  readonly impact?: unknown;
  readonly deployment_id?: string;
  readonly keyDigest?: string;
  readonly namespace?: "positive_recognition" | "report_readiness" | "negative_probe";
}): Effect.Effect<
  { readonly evicted: number; readonly edge_emitted: boolean },
  BoundedResolverDecodeError | InvalidationEdgeStoreError
> =>
  Effect.gen(function* () {
    if (input.cause === "equivalence_revocation") {
      if (input.impact === undefined) {
        return { evicted: 0, edge_emitted: false };
      }
      const decoded = yield* decodeImpact(input.impact).pipe(
        Effect.mapError(
          (cause) =>
            new BoundedResolverDecodeError({
              reason: "equivalence revocation impact failed strict decode",
              safe_cause: safeErrorLabel(cause),
              cause_digest: sha256Canonical(safeErrorLabel(cause)),
            }),
        ),
      );
      // Decode + persist/ack FIRST — failure must not evict.
      const ack = yield* input.edges.emitEquivalenceRevocation(
        decoded,
      );
      if (ack.acknowledged !== true) {
        return yield* Effect.fail(
          new InvalidationEdgeStoreError({
            reason: "equivalence revocation impact was not acknowledged",
            safe_cause: "edge_not_acknowledged",
          }),
        );
      }
      const { evicted } = yield* input.cache.invalidate({
        cause: input.cause,
        predicate: ({ binding }) => {
          const deployment = (binding as { deployment_id?: string }).deployment_id;
          return deployment !== undefined && decoded.affected_deployment_ids.includes(deployment);
        },
        keyDigest: input.keyDigest,
        namespace: input.namespace,
      });
      return { evicted, edge_emitted: true };
    }

    const { evicted } = yield* input.cache.invalidate({
      cause: input.cause,
      deployment_id: input.deployment_id,
      keyDigest: input.keyDigest,
      namespace: input.namespace,
    });
    return { evicted, edge_emitted: false };
  });

/**
 * Invalidate negative cache when capability coverage grows or transient errors recover.
 */
export const invalidateNegativeOnCoverageGrowth = (input: {
  readonly cache: ResolverCachePort;
  readonly previous_coverage: ReadonlyArray<string>;
  readonly next_coverage: ReadonlyArray<string>;
}): Effect.Effect<{ readonly evicted: number }, never> => {
  const prev = new Set(input.previous_coverage);
  const grew = input.next_coverage.some((key) => !prev.has(key));
  if (!grew) return Effect.succeed({ evicted: 0 });
  return input.cache.invalidate({
    cause: "capability_coverage_growth",
    namespace: "negative_probe",
  });
};
