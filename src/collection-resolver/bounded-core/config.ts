import { Effect, Schema } from "effect";
import type { ParseOptions } from "effect/SchemaAST";
import { BoundedResolverConfigError, BoundedResolverDecodeError } from "./errors.js";
import { safeErrorLabel } from "./redaction.js";
import { sha256Canonical } from "./caching/keys.js";
import {
  BoundedResolverConfig,
  DEFAULT_BOUNDED_RESOLVER_CONFIG,
  type BoundedResolverConfig as BoundedResolverConfigType,
} from "./schemas.js";
import { cloneFreeze } from "../capability-registry/immutable.js";

const strictOptions: ParseOptions = {
  errors: "all",
  onExcessProperty: "error",
};

const decodeConfig = Schema.decodeUnknown(BoundedResolverConfig, strictOptions);

const assertBudgetOrdering = (
  config: BoundedResolverConfigType,
): Effect.Effect<void, BoundedResolverConfigError> => {
  if (config.per_network_deadline_ms > config.global_deadline_ms) {
    return Effect.fail(
      new BoundedResolverConfigError({
        reason: "per_network_deadline_ms must be <= global_deadline_ms",
        path: "per_network_deadline_ms",
      }),
    );
  }
  if (config.report_readiness_ttl_ms > config.positive_recognition_ttl_ms) {
    return Effect.fail(
      new BoundedResolverConfigError({
        reason:
          "report_readiness_ttl_ms must be <= positive_recognition_ttl_ms (readiness shorter-lived)",
        path: "report_readiness_ttl_ms",
      }),
    );
  }
  if (config.negative_cache_ttl_ms > config.report_readiness_ttl_ms) {
    return Effect.fail(
      new BoundedResolverConfigError({
        reason: "negative_cache_ttl_ms must be <= report_readiness_ttl_ms",
        path: "negative_cache_ttl_ms",
      }),
    );
  }
  if (config.max_concurrent_probes > config.max_searched_networks) {
    return Effect.fail(
      new BoundedResolverConfigError({
        reason: "max_concurrent_probes must be <= max_searched_networks",
        path: "max_concurrent_probes",
      }),
    );
  }
  return Effect.void;
};

/**
 * Strict-decode + validate bounded resolver config.
 * Defaults are SDD §5.3 interactive budgets.
 * `max_concurrent_probes: 0`, overflow, malformed, or excess properties fail.
 */
export const decodeBoundedResolverConfig = (
  input: unknown,
): Effect.Effect<
  BoundedResolverConfigType,
  BoundedResolverDecodeError | BoundedResolverConfigError
> =>
  Effect.gen(function* () {
    const decoded = yield* decodeConfig(input).pipe(
      Effect.mapError(
        (cause) =>
          new BoundedResolverDecodeError({
            reason: "bounded resolver config failed strict Effect Schema decode",
            safe_cause: safeErrorLabel(cause),
            cause_digest: sha256Canonical(safeErrorLabel(cause)),
          }),
      ),
    );
    yield* assertBudgetOrdering(decoded);
    return cloneFreeze(decoded);
  });

export const defaultBoundedResolverConfig = (): BoundedResolverConfigType =>
  cloneFreeze(DEFAULT_BOUNDED_RESOLVER_CONFIG);
