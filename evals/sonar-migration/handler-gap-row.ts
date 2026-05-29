// evals/sonar-migration/handler-gap-row.ts
//
// RLAI claim-ledger row (Effect Schema) — the substrate for ground-truth-verified,
// adversarially-graded migration claims. Per the /rlaihf RLAIF playbook + the operator's
// "the map is not the territory" discipline: every CLAIM about the envio→ponder migration
// is graded against the LIVE system (objective lane) by an adversarial AI panel (grade lane),
// and the verdict + evidence are appended here. The JOIN of (objective ground_truth + AI verdict)
// in one row IS the substrate.
//
// GENERIC BY DESIGN — this same row grades:
//   • the frozen-only-handler sweep (cohort "frozen-handler-sweep")
//   • every B-1 green-belt group's parity claim (cohort "b1-group-<X>")
//   • any future "does the territory match the map" assertion
//
// Ledger: evals/sonar-migration/handler-gap-ledger.jsonl (append-only, git-tracked — deterministic
// diagnosis, cohort-bounded; per evals/README.md ADR-001). Reader: handler-gap-read.mjs.

import * as Schema from "@effect/schema/Schema";

/** real = genuine gap (territory ≠ map, action needed) · refuted = map was wrong / no gap · uncertain = territory inconclusive */
export const Verdict = Schema.Literal("real", "refuted", "uncertain");
export const Severity = Schema.Literal("critical", "high", "medium", "low", "none");

export const RlaiClaimRow = Schema.Struct({
  // ── context block (join key: cohort ⨯ subject ⨯ commit ⨯ ts) ──
  ts: Schema.String, // ISO-8601, stamped at append time (workflows can't call Date.now)
  commit: Schema.String, // short git sha the territory was probed against
  cohort: Schema.String, // "frozen-handler-sweep" | "b1-group-H-mirror" | …
  run_id: Schema.String, // the Workflow run id that produced the grade
  subject: Schema.String, // the entity / handler / contract under test (e.g. "mint_event")

  // ── the claim ──
  claim: Schema.String, // the assertion being graded against the territory

  // ── objective lane (LIVE territory ground-truth — construct-scar) ──
  ground_truth: Schema.String, // the decisive live-territory evidence behind the verdict
  probe: Schema.optional(Schema.Unknown), // full structured probe evidence (handler-exists / contract-active / data-state / consumer)

  // ── AI-grade lane (RLAIF adversarial — construct-protocol, refute-first) ──
  verdict: Verdict,
  severity: Severity,
  confidence: Schema.Number, // 0..1
  refutation_attempted: Schema.String, // what the grader tried to refute the claim with
  graders: Schema.Array(Schema.String), // lanes that graded it, e.g. ["construct-scar","construct-protocol"]

  // ── forward (the compounding output) ──
  needs_action: Schema.Boolean,
  recommended_action: Schema.String,
  learning: Schema.String, // the reusable lesson carried into the B-1 run
});

export type RlaiClaimRow = Schema.Schema.Type<typeof RlaiClaimRow>;

/** Decode/validate an unknown row at ingest (throws on shape violation). */
export const decodeRow = Schema.decodeUnknownSync(RlaiClaimRow);
export const encodeRow = Schema.encodeSync(RlaiClaimRow);
