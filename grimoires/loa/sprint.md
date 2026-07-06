---
hivemind:
  schema_version: "1.0"
  artifact_type: launch-plan
  product_area: "sonar-api — SVM SQD block-stream substrate"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "sprint-1 task breakdown for svm-sqd-substrate: spike-gated build of the free block-stream supply lane through batch-1 landing and closure"}
  learning_status: directionally-correct
  source: team-internal
trust_tier: operator-authored
read_state: read
confidence: 0.8
decay_class: working
last_confirmed: 2026-07-05
operator_signed: self_attested
---

# Sprint Plan — svm-sqd-substrate · sprint-1

Traces PRD r1 + SDD r1 §5. Branch `feat/svm-sqd-substrate`. BB gate on merge (operator rule).
T-1 is the GATE: its abort criterion (gating/throttle observed) pauses the cycle for operator terms
decision — nothing downstream executes on hope.

### T-1 SPIKE — Portal terms + shape discovery (pythians, measured)
Stream pythians' full history (3,682 DAS members, chunked ≤500) from Portal with request counting.
Measure: requests total, rows/request, continuation semantics (one request per window vs bounded
chunks), wall-clock, throttles/429s. Capture a fixture slice (real response rows) to
`test/fixtures/svm-sqd/`. Register free etiquette key at portal.sqd.dev/app = operator-optional.
**AC**: measured table appended to NOTES; fixture committed; pagination open-item (SDD §2.1) resolved
into the client design; ABORT path exercised-or-cleared. No DB writes (dry).

### T-2 decode (pure) — `sqd-collection-event-source.ts`
Balance-diff FSM per SDD §2.2 + `test/sqd-decode.test.ts` incl. PK-convergence vs parseHeliusTx and
ambiguous-reject cases. **AC**: decode tests green; recall vs the Helius-classified pythians fixture
measured ≥99.5% on ownership-moving events (G1 metric) using T-1's captured rows.

### T-3 client + CLI + integration — `sqd-client.ts`, `sqd-loader.ts`, deltas
Windowing/chunking/cursor/cap per SDD §2.1+§2.3 (constants tuned from T-1 measurements, not guesses);
`EventSource`+`SyncEventSource` += `sqd-stream`; migration 003 CHECK widen; ops `sqd-ingest` step
(injection-safe input pattern). **AC**: `test/sqd-client.test.ts` green; suite + tsc no regressions;
ops workflow lints.

### T-4 G1 adjudication — pythians live ingest
Dry parity first, then live (insert-if-absent → existing rows untouched, new-only). §4.5 reconcile
gate; sync_status `sqd-stream` row. **AC**: G1 targets met + gate passed; per-run meter line recorded.

### T-5 batch — remaining 7 collections
Sequential ops dispatches (Clay/FFF/GG prove the metadata-era fix). **AC**: 8/8 counts >0 via gateway,
sync_status rows current, request meter within SQD_MAX_REQUESTS per run.

### T-6 closure — rides the EXISTING NOTES protocol
Trigger satisfied by T-5 (batch-1 landed, substrate = SQD). Execute: verify → KF-018
RESOLVED-STRUCTURAL → close #122 → notify #121 (freshness contract + collection keys) → contract
manifest svm_sync_status → live via PR. **AC**: protocol's 4 steps done with evidence links.

## Order & gates
T-1 → (T-2 ∥ T-3, both consume T-1 outputs) → T-4 → T-5 → T-6. Sprint acceptance: full suite green,
tsc clean on touched files, BB-reviewed PR merged, closure evidence posted.
