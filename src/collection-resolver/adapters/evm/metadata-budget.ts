/**
 * Optional remote-metadata sub-budget for the EVM NFT probe.
 *
 * Metadata must never consume the full adapter deadline: CR-102 races the whole
 * probe against `request.deadline_at_ms`, so recognition + index + projection
 * need a deterministic reserve after enrich settles (or is skipped).
 *
 * All comparisons use the shared monotonic clock domain (same as CR-102).
 *
 * Reserve semantics:
 * - {@link POST_METADATA_RESERVE_SAFETY_FLOOR_MS} — immutable positive floor;
 *   operator overrides cannot reduce the effective reserve below it.
 * - {@link DEFAULT_POST_METADATA_RESERVE_MS} — configurable *desired* reserve
 *   when no override is supplied; operators may raise above the floor, never
 *   lower the effective value beneath it.
 */

export interface EvmMetadataBudgetConfig {
  /**
   * Hard cap on optional metadata enrich budget (monotonic ms).
   * Default: {@link DEFAULT_METADATA_BUDGET_MAX_MS}.
   */
  readonly max_ms?: number;
  /**
   * Fraction of `(remaining - reserve)` available to metadata (0..1].
   * Default: {@link DEFAULT_METADATA_BUDGET_FRACTION}.
   */
  readonly fraction?: number;
  /**
   * Desired monotonic ms reserved after metadata for projection/return so the
   * adapter can deliver an already-recognized hit before CR-102's outer race.
   * Clamped to ≥ {@link POST_METADATA_RESERVE_SAFETY_FLOOR_MS}; may raise the
   * reserve, never lower it below the floor.
   * Default desired: {@link DEFAULT_POST_METADATA_RESERVE_MS}.
   */
  readonly post_metadata_reserve_ms?: number;
}

export interface ResolvedMetadataBudget {
  readonly max_ms: number;
  readonly fraction: number;
  /** Effective reserve — always ≥ {@link POST_METADATA_RESERVE_SAFETY_FLOOR_MS}. */
  readonly post_metadata_reserve_ms: number;
}

/** Safe default hard cap — small relative to the 1.5s per-network budget. */
export const DEFAULT_METADATA_BUDGET_MAX_MS = 200;

/** Use at most half of the post-reserve remaining budget. */
export const DEFAULT_METADATA_BUDGET_FRACTION = 0.5;

/**
 * Immutable positive safety floor for post-metadata reserve (monotonic ms).
 * Operator overrides of `post_metadata_reserve_ms` cannot reduce the effective
 * reserve below this value — including explicit `0` or tiny overrides that would
 * otherwise let metadata's sub-deadline equal CR-102's controlling deadline.
 */
export const POST_METADATA_RESERVE_SAFETY_FLOOR_MS = 50;

/**
 * Configurable *desired* reserve for post-metadata work when no override is
 * supplied (index already preferred earlier; this covers projection + fiber
 * return ahead of the outer deadline race). Distinct from the immutable floor:
 * operators may raise the desired reserve; resolution always clamps to
 * ≥ {@link POST_METADATA_RESERVE_SAFETY_FLOOR_MS}.
 */
export const DEFAULT_POST_METADATA_RESERVE_MS = 50;

const effectivePostMetadataReserveMs = (desired: number): number =>
  Math.max(POST_METADATA_RESERVE_SAFETY_FLOOR_MS, Math.floor(desired));

export const resolveMetadataBudgetConfig = (
  input?: EvmMetadataBudgetConfig,
): ResolvedMetadataBudget => {
  const max_ms =
    input?.max_ms !== undefined && Number.isFinite(input.max_ms) && input.max_ms > 0
      ? Math.floor(input.max_ms)
      : DEFAULT_METADATA_BUDGET_MAX_MS;
  const fractionRaw =
    input?.fraction !== undefined && Number.isFinite(input.fraction)
      ? input.fraction
      : DEFAULT_METADATA_BUDGET_FRACTION;
  const fraction = Math.min(1, Math.max(0, fractionRaw));
  const desiredReserve =
    input?.post_metadata_reserve_ms !== undefined &&
    Number.isFinite(input.post_metadata_reserve_ms) &&
    input.post_metadata_reserve_ms >= 0
      ? input.post_metadata_reserve_ms
      : DEFAULT_POST_METADATA_RESERVE_MS;
  const post_metadata_reserve_ms = effectivePostMetadataReserveMs(desiredReserve);
  return { max_ms, fraction, post_metadata_reserve_ms };
};

/**
 * Absolute monotonic deadline for optional metadata enrich.
 * Returns `undefined` when the safety floor cannot fit before the outer
 * deadline — skip enrich immediately so recognition can still return.
 * Whenever a sub-deadline is returned it is strictly and materially earlier
 * than `request_deadline_at_ms` by ≥ {@link POST_METADATA_RESERVE_SAFETY_FLOOR_MS}.
 */
export const metadataSubDeadlineAtMs = (input: {
  readonly now_ms: number;
  readonly request_deadline_at_ms: number;
  readonly config: ResolvedMetadataBudget;
}): number | undefined => {
  const remaining = input.request_deadline_at_ms - input.now_ms;
  // Defensive clamp: never trust a below-floor reserve even if config was hand-built.
  const reserve = effectivePostMetadataReserveMs(input.config.post_metadata_reserve_ms);
  if (!(remaining > reserve)) {
    return undefined;
  }
  const available = remaining - reserve;
  const byFraction = Math.floor(available * input.config.fraction);
  const budget = Math.min(input.config.max_ms, byFraction, available);
  if (!(budget > 0)) {
    return undefined;
  }
  // Sub-deadline ends strictly before the outer request deadline by ≥ reserve (≥ floor).
  return input.now_ms + budget;
};
