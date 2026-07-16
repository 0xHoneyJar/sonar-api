import { Data } from "effect";
import type { ResolverAdmissionFullStopError } from "./operations/admission-control.js";

/**
 * Public typed errors — never retain raw identifier/config/cause/provider bodies.
 * Callers see safe reason codes, bounded redacted summaries, and optional digests.
 */

export class BoundedResolverDecodeError extends Data.TaggedError(
  "BoundedResolverDecodeError",
)<{
  readonly reason: string;
  /** Redacted bounded cause label — never raw ParseError / provider body. */
  readonly safe_cause: string;
  /** Optional stable digest of the rejected material for correlation. */
  readonly cause_digest?: string;
}> {}

export class BoundedResolverConfigError extends Data.TaggedError(
  "BoundedResolverConfigError",
)<{
  readonly reason: string;
  readonly path: string;
}> {}

export class StructuralPreflightError extends Data.TaggedError(
  "StructuralPreflightError",
)<{
  readonly reason: string;
  /** Stable digest of the rejected identifier — never the raw input. */
  readonly identifier_digest: string;
}> {}

export class NoHealthyCapabilityError extends Data.TaggedError(
  "NoHealthyCapabilityError",
)<{
  readonly reason: string;
  readonly capability_snapshot_version: {
    readonly registry_epoch: string;
    readonly registry_sequence: string;
  };
}> {}

/**
 * Typed 429 — caller or global resolver budget exceeded.
 * `retry_after_ms` is safe metadata (never credentials or identity).
 */
export class ResolverRateLimitedError extends Data.TaggedError(
  "ResolverRateLimitedError",
)<{
  readonly scope: "caller" | "global";
  readonly reason: string;
  readonly retry_after_ms: number;
  readonly limit: number;
  readonly window_ms: number;
}> {}

export class CircuitOpenError extends Data.TaggedError("CircuitOpenError")<{
  readonly network_key: string;
  readonly operation: "recognize" | "prepare" | "read_evidence";
  readonly state: "open" | "half_open";
  readonly retry_after_ms: number;
}> {}

export class BoundedResolverInternalError extends Data.TaggedError(
  "BoundedResolverInternalError",
)<{
  readonly reason: string;
  /** Redacted cause label — never raw exception / provider body. */
  readonly safe_cause: string;
}> {}

export class InvalidationEdgeStoreError extends Data.TaggedError(
  "InvalidationEdgeStoreError",
)<{
  readonly reason: string;
  readonly safe_cause: string;
}> {}

/**
 * Exhaustive public aggregate — includes CR-107 admission full-stop.
 * Prefer this union at API boundaries over hand-rolled subsets.
 */
export type BoundedResolverError =
  | BoundedResolverDecodeError
  | BoundedResolverConfigError
  | StructuralPreflightError
  | NoHealthyCapabilityError
  | ResolverRateLimitedError
  | CircuitOpenError
  | BoundedResolverInternalError
  | InvalidationEdgeStoreError
  | ResolverAdmissionFullStopError;
