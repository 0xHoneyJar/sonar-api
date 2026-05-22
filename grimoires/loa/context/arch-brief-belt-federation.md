---
title: "Architecture Brief — Append-Only Belt Federation (sonar reframe)"
status: candidate
mode: arch
cycle: sonar-belt-factory
date: 2026-05-21
supersedes_premise: "12 pure-product physical belts (PRD/SDD G1/G2)"
review_targets: [flatline, bridgebuilder]
---

# Architecture Brief — Append-Only Belt Federation

> **For adversarial review.** This brief reframes the `sonar-belt-factory` cycle
> after the S0 calibration spike (`grimoires/loa/a2a/sprint-172/s0-multideploy-calibration.md`)
> proved the original 12-belt premise is budget-infeasible. Reviewers: attack §6
> (load-bearing bets) and §7 (open questions) hardest. Lead with what to doubt.

## 1. Problem (grounded, not hypothetical)

- **The 8-hour sync.** `SCALE.md:15,21` — empirically established: a single
  deployment indexing 6 chains means **any contract addition forces a full reindex
  of all chains**, 30 min → several hours. Per-source `start_block` tightening +
  HyperSync + V3 migration produced **negligible** backfill improvement. The
  bottleneck is architectural, not config. `SCALE.md` D4 names the fix as a
  **per-chain deployment split**.
- **Hard budget ceiling: < $100/mo.** Operator constraint: this is the bar to
  justify leaving Envio's hosted (~$300/mo). Measured (S0-T1, Railway): 1 belt +
  shared infra ≈ **$84.40/mo**, **89% memory**; memory = **$10.11/GB-RAM/mo**.
- **S0 finding:** 12 physical belts ≈ $280–450/mo (each belt = a separate
  memory-resident indexer process; cost = memory × process-count). 3–4.5× over
  ceiling, and *worse* than the hosted option it replaces. **The original premise
  is dead.**

## 2. Reframed thesis

The belt factory's real job is **never re-backfill the already-synced corpus.**
The S0-proven capability (per-belt config + physical schema subsets compile in
isolation) exists so a *new source* can be backfilled *on its own*, in parallel,
without re-syncing the corpus you already paid hours for. Isolation is **on-demand
(for backfill)**, not always-on (for steady-state blast-radius).

## 3. Module boundary (the indexer is ONE freeside module)

| | |
|---|---|
| **`is`** | Index Mibera-ecosystem on-chain events *fast*; serve them through *one federated GraphQL API*. Sync-time optimized. Additive-only public contract. |
| **`is_not`** | Durable analytics store · ClickHouse · Dune · historical snapshots · system-of-record for scores. |

**score-api owns durability + analytics.** Its cron captures from the indexer's
federated API and has fallbacks for indexer downtime. ⇒ the indexer can be
**lean and disposable** — no per-belt HA; KF-013 re-init is tolerable because
score-api backstops gaps. This is the lambda-architecture split: indexer = hot
serving tier; score-api/ClickHouse = warm/cold analytics tier fed by CDC/cron.

## 4. Architecture — append-only belt federation

```
   ┌─────────────── indexer module (this repo / one freeside Beacon) ───────────────┐
   │  CORPUS belt(s)        sibling belt        sibling belt                          │
   │  (all chains, steady,  (new source A,      (new source B,    ← spun up on-demand │
   │   never --restart)      parallel backfill)  parallel backfill)  per new source   │
   │        │                    │                   │                                │
   │        └──────────── federation gateway (query-time fan-out, NO db merge) ───────┤
   └───────────────────────────────────│────────────────────────────────────────────┘
                                        ▼  single federated GraphQL API (additive-only, BeaconV3)
                              score-api cron  →  ClickHouse / Dune  (durable analytics, fallbacks)
```

- **Corpus belt(s):** 1 (maybe 2 by chain) consolidated deployment. Synced once.
  Never `--restart` ⇒ never re-backfilled. ~$50–60/mo.
- **Sibling belts:** when a new source is added, spin up an isolated belt for *just*
  that source (config + schema subset — the factory). Backfill is scoped (one
  contract/chain) ⇒ fast ⇒ parallel ⇒ corpus untouched. Cheap (tiny) or transient.
- **Federation gateway:** composes one GraphQL surface across corpus + siblings at
  **query time**. New belts appear behind the stable API; consumers never see the
  partitioning. **Additive-only** = the BeaconV3 contract (public URL + schema
  unchanged when belts are added).
- **Partition axis = reindex-cost (chain), per D4** — not product taxonomy.
- **Consolidation (the cost-control valve):** low-churn sibling belts are
  periodically folded into the corpus belt via a *deliberate* `--restart` during a
  maintenance window (score-api fallbacks cover the gap). Keeps belt-count bounded.

## 5. Cost model (must stay < $100/mo)

| Component | Steady-state $/mo |
|---|---|
| Shared: eRPC + eRPC Postgres + gateway | ~$25–35 |
| Corpus belt (indexer + Postgres; Hasura shared/optional) | ~$40–55 |
| Sibling belts (each tiny; transient during backfill) | ~$5–15 each, folded periodically |
| **Target total (steady)** | **< $100** |

Memory is the swing factor. Sharing Hasura (1 → N belt Postgres, multi-source) and
right-sizing corpus RAM are the levers. **Shared Postgres is rejected** — a belt
re-init would touch siblings (breaks backfill isolation).

## 6. Load-bearing bets (ATTACK THESE)

- **B1 — Federate, never merge.** Siblings stay separate Postgres; the gateway
  composes at read-time. If the real model is "split then recombine into one DB,"
  that's the `--restart` path and the whole design collapses.
- **B2 — score-api is a sufficient durability backstop.** Leaning on its cron +
  fallbacks lets the indexer be lossy/disposable. If score-api's capture can't
  recover events the indexer drops, this is a hidden data-loss surface.
- **B3 — Scoped backfill is actually parallel.** Sibling belts backfill
  concurrently *without* contending on the shared eRPC ceiling (R6). If eRPC
  throughput is the real bottleneck, parallelism gives no speedup (and SCALE.md
  already showed optimization didn't help — is RPC the ceiling?).
- **B4 — Query-time federation scales.** Fan-out across N belt GraphQL endpoints
  (with cross-belt entity UNION: Action/Mint/Holder dedup, ordering, pagination)
  stays within acceptable latency/cost vs a single DB.

## 7. Open questions (for the reviewers)

- **Q1 (corpus growth):** every new source → a sibling belt ⇒ belt-count + fan-out
  width creep up over time. What is the consolidation cadence/trigger that keeps it
  bounded? Is periodic `--restart`-fold the right valve, or does it reintroduce the
  8-hour pain at fold-time?
- **Q2 (cross-belt consistency):** federated reads hit belts at *different* sync
  heights ⇒ consumers see inconsistent cross-belt state during backfill. Acceptable
  because score-api capture tolerates it? What's the consistency contract?
- **Q3 (join-corpus vs own-belt rule):** crisp decision rule for when a new source
  joins the corpus (cheap, but forces a corpus re-sync) vs gets its own belt
  (isolated, but adds a process). Likely: own-belt if the source's chain is already
  synced past its deploy block (else corpus re-sync is unavoidable per D6).
- **Q4 (parallel-backfill ceiling):** is the cold-sync bottleneck eRPC throughput
  (⇒ parallelism useless; need paid backfill RPC or HyperSync break-glass) or
  indexer CPU (⇒ parallelism helps)? This determines whether the whole "spin up a
  sibling to backfill fast" premise holds. **Most important to resolve.**
- **Q5 (multi-team scale):** scaling to more teams' contracts — does the federated
  API + per-source belt model hold, or does fan-out / cost break first?
- **Q6 (federation tech):** Apollo Federation vs a thin custom gateway vs Hasura
  remote schemas vs one Hasura over multiple Postgres sources — which, and why?

## 8. Out of scope (explicit)

ClickHouse/Dune analytics, snapshot durability, score computation — all score-api.
The cutover/decommission of the current shipped belt (deferred; AC-R7 guard holds).

## 9. What S0 already settled (inputs, not under review)

- Envio `3.0.0-alpha.17`, config field `rpc` (OQ-1).
- Option A (per-belt physical schema subset) compiles: `codegen` + belt-scoped
  `tsc` both exit 0 (R-D / R10).
- `isInitialized()` = table-existence; resume restarts each chain from DB
  `progressBlockNumber`; adding a pre-head source needs `--restart` (D6).
  Runbook: `grimoires/loa/runbooks/belt-reinit.md`.
