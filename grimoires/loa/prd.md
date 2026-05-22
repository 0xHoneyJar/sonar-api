# Product Requirements Document — sonar-api Consolidated Belt + Blue-Green Promotion

> **Cycle**: `sonar-belt-factory` · **Revision**: r2 (reframed 2026-05-22) · **Persona**: SHIP/ARCH (BARTH + protocol/noether)
> **Supersedes**: r1 "12 pure-product belts + BeaconV3 federation" — RETIRED at the S0 calibration spike (budget-infeasible + wrong axis; see `grimoires/loa/a2a/sprint-172/s0-multideploy-calibration.md`).
> **Builds on**: `grimoires/loa/context/arch-brief-belt-federation.md` r2 (reviewed twice — Flatline + Bridgebuilder, PR #15) · `SCALE.md` Guardrail 1 (blue-green) + Guardrail 5 (stable alias) + D4.
> **Grounding legend**: `[CODE:file]` = codebase reality · `> file:line` = doc quote · `(S0)` = S0 spike finding · `(PR#15)` = multi-model review finding · `(Direction 2026-05-22)` = operator decision this session.

## Table of Contents
1. Executive Summary
2. Problem Statement
3. Goals & Success Metrics
4. User Personas & Use Cases
5. Functional Requirements
6. Non-Functional Requirements
7. Technical Considerations
8. Scope & Prioritization
9. Success Criteria
10. Risks & Dependencies

---

## Executive Summary

Keep the THJ sovereign indexer as **one consolidated Envio belt** (full Mibera-ecosystem footprint, 6 chains) serving a **stable, additive-only GraphQL API behind a fixed production alias**. Ship every change (new source, schema addition) via **blue-green promotion**: stand up a green deployment with the change, backfill it in the background while blue keeps serving, run a reconciliation gate, then **atomically swap the alias** blue→green and retire blue. The 8-hour reindex still happens — but off the live path, so consumers see **zero downtime**.

This reframes the cycle away from r1's 12 physical belts (which the S0 spike proved cost ~$280–450/mo against a hard **< $100/mo** ceiling, and which solved the wrong problem). The per-belt schema-subset capability proven in S0 (Option A) is **held in reserve** (FR-10) for a future on-demand split, not the primary mechanism. The indexer owns **serving consistency**; score-api owns durable analytics (ClickHouse/Dune cron + fallbacks) as a safety net, not a crutch.

---

## Problem Statement

### The Problem
> `SCALE.md:15,21`: adding any contract source forces a full reindex of all 6 chains (the "8-hour sync"); per-source `start_block` tightening + HyperSync + V3 gave *negligible* backfill improvement — "the bottleneck is architectural." The pain that reaches consumers is the **stale/down live endpoint during that reindex**, not the reindex itself.

### User Pain Points
- Consumers (frontends, score-api) see stale/missing data during any reindex `> SCALE.md:15`.
- Adding a contract = operational dread (multi-hour downtime window).
- Envio hosted (~$300/mo) is the cost baseline to beat (Direction 2026-05-22).

### Current State `[CODE:reality]`
- One consolidated Envio `3.0.0-alpha.17` belt (config field `rpc`) (S0/OQ-1), full ecosystem footprint, eRPC data source, on Railway (`belt-indexer` + `belt-hasura` + `Postgres`).
- A Caddy **stable-alias gateway already exists** [CODE:Dockerfile.gateway, Caddyfile]: `:{$PORT}` → `reverse_proxy {$BELT_UPSTREAM}`; swap verified (`> grimoires/loa/NOTES.md:265`: bad upstream→502, revert→live).
- Re-init runbook exists [CODE:grimoires/loa/runbooks/belt-reinit.md] (KF-013 `--restart`-seeds-then-resume + verification gate).

### Desired State
A consolidated belt whose updates are **zero-downtime** (blue-green promotion behind the stable alias), staying **< $100/mo** steady-state, where the indexer serves a **consistent** API and re-syncs happen in the background.

---

## Goals & Success Metrics

### Primary Goals
1. **G1 — Zero-downtime updates.** Adding a source or additive schema change never makes the production endpoint stale: changes ship via background green build + atomic alias swap.
2. **G2 — Cost ceiling.** Total indexer infra **< $100/mo** steady-state (the bar to leave Envio's ~$300 hosted).
3. **G3 — API serving consistency.** One stable GraphQL endpoint behind a fixed alias; consumers never touch backend deployment URLs or experience split-brain.
4. **G4 — Background re-sync.** Cold-start / re-init / source-add backfill is a background operation (on green), not consumer downtime; time-to-promote is bounded by RPC backfill speed (operator: fast enough — Direction 2026-05-22).

### Key Performance Indicators (success gates)
| KPI | Target |
|---|---|
| **G1 zero-downtime** | A promotion (add a source) completes with **0 consumer-visible downtime** — alias swap with no 5xx spike on the stable endpoint |
| **G2 budget** | Measured Railway steady-state **< $100/mo** (1 belt + shared eRPC/gateway); transient 2× only *during* a promotion window |
| **G3 stability** | **0 consumer config changes** across a promotion; reconciliation confirms no entity dropped |
| **G4 promotion gate** | Green reaches `latest_processed_block ≥ blue` on **every** chain AND passes reconciliation before any swap |

### Constraints
- Hard budget **< $100/mo** (Direction 2026-05-22).
- Sovereignty: OWN indexer/schema/gateway/eRPC; RENT free RPC + Railway; HyperSync = break-glass only.
- Additive-only public GraphQL contract behind the alias (breaking changes need an explicit path — FR-7).

---

## User Personas & Use Cases

### Primary Persona: Indexer Operator (zerker)
Adds a contract / schema field, deploys green, watches it catch up, promotes on a green light, rolls back by reverting the alias if needed — all without paging consumers.

### Secondary Persona: Consumer App (score-api, mibera-honeyroad, CubQuests, Set&Forgetti, dimensions, mibera-codex, future Dune/Quest API)
Points at the fixed alias URL; queries composed entities (per-event, aggregates, cross-cutting `Action`/`Mint`/`Holder`); never sees the backend swap. **score-api** additionally captures snapshots into ClickHouse/Dune on a cron with fallbacks (durable analytics — out of scope here).

### Tertiary Persona: Future Tenant (AP DAO)
Future on-demand split (the reserved per-belt capability, FR-10) — not this cycle.

---

## Functional Requirements

### FR-1: Consolidated belt
One Envio belt indexing the full footprint (6 chains, all current sources). Handlers compose freely *within* the belt — per-event entities, running aggregates (e.g. `PaddleSupplier` get→update→set), and cross-cutting normalized entities (`Action`, written by 21 handlers via `recordAction`) [CODE:src/handlers/*, src/lib/actions.ts]. No cross-belt composition (one belt → no federation).

### FR-2: Stable alias (exists — specify the contract)
The fixed public GraphQL endpoint = the Caddy `belt-gateway` [CODE:Caddyfile] (`reverse_proxy {$BELT_UPSTREAM}`). Proxy not DNS (atomic, single-source-of-truth). Define the alias contract: public URL, additive-only schema, the `BELT_UPSTREAM` swap as the only cutover lever (no per-consumer config) (resolves PR#15 SKP-001/F-001/Guardrail-5).

### FR-3: Blue-green promotion
Procedure to ship a change: (1) stand up green (new Railway service + own Postgres, via `belt-reinit.md`) with the change; (2) green backfills in background while blue serves; (3) reconciliation gate (FR-4); (4) atomic alias swap `BELT_UPSTREAM`→green; (5) retire blue. Green↔blue DB isolation is structural (separate service + Postgres) (resolves PR#15 SKP-002 isolation).

### FR-4: Promotion gate (reconciliation, not just block-height)
Before the swap: green's `latest_processed_block ≥ blue`'s on **every** chain AND an entity-count reconciliation within tolerance vs blue (extends the existing AC-R7 score-api footprint reconciliation). Block-height alone is insufficient (PR#15 SKP-002). No swap until the gate passes.

### FR-5: Rollback
A bad promotion is reverted by setting `BELT_UPSTREAM` back to blue (proven reversible — `NOTES.md:265`). Blue is retained (not deleted) until green is verified healthy post-swap for a defined window (resolves PR#15 SKP-003 "no rollback path").

### FR-6: Swap atomicity
Decide + specify the swap mechanism's downtime characteristic: today `BELT_UPSTREAM` change → Railway redeploy (~seconds blip; `admin off` in Caddyfile precludes `caddy reload`). For true zero-downtime: enable Caddy admin + graceful `caddy reload`, OR run ≥2 gateway instances, OR accept the blip (score-api fallbacks cover it). Operator-gated by whether the blip is acceptable (PR#15 SKP-001 sub-question).

### FR-7: Additive-only schema + breaking-change path
Green's schema MUST be a superset of blue's so the swap is transparent (additive invariant). Define the path for **non-additive** changes (field rename/removal/retype): versioned alias / consumer-coordinated cutover (resolves PR#15 SKP-003/B1).

### FR-8: Green-build orchestration
Operationalize standing up green from the `belt-reinit.md` runbook (own service + Postgres, `ENVIO_RESTART=1`-seeds-then-resume, verification gate before resume). Include the retry/escalation path if seeding is incomplete (PR#15 BB F-004).

### FR-9: score-api boundary (durable analytics downstream)
The indexer serves; **score-api owns durability/analytics** (cron capture → ClickHouse/Dune + fallbacks). The indexer must serve consistently (not be lossy); score-api is the safety net for indexer downtime, not a justification for gaps (PR#15 SKP-001 corrected emphasis; BB F-008 praised the lambda split).

### FR-10 (reserve, not built this cycle): on-demand split capability
The S0-proven per-belt config + physical schema subset (Option A, codegen+tsc exit 0) is **held in reserve** for a future on-demand split (tenant isolation or a source needing instant-live without waiting for green). Documented, not wired.

---

## Non-Functional Requirements

### Performance
Time-to-promote bounded by full-corpus backfill wall-time (operator: RPC fast enough; worth a one-shot measured number — G4). Steady-state query latency via the Caddy gateway + per-IP rate limit [CODE:Caddyfile, 120 events/min].

### Scalability
Adding sources = batched into a green per promotion (one catch-up, one swap) — no per-source infra growth. Multi-team additions batch the same way.

### Security
Public read-only on-chain data (auth: none). Per-belt Postgres credentials via env. eRPC over private Railway network. KF-012 op-stack getLogs-liar verification per chain before trusting new-source data.

### Reliability
Zero-downtime promotion (G1); reversible rollback (FR-5); green DB isolation (FR-3); score-api fallback safety net (FR-9). Cost model must include transient promotion-window 2× vs current 89% memory headroom (PR#15 SKP-004).

### Compliance
Sovereignty posture (OWN core, RENT RPC/Railway). No new external SaaS dependency on the live path (HyperSync = break-glass only).

---

## Technical Considerations

### Architecture Notes
Lambda split: indexer = hot serving tier (this cycle); score-api/ClickHouse = warm/cold analytics tier (downstream, out of scope). Alias = Caddy gateway. Promotion = blue-green via `BELT_UPSTREAM`.

### Integrations
Consumers via the stable alias; score-api cron capture; loa-freeside `freeside-mcp-gateway`/BeaconV3 as the org-wide routing layer (sonar-api is a freeside building — BeaconV3 declaration is a future/reserve concern, not load-bearing for this cycle's zero-downtime goal).

### Dependencies
Envio `3.0.0-alpha.17` (pinned, S0); Caddy gateway (shipped); eRPC (shipped); Railway managed Postgres. No new runtime deps.

### Technical Constraints
`isInitialized()` = table-existence (S0/D6); resume restarts each chain from DB `progressBlockNumber` → a green that needs historical data is a fresh `--restart` build, not an in-place resume. KF-013 re-init dance applies to green builds. `BERACHAIN id = 80094` is mainnet [CODE:config.yaml].

---

## Scope & Prioritization

### In Scope (this cycle)
One consolidated belt (FR-1) · stable alias contract (FR-2) · blue-green promotion (FR-3) · reconciliation promotion gate (FR-4) · rollback (FR-5) · swap-atomicity decision (FR-6) · additive-only + breaking-change path (FR-7) · green-build orchestration (FR-8) · score-api boundary (FR-9).

### In Scope (Future Iterations)
On-demand split capability (FR-10, reserved) · BeaconV3 declaration to freeside-mcp-gateway · ClickHouse/Dune federation at the analytics layer (score-api).

### Explicitly Out of Scope
12 physical pure-product belts (RETIRED) · query-time federation gateway · permanent sibling belts · ClickHouse/Dune/score computation (score-api) · packaged tenant installable.

### Priority Matrix
P0: FR-2, FR-3, FR-4, FR-5. P1: FR-6, FR-7, FR-8. P2: FR-1 (mostly already true), FR-9 (boundary doc), FR-10 (reserve).

---

## Success Criteria

### Launch Criteria
- [ ] **G1**: a source-add promotion completes with 0 consumer-visible downtime (alias swap, no 5xx spike on the stable endpoint).
- [ ] **G2**: measured Railway steady-state < $100/mo; promotion-window transient cost quantified.
- [ ] **G3**: 0 consumer config changes across a promotion; reconciliation shows no dropped entity (AC-R7 footprint preserved).
- [ ] **G4**: promotion gate enforced — green ≥ blue on every chain + reconciliation pass before swap; rollback (revert `BELT_UPSTREAM`) exercised.
- [ ] Swap-atomicity decision made (blip vs `caddy reload` vs ≥2 instances) with evidence.
- [ ] Breaking (non-additive) schema change path documented.

---

## Risks & Dependencies

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Swap not truly atomic (Railway redeploy blip) | Med | Med | FR-6 decision: Caddy `caddy reload` / ≥2 instances / accept blip (score-api covers); measure |
| R2 | Breaking (non-additive) schema change behind an additive-only alias | Med | High | FR-7 versioned-alias / consumer-coordinated path; additive invariant enforced |
| R3 | Promotion on block-height alone passes a green with dropped entities | Med | High | FR-4 reconciliation gate (entity counts) before swap; AC-R7 footprint check |
| R4 | Green build fails to seed all chains (KF-013) → silent-skip on resume | Med | High | FR-8 verification gate (chain_metadata count) + retry/escalation before promote |
| R5 | Promotion-window 2× cost vs already-89% memory headroom | Med | Med | PR#15 SKP-004 — quantify; bound max promotion window; one belt steady-state |
| R6 | Green never converges (backfill slower than block production) | Low | High | Operator: RPC fast enough; G4 measures full-corpus backfill wall-time once |
| R7 | Re-scoping regresses score-api#151 footprint | Med | High | Reconciliation gate (FR-4) = AC-R7; shipped belt stays SOLE source until verified |
| R8 | KF-012 op-stack getLogs-liar on a new source's chain | Med | High | Per-chain getLogs verification before trusting new-source data |

### Dependencies
Caddy gateway (shipped), eRPC (live), Railway, free RPC, Envio alpha.17 (pinned). loa-freeside (BeaconV3) only for the reserved future federation, non-blocking.

> **Sources**: `grimoires/loa/context/arch-brief-belt-federation.md` r2 + PR #15 reviews (Flatline + BB, alias spike) · `SCALE.md` (Guardrail 1/5, D4) · S0 calibration (`grimoires/loa/a2a/sprint-172/s0-multideploy-calibration.md`) · `belt-reinit.md` · `known-failures.md` (KF-012/013/014) · operator Directions 2026-05-21/22.
