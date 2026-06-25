/**
 * errors.ts — typed error channel for the canonical normalizer (SDD §2).
 *
 * Effect `Data.TaggedError` ADT: the normalizer's failure type is the union
 * {@link CanonicalError}, so every failure mode is NAMED and matchable and no
 * thrown exception crosses the `src/canonical/` boundary (Effect is confined to
 * this layer — SDD §6).
 *
 * Sprint 2 (pure mappers) exercises only {@link SchemaInvalid}. The remaining
 * variants name the failure modes the S4 emit/projection layers surface
 * (Signer / PrevHashStore / Nats / Hasura) and are declared here so the ADT is
 * complete and the S4 Layer signatures reference ONE canonical union rather than
 * inventing per-call error shapes.
 */
import { Data } from "effect";
import type { ParseResult } from "@effect/schema";

/** A candidate failed to decode against `NftActivitySchema` (bad / drifted source data). */
export class SchemaInvalid extends Data.TaggedError("SchemaInvalid")<{
  readonly reason: string;
  readonly parseError?: ParseResult.ParseError;
}> {}

/** A chain source (Hasura / Helius / an SVM Source) could not be read. */
export class SourceUnavailable extends Data.TaggedError("SourceUnavailable")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/** The `sonar-canonical` signer failed to sign an envelope. */
export class SignFailed extends Data.TaggedError("SignFailed")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/** NATS was unreachable at emit time. */
export class NatsUnreachable extends Data.TaggedError("NatsUnreachable")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/** The prev-hash chain tip diverged from the expected value (an emit would fork the chain). */
export class ChainBroken extends Data.TaggedError("ChainBroken")<{
  readonly reason: string;
  readonly expectedPrevHash?: string;
  readonly actualPrevHash?: string;
}> {}

/** The `action` projection write to Hasura failed. */
export class HasuraWriteFailed extends Data.TaggedError("HasuraWriteFailed")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/** The normalizer's complete error union — the error channel of every canonical Effect. */
export type CanonicalError =
  | SchemaInvalid
  | SourceUnavailable
  | SignFailed
  | NatsUnreachable
  | ChainBroken
  | HasuraWriteFailed;
