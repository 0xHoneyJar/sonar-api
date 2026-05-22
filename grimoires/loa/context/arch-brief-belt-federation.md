---
title: "Architecture Brief r2 — One Consolidated Belt + Blue-Green Promotion (sonar reframe)"
status: candidate
mode: arch
cycle: sonar-belt-factory
date: 2026-05-21
revision: r2
supersedes_premise: "r1 append-only belt federation (siblings + query-time gateway) — RETIRED"
review_targets: [flatline, bridgebuilder]
---

# Architecture Brief r2 — One Consolidated Belt + Blue-Green Promotion

> **r2 reframe.** r1 proposed append-only *federation* (permanent sibling belts +
> a query-time gateway). Review (Flatline `SKP-002`/`SKP-003` CRITICAL, BB
> `F-001`/`F-003`) showed that model carries unproven, possibly-false premises
> (parallel-backfill speedup; cross-belt query correctness). r2 **removes the
> federation entirely**: one consolidated belt behind a stable alias, changes
> shipped by **blue-green promotion**. Most of the r1 risk surface disappears
> because there is only ever one belt. Reviewers: attack §6 (bets) and §7 (open
> questions). Lead with what to doubt.

## 1. Problem (grounded)

- **The real pain is DOWNTIME during re-sync, not re-sync itself.** `SCALE.md:15,21`:
  adding any contract source forces a full reindex of all chains (the "8-hour"
  sync), and `SCALE.md` D4 names per-deployment split as the structural fix. The
  thing that hurts consumers is that the *live* endpoint goes stale/down during
  that reindex — not that a reindex happens.
- **Hard budget ceiling: < $100/mo** (the bar to leave Envio's ~$300/mo hosted).
  Measured (S0-T1, Railway): 1 belt + shared infra ≈ **$84.40/mo**, 89% memory.
- **API-level consistency is the indexer's own responsibility** — consumers
  (frontends, score-api) must get a stable, consistent GraphQL endpoint. score-api's
  capture/fallbacks are a *safety net*, not a license for the indexer to be lossy.

## 2. Reframed thesis (r2)

**One consolidated belt** indexing the full Mibera-ecosystem footprint, serving a
**stable, additive-only GraphQL API behind a fixed production alias.** Changes ship
via **blue-green promotion**:

> Build a new deployment (green) that includes the change → let it backfill and
> **catch up to / exceed** the live deployment's (blue) head → **atomically flip
> the production alias** blue→green → retire blue.

The 8-hour reindex still happens — **on green, in the background.** The production
endpoint never goes stale. Consumers point at the alias and **never see the swap.**

## 3. Module boundary (the indexer is ONE freeside module)

| | |
|---|---|
| **`is`** | Index the Mibera-ecosystem footprint into composed, queryable entities; serve them through **one stable GraphQL endpoint** with **zero-downtime** updates via blue-green promotion. |
| **`is_not`** | Durable analytics store · ClickHouse · Dune · historical snapshots · system-of-record for scores. |

score-api owns durable analytics (cron capture → ClickHouse/Dune) and acts as a
**safety net** for indexer gaps — but the indexer is responsible for serving
consistently, not for being disposable. (Lambda split: indexer = hot serving tier;
score-api = warm/cold analytics tier. BB `F-008` praised this framing; r2 keeps it
but corrects the emphasis — serving consistency is load-bearing.)

### Composition stays intra-belt (unchanged, and now uncomplicated)

Handlers compose freely **within the one belt** — per-event entities, running
aggregates (`PaddleSupplier` via get→update→set), and cross-cutting normalized
entities (`Action`, written by **21 handlers** via `recordAction`). Because there
is **one belt**, there is **no cross-belt UNION / dedup / ordering / pagination
problem** (the r1 `SKP-002` CRITICAL is gone by construction). Shared handler
*logic* (`src/handlers/*`, `src/lib/*`) is imported as today.

## 4. Architecture — blue-green promotion behind a stable alias

```
 consumers (frontends, score-api cron)
        │  always → stable production alias (fixed URL, never changes)
        ▼
   ┌─────────── alias / router (thin: points at "current" belt, supports atomic swap) ──────────┐
   │                                                                                             │
   │   BLUE  (live)  ──────────────serving──────────────►        GREEN (building, background)    │
   │   consolidated belt @ head                                  consolidated belt + the change  │
   │                                                             backfilling… catches up to head │
   │                                                                     │ exceeds blue's head    │
   │                                          ◄── atomic alias flip ─────┘                        │
   │   (retire blue)                                                                              │
   └─────────────────────────────────────────────────────────────────────────────────────────────┘
              green is built fresh via the KF-013 re-init runbook (belt-reinit.md)
```

- **Steady-state: ONE belt** (+ shared eRPC + gateway). No siblings, no federation.
- **Promotion (add source / additive schema change):** stand up green with the
  change, backfill in the background (blue keeps serving), promote when green's
  `latest_processed_block ≥ blue`'s, retire blue.
- **Stable alias:** consumers hit a fixed endpoint; the swap is invisible. This is
  `SCALE.md` Guardrail 5 (currently flagged "not yet built") — **r2's core
  deliverable.**
- **Additive-only schema invariant:** green's schema is a superset of blue's, so the
  alias swap is transparent to existing consumers (no breaking changes behind the
  alias).
- **Backfill speed:** operator judgment (2026-05-21) — **the RPC/eRPC path can
  backfill fast enough**; time-to-promote is a feature-latency number, not downtime.

## 5. Cost model (must stay < $100/mo)

| Component | Steady-state $/mo |
|---|---|
| Shared: eRPC + eRPC Postgres + gateway/alias | ~$25–35 |
| Consolidated belt (indexer + Postgres; Hasura) | ~$50–60 |
| **Steady total** | **< $100** |
| Transient during a promotion window (blue + green both up) | ~2× the belt for the catch-up window (hours), then back to 1× |

No permanent siblings, no federation gateway → **no sprawl, no cost creep.** The
only extra cost is the transient 2× *during* a promotion (a few hours of one extra
belt), which is negligible monthly. (Resolves r1 `F-002` unbounded-growth and
`SKP-005` cost-extrapolation concerns: there is nothing to grow.)

## 6. Load-bearing bets (ATTACK THESE)

- **B1 — Additive-only schema.** Every promotion's schema is a superset; the alias
  swap is transparent. If a change is *non-additive* (rename/remove/retype an
  entity field a consumer depends on), blue-green alone doesn't make it safe —
  needs a consumer-coordination step. (What's the path for breaking changes?)
- **B2 — Green converges.** Backfill runs faster than realtime, so green catches up
  to and exceeds blue. Operator asserts RPC backfill is fast enough; if a chain's
  backfill is *slower* than its block production, green never converges.
- **B3 — Atomic alias swap.** The promotion is a clean, single-flip cutover with no
  split-brain window across consumers. `SCALE.md` Guardrail 5 warned a manual
  env-var swap across 4+ consumers produces split-brain — so the alias must be a
  *real* indirection (single source of truth), not per-consumer config edits.
- **B4 — Serving consistency during catch-up.** Blue serves a complete, consistent
  view the entire time green builds; consumers never observe green mid-backfill.

## 7. Open questions (for the reviewers)

- **Q1 (the alias mechanism):** what *is* the stable alias technically — a Railway
  custom domain reassigned on promotion? a gateway/router that holds the
  current-belt URL? a DNS/proxy layer? This is the core thing to build (Guardrail 5);
  it must be atomic and single-source-of-truth across all consumers.
- **Q2 (non-additive / breaking schema changes):** B1 covers additive changes. What
  is the path when a change is *not* additive (field rename/removal, entity
  restructure)? Versioned alias? Consumer-coordinated cutover?
- **Q3 (promotion trigger + verification):** what gate confirms green is safe to
  promote — `latest_processed_block ≥ blue` on every chain, plus a reconciliation
  check (entity counts within tolerance) before the flip? (Connects to S2-T4
  reconciliation already in the cycle.)
- **Q4 (backfill speed, lowered stakes):** operator says RPC is fast enough — worth
  a one-shot confirmation of full-corpus backfill wall-time so "time-to-promote" is
  a known number, but it no longer gates *downtime*.
- **Q5 (multi-team batching):** many teams adding sources → batch several changes
  into one green per promotion (one catch-up, one flip) rather than one promotion
  per change. Confirm batching is the intended cadence.

## 8. What r2 retires from r1 (and why)

| r1 element | r2 status | reason |
|---|---|---|
| Permanent sibling belts | **REMOVED** | sprawl + cost creep (`F-002`, `SKP-005`); blue-green needs only transient green |
| Query-time federation gateway | **REMOVED** | cross-belt UNION/dedup/ordering correctness (`SKP-002` CRITICAL, `F-003`) — moot with one belt |
| Fold = in-place `--restart` (downtime) | **REPLACED** by blue-green | `SKP-003` (fold reintroduces 8h downtime) — green builds in background, blue serves |
| "indexer is disposable" emphasis | **CORRECTED** | serving consistency is the indexer's job; score-api is a safety net (`SKP-001` de-risked — no 8h serving gap to cover) |
| parallel sibling backfill premise | **DROPPED** | `F-001`/`SKP-003-4`/Q4 — irrelevant; one belt, background catch-up |

## 9. What S0 already settled (inputs, not under review)

- Envio `3.0.0-alpha.17`, config field `rpc` (OQ-1).
- Option A (per-belt physical schema subset) compiles — codegen + tsc exit 0
  (R-D/R10). *Note: r2 uses one consolidated belt, so the subset capability is held
  in reserve, not the primary mechanism.*
- `isInitialized()` = table-existence; resume restarts each chain from DB
  `progressBlockNumber`; a fresh green is built via the `--restart`-seeds-then-resume
  runbook. Runbook: `grimoires/loa/runbooks/belt-reinit.md` (BB `F-006`: add a
  chain_metadata-count verification gate before the resume deploy — accepted).
