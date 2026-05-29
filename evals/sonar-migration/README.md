# RLAI migration-claim ledger (`sonar-migration`)

> The map is not the territory. Every claim about the envio→ponder migration gets **graded against the live system**, adversarially, and recorded here. The join of (objective ground-truth ⨯ AI verdict) in one row is the substrate.

Scaffolded via `/rlaihf` (RLAIF mode — objective rigor, multi-model adversarial). Distinct from the Loa-framework eval harness (`evals/harness|graders|suites/`, which is deterministic bash grading of framework changes); this is the **AI-graded migration-diagnosis** lane.

## Files
| file | what |
|---|---|
| `handler-gap-row.ts` | Effect-Schema row contract (generic RLAI claim: context ⨯ claim ⨯ ground-truth ⨯ verdict ⨯ learning). Used to validate at ingest. |
| `handler-gap-ledger.jsonl` | append-only ledger (git-tracked — deterministic, cohort-bounded). One row per graded claim. |
| `handler-gap-read.mjs` | reader/rollup — verdict distribution, needs-action ranked, frozen-but-fine, uncertain, B-1 learnings. |

## How to CAPTURE
The capture seam is a **Workflow** (the agent orchestrator), not a UI — per entity/claim it runs a two-lane grade:
1. **objective lane** — `construct-scar` forensic probe against the **live territory** (railway logs/vars, vRR1 reads, gateway GraphQL, envio-vs-ponder source). Discovers truth; does not trust the doc.
2. **grade lane (RLAIF)** — `construct-protocol` adversarial verifier, **refute-first**: defaults to "the claim is wrong" and only grades `real` if the territory evidence forces it.

The graded rows are appended (validate via `decodeRow`, stamp `ts`/`commit`/`run_id`/`cohort`). First cohort: `frozen-handler-sweep` (the 8 Sprint-M "accept-frozen-only" Mibera entities). Re-run the `b1-rlai-frozen-handler-sweep` workflow to refresh.

## How to INTERPRET
```
node evals/sonar-migration/handler-gap-read.mjs                  # all
node evals/sonar-migration/handler-gap-read.mjs b1-group-H-mirror # one cohort
```
- `verdict=real` → the territory contradicts the map: a genuine gap that needs action (e.g. a missing forward handler). Ranked by severity ⨯ confidence.
- `verdict=refuted` → the map's worry didn't hold (handler exists, or contract inactive + no consumer → "accept-frozen-only" was correct).
- `verdict=uncertain` → territory inconclusive; escalate (more probing or a live test).
- A `real` with high confidence + a live consumer = **do this first** (it's silently regressing someone, like Ruggy/`mint_event`).

## How to ITERATE — the B-1 template
This is the **reusable rigor pattern for the whole B-1 green-belt run.** Every group port (henlo, mirror, validator, …) makes a *parity claim* ("the ponder handler replicates envio + emits correctly"). Grade it the same way: probe the live territory → adversarially refute → append a row with `cohort: "b1-group-<X>"`. The ledger accumulates a single, queryable record of **which migration claims survived contact with the territory** — so B-1 ships on graded truth, not assertion.

> Anti-pattern (refused): grading a claim from the doc/diff alone. If a row's `ground_truth` isn't a live-territory observation, it isn't graded — it's guessed.
