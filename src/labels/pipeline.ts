/**
 * pipeline.ts — the composition root (SP-1). Assembles the LabelStep order from the separate step modules
 * (signing.ts / reconcile.ts / confidence.ts) so `ingest.ts` never imports them. Order: verify signatures
 * (operator-attested) → reconcile chain-derived → derive confidence.
 */
import { makeConfidenceStep, type ConfidenceSignals } from "./confidence";
import { makeSigningStep, type KeyResolver } from "./signing";
import { makeReconcileStep, type Reconciler } from "./reconcile";
import type { LabelInput, LabelStep } from "./types";

export interface PipelineDeps {
  keyResolver: KeyResolver;
  reconciler: Reconciler;
  signalsFor?: (row: LabelInput) => ConfidenceSignals;
}

export function buildIngestSteps(deps: PipelineDeps): LabelStep[] {
  return [makeSigningStep(deps.keyResolver), makeReconcileStep(deps.reconciler), makeConfidenceStep(deps.signalsFor)];
}
