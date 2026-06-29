/**
 * observation.domain.ts — the Sonar Sense envelope (pure · zero-dep · no I/O).
 *
 * Every sensor read returns an `Observation<T>`: the value PLUS the epistemic
 * status of the read. This is the `domain/` leaf of the honeycomb four-folder —
 * it imports NOTHING, so the port's identity never drags chain/network/config.
 *
 * Two orthogonal axes ride on every Observation:
 *   • grounding (epistemic) — can we TRUST this read? grounded|refuted|unverifiable
 *   • tier      (medallion) — how REFINED is the value? bronze|silver|gold
 * `tier ⊥ grounding`: a value can be `gold` yet `unverifiable`, or `bronze` yet
 * `grounded`. They stay independent (the lossless split — `tier` stays
 * domain-local, NOT promoted to a Hounfour primitive this cycle).
 */

/**
 * The grounding tristate — DECLARED LOCALLY (zero-dep).
 *
 * loa-hounfour's EpistemicTristate is a *pattern*, not an exported TS symbol
 * (FL-PRD-006: "instances differ too much for a generic type; the value is in
 * naming, not abstracting"). Its instances even use different state names
 * (`conserved|violated|unverifiable`, `verified:true|false|'unverifiable'`).
 * The canonical names for GROUNDED CONTENT are pinned by honeycomb's
 * `grounding-envelope.schema.json` → `grounded | refuted | unverifiable`, and
 * `unverifiable` is the one state-name shared across every tristate instance in
 * the cluster. So: redeclare here, conform to those names, import nothing.
 *
 * INVARIANT (enforced by code review + the `matchGrounding` exhaustiveness
 * check below — there is deliberately NO runtime validator, per FL-PRD-006):
 * the three states MUST drive THREE DISTINGUISHABLE consumer behaviours.
 * `refuted` is not "false"; `unverifiable` is not "maybe-false" — each is a
 * different instruction to the consumer. Never collapse to a boolean.
 */
export type Grounding = "grounded" | "refuted" | "unverifiable";

/**
 * The medallion tier — orthogonal to grounding, domain-local.
 * bronze = raw read · silver = cross-checked/derived · gold = canonical.
 */
export type Tier = "bronze" | "silver" | "gold";

/**
 * Envelope schema version. Bump ONLY for breaking (non-backward-compatible)
 * field changes; additive optional fields keep the same version. Consumers
 * (e.g. Score) pin/branch on this to stay compatible across kit upgrades.
 */
export const OBSERVATION_SCHEMA_VERSION = "sonar-sense/observation@1" as const;
export type ObservationSchemaVersion = typeof OBSERVATION_SCHEMA_VERSION;

/**
 * A single grounded sensor read. Mirrors the cluster's EventEnvelope shape
 * (flat, JCS-friendly fields + a trace line), scoped to a *read* rather than an
 * *event* — hence `chain_id`/`block_number` (which EventEnvelope lacks) and no
 * signature chain (reads are ephemeral state, not hash-chained events).
 */
export interface Observation<T> {
  /** the sensed value (balance, owner address, boolean, …). */
  readonly value: T;
  /** epistemic status — drives THREE distinguishable consumer behaviours. */
  readonly grounding: Grounding;
  /** medallion position — orthogonal to grounding. */
  readonly tier: Tier;
  /** what produced the read, e.g. "viem:berachain" | "belt-gateway". */
  readonly source: string;
  /** numeric chain id the read pertains to (80094 = Berachain mainnet). */
  readonly chain_id: number;
  /** block height the read was taken at, when the source reports one. */
  readonly block_number?: number;
  /** 0..1 calibrated confidence in `value` GIVEN `grounding`. */
  readonly confidence: number;
  /** MANDATORY — the line back to the originating request / chain event. */
  readonly trace_id: string;
  /** envelope schema version (frozen literal). */
  readonly schema_version: ObservationSchemaVersion;
}

/**
 * Fields the caller supplies. `grounding` and `schema_version` are stamped by
 * the builders; `tier`/`confidence` default sensibly but may be overridden.
 */
export interface ObservationInit<T> {
  readonly value: T;
  readonly source: string;
  readonly chain_id: number;
  readonly trace_id: string;
  readonly tier?: Tier;
  readonly block_number?: number;
  /**
   * Override the grounding-derived default (see `defaultConfidence`). Set this
   * ONLY when you have a genuinely calibrated confidence for THIS read — a
   * `grounded` read with low confidence, or a `refuted`/`unverifiable` read
   * with non-zero confidence, is legitimate but must be deliberate, never
   * accidental. Clamped to 0..1 by the builder (an out-of-range value is
   * neutralised, not propagated — not silently trusted).
   */
  readonly confidence?: number;
}

/**
 * Confidence defaults derived from grounding (override via `init.confidence`):
 *   grounded → 1     (sources agree / cache hit)
 *   unverifiable → 0 (degraded — could not check; `value` is tentative)
 *   refuted → 0      (a second source contradicts `value`)
 */
function defaultConfidence(grounding: Grounding): number {
  switch (grounding) {
    case "grounded":
      return 1;
    case "unverifiable":
    case "refuted":
      return 0;
    default: {
      const _exhaustive: never = grounding;
      throw new Error(`unreachable grounding: ${String(_exhaustive)}`);
    }
  }
}

function build<T>(grounding: Grounding, init: ObservationInit<T>): Observation<T> {
  // Clamp to the documented 0..1 range. Defensive + never-throws (per the
  // domain's no-runtime-validator stance): an out-of-range override is a caller
  // bug we neutralise rather than propagate into a trust-bearing field.
  const confidence = Math.max(0, Math.min(1, init.confidence ?? defaultConfidence(grounding)));
  const o: Observation<T> = {
    value: init.value,
    grounding,
    tier: init.tier ?? "bronze",
    source: init.source,
    chain_id: init.chain_id,
    confidence,
    trace_id: init.trace_id,
    schema_version: OBSERVATION_SCHEMA_VERSION,
  };
  // Omit `block_number` entirely when absent rather than carry an `undefined`
  // key — keeps the envelope JCS-canonical-friendly (no null/undefined noise).
  return init.block_number === undefined ? o : { ...o, block_number: init.block_number };
}

/** Sources agree (eRPC redundant-upstream agreement / cache hit). */
export const grounded = <T>(init: ObservationInit<T>): Observation<T> => build("grounded", init);

/**
 * A second source contradicts the value (e.g. divergent `ownerOf`). Downgrades
 * the read; it never collapses the port — the caller still gets the `value`.
 */
export const refuted = <T>(init: ObservationInit<T>): Observation<T> => build("refuted", init);

/** Could not verify (circuit open / fallback-degraded / single source). `value` is tentative. */
export const unverifiable = <T>(init: ObservationInit<T>): Observation<T> => build("unverifiable", init);

/**
 * Transform the sensed value while PRESERVING the epistemic frame (grounding,
 * tier, source, chain_id, block_number, confidence, trace_id). The blessed
 * alternative to a manual spread — e.g. read a balance as `bigint` then format
 * it, without re-deriving the frame or accidentally dropping the grounding.
 */
export function mapObservation<T, U>(o: Observation<T>, fn: (value: T) => U): Observation<U> {
  return { ...o, value: fn(o.value) };
}

/** Exhaustive handlers — one branch per grounding state. The compiler enforces all three. */
export interface GroundingMatch<T, R> {
  readonly grounded: (o: Observation<T>) => R;
  readonly refuted: (o: Observation<T>) => R;
  readonly unverifiable: (o: Observation<T>) => R;
}

/**
 * The blessed way to branch on grounding. There is deliberately NO
 * `isGrounded(): boolean` helper — a boolean tempts consumers to fold `refuted`
 * and `unverifiable` into one "not ok" bucket, the exact collapse the tristate
 * exists to prevent. `matchGrounding` makes the compiler reject any consumer
 * that fails to give all three states a distinct branch.
 */
export function matchGrounding<T, R>(o: Observation<T>, handlers: GroundingMatch<T, R>): R {
  switch (o.grounding) {
    case "grounded":
      return handlers.grounded(o);
    case "refuted":
      return handlers.refuted(o);
    case "unverifiable":
      return handlers.unverifiable(o);
    default: {
      const _exhaustive: never = o.grounding;
      throw new Error(`unreachable grounding: ${String(_exhaustive)}`);
    }
  }
}
