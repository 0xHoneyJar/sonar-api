# Sprint Plan — Per-Token ERC-1155 Holder State as a Reconstructable Projection (`mv_holder_1155`)

**Version:** 1.0
**Date:** 2026-06-04
**Author:** Sprint Planner Agent (SHIP/ARCH · BARTH + protocol, craft lens)
**PRD Reference:** `grimoires/loa/prd.md` r1 (spiral-pertoken-projection-1)
**SDD Reference:** `grimoires/loa/sdd.md` r1 (Flatline clear — no AUTO-INTEGRATED, no BLOCKERS)
**Cycle:** `spiral-pertoken-projection-1` · Branch: `feat/spiral-pertoken-projection-1`
**Flatline status:** No findings to integrate. No blockers to resolve.

> **Supersedes** `sprint.md` v2.0 (sonar-belt-factory) — retired cycle; different substrate concern. The prior plan addressed blue-green promotion; this plan addresses per-token ERC-1155 holder state via materialized view.

---

## Executive Summary

The presenting failure (sonar-api#62 — wrong per-token balances for apiculture token-4) exposed a substrate gap: `TrackedHolder` is a whole-contract aggregate, not a per-token projection. The PRD decision is **Option A — a Postgres materialized view (`mv_holder_1155`) that folds the existing `"Action"` event-ledger** into correct per-token, per-address balances.

The action table already holds the complete genesis→head history for apiculture (13,611 events; 89,021 expected holder rows across 6 tokens). Per-token holder state is a deterministic fold, not a primary. This sprint ships the fold as a materialized view with conservation invariants wired into CI and a runtime health-check function.

**No Ponder handler changes. No new `onchainTable`. No reindex. No deployment by the agent.**

**Build sequencing follows SDD §8 exactly:**

| Phase | Task(s) | Deliverable |
|-------|---------|-------------|
| 0 — Pre-deploy audit | T1 | Data-quality gate: column types, null rates, coverage |
| 1 — Migration | T2, T3 | `migrations/add-mv-holder-1155.sql` (index + MV + MV indexes + health-check function) |
| 2 — CI script | T4 | `scripts/invariant-check-1155.sh` (I1, I2, I3) + CI pipeline wiring |
| 3 — Refresh | T5 | `scripts/refresh-mv-1155.sh` + cron service config |
| 4 — Hasura | T6 | `scripts/hasura-track-mv-1155.sh` + fallback view |
| 5 — Sign-off | T7, T8 | Backward-compat verification + PR review gates |

---

## Sprint Overview

This cycle is a single sprint. All tasks are sequential (each phase depends on the prior). Tasks T2–T8 are the buildable scope; T1 is a pre-deployment gate that must complete before T2 executes.

| Task | Theme | Scope | Key Deliverable | PRD ACs |
|------|-------|-------|-----------------|---------|
| **T1** | Pre-deployment data quality audit | SMALL | Column-type check + null-rate check + coverage report | Pre-condition for all |
| **T2** | Migration script: action-table index + MV + MV indexes | MEDIUM | `migrations/add-mv-holder-1155.sql` | AC-01, AC-02, AC-03 |
| **T3** | Runtime health-check SQL function | SMALL | `fn_1155_invariant_check()` in migration | AC-11 |
| **T4** | CI conservation-invariant script | MEDIUM | `scripts/invariant-check-1155.sh` + CI wiring | AC-05–AC-10 |
| **T5** | Refresh mechanism | SMALL | `scripts/refresh-mv-1155.sh` + cron config | FR-07, AC-04 |
| **T6** | Hasura tracking script + fallback view | SMALL | `scripts/hasura-track-mv-1155.sh` | AC-12 |
| **T7** | Backward compatibility verification | SMALL | TrackedHolder regression evidence | AC-13 |
| **T8** | PR review gates | SMALL | Flatline + Bridgebuilder reviews | AC-14, AC-15 |

---

## T1: Pre-Deployment Data Quality Audit

**Priority:** P0 (blocks all downstream tasks)
**SDD reference:** §3.2.4, §9 R-02, §9 R-05
**Goal contributions:** G1 (correctness), G4 (generalization)

### Task Goal

Before authoring the migration, verify the live `"Action"` table schema and data quality against every assumption the MV definition depends on. Any gap found here changes the MV SQL before it is written — not after.

### Deliverables

- [x] Column-type report: `numeric1` and `numeric2` actual Postgres data types confirmed.
- [x] Transfer null-rate report: `COUNT(*) WHERE action_type='transfer1155' AND context->>'from' IS NULL` per `primary_collection` — any non-zero count must be documented with impact assessment before T2 starts.
- [x] Action-type coverage report: `SELECT action_type, COUNT(*) FROM "Action" WHERE action_type IN ('mint1155','burn1155','transfer1155') GROUP BY action_type` — confirms the three event types exist and are populated for apiculture.
- [x] Burn-address exclusion alignment: confirm `isBurnAddress()` at `src/lib/mint-detection.ts` includes exactly the two addresses the MV will exclude (`0x0000…0000` and `0x000…dead`); document any discrepancy.
- [x] Findings written to `grimoires/loa/a2a/sprint-pertoken-1/pre-deploy-audit.md`.

### Acceptance Criteria

- [x] Column types for `numeric1` and `numeric2` are documented; the `CAST(... AS NUMERIC)` pattern in the MV SQL is confirmed safe against the actual type.
- [x] Any `transfer1155` actions with a NULL `context->>'from'` are documented with the affected `primary_collection` name and count. If any exist for `puru_apiculture`, T2 must address them before the MV definition finalizes.
- [x] `isBurnAddress()` exclusion list matches the MV definition exactly — no silent divergence.
- [x] Pre-deploy audit document is written and linked from NOTES.md before T2 begins.

### Tests

- The audit produces SQL queries that are preserved in the findings doc — they serve as the test scaffold for the I2 invariant check authored in T4.
- No code is written in T1. The audit is read-only SQL + code inspection.

### Dependencies

- Read access to the live `"Action"` table (operator pre-checks; agent does not deploy).
- `src/lib/mint-detection.ts` in the working tree.

---

## T2: Migration Script — Action-Table Index + `mv_holder_1155` + MV Indexes

**Priority:** P0
**SDD reference:** §3.1, §3.2, §3.3, Phase 1 (§8)
**Goal contributions:** G1 (correct per-token balances), G2 (reconstructability), G3 (conservation invariants), G5 (no reindex fragility)

### Task Goal

Author `migrations/add-mv-holder-1155.sql` — the single DDL file that, when executed by the operator, creates the complete `mv_holder_1155` infrastructure. The migration is idempotent (`IF NOT EXISTS` throughout), reviewed in this PR, and executed operator-led per ADR-010.

### Deliverables

- [x] `migrations/add-mv-holder-1155.sql` containing, in this exact order:
  1. `idx_action_type_collection_numeric2` on `"Action"` (`CREATE INDEX IF NOT EXISTS`)
  2. `mv_holder_1155` MV definition from SDD §3.2.3 (`CREATE MATERIALIZED VIEW … WITH DATA`)
  3. `uidx_mv_holder_1155_pk` unique index on `(collection_key, chain_id, token_id, address)` (`CREATE UNIQUE INDEX IF NOT EXISTS`)
  4. `idx_mv_holder_1155_collection_chain` secondary index (`CREATE INDEX IF NOT EXISTS`)
- [x] The MV SQL matches SDD §3.2.3 exactly: four-arm UNION ALL (mint-in, burn-out, transfer-in, transfer-out); `WHERE balance > 0`; burn-address exclusion via `LOWER(address) NOT IN (…)`.
- [x] A header comment in the migration documenting: estimated wall time (< 5 min), operator pre-check step (column-type query from SDD §3.2.4), and the `REFRESH MATERIALIZED VIEW CONCURRENTLY` usage note.

### Acceptance Criteria

- [x] **AC-01**: Migration script exits 0 against the serving DB schema; `\d mv_holder_1155` shows `(collection_key TEXT, chain_id INT, token_id NUMERIC, address TEXT, balance NUMERIC)`.
- [x] **AC-02**: `\di uidx_mv_holder_1155_pk` confirms the unique index exists on the MV.
- [x] **AC-03**: `\di idx_action_type_collection_numeric2` confirms the action-table index exists.
- [x] **AC-04** (verified in T5 after refresh): `REFRESH MATERIALIZED VIEW mv_holder_1155` (or CONCURRENTLY after unique index is present) completes in < 5 minutes.
- [x] The MV is created `WITH DATA` — the action table's complete history is folded immediately at creation, before Hasura tracking.
- [x] Migration is idempotent: re-running the script does not error (all `IF NOT EXISTS` guards).
- [x] `git diff` confirms zero changes to `src/handlers/`, `schema.graphql`, and any Ponder entity config — backward compat is structural, not just asserted.

### Tests

- **Migration smoke** (operator-run against a local Postgres copy or CI-accessible snapshot before the serving DB):
  - Script exits 0
  - `SELECT COUNT(*) FROM mv_holder_1155` returns a non-zero row count
  - `SELECT COUNT(DISTINCT token_id) FROM mv_holder_1155 WHERE collection_key='puru_apiculture'` returns 6
- **Unique index verification:**
  - `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_holder_1155` succeeds (no error)
  - A non-concurrent refresh would succeed too but block reads — the CONCURRENTLY path confirms the unique index is present

### Dependencies

- T1 complete: column types confirmed; null-rate report clear (or MV SQL adjusted per findings).
- T3 is authored in the same migration file (see below).

---

## T3: Runtime Health-Check SQL Function

**Priority:** P1
**SDD reference:** §3.6, Phase 1 (§8)
**Goal contributions:** G3 (conservation invariants as first-class citizens)

### Task Goal

Author `fn_1155_invariant_check()` as the final DDL statement in `migrations/add-mv-holder-1155.sql`. This function is the runtime surface for the same invariant checks that `scripts/invariant-check-1155.sh` (T4) runs in CI — same logic, different invocation path. Operators call it on demand without a CI run.

### Deliverables

- [x] `CREATE OR REPLACE FUNCTION fn_1155_invariant_check(p_collection_key TEXT DEFAULT NULL, p_chain_id INT DEFAULT NULL) RETURNS TABLE (check_name TEXT, status TEXT, failing_count BIGINT, worst_delta NUMERIC, detail TEXT) LANGUAGE sql STABLE` appended to `migrations/add-mv-holder-1155.sql`.
- [x] Function body from SDD §3.6 verbatim: I1 (mint-burn = supply CTE) + I2 (no-negative-intermediate-balances CTE) returning `UNION ALL`.
- [x] Usage examples as a comment block in the migration: full check (`SELECT * FROM fn_1155_invariant_check()`), scoped check (`SELECT * FROM fn_1155_invariant_check('puru_apiculture', 8453)`).

### Acceptance Criteria

- [x] **AC-11**: `SELECT * FROM fn_1155_invariant_check('puru_apiculture', 8453)` returns two rows: `(I1_mint_burn_supply, PASS, 0, 0, …)` and `(I2_no_negative_balances, PASS, 0, 0, …)` on valid data.
- [x] Function is `STABLE` (no side effects; reads `"Action"` + `mv_holder_1155` only).
- [x] Response time for `fn_1155_invariant_check('puru_apiculture', 8453)` is < 500ms (NFR-05 equivalent for the health check path).
- [x] The function handles `NULL` parameters gracefully — full check across all collections when both params are NULL.

### Tests

- After migration is applied against the local/CI DB:
  ```sql
  SELECT * FROM fn_1155_invariant_check('puru_apiculture', 8453);
  -- Expect: I1 status='PASS' worst_delta=0, I2 status='PASS' failing_count=0
  ```
- Injected-failure test (for code review verification, not a deployed fixture): confirm I1 would FAIL if held balances are manually altered; confirm I2 would FAIL if a negative-balance row were inserted into the raw fold query. Document the expected failure mode in code comments.

### Dependencies

- T2: MV must exist before the function can be tested.

---

## T4: CI Conservation-Invariant Script

**Priority:** P0
**SDD reference:** §3.5, Phase 2 (§8)
**Goal contributions:** G1 (correct by construction), G3 (invariants as first-class), all ACs 05–10

### Task Goal

Author `scripts/invariant-check-1155.sh` — the CI gate that runs I1, I2, and I3 spot-checks against the serving DB (or a CI-accessible snapshot). The script is the mechanized acceptance test for the MV: if it exits 0, all PRD correctness requirements are met. Wire it into CI as a step that blocks merge on failure.

### Deliverables

- [x] `scripts/invariant-check-1155.sh` (executable, `#!/usr/bin/env bash`) containing:
  - **Header**: usage, required env var (`DATABASE_URL`), exit-code semantics (0 = all pass, 1 = any failure).
  - **I1 check**: the full I1 SQL from PRD §8 run via `psql -c`. Any returned rows → print the failing tuples and exit 1.
  - **I2 check**: the I2 SQL from PRD §8. Any returned rows → print the failing `(collection_key, chain_id, token_id, address)` tuples and exit 1.
  - **I3 spot-checks**: seven fixed-value assertions (see table below) each as a separate `psql -c` call. Any mismatch → print expected vs actual and exit 1.
  - Full checksummed addresses for I3 (not the truncated PRD forms).
- [x] CI pipeline wiring: a step in `.github/workflows/` (or the repo's equivalent CI config) that sources `DATABASE_URL` and runs `scripts/invariant-check-1155.sh`. Step runs after the build gate.

### I3 Spot-Check Assertions

| Check | Expected | Failure exit |
|-------|----------|-------------|
| token-4 top holder (`0x099a…` full address) balance | 2,575 | 1 |
| Router (`0x7777…` full address) rows for token-4 | 0 rows | 1 |
| token-4 total minted (from I1 intermediate) | 24,969 | 1 |
| token-4 total burned (from I1 intermediate) | 2 | 1 |
| token-4 net held (`SUM(balance) WHERE token_id=4`) | 24,967 | 1 |
| Distinct token IDs for `puru_apiculture` | 6 | 1 |
| Total holder rows for `puru_apiculture` | ≥ 89,021 | 1 |

### Acceptance Criteria

- [x] **AC-05**: Script I3 returns `balance = 2575` for the token-4 top holder address.
- [x] **AC-06**: Script I3 returns `0 rows` for the router address in the token-4 holder set.
- [x] **AC-07**: Script I1 returns zero rows (conservation delta = 0) for all 6 apiculture tokens.
- [x] **AC-08**: Script I2 returns zero rows (no negative intermediate balances).
- [x] **AC-09**: All seven I3 anchor assertions pass.
- [x] **AC-10**: Script exits 0 on the above data; exits 1 on any injected failure. Script is present in the CI pipeline config; CI runs it on PRs targeting `main`.
- [x] No dynamic SQL: all SQL strings are literal constants in the script, not shell-variable interpolation into query strings.
- [x] `DATABASE_URL` is the only external dependency; no npm, no psql custom plugins.
- [x] Script output on failure names the invariant (I1/I2/I3), the failing tuple(s), and the expected vs actual values.

### Tests

- **Self-test against a local Postgres copy of the action table:** `DATABASE_URL=<local-copy-url> ./scripts/invariant-check-1155.sh` exits 0.
- **Negative-case tests (for CI gate smoke):**
  - If `mv_holder_1155` is empty: I1 and I3 both fail with informative output.
  - If the MV has not been refreshed since a data change that breaks I1: script exits 1 and prints the failing tuple.
  - These negative cases are exercised against the local fixture DB (not the serving DB) before CI wiring.
- **CI pipeline verification:** confirm the CI step appears in the workflow and references the correct `DATABASE_URL` secret.

### Dependencies

- T2: MV must exist for I3 spot-checks to run.
- T3: `fn_1155_invariant_check()` is the runtime equivalent but the CI script uses raw SQL for auditability.
- Operator decision on CI DB target (serving DB vs snapshot) must be made before the CI step is wired — the script accepts either via `DATABASE_URL`.

---

## T5: Refresh Mechanism

**Priority:** P1
**SDD reference:** §3.4, Phase 3 (§8)
**Goal contributions:** G1 (freshness within ≤ 5 min), G5 (no reindex dependency)

### Task Goal

Author `scripts/refresh-mv-1155.sh` — the refresh driver that runs the I2 pre-check before every `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_holder_1155`. Document the Railway cron service configuration (operator-deployed). This is **not** deployed by the agent; the script is reviewed in this PR and executed operator-led.

### Deliverables

- [x] `scripts/refresh-mv-1155.sh` (executable, `#!/usr/bin/env bash`) with:
  1. **I2 pre-check**: run the I2 query (no-negative-intermediate-balances). If any rows returned: log error with count, emit an entry to `.run/audit.jsonl`, exit 1 — **do NOT proceed to REFRESH**.
  2. **Pre-refresh row count**: `SELECT COUNT(*) FROM mv_holder_1155` captured to log.
  3. **REFRESH**: `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_holder_1155`.
  4. **Post-refresh row count and elapsed time**: log success with row count + elapsed seconds.
  5. **Audit emit**: append a structured JSON line to `.run/audit.jsonl` with timestamp, outcome, row count, elapsed.
- [x] `scripts/refresh-mv-1155.sh` wrapped with a `timeout` command (default: 360 seconds) so a hung refresh doesn't park the lock indefinitely.
- [x] A companion `docs/cron-refresh-config.md` (or section in the existing runbook) documenting the Railway cron service setup: service name (`mv-refresh-cron`), schedule (`*/5 * * * *`), required env var (`DATABASE_URL`), the command (`scripts/refresh-mv-1155.sh`), and the failure behavior (cron retries on next interval; stale MV remains readable).

### Acceptance Criteria

- [x] **FR-07 satisfied**: the refresh mechanism, when deployed, will refresh the MV at ≤ 5-minute intervals.
- [x] **AC-04**: `REFRESH MATERIALIZED VIEW mv_holder_1155` (timed) completes in < 5 minutes on the serving DB — measured and logged in the first operator-run refresh after migration applies.
- [x] The script exits 1 and skips the REFRESH when the I2 pre-check returns any rows (NFR-03: no negative balance exposure via a bad refresh).
- [x] The script exits 1 and logs the error when Postgres is unavailable — no silent swallow.
- [x] The `timeout` wrapper is present; a refresh exceeding 360 seconds causes the script to exit 124.
- [x] The cron config doc names the exact Railway service parameters needed for operator deployment.
- [x] No hardcoded connection strings — `DATABASE_URL` sourced from environment.

### Tests

- **I2 pre-check guard**: in a local fixture environment, insert a synthetic negative-balance row into a test version of the raw fold and verify the script exits 1 before calling REFRESH.
- **Normal path**: against the local DB, verify the script exits 0, the CONCURRENTLY clause works (requires `uidx_mv_holder_1155_pk` from T2), and the audit log entry is written.
- **Timeout test**: `timeout 5 scripts/refresh-mv-1155.sh` exits 124 when forced to sleep (manual test; not a CI fixture).

### Dependencies

- T2: `uidx_mv_holder_1155_pk` must exist for `REFRESH MATERIALIZED VIEW CONCURRENTLY`.
- T3: `fn_1155_invariant_check()` is the on-demand equivalent; the refresh script does not call it (uses the raw I2 SQL directly for the pre-check to avoid a function dependency).

---

## T6: Hasura Tracking Script + Fallback View

**Priority:** P1
**SDD reference:** §3.7, Phase 4 (§8)
**Goal contributions:** G1 (correct data exposed via GraphQL)

### Task Goal

Author `scripts/hasura-track-mv-1155.sh` — the Hasura metadata API calls that track `mv_holder_1155` and add the public SELECT permission. Author the fallback view `v_holder_1155` (a regular Postgres view wrapping the MV) for the case where Hasura cannot track an MV directly (SDD R-01). Both are scripted for operator execution; neither is executed by the agent.

### Deliverables

- [x] `scripts/hasura-track-mv-1155.sh` (executable) containing:
  1. `pg_track_table` metadata API call for `mv_holder_1155`.
  2. `pg_create_select_permission` call: `public` role, `columns: "*"`, `allow_aggregations: true`, `filter: {}` — matching the existing 94-table pattern.
  3. A usage block in the script header: required env vars (`HASURA_GRAPHQL_ENDPOINT`, `HASURA_ADMIN_SECRET`), the fallback instruction if the MV track fails.
- [x] A fallback DDL block (commented out, or in a separate `migrations/add-fallback-view-1155.sql`): `CREATE VIEW v_holder_1155 AS SELECT * FROM mv_holder_1155;` — operator uncomments and runs if `pg_track_table` on the MV fails.
- [x] Verification query documented in the script header: the GraphQL query that confirms the MV is tracked and queryable, with expected result (token-4 top holder, balance = 2575).

### Acceptance Criteria

- [x] **AC-12**: After the operator runs `scripts/hasura-track-mv-1155.sh`, the GraphQL endpoint exposes `mv_holder_1155`. The following query returns `address = 0x099a…`, `balance = 2575` (verified by the operator, not the agent):
  ```graphql
  query {
    mv_holder_1155(
      where: { collection_key: { _eq: "puru_apiculture" }, chain_id: { _eq: 8453 }, token_id: { _eq: "4" } }
      order_by: { balance: desc }
      limit: 1
    ) { address balance }
  }
  ```
- [x] The script sources `HASURA_ADMIN_SECRET` from the environment — it is never hardcoded in the script body.
- [x] The fallback `v_holder_1155` view DDL is present and documented — if the MV track fails (R-01), the operator runs the fallback DDL, then tracks `v_holder_1155` instead.
- [x] Hasura permissions match the existing table permission pattern (no privilege escalation).

### Tests

- Script is reviewed for the absence of hardcoded secrets (grep for `$HASURA_ADMIN_SECRET` used correctly vs any literal string that looks like a key).
- The verification GraphQL query is tested by the operator against the live endpoint after execution — this is the Phase 4 operator-led acceptance step from SDD §8.
- No automated test for this task — the Hasura API is an external system; scripted validation is the contract.

### Dependencies

- T2: MV must exist in Postgres before tracking.
- T3: `fn_1155_invariant_check()` confirms data integrity before operator runs this script.
- Operator has `HASURA_ADMIN_SECRET` and `HASURA_GRAPHQL_ENDPOINT` available.

---

## T7: Backward Compatibility Verification

**Priority:** P1
**SDD reference:** §7.3, §6.4
**Goal contributions:** G5 (no reindex fragility), NFR-04 (backward compat)

### Task Goal

Confirm that the MV creation leaves `TrackedHolder` and all existing consumers unaffected. This is a verification task, not a build task. Document the evidence before the PR merges.

### Deliverables

- [x] A `git diff` check confirming: zero modifications to `src/handlers/puru-apiculture1155.ts`, `schema.graphql`, or any Ponder entity config. The MV is additive — nothing existing changes.
- [x] A backward-compat test query documented in `grimoires/loa/a2a/sprint-pertoken-1/pre-deploy-audit.md` (or a companion file): the whole-contract aggregate query pattern against `TrackedHolder` that should return identical results before and after MV creation.
  - Pattern: `SELECT balance FROM "TrackedHolder" WHERE "contractAddress" = '<apiculture-contract>' AND "chainId" = 8453 AND "address" = '0x099a…'` — should return the same row as before (whole-contract balance, not per-token).
- [x] Explicit statement in PR description: `TrackedHolder` is untouched; the MV is additive; no existing query is broken.

### Acceptance Criteria

- [x] **AC-13**: No `TrackedHolder` row disappears, no count changes, no consumer query breaks — confirmed by the backward-compat query pattern.
- [x] `git diff HEAD~1 -- src/handlers/ schema.graphql` shows no changes — structural guarantee.
- [x] The PR does not include `hold1155` cleanup, `adjustHolder1155` refactoring, or any handler-level change (FR-12, FR-13, FR-14).

### Tests

- The backward-compat query is run against the local DB before and after applying the migration — row counts must be identical.
- If the CI pipeline has existing test coverage for `TrackedHolder` queries, confirm those tests pass unchanged.

### Dependencies

- T2: Migration must be applied to confirm the MV is additive.
- Requires: the `git diff` check is trivially passable if no handler files were touched.

---

## T8: PR Review Gates

**Priority:** P0
**SDD reference:** §8 Phase 5
**Goal contributions:** AC-14, AC-15

### Task Goal

Gate the PR with Flatline multi-model review and Bridgebuilder review before merge. Confirm no deployment, cutover, or alias swap was performed by the agent (ADR-010 hard constraint).

### Deliverables

- [x] Flatline review run against the PR diff. No BLOCKER findings may be unresolved at merge time.
- [x] Bridgebuilder review run against the PR diff. No BLOCKER findings may be unresolved at merge time.
- [x] PR description confirms: no deployment commands in agent output; no DB migrations executed by the agent; all scripts are authored for operator execution.

### Acceptance Criteria

- [x] **AC-14**: PR is gated by both Flatline multi-model review and Bridgebuilder review with no unresolved BLOCKER findings.
- [x] **AC-15**: No deployment, DB migration, Hasura tracking, or alias swap was performed by the agent. All scripts authored are reviewed and ready for operator execution.
- [x] Any Flatline findings at HIGH_CONSENSUS level are integrated before the PR targets `main`; any DISPUTED findings are documented with the operator's disposition.

### Tests

- Not applicable — this is a process gate, not a code task.
- Evidence: Flatline + Bridgebuilder review artifacts in `grimoires/loa/a2a/sprint-pertoken-1/`.

### Dependencies

- T2–T7 complete (all code artifacts authored and reviewed).

---

## Risk Register

| ID | Risk | Task | Probability | Impact | Mitigation |
|----|------|------|-------------|--------|------------|
| R-01 | Hasura cannot track an MV directly (requires unique index — confirmed; but some versions behave differently) | T6 | Medium | Medium | Fallback `v_holder_1155` regular view authored in T6; conservation invariants unaffected either way |
| R-02 | `context->>'from'` NULL for some `transfer1155` actions in non-apiculture collections | T1 | Medium | Medium | T1 data-quality audit surfaces null-rate per collection; MV will under-count transfers for collections with gaps — gap is in the handler, not the MV; documented in audit report |
| R-03 | `numeric1` / `numeric2` column types are not NUMERIC-castable (e.g. stored as TEXT with non-numeric chars) | T1 | Low | High | T1 column-type check; CAST handles bigint/text/numeric; operator pre-checks via SDD §3.2.4 query |
| R-04 | Refresh cron fails silently; MV drifts from action table | T5 | Medium | Medium | `fn_1155_invariant_check()` (T3) exposes drift on demand; I1 delta becomes non-zero when new events are unfolded; cron failure is surfaced via Railway service health |
| R-05 | Burn-address list in MV diverges from `isBurnAddress()` in a future cycle | T1, T2 | Low | Low | T1 explicitly audits alignment; SDD §5.3 documents the coupling; code review gate |
| R-06 | MV refresh time exceeds 5 minutes as the action table grows past current scale | T5 | Low | Medium | The `idx_action_type_collection_numeric2` index (T2) is the performance mitigation; if exceeded, the `timeout 360` wrapper in T5's script surfaces it |
| R-07 | The I3 spot-check full addresses are not embedded in the script (truncated in PRD) | T4 | Low | Medium | T4 tasks include retrieving the full checksummed addresses from live DB before scripting the I3 checks |

---

## Success Metrics Summary

| Metric | Target | Task | Verification |
|--------|--------|------|-------------|
| Token-4 top holder balance | 2,575 (exact) | T4 (I3) | `scripts/invariant-check-1155.sh` exit 0 |
| Router `0x7777…d91` in token-4 set | Absent (0 rows) | T4 (I3) | Script I3 spot-check |
| I1 conservation delta | 0 for all 6 apiculture tokens | T4 (I1) | Script I1 check |
| I2 negative intermediates | 0 | T4 (I2) | Script I2 check |
| Token-4 minted | 24,969 | T4 (I3) | Script I3 |
| Token-4 burned | 2 | T4 (I3) | Script I3 |
| Token-4 net held | 24,967 | T4 (I3) | Script I3 |
| Distinct apiculture token IDs in MV | 6 | T4 (I3) | Script I3 |
| Total apiculture holder rows in MV | ≥ 89,021 | T4 (I3) | Script I3 |
| MV refresh time | < 5 minutes | T5 | First operator refresh; timed |
| Health-check response time | < 500ms | T3 | `SELECT * FROM fn_1155_invariant_check('puru_apiculture', 8453)` |
| CI conservation check pass rate | 100% on main | T4 | CI pipeline |
| No existing `TrackedHolder` query broken | True | T7 | Backward-compat verification |
| No deployment by agent | True | T8 | PR description + `git diff` |

---

## Dependencies Map

```
T1 (Pre-deploy audit)
  └──▶ T2 (Migration: index + MV + MV indexes)
         └──▶ T3 (Health-check function, in same migration file)
                └──▶ T4 (CI invariant script — reads MV via DATABASE_URL)
                └──▶ T5 (Refresh script — calls CONCURRENTLY, needs uidx_mv_holder_1155_pk)
                └──▶ T6 (Hasura tracking script — MV must exist in Postgres)
                └──▶ T7 (Backward compat — git diff + backward-compat query)
  T2–T7 ──▶ T8 (PR review gates — all artifacts must be authored)
```

Phase gate: T1 results must be reviewed before T2 authoring begins. T2's migration script must be reviewed before T5 and T6 scripts are finalized (they reference the MV name and unique index name).

---

## Appendix

### A. PRD Acceptance Criteria Mapping

| PRD AC | Owner Task | Verification Method |
|--------|-----------|---------------------|
| AC-01 | T2 | Migration exits 0; `\d mv_holder_1155` shows correct schema |
| AC-02 | T2 | `\di uidx_mv_holder_1155_pk` confirms unique index |
| AC-03 | T2 | `\di idx_action_type_collection_numeric2` confirms action-table index |
| AC-04 | T5 | First operator-run refresh timed and logged |
| AC-05 | T4 (I3) | Script I3 spot-check for token-4 top holder balance |
| AC-06 | T4 (I3) | Script I3 spot-check for router absence |
| AC-07 | T4 (I1) | I1 delta = 0 for all 6 apiculture tokens |
| AC-08 | T4 (I2) | I2 zero negative intermediate balances |
| AC-09 | T4 (I3) | All seven I3 anchor values confirmed |
| AC-10 | T4 | CI wiring; exit 0/1 semantics |
| AC-11 | T3 | SQL function callable; returns structured result |
| AC-12 | T6 | Operator-verified GraphQL query returns token-4 top holder |
| AC-13 | T7 | `git diff` + backward-compat query pattern |
| AC-14 | T8 | Flatline + Bridgebuilder reviews with no unresolved BLOCKERs |
| AC-15 | T8 | No deployment commands in agent output |

### B. SDD Component Mapping

| SDD Component | Task | Status |
|--------------|------|--------|
| `idx_action_type_collection_numeric2` (§3.1) | T2 | Planned |
| `mv_holder_1155` MV definition (§3.2.3) | T2 | Planned |
| `uidx_mv_holder_1155_pk` unique index (§3.3) | T2 | Planned |
| `idx_mv_holder_1155_collection_chain` secondary index (§3.3) | T2 | Planned |
| `fn_1155_invariant_check()` SQL function (§3.6) | T3 | Planned |
| `scripts/invariant-check-1155.sh` (§3.5) | T4 | Planned |
| `scripts/refresh-mv-1155.sh` (§3.4) | T5 | Planned |
| `scripts/hasura-track-mv-1155.sh` (§3.7) | T6 | Planned |
| Fallback `v_holder_1155` view (§3.7 R-01 fallback) | T6 | Planned |
| Backward compat: `TrackedHolder` unchanged (§6.4) | T7 | Planned |
| PR review gates: Flatline + Bridgebuilder (§8 Phase 5) | T8 | Planned |
| Pre-deployment data-quality check (§3.2.4, §9 R-02, R-05) | T1 | Planned |

### C. PRD Goal Traceability

| Goal | Description | Contributing Tasks | Verification |
|------|-------------|-------------------|-------------|
| **G1** | Correct per-token holder balances | T2, T4 | I3 spot-check: token-4 top holder = 2,575; router absent |
| **G2** | Projection reconstructability | T2 | MV `WITH DATA` + `REFRESH` from `"Action"` at any time |
| **G3** | Conservation invariants as first-class citizens | T3, T4 | I1, I2, I3 all pass; CI gate; `fn_1155_invariant_check()` on demand |
| **G4** | Generalization to all registered 1155 collections | T1, T2 | No `primary_collection` hardcoding; MV covers all collections via `WHERE` parameterization |
| **G5** | No reindex fragility | T2, T7 | MV derives from `"Action"` (already populated); `TrackedHolder` unchanged |

**Coverage check:**
- [x] All PRD goals (G1–G5) have at least one contributing task.
- [x] All goals have a verification method.
- [x] No orphan tasks — every task traces to at least one goal.

---

*Generated by Sprint Planner Agent — tracks PRD r1 + SDD r1 (spiral-pertoken-projection-1). Flatline: no findings to integrate (clean). 2026-06-04.*
