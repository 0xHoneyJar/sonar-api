# Sprint Plan — sonar-api Consolidated Belt + Blue-Green Promotion (`sonar-belt-factory`)

**Version:** 2.0 (full rewrite to track PRD r2 + SDD r7)
**Date:** 2026-05-22
**Author:** Sprint Planner Agent (SHIP/ARCH · BARTH + protocol/noether, craft lens)
**PRD Reference:** `grimoires/loa/prd.md` r2 (sonar-belt-factory)
**SDD Reference:** `grimoires/loa/sdd.md` r7 (Flatline-remediated · §17 R-A..R-G + IMP-001..009 integrated)
**Cycle:** `sonar-belt-factory` · ledger global sprint range **172–176**

> **Supersedes** sprint.md v1.0 (the RETIRED r1/r6 "12 pure-product belts + BeaconV3 federation + Effect serving" plan). The v1.0 S0 calibration spike (global 172) ran and PROVED the 12-belt approach budget-infeasible ($280–450/mo vs the hard < $100/mo ceiling) — that finding triggered the PRD r2 reframe to **one consolidated belt + blue-green promotion**. S0 is retained as completed; S1–S4 are re-authored to the new SDD §13 sequencing.

---

## Executive Summary

Keep the THJ sovereign indexer as **one consolidated Envio belt** (41 contracts · 93 entities · 6 chains) serving a **stable, additive-only GraphQL API behind a fixed production alias** (the Caddy `belt-gateway`, already live). Ship every change (new source, additive schema field) via **blue-green promotion**: stand up a green deployment with the change, backfill it in the background while blue keeps serving, run a **reconciliation gate**, then **atomically swap the alias** blue→green via `caddy reload` and retire blue after a rollback window. The 8-hour reindex still happens — off the live path, so consumers see **zero downtime**.

The infrastructure is mostly **already live** (the consolidated belt = blue; the Caddy alias; the eRPC L2; the `belt-reinit.md` re-init runbook). This cycle is predominantly **operational discipline + the reconciliation gate** — not greenfield build. The one substantive net-new code artifact is `scripts/promotion-gate.js` (zero-dep, test-first), which carries the §17 remediation requirements (fixed-block-cutoff reconciliation, raw-L1 spot-check, content sample, schema superset-diff, non-skippable `promote` precondition).

**Total Sprints:** 5 (S0 completed + S1–S4 to build)
**Sprint Duration:** S0 = half-day (completed spike); S1 ≈ 2.5 days; S2–S4 ≈ 2 days each
**Sovereignty posture:** OWN indexer/schema/gateway/eRPC; RENT free RPC + Railway; HyperSync = break-glass only.

### PRD Goals (G-N traceability — see Appendix C)

| ID | Goal | KPI gate (PRD §3) |
|----|------|-------------------|
| **G1** | Zero-downtime updates — source/schema change ships via background green + atomic alias swap; never makes the live endpoint stale | A source-add promotion completes with **0 consumer-visible downtime** (no 5xx spike on the stable endpoint) |
| **G2** | Cost ceiling — total indexer infra **< $100/mo** steady-state (the bar to leave Envio's ~$300 hosted) | Measured Railway steady-state < $100/mo (≈ $84/mo single belt per S0); transient 2× only *during* a promotion window |
| **G3** | API serving consistency — one stable GraphQL endpoint behind a fixed alias; no split-brain, no consumer config edits | **0 consumer config changes** across a promotion; reconciliation confirms no entity dropped (AC-R7 footprint preserved) |
| **G4** | Background re-sync + promotion gate — backfill is a background operation on green, gated by reconciliation before any swap | Promotion gate enforced: green ≥ blue on **every** chain AND reconciliation pass before swap; rollback exercised |

> **Goal-ID note:** the PRD labels its goals `G1`–`G4` directly (PRD §3 Primary Goals). This plan uses those IDs verbatim. No auto-assignment required.

---

## Sprint Overview

| Sprint | Global | Theme | Scope | Key Deliverables | Dependencies |
|--------|--------|-------|-------|------------------|--------------|
| **S0** | 172 | Envio multi-deployment calibration spike (FR-0) | SMALL | **COMPLETED** — proved 12-belt infeasible → PRD r2 reframe; alpha.17/`rpc` field; Option-A reserve; cost $84/mo; `belt-reinit.md` | None |
| **S1** | 173 | Stable-alias contract + the reconciliation gate (FR-2, FR-4) | LARGE | `promotion-gate.js` (test-first) with all §17 remediation requirements; alias contract specified + swap smoke | S0 |
| **S2** | 174 | Green-build orchestration + dry-run promotion (FR-3, FR-8) | MEDIUM | Green-build procedure on `belt-reinit.md` + seed-count verify; one end-to-end dry-run promotion (stand up → gate → swap → rollback); G4 backfill wall-time measured | S1 |
| **S3** | 175 | Swap atomicity + rollback + breaking-change path (FR-5, FR-6, FR-7) | MEDIUM | Caddy graceful-reload swap (Option B, localhost-only admin) with off-host-unreachable verification; rollback exercised; expand/contract path documented | S2 |
| **S4** | 176 | Boundary docs + reserve + E2E goal validation (FR-1, FR-9, FR-10) | SMALL | FR-1 one-belt confirmation; score-api boundary doc; FR-10 reserve documented (no code); **E2E validation of G1–G4** | S3 |

---

## Sprint 0 (COMPLETED): Envio Multi-Deployment Calibration Spike

**Global ID:** 172 · **Scope:** SMALL · **Status:** ✅ COMPLETED · **Priority:** P0 (gated all)

### Sprint Goal
Prove Envio multi-deployment mechanics and per-belt cost before committing to any belt-split architecture (FR-0 calibration spike, spike-not-wire / NET-0 LOC doctrine).

### Outcome (closing the loop — this sprint is done)
- ✅ **OQ-1 / version reconcile** — Envio `3.0.0-alpha.17` pinned; data-source field is **`rpc`** (not `rpc_config`). `(S0)` `> grimoires/loa/a2a/sprint-172/s0-multideploy-calibration.md`
- ✅ **R-D / Option-A proof** — per-belt config + physical schema subset codegens + `tsc` exit 0 (held in reserve as FR-10).
- ✅ **Q-a / topology** — Railway: per-belt = indexer+hasura+postgres; shared = gateway+erpc+erpc-pg.
- ◐ **Q-b / cost** — project-aggregate $84.40/mo for 1 belt + shared (89% memory); 12 belts projected $280–450/mo → **budget-infeasible against the < $100/mo ceiling**.
- ✅ **Q-c / D6** — reset semantics closed; `runbooks/belt-reinit.md` authored (KF-013 re-init dance).

### The load-bearing finding
> "This reframes the cycle away from r1's 12 physical belts (which the S0 spike proved cost ~$280–450/mo against a hard < $100/mo ceiling, and which solved the wrong problem)." — `> prd.md:L26`

S0's purpose was served: the per-belt cost finding RETIRED the 12-belt plan and produced the PRD r2 / SDD r7 reframe. No further S0 work; the scratch belt was deleted per the spike-not-wire NET-0 contract. The S1–S4 below are the new plan.

---

## Sprint 1: Stable-Alias Contract + The Reconciliation Gate

**Global ID:** 173 · **Scope:** LARGE (7–10 tasks) · **Priority:** P0
**Duration:** 2.5 days

### Sprint Goal
Author the one substantive net-new artifact — `scripts/promotion-gate.js` — test-first, carrying every §17 remediation requirement, and formally specify + smoke-test the stable alias contract so the swap lever is proven before any green is built.

### Deliverables
- [ ] `scripts/promotion-gate.js` exists (zero-dep, matching `verify-belt-config.js`'s no-dependency invariant) and exits 0 against a **blue-vs-blue self-parity** sanity run.
- [ ] Gate enforces all three checks: block-height parity (Part 1), entity-count reconciliation (Part 2, AC-R7 footprint), and schema-diff superset (FR-7 §9.1).
- [ ] Gate writes its result to `grimoires/loa/a2a/sprint-173/promotion-reconciliation.md` on every run (PASS/FAIL + per-check evidence).
- [ ] The alias contract is documented (§4): public URL, additive-only schema invariant, `BELT_UPSTREAM` as the sole swap lever, proxy-not-DNS rationale.
- [ ] The existing swap smoke (bad upstream → 502, revert → live) is re-run and recorded as the alias baseline `> NOTES.md:265`.

### Acceptance Criteria
- [ ] `node scripts/promotion-gate.js` exits **0** when comparing blue against itself (self-parity must pass — a gate that fails its own identity is broken).
- [ ] Gate **exits non-zero** on each injected failure: short block-height on one chain; an entity count outside tolerance; a green schema missing a blue field (negative test cases — IMP-009).
- [ ] Reconciliation runs at a **fixed block cutoff** per chain `target = min(blue_head, green_head) − safety_margin`, not at wall-clock "now" (R-F: racy comparison closed).
- [ ] Gate includes a **raw-L1 `eth_getLogs` spot-check** (bypassing the eRPC cache) for a sample of (chain, contract, block-range) so a poisoned shared-cache entry can't pass blue=green while both are wrong (R-B).
- [ ] Gate includes a **content sample**: for N sampled entity IDs per high-value entity, field-level payloads are compared blue-vs-green, not just counts (R-E).
- [ ] Tolerance is **exact** on low-cardinality entities (e.g. `MiberaLoan 176`) and an **absolute floor** `max(0.1%, fixed_row_floor)` on high-cardinality (e.g. `Action 2.07M`) — not a bare ±0.5% (R-G); tolerance is configurable with a provisional default + override (IMP-007).
- [ ] Schema-compat diff checks **nullability and enum** dimensions, not just name/type presence (IMP-005).
- [ ] Connection strings (blue + green Postgres / GraphQL) are sourced from env/config, never hardcoded (IMP-001).

### Technical Tasks

<!-- Test-first: write the failing gate test, then the gate. -->

- [ ] Task 1.1: Write the test harness for `promotion-gate.js` first — fixtures for blue-vs-blue (self-parity PASS) and the injected-failure negative cases (short height, count drift, missing field, nullability change). → **[G-4]**
- [ ] Task 1.2: Implement **Part 1 — block-height parity**: query each deployment's `chain_metadata`, assert `green.latest_processed_block ≥ blue` on **every** chain (§6.1, SCALE.md probe). → **[G-4]**
- [ ] Task 1.3: Implement **Part 2 — entity-count reconciliation** over the score-api footprint (12 entities: `MiberaLoan 176` … `Action 2.07M` … `TreasuryActivity 11,819`) with the R-G tolerance model (exact low-cardinality / absolute-floor high-cardinality). → **[G-3, G-4]**
- [ ] Task 1.4: Implement the **fixed-block-cutoff** comparison (`target = min(blue_head, green_head) − safety_margin`) so both belts are queried AT that block, not "now" (R-F). → **[G-4]**
- [ ] Task 1.5: Implement the **schema-diff superset check** — parse blue + green `schema.graphql`, assert green ⊇ blue across name/type **and** nullability/enum (§9.1, IMP-005); non-superset → FAIL. → **[G-3, G-1]**
- [ ] Task 1.6: Implement the **raw-L1 `eth_getLogs` spot-check** (cache-bypass) + the **content sample** (field-level payload compare for N sampled IDs) — the two anti-silent-loss checks (R-B, R-E; extends KF-012 discipline). → **[G-4]**
- [ ] Task 1.7: Wire result emission to `grimoires/loa/a2a/sprint-173/promotion-reconciliation.md`; source all connection strings from env/config (IMP-001); make tolerance configurable with provisional default (IMP-007). → **[G-4]**
- [ ] Task 1.8: Document the alias contract (§4) and re-run + record the swap smoke baseline (`BELT_UPSTREAM` bad → 502, revert → live). → **[G-3]**

### Dependencies
- S0 (complete): Envio version/field, topology, cost model, `belt-reinit.md`.
- The shipped blue belt + live Caddy alias + live eRPC L2 (all already live — read-only for this sprint).

### Security Considerations
- **Trust boundaries:** the gate reads from blue + green Postgres/GraphQL (trusted, operator-owned) and from **raw public L1 RPC** (untrusted external — the raw-L1 spot-check treats getLogs responses as suspect per KF-012; an empty-200 must surface as a gap, not silently pass).
- **External dependencies:** none new — `promotion-gate.js` is zero-dep (no npm install), matching `verify-belt-config.js`. The raw-L1 check uses the same eRPC-bypass RPC endpoints already in config.
- **Sensitive data:** Postgres connection strings sourced from env (IMP-001), never committed. Public read-only on-chain data; no auth surface added.

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Shared eRPC cache makes blue=green both-wrong pass reconciliation (R-B) | Med | High | Raw-L1 `eth_getLogs` spot-check bypasses the cache (Task 1.6); reconciliation is blue-vs-green **plus** green-vs-raw-L1 |
| Counts match but rows are wrong/dup/stale (R-E) | Med | High | Field-level content sample for N sampled IDs (Task 1.6) |
| ±0.5% tolerance hides thousands of high-cardinality rows (R-G) | Med | High | Exact on low-cardinality + absolute floor on high-cardinality (Task 1.3) |
| Racy wall-clock comparison while both belts advance (R-F) | Med | Med | Fixed block cutoff per chain (Task 1.4) |

### Success Metrics
- `promotion-gate.js` self-parity exit 0; all ≥3 negative cases exit non-zero (IMP-009).
- 100% of the 12 score-api footprint entities covered by Part-2 reconciliation.
- Gate run < a few minutes wall-time (operator-runnable, not a CI burden).

---

## Sprint 2: Green-Build Orchestration + Dry-Run Promotion

**Global ID:** 174 · **Scope:** MEDIUM (4–6 tasks) · **Priority:** P0
**Duration:** 2 days

### Sprint Goal
Operationalize standing up green from `belt-reinit.md` with the seed-count verification gate, then exercise the **full blue-green loop end-to-end once** via a dry-run promotion (green = a copy of blue) — proving stand-up → gate → swap → rollback works and capturing the G4 backfill wall-time.

### Deliverables
- [ ] A green-build procedure (extending `belt-reinit.md`) that stands up a separate Railway `belt-indexer'` + `belt-hasura'` + **own Postgres-green**, with the `ENVIO_RESTART=1`-seeds-then-resume dance.
- [ ] The BB-F006 **seed-count verification step** wired into the procedure: assert `SELECT COUNT(*) FROM chain_metadata` == config chain count before removing `ENVIO_RESTART`.
- [ ] One completed **dry-run promotion**: green stands up, `promotion-gate.js` (from S1) PASSES, the alias swaps, and a rollback restores blue.
- [ ] The **G4 one-shot measurement**: full-corpus backfill wall-time recorded as a known number (does not gate downtime).
- [ ] Promotion-window cost quantified (transient 2× vs the 89% steady-state headroom — R5/R-C).

### Acceptance Criteria
- [ ] Green stands up with its **own Postgres**, structurally isolated from blue (separate Railway service) — a green `--restart` provably leaves blue's `chain_metadata`/checkpoints untouched (FR-3 isolation).
- [ ] The seed-count gate **blocks resume** on a short `chain_metadata` count and the procedure documents "re-deploy `ENVIO_RESTART=1` until count matches" (FR-8 retry/escalation; KF-013/R4).
- [ ] The dry-run swap exhibits the FR-6 downtime characteristic decided in S3 (or, if S3's reload isn't built yet, records the current ~seconds Railway-redeploy blip as the baseline to improve in S3).
- [ ] Rollback (`revert BELT_UPSTREAM` → blue) restores service with **0 consumer config changes** and no data loss (blue retained hot **and kept indexing at-head** — FR-5, R-A).
- [ ] Railway plan headroom for the transient 2× is confirmed before the dry-run; a promotion that would exceed plan memory is blocked (R-C).
- [ ] **Sustained-parity**: the gate is re-run after a short interval (not a single snapshot) to confirm green stays caught up, not just momentarily even (IMP-003).

### Technical Tasks
- [ ] Task 2.1: Write the green-build procedure section in `belt-reinit.md` (own service + own Postgres; `ENVIO_RESTART=1` seed → seed-count verify → remove flag → resume background backfill). → **[G-1, G-4]**
- [ ] Task 2.2: Wire the BB-F006 seed-count verify (`COUNT(*) chain_metadata` vs config chain count) as a hard pre-resume step with the retry-until-match escalation (KF-013/R4). → **[G-4]**
- [ ] Task 2.3: Confirm Railway plan headroom for the transient 2×; size green's memory; record the bound on the promotion window (R-C / R5). → **[G-2]**
- [ ] Task 2.4: Execute the **dry-run promotion** end-to-end (green=copy-of-blue → S1 gate PASS → swap → rollback); capture the G4 backfill wall-time + the promotion-window cost. → **[G-1, G-4]**
- [ ] Task 2.5: Run the **sustained-parity** re-check (gate twice across an interval) and record green-stays-caught-up evidence (IMP-003). → **[G-4]**

### Dependencies
- S1: `promotion-gate.js` (the gate the dry-run runs).
- `belt-reinit.md` (KF-013 re-init primitive); the shipped blue belt; eRPC warm cache.

### Security Considerations
- **Trust boundaries:** green is operator-stood-up infra (trusted); the seed-count gate guards against the silent-skip class (KF-013) where Envio's table-existence `isInitialized()` resumes a half-seeded green.
- **External dependencies:** none new — green reuses the same belt Docker image + shared eRPC; only Railway service/Postgres provisioning.
- **Sensitive data:** green's Postgres credentials via Railway env (per-belt, not shared with blue); eRPC over the private Railway network.

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Green seeds incompletely (JS crashes mid-seed → short `chain_metadata`) (R4/KF-013) | Med | High | Seed-count verify blocks resume; re-deploy `ENVIO_RESTART=1` until count matches (Task 2.2) |
| Promotion-window 2× exceeds the 89%-headroom Railway plan (R-C/R5) | Med | Med | Confirm plan headroom + bound the window before the dry-run (Task 2.3) |
| Green never converges (a chain backfills slower than block production) (R6) | Low | High | eRPC warm cache on Bera/Base/OP/ETH; G4 wall-time measures it once; escalate RPC tier if a chain can't keep up |

### Success Metrics
- Dry-run promotion completes the full loop (stand-up → gate PASS → swap → rollback) in one session.
- G4 backfill wall-time captured as a single concrete number.
- Promotion-window cost quantified (2× transient, bounded).

---

## Sprint 3: Swap Atomicity + Rollback + Breaking-Change Path

**Global ID:** 175 · **Scope:** MEDIUM (4–6 tasks) · **Priority:** P1
**Duration:** 2 days

### Sprint Goal
Realize the FR-6 swap-atomicity decision (Option B — Caddy graceful reload, admin API localhost-only) with an off-host-unreachable verification, exercise the rollback procedure for real, and document the expand/contract path for non-additive (breaking) schema changes.

### Deliverables
- [ ] Caddy `belt-gateway` rebuilt with the **admin API enabled, bound localhost-only** (`admin localhost:2019` or unix socket — NEVER exposed); the promotion swap step becomes a `caddy reload` (or admin-API config POST) instead of an env-var-triggered Railway redeploy.
- [ ] A **verification** that the admin endpoint is **unreachable from outside** the gateway container (the binding security requirement from §7.3/§7.4 pushback + IMP-014).
- [ ] A **zero-downtime swap probe**: poll the alias during a `caddy reload` swap and assert **no 5xx spike** (G1) — or, on the documented contingency, fall back to Option C (≥2 replicas).
- [ ] Rollback procedure documented + exercised against the live alias (revert `BELT_UPSTREAM`→blue; blue retained hot and at-head per R-A).
- [ ] The **expand/contract (parallel-change) path** for breaking schema changes documented (§9.2): EXPAND (add new field, keep old) → promote → consumer migration → CONTRACT (remove old) → promote.

### Acceptance Criteria
- [ ] The Caddy admin API is reachable from inside the container but **NOT** reachable off-host (verified — a curl from outside the container to the admin port fails/times out).
- [ ] A swap via `caddy reload` produces **no 5xx** on the alias during the swap window (zero-downtime swap probe PASS) — directly satisfies G1.
- [ ] If localhost-only admin binding proves infeasible on Railway, the documented contingency (Option C: ≥2 gateway replicas, rolling redeploy) is taken — **no re-decision needed** (§7.4).
- [ ] Rollback restores blue with 0 consumer config changes, lossless, because blue kept indexing at-head through the verification window (R-A: blue NOT paused at swap).
- [ ] The swap is performed ONLY through a `promote` flow that runs `promotion-gate.js` as a **non-skippable precondition** (exit 0 required before it touches the alias); bare `BELT_UPSTREAM` edits are not the documented path (R-D / OQ-4 → command).
- [ ] The breaking-change path is documented such that the alias **never** serves a schema missing a field a live consumer reads (the additive invariant holds across both expand and contract promotions).

### Technical Tasks
- [ ] Task 3.1: Rebuild `Dockerfile.gateway` / `Caddyfile` with `admin` bound localhost-only (replacing `admin off`); add the `caddy reload`-based swap step to the promotion procedure (FR-6 Option B, §7.4). → **[G-1]**
- [ ] Task 3.2: Verify the admin endpoint is unreachable off-host (off-container curl to the admin port fails); record evidence (R9/IMP-014 closure). → **[G-1]**
- [ ] Task 3.3: Run the zero-downtime swap probe (poll alias through a `caddy reload`, assert no 5xx); if infeasible, switch to Option C and document (§7.4 contingency). → **[G-1]**
- [ ] Task 3.4: Wrap the swap in a `promote` flow with `promotion-gate.js` as a non-skippable precondition (R-D); document + exercise the rollback procedure (revert `BELT_UPSTREAM`→blue within the window; blue at-head per R-A); record the rollback-triggers list (§8). → **[G-1, G-4]**
- [ ] Task 3.5: Document the expand/contract breaking-change path (§9.2) with the schema-diff gate as the enforcement that a non-additive green fails before the swap. → **[G-3]**

### Dependencies
- S2: a working green-build + dry-run loop (the swap mechanism is exercised in the dry-run).
- S1: `promotion-gate.js` (the precondition the `promote` flow runs).
- The live Caddy gateway (rebuilt this sprint).

### Security Considerations
- **Trust boundaries:** enabling the Caddy admin API **widens the gateway attack surface** (R9). The hard constraint: admin bound localhost-only, never exposed; Task 3.2 is the explicit verification that the surface is closed off-host.
- **External dependencies:** the gateway rebuild uses the same `caddy:2` + `caddy-ratelimit` (xcaddy) stack — no new dependency; only the `admin` directive changes.
- **Sensitive data:** the admin API can rewrite the gateway config — off-host reachability would be a config-injection vector. localhost-only binding + the off-host-unreachable verification (Task 3.2) is the mitigation.

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Enabling Caddy admin widens attack surface (R9/IMP-014) | Low | Med | Bind localhost-only; verify off-host-unreachable (Task 3.2); contingency Option C avoids the admin surface entirely |
| `caddy reload` localhost binding infeasible on Railway | Low | Med | Documented contingency: Option C (≥2 replicas, rolling) — no re-decision (§7.4) |
| Breaking change behind the additive-only alias breaks a consumer at swap (R2) | Med | High | Expand/contract path (Task 3.5); schema-diff superset check FAILS a non-additive green at the gate |
| Operator swaps `BELT_UPSTREAM` directly, bypassing the gate (R-D) | Med | High | `promote` flow makes the gate a non-skippable precondition (Task 3.4); bare edits not the documented path |

### Success Metrics
- Swap produces 0 5xx (G1 zero-downtime swap proven) — or Option-C contingency taken with evidence.
- Admin endpoint verified unreachable off-host.
- Rollback exercised against the live alias; expand/contract path documented; `promote` flow gates the swap.

---

## Sprint 4 (Final): Boundary Docs + Reserve + End-to-End Goal Validation

**Global ID:** 176 · **Scope:** SMALL (1–3 tasks + E2E) · **Priority:** P2
**Duration:** 1.5 days

### Sprint Goal
Confirm FR-1 (one belt — mostly already true), write the score-api boundary doc (FR-9) and the FR-10 reserve documentation (design only, no code), and validate end-to-end that all PRD goals G1–G4 are achieved.

### Deliverables
- [ ] FR-1 confirmation note: the indexer is ONE consolidated belt; handlers compose intra-belt (`Action` via 21 handlers, etc.); no cross-belt federation exists.
- [ ] The score-api boundary doc (FR-9, §10.1): indexer = hot serving tier (must not be lossy); score-api = warm/cold analytics safety net (cron → ClickHouse/Dune + fallbacks). The reconciliation gate is what keeps the indexer non-lossy.
- [ ] The FR-10 reserve documented (the S0-proven on-demand split capability — Option A) as a dormant, documented-not-wired path; BeaconV3 declaration noted as the same reserve class.
- [ ] **E2E goal validation** (Task 4.E2E below) — all of G1–G4 validated with documented evidence.

### Acceptance Criteria
- [ ] Boundary doc clearly states "score-api fallback is a safety net for a brief swap blip, NOT a license for the indexer to be lossy" (PR#15 SKP-001 corrected emphasis).
- [ ] FR-10 reserve is documented with the S0 codegen+tsc evidence ref; explicitly marked **not built this cycle**.
- [ ] Every PRD goal (G1–G4) has a documented validation result; no goal marked "not achieved" without explicit justification.

### Task 4.E2E: End-to-End Goal Validation

**Priority:** P0 (Must Complete)
**Goal Contribution:** All goals (G1, G2, G3, G4)

**Description:** Validate that all PRD launch criteria (`> prd.md:L173-180`) are achieved through the complete blue-green promotion implementation.

**Validation Steps:**

| Goal ID | Goal | Validation Action | Expected Result |
|---------|------|-------------------|-----------------|
| **G1** | Zero-downtime updates | Run a real source-add promotion (or replay the S2/S3 dry-run + reload swap); poll the alias through the swap | 0 consumer-visible downtime — no 5xx spike on the stable endpoint (Option B reload) |
| **G2** | Cost ceiling < $100/mo | Read Railway steady-state cost; confirm single-belt ≈ $84/mo; confirm promotion-window 2× is transient + bounded | Steady-state < $100/mo; transient cost quantified (S2 Task 2.3) |
| **G3** | API serving consistency | Confirm 0 consumer config changes across the promotion; run `promotion-gate.js` Part-2 reconciliation | 0 config changes; AC-R7 footprint reconciliation PASS (no dropped entity) |
| **G4** | Background re-sync + promotion gate | Confirm `promotion-gate.js` exit 0 required pre-swap (block ≥ blue every chain + reconciliation); confirm rollback exercised | Gate enforced as the swap precondition (R-D `promote` flow); rollback (revert `BELT_UPSTREAM`) exercised |

**Acceptance Criteria:**
- [ ] Each goal validated with documented evidence written to `grimoires/loa/a2a/sprint-176/e2e-validation.md`.
- [ ] The swap-atomicity decision (FR-6 Option B) is recorded with the measured swap downtime characteristic.
- [ ] The breaking (non-additive) schema change path is documented (expand/contract).
- [ ] No goal marked "not achieved" without explicit justification.

### Technical Tasks
- [ ] Task 4.1: Write the FR-1 one-belt confirmation note + the FR-9 score-api boundary doc (§10.1). → **[G-3]**
- [ ] Task 4.2: Document the FR-10 on-demand-split reserve (Option A, with S0 evidence) + the BeaconV3 reserve note — design only, no code (§10.2). → **[G-2]**
- [ ] Task 4.E2E: Execute the end-to-end goal validation (table above); write results to `grimoires/loa/a2a/sprint-176/e2e-validation.md`. → **[G-1, G-2, G-3, G-4]**

### Dependencies
- S1 (gate), S2 (dry-run + green-build), S3 (swap atomicity + rollback) — E2E validates the whole stack.

### Security Considerations
- **Trust boundaries:** documentation sprint — no new trust surface. The E2E validation re-confirms the S3 admin-API-off-host-unreachable property still holds.
- **External dependencies:** none.
- **Sensitive data:** none added; boundary doc references the existing score-api lambda split.

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Re-scoping regresses the score-api#151 footprint (R7) | Med | High | E2E G3 = AC-R7 reconciliation; the shipped belt stays SOLE source until a green verifiably reconciles (score-api#151 repoint deferred) |
| A goal can't be validated end-to-end (e.g. no real promotion run yet) | Low | Med | Replay the S2/S3 dry-run as the G1/G4 evidence; mark "validated via dry-run" explicitly |

### Success Metrics
- All 4 PRD goals validated with evidence in `e2e-validation.md`.
- Boundary + reserve docs complete.

---

## Risk Register

| ID | Risk | Sprint | Probability | Impact | Mitigation | Source |
|----|------|--------|-------------|--------|------------|--------|
| R1 | Swap not truly atomic (Railway redeploy blip) | S2, S3 | Med | Med | FR-6 Option B `caddy reload` (S3); measure 5xx during dry-run (S2) | prd R1 |
| R2 | Breaking schema change behind additive-only alias | S3 | Med | High | Expand/contract path + schema-diff superset gate fails non-additive green | prd R2 |
| R3 | Promotion on block-height alone passes a green with dropped entities | S1 | Med | High | Two-part gate (entity-count + schema-diff + content sample), not height alone | prd R3 / SKP-002 |
| R4 | Green build fails to seed all chains (KF-013) → silent-skip | S2 | Med | High | Seed-count verify before resume; retry `ENVIO_RESTART=1` until match | KF-013 |
| R5 | Promotion-window 2× cost vs 89% memory headroom | S2 | Med | Med | Confirm plan headroom; bound window; batch changes into one green | prd R5 / R-C |
| R6 | Green never converges (chain backfill slower than block prod) | S2 | Low | High | Warm eRPC cache; G4 wall-time once; escalate RPC tier | prd R6 |
| R7 | Re-scoping regresses score-api#151 footprint | S1, S4 | Med | High | Reconciliation = AC-R7; shipped belt SOLE source until green reconciles | prd R7 |
| R8 | KF-012 op-stack getLogs-liar on a new source's chain | S1 | Med | High | Per-chain getLogs verification + raw-L1 spot-check (R-B); gate catches gap | KF-012 |
| R9 | Caddy admin API widens gateway attack surface | S3 | Low | Med | Bind localhost-only; verify off-host-unreachable; contingency Option C | sdd §7 |
| R10 | Envio codegen treats superset schema as additive (unconfirmed) | S2 | Low | High | Confirm on the first real promotion (OQ-3); S0 proved subset codegens cleanly | sdd §3.3 |
| R-B | Shared eRPC cache → blue=green both-wrong passes reconciliation | S1 | Med | High | Raw-L1 `eth_getLogs` spot-check bypasses cache | sdd §17 R-B |
| R-E | Counts match but rows wrong/dup/stale | S1 | Med | High | Field-level content sample for N sampled IDs | sdd §17 R-E |
| R-F | Racy comparison while both belts advance | S1 | Med | Med | Fixed block cutoff per chain | sdd §17 R-F |
| R-D | Bypassable gate (operator swaps directly) | S3 | Med | High | `promote` flow makes the gate a non-skippable precondition | sdd §17 R-D |

---

## Success Metrics Summary

| Metric | Target | Measurement Method | Sprint |
|--------|--------|--------------------|--------|
| Gate self-parity | exit 0 (blue-vs-blue) | `node scripts/promotion-gate.js` | S1 |
| Gate negative cases | exit non-zero on ≥3 injected failures | gate test harness (IMP-009) | S1 |
| Footprint coverage | 12/12 score-api entities reconciled | Part-2 reconciliation entity list | S1 |
| Green isolation | blue `chain_metadata` untouched by green `--restart` | dry-run promotion | S2 |
| G4 backfill wall-time | one concrete number captured | dry-run promotion measurement | S2 |
| Steady-state cost | < $100/mo (≈ $84/mo single belt) | Railway cost reading | S2, S4 |
| Zero-downtime swap | 0 5xx on the alias during a `caddy reload` swap | swap probe | S3 |
| Admin endpoint security | unreachable off-host | off-container curl verification | S3 |
| Gate non-skippable | swap only via `promote` flow (gate precondition) | promote-flow review | S3 |
| All PRD goals | G1–G4 validated with evidence | `e2e-validation.md` | S4 |

---

## Dependencies Map

```
S0 (172, DONE) ──▶ S1 (173) ──────▶ S2 (174) ──────▶ S3 (175) ──────▶ S4 (176, E2E)
  spike →            the gate          green-build       swap atomicity     boundary + reserve
  reframe            (net-new code)    + dry-run loop    + rollback + B/C    + validate G1–G4
                     FR-2, FR-4        FR-3, FR-8        FR-5, FR-6, FR-7    FR-1, FR-9, FR-10
```

---

## Appendix

### A. PRD Feature Mapping

| PRD Feature (FR-X) | Priority | Sprint | Status |
|--------------------|----------|--------|--------|
| FR-1 — Consolidated belt | P2 | S4 (confirm) | Planned (mostly already true) |
| FR-2 — Stable alias (specify contract) | P0 | S1 | Planned |
| FR-3 — Blue-green promotion | P0 | S2 | Planned |
| FR-4 — Promotion gate (reconciliation) | P0 | S1 | Planned |
| FR-5 — Rollback | P0 | S3 | Planned |
| FR-6 — Swap atomicity | P1 | S3 | Planned |
| FR-7 — Additive-only + breaking-change path | P1 | S1 (diff) + S3 (path) | Planned |
| FR-8 — Green-build orchestration | P1 | S2 | Planned |
| FR-9 — score-api boundary | P2 | S4 | Planned |
| FR-10 — On-demand split (reserve) | P2 | S4 (doc only) | Planned (no code) |

### B. SDD Component Mapping

| SDD Component / §17 finding | Sprint | Status |
|----------------------------|--------|--------|
| `promotion-gate.js` (§6.2) | S1 | Planned |
| Stable alias contract (§4) | S1 | Planned |
| R-B raw-L1 spot-check (§17) | S1 | Planned |
| R-E content sample (§17) | S1 | Planned |
| R-F fixed-block cutoff (§17) | S1 | Planned |
| R-G tolerance model (§17) | S1 | Planned |
| IMP-001/005/007/009 (gate impl reqs) | S1 | Planned |
| Green-build procedure + seed-count gate (§5.2) | S2 | Planned |
| R-A blue-keeps-indexing rollback (§17/§8) | S2, S3 | Planned |
| R-C plan-headroom for 2× (§17/§5.4) | S2 | Planned |
| IMP-003 sustained-parity (§17) | S2 | Planned |
| Caddy graceful reload + localhost admin (§7.4) | S3 | Planned |
| R-D non-skippable `promote` precondition (§17) | S3 | Planned |
| Expand/contract breaking-change path (§9.2) | S3 | Planned |
| score-api boundary + FR-10 reserve (§10) | S4 | Planned |

### C. PRD Goal Mapping

| Goal ID | Goal Description | Contributing Tasks | Validation Task |
|---------|------------------|--------------------|-----------------|
| **G1** | Zero-downtime updates (blue-green + atomic swap) | S1: 1.5 · S2: 2.1, 2.4 · S3: 3.1, 3.2, 3.3, 3.4 | S4: Task 4.E2E |
| **G2** | Cost ceiling < $100/mo | S2: 2.3 · S4: 4.2 | S4: Task 4.E2E |
| **G3** | API serving consistency (stable alias, no split-brain) | S1: 1.3, 1.5, 1.8 · S3: 3.5 · S4: 4.1 | S4: Task 4.E2E |
| **G4** | Background re-sync + promotion gate | S1: 1.1, 1.2, 1.3, 1.4, 1.6, 1.7 · S2: 2.1, 2.2, 2.4, 2.5 · S3: 3.4 | S4: Task 4.E2E |

**Goal Coverage Check:**
- [x] All PRD goals (G1–G4) have at least one contributing task.
- [x] All goals have a validation task in the final sprint (S4 Task 4.E2E).
- [x] No orphan tasks (every task annotated → **[G-N]**).

**Per-Sprint Goal Contribution:**
- S0 (done): foundation/reframe — informs G2 (cost), no live goal contribution.
- S1: G4 (gate core), G3 (alias contract + schema diff), G1 (schema superset).
- S2: G1 (green build + dry-run), G4 (seed-count + sustained-parity), G2 (plan headroom).
- S3: G1 (zero-downtime swap), G3 (breaking-change path), G4 (rollback + non-skippable gate).
- S4: E2E validation of all goals G1–G4.

---

## Flatline Remediation (sprint-phase — 3-model, CLI subscription $0, full confidence)

Integrated from the sprint-plan adversarial review (`grimoires/loa/a2a/flatline/sprint-review.json`). These are sprint-level gaps the SDD §17 didn't cover:

- **SR-1 (SKP-001/003 CRITICAL — gates S1; NEW Task 1.0).** Tasks 1.3/1.4 assume at-block ("as of block N") querying works, but Hasura/Envio serves **current** state — fine for append-only event entities that carry a `block_number` (filter + count), **not** for mutable aggregates (`PaddleSupplier`, `*Stats`, overwritten in place). **Add Task 1.0 (BEFORE 1.3/1.4): reconciliation-feasibility spike** — for each of the 12 AC-R7 entities, confirm whether at-block querying is possible (has a block column) and **classify** it: (a) append-only → at-block count at the fixed cutoff; (b) mutable aggregate → reconcile at a **settled** block below the reorg threshold via event-derived recompute OR current-state compare once both belts pass the cutoff. If a class supports neither, the gate documents the deterministic alternative. **Tasks 1.3/1.4 implement per the 1.0 classification; do not assume uniform at-block querying.**
- **SR-2 (SKP-001 CRITICAL — S2).** Green's transient 2× backfill vs Railway memory is a **hard provisioning pre-req**, not just "confirm headroom": green runs in a strictly isolated Railway environment OR a temporary plan-ceiling upgrade is verified **before** green backfill starts; a promotion that would exceed plan memory is **blocked**. (Add to S2 green-build acceptance.)
- **SR-3 (SKP-002/001 HIGH — S3).** The `promote` flow must be a **named, enforced artifact**: `scripts/promote.sh` that (1) runs `node scripts/promotion-gate.js`, (2) fails closed on non-zero, (3) is the **only** path that writes `BELT_UPSTREAM` / triggers the Caddy reload. Restrict manual write paths (gateway config in a controlled script, not ad-hoc `railway variables` edits) so the gate is non-bypassable in mechanism, not just by documentation (closes R-D properly).
- **SR-4 (SKP-002 HIGH — S1 Task 1.6).** The raw-L1 `eth_getLogs` spot-check will hit **free-RPC rate limits**: add exponential backoff + jitter, and use a **dedicated low-tier RPC key** for the gate (not the shared free pool / not the eRPC cache it's bypassing).
- **SR-5 (SKP-003 HIGH — S1 Task 1.6).** The content sample targets **deterministic "golden" entity IDs** (e.g. a known genesis/protocol tx per entity class), not random sampling — so a semantic mutation in a fixed, high-signal record is reliably caught.
- **SR-6 (SKP-002 HIGH — S3 §7.4).** Caddy admin hardening beyond localhost TCP: prefer a **unix socket with filesystem perms**, explicitly disable network exposure at the service level, and audit config reloads. (Strengthens the OQ-1 localhost-only constraint.)
- **SR-7 (high-consensus — S1/S2).** Cross-cutting: (a) **fail-closed** gate semantics — any check error/unknown → FAIL, never PASS (IMP-004); (b) explicit **rollback-window duration** before blue is retired (IMP-001); (c) enumerate the **full 12-entity AC-R7 footprint list** in the plan for auditable 12/12 coverage (IMP-009); (d) an explicit **blue-keeps-indexing verification step** in S2 (IMP-008, confirms R-A); (e) a **mechanical zero-dep check** for `promotion-gate.js` (IMP-010); (f) gate **execution env + required env vars** documented (IMP-005).

**Disputed (operator's call, not auto-integrated):** IMP-011 (dry-run green-copy mechanism — what the dry-run actually proves), IMP-012 (re-verify Caddy exposure after later deploys — config-drift guard), IMP-013 (backfill wall-time escalation threshold). Left as S2/S4 judgment calls.

**Status: sprint plan Flatline-remediated (SR-1..SR-7).**

---

*Generated by Sprint Planner Agent — tracks PRD r2 + SDD r7. Supersedes sprint.md v1.0 (RETIRED 12-belt plan). Flatline-remediated 2026-05-22 (SR-1..SR-7).*
