# SPIRAL SEED 001 — SQD live-tail (svm-sqd-substrate) · r2 (cycle-1 tuition folded in)

## Task
Land SqdCollectionEventSource as the $0 live-tail lane for svm.collection_event:
RESUME branch feat/spiral-spiral-20260706-4c5209-cycle-1 (cycle-1 banked: commits
bb747b03 + bb427a82 — SqdAuthRequiredError, ceiling guard, liveness monitor, kill
switch, 5 test files / ~900 test lines on top of the original 42-test baseline).
Converge on the content-addressed PK {tx_signature}:{nft_mint}:{instruction_index},
pass the §4.5 reconcile-by-recompute gate against the pythians 30,006-event fixture,
open a PR. bridgebuilder-review runs ON the PR.

## Prior outputs (verified 2026-07-05)
- SQD Portal portal.sqd.dev solana-mainnet: open/unauthenticated, block 0 → real-time
  (height 430,902,735). Filter ceiling ~345KB → MINT_CHUNK=1500. Continuation lastBlock+1.
  Batch history walks INFEASIBLE — live-tail role ONLY.
- Cycle-1 (cycle-299234b776) died at IMPL_EVIDENCE_MISSING circuit breaker: its sprint
  plan listed grimoires/loa/a2a/spiral-001/bb-review-*.json as an implementation
  deliverable — a category error (see Constraints). The CODE it banked is good.
- Two-lane ADR: grimoires/loa/context/2026-07-05-warehouse-supply-lane-adr.md.
  Insert-if-absent merge (coarse never clobbers). DAS = trust root.
- Snapshot-first onboarding done (#136-#138): 9 collections live. This lane adds EVENT
  HISTORY FORWARD, not ownership.
- Meter precedent: src/svm/helius-meter.ts — guard ships with first integration line.

## Consumer (anti deployed-but-unconsumed)
score-api (#121/#135) reads svm.collection_event via Hasura. The PR must demonstrate
the consumer-shape query.

## Constraints (hard)
- bridgebuilder-review is a PR-STAGE gate. NEVER list bb-review artifacts
  (grimoires/loa/a2a/**/bb-review-*.json) as sprint evidence/deliverable paths —
  implementation cannot produce them (cycle-1 circuit-breaker tuition, 2026-07-05).
  Sprint evidence paths = code + tests + docs the implementer itself writes.
- Sprint plans MUST carry acceptance-criteria checkboxes (cycle-1 PRE-CHECK WARN).
- No Dune calls (operator-approved spends only). No new metered providers/keys.
- §4.5 completeness gate applies per-lane; NEVER combine with windowed ingestion.
- Prefer cheap-and-loud failure shapes over silent long-running ones.

## Known BLOCKING defect (fix FIRST — run-2 adversarial review DISS-001)
src/svm/sqd-loader.ts runSqdLoader: collection-wide cursor + independent mint chunks
= permanent slot skips when a run stops at the request cap mid-chunks. Fix: only
advance the durable collection cursor after ALL chunks complete through that slot
(slot-window outermost), or track per-chunk resume progress. This violates the
coarse-never-clobbers doctrine — it is the walk-train lesson in cursor form.

## Stopping conditions
- Chronos: remaining budget $25 of the operator's $45 cap (runs 1+2 spent ~$20).
- Kaironic: findings/PR-delta plateau → terminate; do not pad cycles.
- HALT if SQD portal turns authenticated/paid (SqdAuthRequiredError exists for this).

## Cut from scope
No deep-history backfill. No Base/EVM work. No webhook-lane changes. No new providers.

## COMPLETION RECORD (2026-07-05 · appended post-landing)
Task LANDED as PR #140 (merged 04:22Z). Route: 3 harness runs (evidence-gate death →
banked impl → review-budget death) + /bug convergence cycle (sprint-bug-173, dissent
2→1→0) + audit APPROVED + BB dispositions. The §4.5 gate is deliberately BLOCKED until
the real fixture lands (bd-3mvd). Open follow-ups: bd-k5fh, bd-zyli (decode), bd-j0fj
(repo tsc). Cycle-1 harvest lesson: bb-review artifacts are PR-stage, never sprint
evidence paths; per-cycle budget must cover the review gate (spiral.max_budget_per_cycle_usd).
