# Session 4 — Run sprint-plan (blue-green) to completion → /run-bridge 3

> sonar-belt-factory is fully planned + thrice-reviewed. This session EXECUTES it. The cycle was reframed (this is NOT the 12-belt federation) to **one consolidated belt + blue-green promotion + a stable Caddy alias**. Mission: `/run sprint-plan` to completion, then `/run-bridge 3`.

## ⚠️ READ FIRST — the scoping reality (or you'll burn the session)

`/run sprint-plan` runs the autonomous loop (implement→review→audit→commit→PR) over S1–S4. But **only S1 is autonomous-viable**:

| Sprint | Nature | Autonomous? |
|---|---|---|
| **S1** | `promotion-gate.js` — code, test-first, zero-dep, local | ✅ yes (already BUILT this session — see First Steps) |
| **S2** | green build: NEW Railway service + Postgres, `ENVIO_RESTART` seed-then-resume, OOM plan-ceiling | ❌ real infra + $ — **operator-paced** |
| **S3** | Caddy admin localhost-only + `promote.sh` + a live dry-run promotion | ❌ real infra — **operator-paced** |
| **S4** | boundary docs + E2E goal validation against deployed infra | ❌ needs S2/S3 live |

**`/run sprint-plan` WILL HALT at S2** (autonomous run-mode is git-scoped: it writes code/commits/PRs — it cannot provision Railway, spend money, enable Caddy admin, or run a live promotion). At the S2 halt, **switch to operator-paced**: the operator drives the Railway infra (using `grimoires/loa/runbooks/belt-reinit.md` for the green build), the agent assists. Do NOT let autonomous mode try to deploy infra.

## Context

- **Repo:** `0xHoneyJar/sonar-api`, branch `cycle/sonar-belt-factory`. (`~/bonfire/freeside-sonar` is a **symlink** to this repo — one physical dir, no split-brain.) Use `gh -R 0xHoneyJar/sonar-api` (the `upstream` remote is `moose-code/thj` and gh misresolves to it).
- **The reframe (why):** S0 spike proved 12 physical belts = ~$280–450/mo vs the hard **<$100/mo** ceiling. Real problem (per SCALE.md D4) = the 8-hour full-reindex on any source-add, and the *downtime* it causes — not isolation. Fix = one belt + blue-green promotion (green builds in background, atomic alias swap, zero consumer downtime). score-api owns durable analytics (safety net); the indexer owns serving consistency.
- **Reviewed:** PRD r2 + SDD r7 (§17 R-A..R-G) + sprint v2.0 (SR-1..SR-7) — all Flatline-remediated on the CLI subscription at **$0 metered**. Full trail on **PR #15**.

## Load Order
1. `grimoires/loa/sprint.md` — the S1–S4 plan + SR-1..SR-7 remediation (the spine).
2. `grimoires/loa/sdd.md` r7 — §4 alias · §5 promotion · §6 reconciliation gate · §7 swap (Option B) · §8 rollback · §17 R-A..R-G.
3. `grimoires/loa/prd.md` r2 — goals G1–G4, FR-1..FR-10.
4. `grimoires/loa/a2a/sprint-173/reconciliation-feasibility.md` — Task 1.0 (SR-1): the 3 reconciliation MODES (A at-block / B Action timestamp-proxy / C converged-exact).
5. `grimoires/loa/a2a/sprint-173/reviewer.md` — S1 impl report + AC Verification (5 Met · 3 deferred-to-S2).
6. `grimoires/loa/runbooks/belt-reinit.md` — KF-013 green-build dance (S2).
7. `grimoires/loa/known-failures.md` — KF-012 (getLogs-liar), KF-013 (re-init), KF-014 (BB enrichment on headless).
8. **Context intake first** (repo CLAUDE.md): read `known-failures.md` before triaging anything.

## First Steps (housekeeping — do before /run)
1. **Clean scratch (NET-0):** `! rm -f config.s0spike.yaml schema.s0spike.graphql tsconfig.s0spike.json && rm -rf ./src/belts/s0spike/`
2. **Commit S1** (built+tested this session, currently untracked): `scripts/promotion-gate.js` + `test/promotion-gate.test.ts` + `grimoires/loa/a2a/sprint-173/*` — `feat(sprint-1): promotion-gate.js + 3-mode reconciliation (S1)`.
3. **Materialize beads** for S1–S4 (the new plan was never put in beads; old 12-belt tasks are closed). Mark S1 tasks done (built).
4. Verify S1: `npx vitest run test/promotion-gate.test.ts` → expect **15 passed**.

## What to run (in order)
1. **S1** — already built. Run only its review+audit: `/run sprint-1` (it'll see the code + 15 tests; the 3 live-data ACs are [ACCEPTED-DEFERRED→S2] per NOTES.md Decision Log — don't re-litigate). OR skip to S2 if you accept S1 as-built.
2. **S2–S4** — `/run sprint-plan --from 2` will HALT at S2's infra. **Switch to operator-paced:** operator stands up green (belt-reinit.md), wires Caddy admin (localhost-only, Option B), runs the live `promotion-gate.js` (its `makeFetchSnapshot` live wiring lands here — the 3 deferred ACs get exercised), does the dry-run promotion + rollback test, then the alias swap.
3. **`/run-bridge 3`** — at the very end, 3 Bridgebuilder iterations over the shipped diff. Runs on the CLI subscription ($0). Expect **KF-014**: BB Pass-2 enrichment fails on `claude-headless` — accept the Pass-1 convergence findings (don't retry for enrichment).

## Guardrails (the gate must honor — already in the code/SDD)
- Gate is **fail-closed** (missing count/chain → FAIL). Two-part + content-sample + raw-L1 (anti shared-cache-poison, R-B). Reconcile at a **fixed block cutoff** (R-F), tolerance exact-low-card / absolute-floor-high-card (R-G).
- **Additive-only schema** behind the alias; breaking changes use expand/contract (SDD §9.2).
- Blue **keeps indexing** post-swap (lossless rollback, R-A). Green = separate service+Postgres (DB isolation, free).
- `promote.sh` is the **only** swap path (gate = non-skippable precondition, SR-3/R-D).

## What NOT to do
- Do NOT let autonomous mode provision Railway / deploy / enable Caddy admin / run a live promotion — those are operator-driven (S2+).
- Do NOT retry KF-012/013/014 dead-ends (read known-failures.md). Do NOT retry `ENVIO_PG_SSL_MODE=false` (KF-013 misdiagnosis).
- Do NOT reintroduce the 12-belt federation (retired). Do NOT add a query-time federation gateway or sibling belts.

## Verify (cycle done when)
- G1: a source-add promotion completes with **0 consumer-visible downtime** (alias swap, no 5xx).
- G2: measured Railway steady-state **<$100/mo**.
- G3: 0 consumer config changes across a promotion; reconciliation = no dropped entity (AC-R7).
- G4: promotion gate enforced (green ≥ blue every chain + reconciliation) before swap; rollback exercised.
- `/run-bridge 3` complete; findings triaged.

## Persona
SHIP/ARCH — BARTH (the-arcade) + protocol/noether, craft lens. Operator-paced from S2 on (kaironic: pair at infra branches).

## Key References
| Topic | Path |
|---|---|
| Plan / SRs | `grimoires/loa/sprint.md` |
| Design / §17 | `grimoires/loa/sdd.md` |
| Goals / FRs | `grimoires/loa/prd.md` |
| Reconciliation modes | `grimoires/loa/a2a/sprint-173/reconciliation-feasibility.md` |
| Gate code | `scripts/promotion-gate.js` + `test/promotion-gate.test.ts` |
| Green-build runbook | `grimoires/loa/runbooks/belt-reinit.md` |
| Alias contract | `grimoires/loa/a2a/sprint-173/alias-contract.md` |
| Review trail | PR #15 (`gh pr view 15 -R 0xHoneyJar/sonar-api`) |
| Known failures | `grimoires/loa/known-failures.md` (KF-012/013/014) |
