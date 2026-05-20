# Product Requirements Document — Indexer Belt Rebuild, Deployment #1

> **Cycle**: indexer-belt-rebuild · **Deployment #1** (the fire fix)
> **Source of truth**: `grimoires/loa/specs/indexer-belt-rebuild.md` (operator build doc, 2026-05-19).
> This PRD formalizes deployment #1 only; the build doc remains canonical for the
> belt model and the later deployments.
> **Date**: 2026-05-19 · **Build construct**: `construct-noether`
> **Revision**: r2 — integrates the 2026-05-19 3-model Flatline review (see §11).

## 1. Problem / Context

The Envio **hosted** indexer (`indexer.hyperindex.xyz`) is **dead** — confirmed HTTP 404
across the base domain and deployment slugs `914708e` / `b5da47c` (2026-05-19). This repo
(`freeside-sonar`, forked from `moose-code/thj`) IS the monolithic indexer that was
deployed there.

Every downstream consumer reading that endpoint is degraded. Two consumers depend on it
directly:

- **mibera-honeyroad** — the `/backing` loan UI. Loan routes (`active-loans`,
  `expired-loans`, `user-loans`, `rfv-data`) read this indexer; users currently cannot
  see loan state.
- **freeside-score / score-api** — wallet scoring. All reads in
  `score-api/trigger/utils/envio-client.ts` (12 entities).

On-chain loan diagnosis (2026-05-19): **CLEAR** — 19 active loans, 0 past expiry, 0 within
7 days. Soonest expiry loan #134 due 2026-05-30. This is a *this-week build*, not a
tonight-scramble.

The strategic response (build doc + loa-freeside ADR-008): stop renting a hosted indexer;
self-host. Decompose the monolith **by project** into independently-syncing **belts** —
one self-hosted HyperIndex deployment per belt on Railway. Deployment #1 stands up the
**Mibera belt**, scoped thin, as the fire fix and the template for the other three belts.

## 2. Goals

- **G1** — Restore mibera-honeyroad's `/backing` loan display by standing up a self-hosted
  GraphQL indexer endpoint serving `MiberaLiquidBacking` + `MiberaCollection` data.
- **G2** — Deliver it as the first **belt**: a self-hosted HyperIndex deployment on Railway
  syncing Berachain independently — the reusable pattern for the HoneyJar / Purupuru /
  Sprawl belts.
- **G3** — Preserve the GraphQL schema contract exactly, so both consumers recover by
  changing one environment variable each — no consumer code changes.

### Success metrics

- mibera-honeyroad `/backing` renders live loan data after a single `NEXT_PUBLIC_ENVIO_URL`
  repoint.
- The new endpoint's active-loan count reconciles **exactly** with on-chain
  `MiberaLiquidBacking` state at a pinned block height (≈19 per the 2026-05-19 diagnosis —
  see FR-4 for the deterministic gate).
- Deployment is **live before ~2026-05-27** (the 10.5-day buffer to loan #134's 2026-05-30
  expiry).
- score-api resolves the deployment-#1 subset of its 12 entities after one
  `ENVIO_GRAPHQL_URL` repoint, with uncovered entities returning empty (not errors).

## 3. Non-Goals (What NOT to Build)

- **NOT all 4 belts.** Deployment #1 is Mibera-belt-thin — exactly two contracts. Widening
  the Mibera belt and the other belts come after.
- **NOT a handler rewrite.** The hosted *service* died; the handler code did not. Self-host
  the existing HyperIndex handlers as-is.
- **NOT the ~14 archived contracts** (Crayons, SFVault, Aquabera, FatBera, validator infra
  not consumed by Mibera, Henlo, ApdaoAuctionHouse).
- **NOT the puru-erc1155 fix** — that is a Purupuru-belt task; the plan already exists at
  `grimoires/loa/puru-erc1155-fix-plan.md`.
- **NOT per-belt schemas.** Shared `schema.graphql`; revisit only if it proves a problem.
- **NOT renaming entities or fields.** `schema.graphql` is a frozen consumer contract.
- **NOT acting on the stale cycle-112 sprint** (relocated to `archive/cycle-112-sprint.md`).

## 4. Users / Stakeholders

| Stakeholder | Interest in deployment #1 |
|---|---|
| mibera-honeyroad `/backing` users | Loan state visibility restored (`active`, `expired`, `user`, `rfv`). |
| freeside-score / score-api | Wallet scoring — partial entity restoration from the Mibera-belt subset. |
| Operator (zerker) | Capability deliverable: first in-house self-hosted indexer; the template for 3 more belts. |
| Future belt deployments | Inherit the Railway + per-belt-config pattern proven here. |

## 5. Functional Requirements

Dependency-ordered (each FR depends on the prior).

- **FR-0 — Pre-flight: data-source verification.** Before deployment work, verify Berachain
  HyperSync (`berachain.hypersync.xyz`) still serves chain `80094` on a free tier. If it
  does not, select and verify a public Berachain RPC endpoint as the fallback. The outcome
  is **recorded** — FR-3 consumes a resolved data source, not an open question.
  *(Flatline IMP-002.)*

- **FR-1 — `config.mibera.yaml` (thin belt config).** A HyperIndex config indexing exactly
  `MiberaLiquidBacking` (`0xaa04F13994A7fCd86F3BbbF4054d239b88F2744d`, start_block
  `3971122`) and `MiberaCollection` (`0x6666397dfe9a8c469bf65dc744cb1c733416c420`,
  start_block `3837808`) on Berachain `80094`. Addresses, start_blocks, and event
  signatures sourced from the existing `config.yaml`. Reuses `schema.graphql` (unused
  entities staying empty is acceptable). **Both addresses and both start_blocks MUST be
  diffed against `config.yaml` and confirmed byte-identical** — a start_block copy error
  silently corrupts sync completeness. *(Flatline IMP-009.)*

- **FR-2 — Handler correctness verification.** Confirm the existing
  `src/handlers/mibera-liquid-backing.ts` and `src/handlers/mibera-collection.ts` handlers
  not only execute but **emit correct entity data when the config indexes only these two
  contracts** — i.e. they do not depend on entities or state populated by the monolith's
  other (now-absent) indexed contracts. Verification MUST include a **local dev run that
  produces visible entity emissions** for both contracts, cross-checked against the exact
  entity + field set the two consumers query. `pnpm codegen` and `pnpm tsc --noEmit` clean
  are **necessary but not sufficient** — they do not prove runtime handler execution or
  entity emission. *(Flatline SKP-001·880 [CRITICAL], IMP-006.)*

- **FR-3 — Railway self-host.** A Railway service running this HyperIndex against
  `config.mibera.yaml`. MUST include:
  - **(a)** a provisioned **persistent PostgreSQL database** with its connection string
    wired in — HyperIndex requires Postgres; without persistent storage, a container
    restart loses sync state;
  - **(b)** the **explicit set of required environment variables** (Postgres URL, the
    FR-0 data-source endpoint, chain/network config) — enumerated, not discovered
    mid-deploy; *(Flatline IMP-001;)*
  - **(c)** the **explicit build + start command** for the Railway service. *(Flatline
    IMP-004.)*
  One Railway project; this is its first service.

- **FR-4 — GraphQL endpoint verification.** The endpoint is reachable, syncs Berachain from
  the contracts' start_blocks to chain head, and serves loan + collection data. The
  active-loan spot-check MUST be **deterministic**: pinned to a stated block height,
  accounting for chain finality, with the exact GraphQL query semantics specified, and
  reconciled against the on-chain `MiberaLiquidBacking` loan enumeration
  (`0..backingLoanId-1`, `backingLoanExpired(id)`). "≈19" is the 2026-05-19 reference
  count; the gate is **"matches on-chain at the pinned block,"** not a fuzzy number.
  *(Flatline SKP-001·720.)*

- **FR-5 — Consumer handback.** Hand the new endpoint URL to both consumers via environment
  variable only:
  - mibera-honeyroad — `NEXT_PUBLIC_ENVIO_URL` (Vercel); `/backing` recovers.
  - score-api — `ENVIO_GRAPHQL_URL` in `score-api/trigger/utils/envio-client.ts`.
  - **score-api partial-restoration contract** — explicitly enumerate which of the 12
    entities resolve with data under deployment #1 (`MiberaLoan`, `MiberaTransfer`,
    `MintActivity`, `NftBurn(mibera)`, `Action:treasury_purchase`) versus which return
    **empty** (the remaining 7). Uncovered entities MUST return **empty arrays**, never
    schema or endpoint errors. *(Flatline IMP-003, IMP-010, SKP-002·730.)*
  - **Pre-repoint safety audit** — before flipping the production `ENVIO_GRAPHQL_URL`,
    audit `score-api/trigger/utils/envio-client.ts` to confirm it handles empty/null
    responses for the unindexed entities gracefully. Repointing to a partial-data endpoint
    MUST NOT crash wallet scoring. *(Flatline SKP-001·850 [CRITICAL].)*

## 6. Non-Functional Requirements

- **NFR-1 — Frozen schema contract.** `schema.graphql` entity types and field names are a
  hard contract. Two consumers read exact names: mibera-honeyroad loan routes, and
  score-api `envio-client.ts` (12 entities — type + every field name). Self-hosting
  HyperIndex with the existing `schema.graphql` verbatim satisfies this; consumers repoint
  by URL only. **No renames.**
- **NFR-2 — Reversibility.** Deployment #1 is purely additive — a new Railway service on a
  new URL. The dead hosted endpoint is already dead; nothing breaks by standing up a
  replacement. A wrong outcome is fixable config-only; each consumer repoint is one
  revertible env var.
- **NFR-3 — Loan-data correctness (`feedback_backing_is_sacred`).** The loan data path must
  be **correct**, not merely present. The loan model: `backingLoanDetails(id)` →
  `(loanedTo, timestampDue, interestOwed, backingOwed, defaultCreatorFee)`; loans
  enumerated `0..backingLoanId-1`; `backingLoanExpired(id)` seizes. Correctness is proven
  by FR-2 (handler emission) and FR-4 (deterministic on-chain reconciliation).
- **NFR-4 — Independent sync.** The belt syncs as its own HyperIndex deployment, independent
  of any other project — the factory model. Monolith-wide syncing (the dead service's
  problem) is explicitly rejected.
- **NFR-5 — Operational visibility.** The belt deployment MUST expose a health/liveness
  signal and an alert path, so a future endpoint death is **detected, not silently
  absorbed** — the failure mode that caused this incident. *(Flatline IMP-005.)*

## 7. Constraints & Dependencies

- **HyperIndex** is open-source and self-hostable — the deployment substrate. Requires a
  PostgreSQL database at runtime.
- **Railway** — hosting platform for the belt service + its Postgres database.
- `config.yaml` — the contract → address → chain → start_block source of truth (41
  contracts, 6 chains).
- `schema.graphql` — entity definitions; frozen.
- Shared `src/handlers/` + `schema.graphql` across all future belt configs (one codebase).
- Berachain `80094` data source — HyperSync (`berachain.hypersync.xyz`) preferred; public
  RPC fallback. Resolved by FR-0.

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Berachain HyperSync no longer free / unavailable | Sync source gap | FR-0 resolves the data source before deployment work begins. |
| RPC-fallback historical-sync cascade — public RPC from start_block 3837808 may be slow / rate-limited, cascading into sync failure | Endpoint never reaches head; loan data stale | Prefer HyperSync (FR-0). If RPC is forced, budget for slow historical sync and monitor sync progress; treat as a known caveat. *(Flatline SKP-002·750.)* |
| First-time HyperIndex self-host on Railway — unknown deployment friction | Schedule slip vs. 2026-05-27 | 10.5-day buffer absorbs iteration; deployment #1 deliberately thin (2 contracts). |
| Handlers assume monolith context / cross-contract state | Loan data incorrect (NFR-3 breach) | FR-2 explicitly verifies handlers emit correct consumer entities, scoped to 2 contracts, via a local dev run. |
| Active-loan count mismatch on spot-check | Loan data path wrong | FR-4 gates handback on a deterministic block-pinned reconciliation against on-chain state. |
| score-api crashes on partial-data endpoint | Wallet scoring outage worsened | FR-5 pre-repoint audit of `envio-client.ts` empty/null handling. |
| Cross-belt `Action` fragmentation | score-api full restoration incomplete | Out of scope for #1 — score-api gets partial restoration; composition strategy resolved before the HoneyJar belt (§10). |

## 9. Acceptance Criteria

Deployment #1 is complete when:

1. FR-0 data source is verified and recorded (HyperSync free, or a verified RPC fallback).
2. `config.mibera.yaml` exists, scoped to the two contracts on Berachain `80094`; its
   addresses + start_blocks are confirmed byte-identical to `config.yaml`.
3. `pnpm codegen` and `pnpm tsc --noEmit` run clean.
4. A local dev run shows both handlers emitting correct entity data scoped to the two
   contracts (FR-2).
5. A Railway service + persistent Postgres deploys, and HyperIndex syncs Berachain from
   start_blocks to head.
6. The GraphQL endpoint's active-loan count reconciles exactly with on-chain
   `MiberaLiquidBacking` state at a pinned block height (≈19 per the 2026-05-19 diagnosis).
7. The belt exposes a health signal + alert path (NFR-5).
8. mibera-honeyroad `/backing` renders live loan data after the `NEXT_PUBLIC_ENVIO_URL`
   repoint.
9. `score-api/trigger/utils/envio-client.ts` is audited for empty/null handling; after the
   `ENVIO_GRAPHQL_URL` repoint, the deployment-#1 entity subset resolves and uncovered
   entities return empty arrays without errors.
10. `schema.graphql` is unchanged — no entity or field renamed.

## 10. Open Decisions (do not block deployment #1)

- **Cross-belt `Action` fragmentation** — post-split, each belt is its own HyperIndex DB +
  GraphQL endpoint, so the `Action` entity fragments across belt databases. score-api reads
  one `ENVIO_GRAPHQL_URL` today. When belts beyond Mibera ship, score-api must either query
  multiple belt endpoints and merge, or `freeside-sonar` exposes a composition/federation
  endpoint. **Resolve before the HoneyJar belt ships.** Deployment #1 is unaffected.

## 11. Flatline Review Integration (r2)

Revised per the 2026-05-19 3-model headless Flatline review of r1 (claude-headless +
codex-headless + gemini-headless; full confidence, 80% model agreement). All 13 findings
integrated:

- **6 high-consensus** — IMP-001 (Railway env vars → FR-3b), IMP-002 (data-source
  pre-flight → FR-0), IMP-003 (entity enumeration → FR-5), IMP-004 (build/start command →
  FR-3c), IMP-005 (health check + alert → NFR-5), IMP-006 (local dev run → FR-2).
- **2 disputed** — IMP-009 (config diff → FR-1), IMP-010 (empty-array semantics → FR-5).
- **5 blockers** — SKP-001·880 (handler correctness → FR-2), SKP-001·850 (score-api crash
  → FR-5 pre-repoint audit), SKP-002·730 (partial-restoration contract → FR-5),
  SKP-001·720 (deterministic loan gate → FR-4), SKP-002·750 (RPC-fallback cascade →
  §8 risk).

Full result: `grimoires/loa/a2a/flatline/prd-review.json`.
