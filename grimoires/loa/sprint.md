# Sprint Plan — Indexer Belt Rebuild, Deployment #1

> **Cycle**: indexer-belt-rebuild · **Deployment #1** (the fire fix)
> **Implements**: `grimoires/loa/prd.md` (r2) + `grimoires/loa/sdd.md` (r3)
> **Build doc**: `grimoires/loa/specs/indexer-belt-rebuild.md` · **Construct**: `construct-noether`
> **Date**: 2026-05-19 · **Deadline**: live before ~2026-05-27 (10.5-day buffer)
> **Revision**: r3 — split into Sprint 1 (autonomously-codeable) + Sprint 2
> (operator-paired deploy/ops). Task content unchanged from r2 (Flatline-reviewed,
> 16 findings integrated — see end).

## Overview

Deployment #1 — the thin Mibera-belt fire fix: a self-hosted HyperIndex deployment on
Railway indexing `MiberaLiquidBacking` + `MiberaCollection` on Berachain, fronted by a
stable gateway URL, restoring mibera-honeyroad's `/backing`. Split by execution mode:

- **Sprint 1 — Belt Config (code)** — pure file authoring; runs via `/run sprint-1` with
  the implement→review→audit cycle.
- **Sprint 2 — Deploy & Handback** — Railway / Cloudflare / Vercel ops + the one-way
  production repoint; operator-paired, with this plan + `sdd.md` as the runbook.

No handler or schema code changes anywhere.

---

## Sprint 1 — Belt Config (code)

### S1-T1 — Author `config.mibera.yaml` (PRD FR-1, SDD §3.1 + §5)
- **Do**: Create `config.mibera.yaml` — a HyperIndex config, network Berachain `80094`,
  data source defaulting to `berachain.hypersync.xyz` HyperSync (Sprint 2 / S2-T1 confirms
  it). Two contracts, **full addresses**:
  - `MiberaLiquidBacking` — `0xaa04F13994A7fCd86F3BbbF4054d239b88F2744d`, start_block
    `3971122`, 9 events (`LoanReceived`, `BackingLoanPayedBack`, `BackingLoanExpired`,
    `ItemLoaned`, `LoanItemSentBack`, `ItemLoanExpired`, `ItemPurchased`, `ItemRedeemed`,
    `RFVChanged` — signatures per SDD §3.1).
  - `MiberaCollection` — `0x6666397dfe9a8c469bf65dc744cb1c733416c420`, start_block
    `3837808`, `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)`.
  - Per-event `field_selection` copied **verbatim** from `config.yaml` — incl.
    `transaction_fields` `value` on `MiberaCollection.Transfer` and `from` on the
    `MiberaLiquidBacking` events that use it (SDD §5).
- **Acceptance**: AC-2 — config exists, scoped to the 2 contracts; addresses, start_blocks,
  and `field_selection` are byte-identical to `config.yaml`.
- **Deps**: none. **Size**: M.

### S1-T2 — Author `scripts/verify-belt-config` + test (SDD §5.3)
- **Do**: Build `scripts/verify-belt-config` — parses `config.mibera.yaml` + `config.yaml`
  and asserts, per event of both belt contracts, that `field_selection`, addresses, and
  start_blocks are byte-identical; exits non-zero on any mismatch. **Test-first**: write a
  test that injects a `field_selection` mismatch and asserts the script fails, before the
  script is "done". Wire the script as a build/CI gate; runnable locally.
- **Acceptance**: AC-11 — check passes against the real `config.mibera.yaml`; fails on the
  injected-mismatch test.
- **Deps**: S1-T1. **Size**: M.

**Sprint 1 done when**: `config.mibera.yaml` exists + verified by `verify-belt-config`;
`scripts/verify-belt-config` + its test committed; `pnpm tsc --noEmit` clean for any new
TS. Draft PR opened.

---

## Sprint 2 — Deploy & Handback (operator-paired)

Railway / Cloudflare / Vercel ops + the one-way production repoint. Executed by the
operator with this plan + `sdd.md` as the runbook; not autonomous.

### S2-T1 — Data-source verification (FR-0)
Verify `berachain.hypersync.xyz` serves chain `80094` free; else select + verify a public
Berachain RPC (note the rate-limit risk for historical sync). Reconcile S1-T1's config
default with the outcome. → AC-1.

### S2-T2 — Config-selection spike (S0)
Prove how HyperIndex selects `config.mibera.yaml` over default `config.yaml` — build-step
copy vs `--config`/`ENVIO_CONFIG` — across `codegen`, local run, and Railway start. Pick
one mechanism; record it. Half-day box. Derisks S2-T5.

### S2-T3 — Build gate (FR-2)
`pnpm codegen` + `pnpm tsc --noEmit` clean against `config.mibera.yaml`; `verify-belt-config`
green. → AC-3.

### S2-T4 — Local dev run (FR-2)
Run the indexer locally; confirm the 3 SDD §6 queries — `MiberaLoan` non-empty,
`MiberaTransfer` non-empty, `MintActivity` with `amountPaid > 0` present. → AC-4.

### S2-T5 — Railway service + Postgres (FR-3)
Railway project + first service: HyperIndex, config selection per S2-T2, persistent
PostgreSQL, committed env-var table, pinned build/start commands. → AC-5. *(The L; start
early.)*

### S2-T6 — Observability (NFR-5, SDD §8)
Railway healthcheck → HyperIndex health endpoint; sync-lag alert (chain-head − indexed
> 300 blocks or > 10 min, tuned post-sync); Postgres disk alert ≥ 80%; routed to operator
+ ops channel. → AC-7.

### S2-T7 — GraphQL endpoint hardening (SDD §9.2)
Per-IP rate limit + GraphQL depth/complexity cap. → AC-12.

### S2-T8 — Stable gateway/proxy URL (SDD §9.1)
Lightweight reverse proxy (Railway service or Cloudflare Worker), stable public URL,
upstream = single config value. Document the upstream-swap recovery procedure; verify a
swap. → AC-13.

### S2-T9 — Sync + deterministic loan reconciliation (FR-4)
Sync Berachain to head. Reconcile the endpoint's active-loan set against on-chain
`MiberaLiquidBacking` (`eth_call`: `backingLoanId`, `backingLoanDetails`,
`backingLoanExpired` over `0..backingLoanId-1`) at a pinned finalized block — exact
equality (≈19 reference). → AC-6. *(Historical sync = background long-pole.)*

### S2-T10 — score-api empty-safe audit (FR-5, SDD §7 — hard gate)
Audit `score-api/trigger/utils/envio-client.ts` for the 7 uncovered entities
(`PaddleSupply`, `PaddleLiquidation`, `BgtBoostEvent`, `MintEvent`, `Erc1155MintEvent`,
`CandiesBacking`, `FriendtechTrade`) — confirm each query path is empty/null-safe. ½-day
box; score-api fixes have their own repo/deploy cycle — surface immediately. Artifact:
`grimoires/loa/a2a/<sprint>/score-api-empty-safe-audit.md`. → AC-9.

### S2-T11 — Staged consumer handback (FR-5, SDD §9.1)
After S2-T9 + a soak (≥2 h synced-to-head, healthcheck green, sync-lag quiet): repoint
**mibera-honeyroad** `NEXT_PUBLIC_ENVIO_URL` → the S2-T8 gateway URL. Then, after S2-T10:
repoint **score-api** `ENVIO_GRAPHQL_URL` → the gateway URL. → AC-8.

### S2-T12 — Schema-unchanged confirmation (NFR-1)
Final `git diff schema.graphql` — zero diffs. → AC-10.

**Sprint 2 done when**: AC-1, AC-3…AC-10, AC-12, AC-13 met; `/backing` renders live loan
data via the gateway; score-api resolves the deployment-#1 subset.

---

## Dependency Graph

```
Sprint 1:  S1-T1 ─▶ S1-T2
Sprint 2:  S2-T1 ─▶ S2-T2 ─▶ S2-T3 ─▶ S2-T4 ─▶ S2-T5 ─┬─▶ S2-T6 ─┐
           (S1-T1 feeds S2-T3)                          ├─▶ S2-T7 ─┤
                                                        ├─▶ S2-T8 ─┼─▶ S2-T11 ─▶ S2-T12
                                                        └─▶ S2-T9 ─┘
           S2-T10 (independent) ──────────────────────────────────▶ S2-T11 (score-api leg)
```

## Risks

- **S2-T5** — first-time Railway HyperIndex self-host (the one L); S2-T2 spike derisks it.
- **S2-T9 historical sync** — wall-clock, RPC-rate-limit-sensitive; S2-T6 detects a stall.
- **S2-T11 is one-way at the consumer→gateway hop** — but happens once, to a stable URL;
  belt-level recovery is a gateway upstream swap (S2-T8).
- **S2-T10 cross-repo** — score-api fixes deploy on their own cycle; time-boxed + surfaced.

## Definition of Done

All 13 acceptance criteria (AC-1…AC-13, SDD §10) met.

## Flatline Sprint Review Integration

r2 integrated all 16 findings from the 2026-05-19 3-model headless Flatline sprint review
(full confidence, 80% agreement) — stable gateway as the structural fallback, config-
selection spike, full addresses, time-boxed cross-repo audit, exact soak/threshold/
reconciliation specs. r3 split the task set into Sprint 1 / Sprint 2 by execution mode;
no task content changed. Full result: `grimoires/loa/a2a/flatline/sprint-review.json`.
