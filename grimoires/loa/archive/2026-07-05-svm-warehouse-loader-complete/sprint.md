---
hivemind:
  schema_version: "1.0"
  artifact_type: launch-plan
  product_area: "sonar-api — SVM warehouse-loader lane"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "atomic task breakdown for the svm-warehouse-loader cycle: warehouse loader + multi-collection webhook + incremental reconcile + sync_status"}
  learning_status: directionally-correct
  source: team-internal
trust_tier: operator-authored
read_state: read
confidence: 0.8
decay_class: working
last_confirmed: 2026-07-05
operator_signed: self_attested
---

# Sprint Plan — svm-warehouse-loader · sprint-1 (single sprint cycle)

Traces: PRD r1 §6, SDD r1 §2. All tasks fixture-verifiable without live Helius (NFR-3). Branch: `feat/svm-warehouse-loader`.

## Tasks

### T-1 dune-client (FR-1 substrate)
`src/svm/dune-client.ts`: executeQuery/pollResult/fetchRows with pagination + retry/backoff (mirror `addressHistory` pattern), `X-Dune-API-Key` from env, per-run `executionCostCredits` logging.
**AC**: `test/dune-client.test.ts` green (mocked fetch: pagination joins pages; 429/5xx retries capped; cost surfaced; key never in thrown messages). Verify real API pagination limit against pythians query id and record it in the SDD [ASSUMPTION closure].

### T-2 kind-mapping adjudication (FR-2 decision) — BLOCKS T-3 kind config
Build marketplace program-ID map from pythians fixture: extract distinct `outer_executing_account` values from a committed fixture slice (Dune rows for txs that our existing 30,006-event dataset classified sale/list/delist vs plain transfer). Measure precision/recall of program-ID classification.
**AC**: `test/kind-mapping.test.ts` documents measured precision; decision recorded in SDD §2.4: (a) adopted if sale-detection precision ≥99% on fixture, else (c) transfers-only + flag. Fixture committed under `test/fixtures/svm-warehouse/`.

### T-3 warehouse-loader (FR-1)
`src/svm/warehouse-loader.ts` CLI per SDD §2.3: registry resolve → cursor → 30-day windows → row validation → mapping (incl. per-(tx,mint) ordinal identical to `parseHeliusTx` rule) → `upsertCollectionEvents` → sync_status write → reconcile-gate mark. `src/svm/sql/*.sql` committed.
**AC**: `test/warehouse-loader.test.ts` green — PK-convergence test (same tx via warehouse row AND `parseHeliusTx` fixture → identical id), cursor windowing, malformed-row rejection, `--dry` produces no writes.

### T-4 sync_status (FR-5)
`migrations/svm/002_sync_status.sql` + writer module `src/svm/sync-status.ts` + wiring into loader (T-3), webhook (T-5), reconcile (T-6).
**AC**: `test/sync-status.test.ts` green (upsert semantics, source labels loader|webhook|reconcile, skipped-no-das result state). Migration idempotent (IF NOT EXISTS).

### T-5 multi-collection webhook (FR-3)
Registry-driven member map + routing per SDD §2.5; `COLLECTION` env as single-tenant override; `/health` per-collection blocks.
**AC**: existing 4 webhook tests still green; new tests: two-collection routing, override mode, per-collection /health shape, degraded member-set warning still per-collection.

### T-6 incremental reconcile (FR-4)
Default snapshot-diff path + `--full` + `--verify-off` per SDD §2.6.
**AC**: unit test with synthetic snapshot vs derived-owner divergence walks ONLY drifted mints (assert via injected source counting calls); `--verify-off` writes `skipped-no-das`.

### T-7 registry batch-1 (FR-6)
8 classic-mint entries from the candidates doc (addresses already on-chain-verified 2026-07-04).
**AC**: registry resolve test for all 8 keys; `resolveCollection` error message lists them.

### T-8 contract-guard extension (PRD risk 1)
Extend `scripts/svm-contract.json` + verifier for `svm_sync_status` (pending-exposure) and record warehouse source columns as a documented external dependency.
**AC**: `pnpm` contract verify green; sync_status marked pending-exposure until Hasura track (rollout step 1).

### T-9 post-topup runbook (NOT code — doc task)
`grimoires/loa/runbooks/svm-warehouse-rollout.md`: migration+track motion, pythians gap-heal command (`--from 2026-06-25`, expected ~108 events, parity vs Dune ground truth), batch-1 ingestion order + per-run cost log table, Helius webhook re-verification checklist, #122 closure criteria.
**AC**: runbook exists, every command copy-pasteable, ground-check clean.

## Dependency order
T-1 → T-3; T-2 → T-3(kind config); T-4 before T-3/T-5/T-6 wiring (table first); T-5, T-6 parallel after T-4; T-7 anytime; T-8 after T-4; T-9 last.

## Acceptance gate for the sprint
All new/extended test files green + full `vitest run` no regressions + `tsc --noEmit` no NEW errors + ground-check clean on runbook + no live-network calls in CI paths.
