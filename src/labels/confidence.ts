/**
 * confidence.ts — per-method confidence derivation + validity-window decay (SDD §4, H-5, DH-4).
 *
 * confidence is NOT free-form (FAGAN SKP-006: "decorative"); it's a function of the labeling METHOD.
 * The DB `label.decay_config` table is the authoritative half-life source; these defaults mirror it for
 * the in-app `confidenceStep`, and the S5 view computes decay in SQL from decay_config.
 */
import type { LabelInput, LabelMethod, LabelStep } from "./types";

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export interface ConfidenceSignals {
  patternStrength?: number; // own-indexed: 0..1 (escrow/distributor fan-out strength)
  corroborated?: boolean; // external-attested: chain-corroborated?
  score?: number; // heuristic: caller-supplied 0..1
}

export function confidenceFor(method: LabelMethod, s: ConfidenceSignals = {}): number {
  switch (method) {
    case "chain-mechanical":
    case "operator-attested":
      return 1.0;
    case "program-metadata":
      return 0.95;
    case "own-indexed":
      return clamp(0.8 + 0.15 * (s.patternStrength ?? 0), 0.8, 0.95);
    case "external-attested":
      return s.corroborated ? 0.9 : 0.5;
    case "heuristic":
      return clamp(s.score ?? 0.3, 0, 1);
  }
}

/** Half-life (days) per method; null = no decay (∞). Mirrors label.decay_config defaults (DH-4). */
export const HALF_LIFE_DAYS: Record<LabelMethod, number | null> = {
  "chain-mechanical": null,
  "operator-attested": null,
  "program-metadata": 365,
  "own-indexed": 180,
  "external-attested": 90,
  "heuristic": 60,
};

/** effective_confidence = base × 0.5^(age/half_life); no decay when half-life is null. */
export function effectiveConfidence(method: LabelMethod, base: number, ageDays: number): number {
  const hl = HALF_LIFE_DAYS[method];
  if (hl == null) return base;
  return base * Math.pow(0.5, Math.max(0, ageDays) / hl);
}

/** Step that sets confidence from method+signals when a producer didn't supply one. */
export function makeConfidenceStep(signalsFor?: (row: LabelInput) => ConfidenceSignals): LabelStep {
  return {
    name: "confidence",
    apply(row: LabelInput): LabelInput {
      if (typeof row.confidence === "number") return row;
      return { ...row, confidence: confidenceFor(row.method, signalsFor?.(row) ?? {}) };
    },
  };
}
