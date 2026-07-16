/**
 * Request-local idempotent resolver_terminal emitter.
 *
 * Exactly one terminal event per resolveBounded invocation after any exit —
 * success, typed failure, or defect. Callers arm a classification; the exit
 * hook finalizes once. Duplicate finalize calls are no-ops.
 */
import type { RecognitionObserverPort } from "./observer.js";
import {
  bucketCandidateCount,
  type CacheOutcomeDimension,
  type IdentifierFormatDimension,
  type ResolverRoleDimension,
  type TerminalOutcomeDimension,
} from "./events.js";

export interface ResolverTerminalFinalizeInput {
  readonly identifier_format: IdentifierFormatDimension;
  readonly terminal_outcome: TerminalOutcomeDimension;
  readonly candidate_count: number;
  readonly cache_outcome: CacheOutcomeDimension;
  readonly role: ResolverRoleDimension;
  readonly adapter_attempts: number;
}

export interface ResolverTerminalFinalizer {
  /** Record the terminal classification and emit at most once. */
  readonly finalize: (input: ResolverTerminalFinalizeInput) => void;
  /** True after the single terminal has been emitted. */
  readonly settled: () => boolean;
  /**
   * Exit-hook safety net: if no branch finalized, emit a failed/rejected
   * terminal so every resolver exit still produces exactly one event.
   */
  readonly ensure: (fallback: ResolverTerminalFinalizeInput) => void;
}

export const createResolverTerminalFinalizer = (input: {
  readonly observer: RecognitionObserverPort | undefined;
  readonly started_ms: number;
  readonly nowMs: () => number;
}): ResolverTerminalFinalizer => {
  let settled = false;

  const emit = (args: ResolverTerminalFinalizeInput): void => {
    if (settled) return;
    settled = true;
    if (input.observer === undefined) return;
    const latency = Math.max(0, Math.min(60_000, input.nowMs() - input.started_ms));
    input.observer.record({
      kind: "resolver_terminal",
      identifier_format: args.identifier_format,
      terminal_outcome: args.terminal_outcome,
      candidate_count_bucket: bucketCandidateCount(args.candidate_count),
      cache_outcome: args.cache_outcome,
      ambiguous: args.candidate_count > 1,
      role: args.role,
      latency_ms: latency,
      adapter_attempts: Math.min(8, Math.max(0, args.adapter_attempts)),
    });
  };

  return {
    finalize: emit,
    settled: () => settled,
    ensure: (fallback) => {
      if (!settled) emit(fallback);
    },
  };
};

/** Default terminal for exits that never armed a classification. */
export const unclassifiedRejectedTerminal = (): ResolverTerminalFinalizeInput => ({
  identifier_format: "unclassified",
  terminal_outcome: "rejected",
  candidate_count: 0,
  cache_outcome: "none",
  role: "failed",
  adapter_attempts: 0,
});

export const failedTerminal = (input: {
  readonly identifier_format: IdentifierFormatDimension;
  readonly adapter_attempts?: number;
  readonly cache_outcome?: CacheOutcomeDimension;
}): ResolverTerminalFinalizeInput => ({
  identifier_format: input.identifier_format,
  terminal_outcome: "failed",
  candidate_count: 0,
  cache_outcome: input.cache_outcome ?? "none",
  role: "failed",
  adapter_attempts: input.adapter_attempts ?? 0,
});
