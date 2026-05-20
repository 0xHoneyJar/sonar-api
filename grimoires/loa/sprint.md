# Sprint Plan — Indexer Belt Rebuild, Deployment #1

> **Cycle**: indexer-belt-rebuild · **Deployment #1** (the fire fix)
> **Implements**: `grimoires/loa/prd.md` (r2) + `grimoires/loa/sdd.md` (r3)
> **Build doc**: `grimoires/loa/specs/indexer-belt-rebuild.md` · **Construct**: `construct-noether`
> **Date**: 2026-05-19 · **Deadline**: live before ~2026-05-27 (10.5-day buffer)
> **Revision**: r2 — integrates the 2026-05-19 3-model Flatline sprint review (see end).

## Overview

Deployment #1 is **one sprint** — the thin Mibera-belt fire fix: a self-hosted HyperIndex
deployment on Railway indexing `MiberaLiquidBacking` + `MiberaCollection` on Berachain,
fronted by a **stable gateway URL**, restoring mibera-honeyroad's `/backing` loan UI. 14
tasks, dependency-ordered. No handler or schema code changes.

**Key r2 change**: consumers repoint to a **stable gateway/proxy URL** (T10), not the raw
Railway service URL. The gateway's upstream is a single config value — so the one-way
consumer repoint happens *once* (to the gateway), and any future belt swap or post-handback
recovery is an operator-controlled upstream change with zero consumer impact. This is the
structural fallback the Flatline review's 3 CRITICALs demanded.

## Sprint 1 — Mibera Belt

**Size**: S ≈ <½ day · M ≈ ½–1 day · L ≈ 1–2 days. ∥ = may run in parallel.

### T1 — Data-source verification (FR-0)
- **Do**: Verify `berachain.hypersync.xyz` HyperSync serves chain `80094` free. Else select
  + verify a public Berachain RPC. Record the source. Note: if RPC, historical sync from
  block 3.8M may be rate-limited (a long-pole; T8 sync-lag alert detects a stall).
- **Acceptance**: AC-1. **Deps**: none. **Size**: S.

### T2 — Author `config.mibera.yaml` (FR-1)
- **Do**: HyperIndex config, network Berachain `80094`, data source from T1. Two contracts,
  **full addresses** (no truncation):
  - `MiberaLiquidBacking` — `0xaa04F13994A7fCd86F3BbbF4054d239b88F2744d`, start_block
    `3971122`, 9 events.
  - `MiberaCollection` — `0x6666397dfe9a8c469bf65dc744cb1c733416c420`, start_block
    `3837808`, `Transfer`.
  Per-event `field_selection` copied **verbatim** from `config.yaml` (SDD §5).
- **Acceptance**: AC-2. **Deps**: T1. **Size**: M.

### T3 — Config-selection spike (S0) *(NEW)*
- **Do**: Resolve the SDD §3.4 fork. Prove how HyperIndex selects `config.mibera.yaml` over
  the default `config.yaml` — test the build-step copy approach AND `--config`/`ENVIO_CONFIG`
  if the installed Envio version supports it — across **all three** commands: `codegen`,
  local run, and Railway start. Pick one mechanism; record it. Half-day box.
- **Acceptance**: config-selection mechanism decided + proven across codegen/local/Railway.
- **Deps**: T2. **Size**: S–M. *(Calibration spike — derisks T7 before it commits.)*

### T4 — `field_selection` structural check + early schema diff (SDD §5.3)
- **Do**: Build `scripts/verify-belt-config` — asserts per-event `field_selection`,
  addresses, start_blocks in `config.mibera.yaml` are byte-identical to `config.yaml`; exits
  non-zero on mismatch; wired as a build/CI gate. Also run `git diff schema.graphql` now
  (early feedback on NFR-1, not just at T14).
- **Acceptance**: AC-11 — check passes; fails on an injected mismatch (test-first).
- **Deps**: T2. **Size**: M.

### T5 — Build gate (FR-2)
- **Do**: `pnpm codegen` + `pnpm tsc --noEmit` clean against `config.mibera.yaml`; T4 check
  green.
- **Acceptance**: AC-3. **Deps**: T3, T4. **Size**: S.

### T6 — Local dev run (FR-2)
- **Do**: Run the indexer locally against `config.mibera.yaml`. Confirm both handlers emit
  entities via the 3 SDD §6 queries: `MiberaLoan` non-empty, `MiberaTransfer` non-empty,
  `MintActivity` with `amountPaid > 0` present.
- **Acceptance**: AC-4 — 3 queries return expected results; recorded.
- **Deps**: T5. **Size**: M.

### T7 — Railway service + Postgres (FR-3)
- **Do**: Railway project + first service: HyperIndex from this repo, config selection per
  T3, persistent Railway PostgreSQL. **Committed env-var table** (`.env.example` or a
  sprint-doc table): Postgres URL, T1 data source, chain config, RPC key — exact names.
  Pinned build + start commands.
- **Acceptance**: AC-5. **Deps**: T6. **Size**: L. *(Start early — the main schedule risk.)*

### T8 — Observability (NFR-5, SDD §8) ∥
- **Do**: Railway healthcheck → HyperIndex health endpoint (3-fail threshold). Sync-lag
  alert with **exact, rationale-documented thresholds** (initial: chain-head − indexed
  > 300 blocks **or** > 10 min; tuned after first sync). Postgres disk alert ≥ 80%. Route
  to operator + team ops channel.
- **Acceptance**: AC-7 — healthcheck live; alerts configured + test-fired.
- **Deps**: T7. **Size**: M.

### T9 — GraphQL endpoint hardening (SDD §9.2) ∥
- **Do**: Per-IP rate limit + GraphQL depth/complexity cap at the Railway/proxy/Hasura layer.
- **Acceptance**: AC-12 — limits live; verified with an over-limit probe.
- **Deps**: T7. **Size**: M.

### T10 — Stable gateway/proxy URL (SDD §9.1 r3) *(NEW)*
- **Do**: Stand up a lightweight reverse proxy (Railway service or Cloudflare Worker) with a
  **stable public URL**. Its upstream target (the current belt's GraphQL endpoint) is a
  single config/env value. Consumers will point at THIS URL, never the raw Railway service
  URL. Document the upstream-swap procedure — the recovery path if a belt degrades.
- **Acceptance**: AC-13 (new) — gateway URL live, forwards to the belt endpoint; an
  upstream-swap is verified (point it at a second target, confirm traffic follows).
- **Deps**: T7. **Size**: M.

### T11 — Sync + deterministic loan reconciliation (FR-4)
- **Do**: Sync Berachain from start_blocks to head. **Reconciliation method, specified**:
  a script reading on-chain `MiberaLiquidBacking` via `eth_call` (`backingLoanId`, then
  `backingLoanDetails(id)` + `backingLoanExpired(id)` over `0..backingLoanId-1`) at a pinned
  finalized block; compare to the endpoint's active set at the same block. Expected count:
  ≈19 (2026-05-19 reference); gate is exact equality at the pinned block.
- **Acceptance**: AC-6. **Deps**: T7. **Size**: M. *(Historical sync is wall-clock — a
  background long-pole; start as soon as T7 is up.)*

### T12 — score-api empty-safe audit (FR-5, SDD §7 — hard gate)
- **Do**: Audit `score-api/trigger/utils/envio-client.ts` for the **7 named uncovered
  entities** — `PaddleSupply`, `PaddleLiquidation`, `BgtBoostEvent`, `MintEvent`,
  `Erc1155MintEvent`, `CandiesBacking`, `FriendtechTrade` — confirm each query path is
  empty/null-safe. Artifact: `grimoires/loa/a2a/<sprint>/score-api-empty-safe-audit.md`.
- **Cross-repo note**: score-api is a **separate repo**. Any unsafe path is a score-api fix
  with its own review/deploy cycle. Time-box the audit to ½ day; if fixes are needed,
  surface them immediately as a separate score-api work item — they block only T13's
  *score-api* leg, not the mibera-honeyroad leg.
- **Acceptance**: AC-9. **Deps**: none (parallel from T1). **Size**: M.

### T13 — Staged consumer handback (FR-5, SDD §9.1)
- **Do**: After T11 passes + a **soak: ≥ 2 h synced-to-head with healthcheck green and
  sync-lag alert quiet**: repoint **mibera-honeyroad** `NEXT_PUBLIC_ENVIO_URL` → the **T10
  gateway URL**; `/backing` recovers. Then, after T12 passes: repoint **score-api**
  `ENVIO_GRAPHQL_URL` → the gateway URL.
- **Acceptance**: AC-8 — `/backing` renders live loan data; score-api subset resolves,
  uncovered entities return empty arrays.
- **Deps**: T10, T11 (mibera-honeyroad leg); + T12 (score-api leg). **Size**: S.

### T14 — Schema-unchanged confirmation (NFR-1)
- **Do**: Final `git diff schema.graphql` — zero diffs.
- **Acceptance**: AC-10. **Deps**: T2–T13. **Size**: S.

## Dependency Graph

```
T1 ─▶ T2 ─▶ T3 ─▶ T5 ─▶ T6 ─▶ T7 ─┬─▶ T8 ─┐
        └─▶ T4 ─▶ T5             ├─▶ T9 ─┤
                                  ├─▶ T10 ┼─▶ T13 ─▶ T14
                                  └─▶ T11 ┘
T12 (independent from T1) ───────────────▶ T13 (score-api leg)
```

## Verification Spine

T4 automated `field_selection` check (test-first) · T5 codegen+typecheck · T6 local
dev-run entity proof · T11 deterministic on-chain reconciliation · T12 consumer empty-safe
audit · T10 gateway upstream-swap verification.

## Risks

- **T7** — first-time Railway HyperIndex self-host, the one L; T3 spike derisks config
  selection ahead of it. Start early.
- **T11 historical sync** — wall-clock, not effort; RPC fallback (T1) may rate-limit.
  Background long-pole; T8 sync-lag alert detects a stall.
- **T12 cross-repo** — score-api fixes have their own deploy cycle; time-boxed + surfaced
  early so they don't silently block T13.
- **The repoint is still one-way at the consumer→gateway hop** — but it happens *once*,
  to a stable URL; belt-level recovery is a gateway upstream swap (T10), not an outage.

## Definition of Done

All 13 acceptance criteria (AC-1…AC-13) met. `/backing` renders live loan data via the
stable gateway; score-api resolves the deployment-#1 entity subset; `schema.graphql`
unchanged; the belt is observable, hardened, and swap-recoverable behind the gateway.

## Flatline Sprint Review Integration (r2)

Revised per the 2026-05-19 3-model headless Flatline sprint review of r1 (full confidence,
80% agreement). All 16 findings integrated:

- **6 high-consensus** — IMP-001 (name 7 entities → T12), IMP-002 (concrete soak → T13),
  IMP-003 (config-selection fork → T3 spike), IMP-004 (full addresses → T2), IMP-005
  (reconciliation method → T11), IMP-007 (exact alert thresholds → T8).
- **2 disputed** — IMP-009 (env-var table → T7), IMP-010 (early schema diff → T4).
- **8 blockers** — SKP-001·880 + SKP-005·830 + SKP-001·850 (no structural fallback → T10
  stable gateway), SKP-002·840 (truncated addresses → T2), SKP-003·740 + SKP-001·720
  (config-selection undecided/unproven → T3 spike), SKP-004·710 (T12 cross-repo unbounded
  → T12 time-box + early surfacing), SKP-002·750 (RPC historical sync → T1/T11 risk).

Full result: `grimoires/loa/a2a/flatline/sprint-review.json`.
