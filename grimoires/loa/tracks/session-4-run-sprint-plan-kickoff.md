---
session: 4
date: 2026-05-22
type: kickoff
status: planned
cycle: sonar-belt-factory
---

# Session 4 — Run sprint-plan (blue-green) to completion → /run-bridge 3 (kickoff)

## Scope
- Execute the reframed sonar-belt-factory cycle: `/run sprint-plan` → `/run-bridge 3`.
- S1 (`promotion-gate.js`) is built+tested (15/15) — needs commit + beads + review/audit.
- S2–S4 are operator-paced Railway infra (`/run sprint-plan` halts at S2 by design).
- 3 S1 ACs are [ACCEPTED-DEFERRED→S2] (live-data: cutoff fetch, raw-L1, content-sample).

## Artifacts
- Build doc (source of truth): `specs/enhance-run-sprint-plan-blue-green.md`
- Plan: `sprint.md` (SR-1..SR-7) · Design: `sdd.md` r7 (§17 R-A..R-G) · `prd.md` r2
- S1: `scripts/promotion-gate.js` + `test/promotion-gate.test.ts` + `a2a/sprint-173/*`

## Prior session (this one)
Reframed the cycle off the S0 spike (12-belt = budget-infeasible) → one consolidated belt + blue-green promotion + stable Caddy alias. Re-planned PRD r2/SDD r7/sprint v2.0 (all Flatline-remediated, $0 CLI-subscription), reviewed on PR #15 (Flatline ×3 + BB ×2 + alias spike). Built S1 gate (15/15 tests). Closed obsolete 12-belt beads.

## Decisions made
- Blue-green promotion behind a proxy alias (Caddy `belt-gateway`, BELT_UPSTREAM swap) — not DNS, single-source.
- FR-6 swap = Option B (Caddy graceful reload, admin localhost-only); Option C (≥2 replicas) is the contingency.
- Two-part fail-closed reconciliation gate + raw-L1 anti-poison + content-sample + fixed-block-cutoff; 3 modes (A/B/C) per Task 1.0.
- score-api owns durable analytics (safety net); indexer owns serving consistency.
- S2+ operator-paced (autonomous run-mode can't do Railway infra).

## First steps for the executing session
1. `! rm` the s0spike scratch (NET-0). 2. Commit S1. 3. Materialize S1–S4 beads. 4. `/run sprint-plan` (halts at S2) → operator-paced S2–S4 → `/run-bridge 3`.
