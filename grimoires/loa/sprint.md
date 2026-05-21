# Sprint Plan — Indexer Belt Rebuild (re-sprint, SDD r4)

> **Cycle**: indexer-belt-rebuild · **Re-sprint** against SDD **r4** §12
> **Implements**: `grimoires/loa/prd.md` (r2) + `grimoires/loa/sdd.md` (**r4**)
> **Date**: 2026-05-19 · **Runway**: kaironic, ample (~10 days as of 2026-05-20)
> **Revision**: r4 — re-sequenced for the **L0–L6 bottom-up stack**. SDD r4
> introduces **eRPC as the shared L2 substrate**; the belt now indexes Berachain via
> JSON-RPC *through eRPC*, retiring r3's HyperSync data source. Builds **floor-first**.

## Overview

SDD r4 re-architects Deployment #1 as the first instance of a **factory stack**
(`grimoires/loa/sdd.md` §2, §12). The build goes **bottom-up**: stand the L2 eRPC
substrate up *once*, then point the belt at it, then verify and expose it. eRPC is
shared infrastructure — "the building's electrical service" (SDD §3.1) — so the cache
warmed by Mibera's cold sync compounds for every later belt.

> SDD r4 §12: *"build the floor (L2) once, then build up."*

**Sprint sequencing** (SDD r4 §12 table):

| Sprint | Layer | What it builds | Mode |
|---|---|---|---|
| **S0** | L1/L2 calibration | The eRPC calibration spike — measure free-Berachain-RPC + eRPC cold-sync rate | Operator-paired spike |
| **S1** | L2 | The eRPC substrate — `erpc.yaml` + dedicated Railway service + cache Postgres | Code (`erpc.yaml`) + operator-paired infra |
| **S2** | L3 | Re-point the Mibera belt to eRPC + verify | Code (`config.mibera.yaml`) + operator-paired verify |
| **S3** | L4/L5/L6 | L5 gateway, §7 observability, hardening, staged repoint + handback | Operator-paired ops |

**Sprint 1 (belt config) is already COMPLETE** — `config.mibera.yaml`,
`scripts/verify-belt-config.js`, `src/belts/mibera/EventHandlers.mibera.ts` (`/run sprint-1`,
2026-05-20; commits 1052125, 8cb08ce, 9a97c1a; AC-2 + AC-11 met). Its artifacts are
**reused, not redone** — see S2-T1, which *modifies* the existing config (one key: the
data source). Re-sprint task numbering below restarts at S0; the completed belt config
is not re-listed as a task.

> SDD r4 §12: *"The Sprint 1 belt artifacts are **reused** — Mibera is instance #1 of
> the scaled pattern, not a throwaway."*

**Operator decisions baked in** (SDD r4 §11, resolved via AskUserQuestion 2026-05-20 —
this plan generated *on answers, not assumptions*):

- **RPC access** → eRPC L1 cluster is **public endpoints + free-tier accounts** ($0).
- **Hosting cost** → **paid Railway hosting is acceptable**; the free-only constraint is
  the L1 data layer, not hosting. Optimize eRPC + Postgres for reliability.
- **eRPC topology** → **dedicated** Railway service + its own cache Postgres.
- **S0 yardstick** → **no preset pass/fail**; S0 measures + reports the cold-sync rate;
  the operator judges viability from the number.
- **OD-4 chain scope** → eRPC built **multi-chain-capable**, only **Berachain wired now**.
- **OD-5** → L5 ships as a simple proxy but the interface MUST NOT foreclose federation.

**Framing**: experimental pressure-test. S0 is the *first experiment* — run it to *learn
the cold-sync rate*, then sequence S1+ from what is observed. No item in this plan is a
deadline to fear; each unknown is a number to measure (SDD §11).

---

## Sprint 0 — eRPC Calibration Spike (the central experiment)

> **Scope**: SMALL (2 tasks) · **Layer**: L1/L2 calibration · **Budget**: half-day box
> **Mode**: operator-paired spike. Per OperatorOS S0 calibration-spike pattern — a new
> external-infra integration (eRPC + free-RPC) with non-trivial integration cost; surface
> the cost in S0 so S1+ inherit the pinning.

**Sprint Goal**: Measure — not guess — whether free Berachain RPC fronted by eRPC can
cold-sync the Mibera belt from block `3837808` at a usable rate, and enumerate the
specific OD-1 endpoints/accounts that S1's `erpc.yaml` will wire.

This is **hypothesis H1** under test (SDD §3.4): *"Free Berachain RPC (public endpoints +
free-tier accounts), fronted by eRPC caching + hedging, can cold-sync the Mibera belt
from block `3837808` to chain head at a usable rate."* There is **no preset threshold** —
S0 produces a directional rate; the operator judges viability (SDD §11 OD-3).

### S0-T1 — Enumerate + verify the OD-1 Berachain public-RPC cluster
- **Do**: Enumerate candidate **Berachain `80094`** L1 endpoints — anonymous public /
  free-available RPC endpoints (Chainlist + Berachain's documented public RPC).
  **No free-tier-account signups** (operator decision 2026-05-20). For each candidate,
  verify it serves chain `80094`: confirm `eth_chainId` returns `0x138de` (80094),
  `eth_blockNumber` returns a plausible head, and probe its `eth_getLogs` block-range
  limit (Berachain coverage is thinner than Base/Arbitrum — SDD §3.2). Record the
  verified set + each endpoint's observed `eth_getLogs` limit.
- **Acceptance**: Resolves **OD-1** — a verified list of `≥2` working public `80094`
  endpoints recorded as S1's `erpc.yaml` upstream-group input. (Free-tier accounts
  remain a deferred fallback if S0-T2 measures public-only as inadequate.)
- **Deliverable**: `grimoires/loa/spikes/s0-erpc-calibration.md` §"OD-1 endpoint table".
- **Deps**: none. **Size**: S.

### S0-T2 — Measure the cold-sync rate (the H1 experiment) → **[G1, G2]**
- **Do**: Run a half-day eRPC + free-RPC cold-sync experiment from block `3837808`. Stand
  eRPC up disposably (local container or a throwaway Railway service is fine — this is a
  spike, not the S1 deploy), point it at the S0-T1 endpoint cluster, and cold-sync the
  Mibera belt config through it. **Measure**: blocks/sec (or blocks/min) cold-sync
  throughput; eRPC cache hit/miss behavior; per-endpoint error rate / blacklist events;
  whether the sync stalls or progresses. **No pass/fail bound** — record the observed
  number. Half-day time-box: if not synced-to-head in the box, that *is* the result —
  report the partial rate + extrapolated full-sync wall-clock.
- **Acceptance**: **AC-1 (r4)** — the free-RPC + eRPC cold-sync rate from `3837808` is
  **measured and recorded as an observed result**. The spike script self-deletes after
  the artifact is written (S0-spike NET-0-LOC convention); eRPC config/findings carry
  into S1.
- **Deliverable**: `grimoires/loa/spikes/s0-erpc-calibration.md` — cold-sync rate, eRPC
  behavior notes, the §7.4 sync-lag threshold S1 should adopt, and a sequencing
  recommendation for S1+ (e.g. staggered launches if the rate is slow).
- **Deps**: S0-T1. **Size**: M.

**Sprint 0 done when**: `grimoires/loa/spikes/s0-erpc-calibration.md` exists with the
OD-1 endpoint table + a measured cold-sync rate. **Operator pair-point** — the operator
reads the number and decides S1 sequencing (proceed straight through / stagger / adjust).
Per SDD §11 this is a *result to reason from*, not a gate.

---

## Sprint 1 — Build the eRPC L2 Substrate

> **Scope**: MEDIUM (4 tasks) · **Layer**: L2 · **Mode**: `erpc.yaml` authoring is code
> (`/build`); the Railway service + Postgres provisioning is operator-paired infra ops.

**Sprint Goal**: Stand the shared eRPC substrate up *once* — `erpc.yaml`
(multi-chain-capable, Berachain wired) running as a dedicated Railway service with its
own cache Postgres — the factory floor every later belt rides for free.

> SDD §3.1: *"One deploy, all belts. … The cache compounds — Bottom-up gets cheaper as
> the factory scales."*

### S1-T1 — Author `erpc.yaml` (the L2 config) → **[G2]** ✅ COMPLETE (2026-05-20, review-approved)
- **Do**: Author a single `erpc.yaml` at repo root (SDD §3.2). **Multi-chain-capable but
  Berachain-wired** — one logical project; the **Berachain `80094`** upstream group
  declared, listing the S0-T1-verified endpoint cluster (mixed public + free-tier).
  - **Schema MUST accommodate adding ETH / ARB / Base / OP / Zora upstream groups later
    as a purely additive edit** — no restructuring (OD-4, the multi-chain requirement).
  - **Reorg-safe cache policy** — finalized blocks → effectively-infinite TTL; chain-tip /
    unfinalized → short TTL or cache-bypass; set the per-chain finality-distance / TTL.
  - **Hedged requests + health tracking** — hedge across the `80094` cluster; track
    per-endpoint error-rate / latency; auto-blacklist degrading endpoints.
  - **Persistence** — cache store = a PostgreSQL connection, referenced **by env-var name
    only** (`erpc.yaml` is committed to git; SDD §10.3).
  - **Secrets in env, never inline** — no Postgres password, no endpoint key in the file.
    Keyed endpoints reference Railway env vars by name. (SDD §3.2 explicitly rejects the
    inline-password anti-pattern from the absorbed research doc.)
- **Acceptance**: **AC-1b (r4)** — `erpc.yaml` exists, multi-chain-capable, `80094`
  upstream group wired; **zero secrets inline** (grep the file — no password, no key).
- **Deps**: S0-T1 (endpoint cluster). **Size**: M.

### S1-T2 — Provision the dedicated eRPC Railway service + cache Postgres → **[G2]**
- **Do** *(operator-paired infra)*: In the one Railway project, provision **eRPC as its
  own dedicated service** (not co-located in a belt container — OD-2 / SDD §3.3) running
  `erpc.yaml`, plus a **dedicated Railway PostgreSQL cache instance** (distinct from any
  belt Postgres). Wire the cache-Postgres connection string + any keyed-endpoint keys as
  **Railway environment variables**; pin the eRPC service's build/start commands. eRPC
  exposes an **internal/private URL** that belt HyperIndex services will target. Paid
  Railway tier is accepted — optimize for reliability.
- **Acceptance**: **AC-1b (r4)** — eRPC Railway service + cache Postgres deployed; eRPC
  reachable on its internal URL; secrets in env, none inline. The internal URL is
  recorded as S2's data-source input.
- **Deliverable**: env-var table + the eRPC internal URL recorded in the deploy runbook.
- **Deps**: S1-T1. **Size**: L. *(First-time eRPC self-host — the long pole; S0's
  disposable eRPC stand-up de-risks it.)*

### S1-T3 — Tune initial cache-Postgres sizing (OD-2) → **[G2]**
- **Do** *(operator-paired)*: Set initial eRPC cache-Postgres sizing — start small per
  SDD §11 R-4 / OD-2; Railway Postgres resizes. Inform the size from S0's observed cache
  behavior (S0-T2 notes hit/miss + cached-range volume).
- **Acceptance**: cache Postgres sized; the **§7.3 disk-usage alert (≥80%)** is noted as
  the under-sizing backstop for S3-T3 to wire.
- **Deps**: S1-T2, S0-T2. **Size**: S.

### S1-T4 — eRPC smoke verification → **[G1, G2]**
- **Do** *(operator-paired)*: Smoke-verify the L2 substrate end-to-end before any belt
  depends on it. Issue JSON-RPC calls (`eth_chainId`, `eth_blockNumber`, an `eth_getLogs`
  range query) **through the deployed eRPC URL** for chain `80094`; confirm correct
  responses, observe a cache hit on a repeated finalized-range query, and confirm
  failover (manually mark an endpoint bad or observe an auto-blacklist).
- **Acceptance**: eRPC answers `80094` JSON-RPC correctly; a repeated finalized query is
  served from cache; failover across the endpoint cluster is observed.
- **Deps**: S1-T2. **Size**: S.

**Sprint 1 done when**: `erpc.yaml` committed (multi-chain-capable, Berachain wired, zero
inline secrets); eRPC + cache Postgres live on Railway as a dedicated service; eRPC
smoke-verified for `80094`. AC-1b met. The eRPC internal URL is handed to S2.

---

## Sprint 2 — Re-point the Mibera Belt to eRPC + Verify (L3)

> **Scope**: MEDIUM (5 tasks) · **Layer**: L3 · **Mode**: `config.mibera.yaml` edit is
> code (`/build`); the build gate, dev run, Railway deploy, sync + reconciliation are
> operator-paired.

**Sprint Goal**: Point the **already-built** Mibera belt config at the L2 eRPC substrate,
deploy the belt service, and verify the belt emits correct, on-chain-reconciled loan data.

> SDD r4 §4.1: *"Sprint 1 shipped `config.mibera.yaml` … **r4 changes one thing: the
> data source.**"*

### S2-T1 — Re-point `config.mibera.yaml` data source to eRPC → **[G1, G3]** ✅ COMPLETE (2026-05-20, review-approved)
- **Do**: Modify the **existing, Sprint-1-completed** `config.mibera.yaml` — change **one
  thing** (SDD §4.1): replace `hypersync_config` (`https://berachain.hypersync.xyz`) with
  an **`rpc_config`** whose URL is the **eRPC L2 internal URL** from S1-T2. HyperIndex
  then indexes Berachain over JSON-RPC through eRPC. Everything else is **unchanged and
  reused**: `name: mibera-belt`, `handlers: src/belts/mibera`, the two contracts +
  addresses + start_blocks (`MiberaLiquidBacking` `0xaa04F13994A7fCd86F3BbbF4054d239b88F2744d`
  / `3971122`; `MiberaCollection` `0x6666397dfe9a8c469bf65dc744cb1c733416c420` / `3837808`),
  all per-event `field_selection`. Do **not** redo the belt config — only the data-source
  key. Re-run `scripts/verify-belt-config.js` to confirm the data-source change left
  `field_selection` / addresses / start_blocks byte-identical to `config.yaml`.
- **Acceptance**: **AC-2b (r4)** — data source is `rpc_config` → the eRPC L2 URL; **no
  `hypersync_config` remains**. **AC-2 / AC-2c** still hold — `verify-belt-config.js`
  green; `handlers: src/belts/mibera` holds exactly the belt entrypoint.
- **Deps**: S1-T2 (eRPC URL). **Size**: S. *(Reuses Sprint 1 artifacts — one-key edit.)*

### S2-T2 — Build gate against `config.mibera.yaml` → **[G1]**
- **Do** *(operator-paired)*: `pnpm envio codegen` + `pnpm tsc --noEmit` run **clean**
  against `config.mibera.yaml`; `scripts/verify-belt-config.js` green; the §5.1 config
  check wired as a CI gate (**AC-11**). Note: bd-1kg (`sf-vaults.ts` tsc errors) and
  bd-3nb (unscoped `pnpm test`) are pre-existing, NOT introduced — scoped `codegen` over
  `src/belts/mibera` should not pull `sf-vaults` in (DISS-001 autoload-glob fix). If
  scoped codegen still surfaces them, that is a finding to surface, not silently fix.
- **Acceptance**: **AC-3** — `pnpm codegen` + `pnpm tsc --noEmit` clean; **AC-11** — the
  `field_selection` structural check passes as a CI gate.
- **Deps**: S2-T1. **Size**: M.

### S2-T3 — Local dev run — the 3 handler-emission queries → **[G1, G3]**
- **Do** *(operator-paired)*: Run the indexer locally against `config.mibera.yaml`
  (`pnpm envio local docker up` + `pnpm envio start`, exact commands per the repo). For
  the local run the belt may point at eRPC **or** directly at a free Berachain endpoint —
  the handler-emission proof is data-source-agnostic (SDD §6). Confirm the 3 reproducible
  SDD §6 queries: (1) `MiberaLoan(limit:5)` non-empty; (2) `MiberaTransfer(limit:5)`
  non-empty; (3) `MintActivity(where:{amountPaid:{_gt:"0"}},limit:5)` ≥1 row (proves the
  §5 `value` field flows end-to-end). Record expected results.
- **Acceptance**: **AC-4** — local dev run shows both handlers emitting correct entity
  data scoped to the two contracts; all 3 queries return as specified.
- **Deps**: S2-T2. **Size**: M.

### S2-T4 — Deploy the L3 belt Railway service + belt Postgres → **[G1, G2]**
- **Do** *(operator-paired)*: In the same Railway project, provision the **Mibera belt
  service** — HyperIndex from this repo run against `config.mibera.yaml` — plus its **own
  persistent PostgreSQL** (separate from the eRPC cache Postgres — SDD §4.5). **Config
  selection**: the Railway build step copies `config.mibera.yaml` → `config.yaml` in the
  service working tree (version-independent; sidesteps `--config`-flag uncertainty); if
  the installed Envio version supports `--config` / `ENVIO_CONFIG`, prefer that — confirm
  at deploy. Build command `pnpm install --frozen-lockfile && pnpm envio codegen`; start
  command `pnpm envio start`. Enumerate env vars (FR-3b): belt-Postgres URL, **the eRPC
  L2 URL** (data source), chain config — secrets in Railway env, never in git.
- **Acceptance**: **AC-5** — belt Railway service + persistent belt Postgres deploy;
  HyperIndex syncs Berachain from the start_blocks toward head **through eRPC**.
- **Deliverable**: enumerated belt env-var table in the deploy runbook.
- **Deps**: S2-T1, S1-T4. **Size**: L. *(First-time HyperIndex self-host; start early.)*

### S2-T5 — Sync to head + deterministic loan reconciliation → **[G1, G3]**
- **Do** *(operator-paired)*: Let the belt cold-sync Berachain to head **through eRPC**
  (background-backfill; the endpoint serves whatever range is synced — SDD §3.4).
  Reconcile the endpoint's active-loan set against on-chain `MiberaLiquidBacking` at a
  block pinned **past finality and past the synced frontier**: read `backingLoanId`, then
  `backingLoanDetails(id)` + `backingLoanExpired(id)` for `id` in `0..backingLoanId-1`.
  The endpoint's active set MUST **exactly equal** the on-chain active set (≈19 is the
  2026-05-19 reference; the gate is exact equality at the pinned block). Record the
  pinned block + the reference count in the verification artifact.
- **Acceptance**: **AC-6** — the endpoint's active-loan count reconciles **exactly** with
  on-chain `MiberaLiquidBacking` state at the pinned block.
- **Deps**: S2-T4. **Size**: L. *(Historical cold sync = wall-clock long-pole; S0's
  measured rate sets the expectation; the S3-T3 sync-lag alert catches a stall.)*

**Sprint 2 done when**: `config.mibera.yaml` points at eRPC (AC-2b); build gate green
(AC-3, AC-11); local dev run proves handler emission (AC-4); belt service + Postgres live
and syncing through eRPC (AC-5); active loans reconcile exactly on-chain (AC-6).

---

## Sprint 3 — L4/L5/L6 — Gateway, Observability, Hardening, Handback

> **Scope**: LARGE (7 tasks) · **Layer**: L4/L5/L6 · **Mode**: operator-paired ops. This
> plan + `sdd.md` are the runbook. The consumer repoint is one-way — gated + staged.

**Sprint Goal**: Front the belt with a stable, federation-ready L5 gateway; make both L2
and L3 fail loudly not silently; harden the public endpoint; and stage the one-way
consumer repoint behind verification + a soak.

> SDD §7.3: *"a healthy belt fed by a degraded eRPC is still a degraded factory"* — the
> stack has **two** silent-failure layers; both need health signals.

### S3-T1 — Stand up the L5 gateway (stable URL, federation-ready) → **[G1, G3]**
- **Do** *(operator-paired)*: Stand up a lightweight reverse proxy (Railway service or
  Cloudflare Worker) holding a **stable public URL**; its upstream — the belt's L4
  GraphQL endpoint (the Railway internal URL) — is a **single config value**. The
  interface MUST be **federation-ready** (OD-5 / SDD §9.2): the config shape MUST be able
  to express **N upstreams without restructuring**, and the public URL + GraphQL contract
  MUST NOT change when a second belt is added. Federation is **not built** now — only
  not-foreclosed. Document the upstream-swap recovery procedure and **verify a swap**.
- **Acceptance**: **AC-13** — the L5 gateway holds a stable public URL; an upstream-swap
  is verified; the gateway config can express N upstreams without restructuring.
- **Deps**: S2-T4 (belt L4 URL). **Size**: M.

### S3-T2 — GraphQL endpoint hardening → **[G1]**
- **Do** *(operator-paired)*: At the L5 gateway / Railway layer, add a **per-IP request
  rate limit** and a **GraphQL query depth/complexity cap** (HyperIndex/Hasura-layer
  setting or the gateway) so a single query cannot exhaust the indexer (SDD §10.2).
- **Acceptance**: **AC-12** — the L5 gateway's per-IP rate limit + query depth/complexity
  cap are live.
- **Deps**: S3-T1. **Size**: S.

### S3-T3 — Two-layer observability — health, sync-lag, disk alerts → **[G1]**
- **Do** *(operator-paired)*: Wire the SDD §7.3 / §7.4 observability:
  - **L3 belt healthcheck** — Railway belt-service healthcheck → HyperIndex
    health/status endpoint (~30s cadence, 3-consecutive failure threshold; Railway
    restarts on failure).
  - **L2 eRPC healthcheck** — Railway eRPC-service healthcheck → eRPC health/metrics
    endpoint; alert when a chain's whole endpoint cluster is blacklisted (an L2 outage).
  - **Sync-lag alert** — alert when `chain_head_block − indexed_block` exceeds the
    threshold — **initial `>~300 blocks` or `>10 min`, tuned to S0's measured cold-sync
    rate** (S0-T2 / SDD §7.4). The alert distinguishes "backfilling at the S0 rate"
    (healthy) from "stalled" (the silent-death failure mode).
  - **Postgres disk alerts** — ≥80% disk-usage alert on **both** the belt Postgres and
    the eRPC cache Postgres.
  - Route all alerts to the operator + the team ops channel (Railway notifications +
    webhook; exact channel is an operator deploy-time config step).
- **Acceptance**: **AC-7** — L3 belt healthcheck, L2 eRPC healthcheck, sync-lag alert,
  and both Postgres disk alerts are live.
- **Deps**: S3-T1, S1-T2. **Size**: M.

### S3-T4 — score-api empty-safe audit (HARD GATE) → **[G1, G3]**
- **Do** *(operator-paired)*: Audit `score-api/trigger/utils/envio-client.ts` for the **7
  uncovered entities** (`PaddleSupply`, `PaddleLiquidation`, `BgtBoostEvent`, `MintEvent`,
  `Erc1155MintEvent`, `CandiesBacking`, `FriendtechTrade`). Confirm **every** uncovered-
  entity query path is empty/null-safe — an empty array does not crash or NaN-poison
  wallet scoring (partial coverage is *more* dangerous than none — SDD §7.2). Any unsafe
  path is a score-api fix that **blocks the `ENVIO_GRAPHQL_URL` repoint**; score-api fixes
  deploy on their own repo/cycle — surface immediately, do not absorb. ½-day box.
- **Acceptance**: **AC-9** — `envio-client.ts` audited; uncovered entities return empty
  arrays without errors; findings recorded.
- **Deliverable**: `grimoires/loa/a2a/<sprint>/score-api-empty-safe-audit.md`.
- **Deps**: none (independent — can run in parallel with S3-T1..T3). **Size**: M.

### S3-T5 — Staged consumer handback → **[G1, G3]**
- **Do** *(operator-paired, one-way)*: After S2-T5 reconciliation passes **and** a soak
  (≥2 h synced-to-head, healthcheck green, sync-lag quiet — SDD §9.1):
  1. Repoint **mibera-honeyroad** `NEXT_PUBLIC_ENVIO_URL` (Vercel) → the S3-T1 gateway
     URL. Confirm `/backing` renders live loan data.
  2. After S3-T4 passes: repoint **score-api** `ENVIO_GRAPHQL_URL` → the gateway URL.
  Both repoint to the **stable gateway URL**, never the raw belt URL — so post-handback
  belt recovery is a gateway upstream-swap (S3-T1), not an outage-pressure code fix.
- **Acceptance**: **AC-8** — mibera-honeyroad `/backing` renders live loan data after the
  `NEXT_PUBLIC_ENVIO_URL` repoint to the gateway.
- **Deps**: S2-T5, S3-T1, S3-T4 (score-api leg only). **Size**: M.

### S3-T6 — Schema-unchanged confirmation → **[G3]**
- **Do** *(operator-paired)*: Final `git diff schema.graphql` — **zero diffs**. No entity
  or field renamed across the whole cycle (SDD §4.4, the frozen consumer contract).
- **Acceptance**: **AC-10** — `schema.graphql` unchanged.
- **Deps**: none. **Size**: S.

### S3-T7 — End-to-End Goal Validation → **[G1, G2, G3]** *(P0 — Must Complete)*
- **Do** *(operator-paired)*: Validate the three PRD goals end-to-end against the live
  stack:
  - **G1 — Restore `/backing`**: load mibera-honeyroad `/backing` against the live
    gateway; loan state (`active`, `expired`, `user`, `rfv`) renders. *(Validated via
    S3-T5 + a live page load.)*
  - **G2 — Deliver the first belt / factory pattern**: confirm the deployed shape *is*
    the reusable pattern — eRPC L2 shared substrate + `src/belts/mibera` per-belt
    entrypoint + `verify-belt-config.js` config-fidelity gate + the Railway service
    layout. Confirm a 2nd belt would add **zero eRPC infrastructure** (additive
    `erpc.yaml` upstream group only). *(Validated via S1 + the SDD §13 forward-pointers.)*
  - **G3 — Schema contract preserved**: both consumers recovered by **one env var each**,
    zero consumer code changes; `schema.graphql` byte-unchanged. *(Validated via S3-T5 +
    S3-T6.)*
- **Acceptance**: all three PRD goals demonstrably met against the live deployment;
  result recorded.
- **Deps**: S3-T5, S3-T6. **Size**: S.

**Sprint 3 done when**: AC-7, AC-8, AC-9, AC-10, AC-12, AC-13 met; `/backing` renders
live loan data via the L5 gateway; score-api resolves the Deployment #1 entity subset;
all 3 PRD goals validated E2E (S3-T7).

---

## Dependency Graph

```
S0:  S0-T1 ─▶ S0-T2
            │  (cold-sync rate → tunes S3-T3 sync-lag threshold)
S1:  S0-T1 ─▶ S1-T1 ─▶ S1-T2 ─┬─▶ S1-T3   (S0-T2 also feeds S1-T3 sizing)
                               └─▶ S1-T4
S2:  S1-T2 ─▶ S2-T1 ─▶ S2-T2 ─▶ S2-T3
     S1-T4 ┐
     S2-T1 ┴─▶ S2-T4 ─▶ S2-T5
S3:  S2-T4 ─▶ S3-T1 ─┬─▶ S3-T2
                     └─▶ S3-T3   (S1-T2 also feeds S3-T3)
     S3-T4 (independent — parallel with S3-T1..T3)
     S2-T5 ┐
     S3-T1 ┼─▶ S3-T5 ─▶ S3-T6 ─▶ S3-T7
     S3-T4 ┘ (score-api leg)
```

## Risk Register

| ID | Risk | Mitigation |
|---|---|---|
| **R-1** | **Cold first-sync throughput** (H1). Free Berachain RPC from `3837808` may be slow or stall. | **S0-T2 measures it** — observed result, not preset gate. Background-backfill design + S3-T3 sync-lag alert catch a stall. The S0 number sequences S1+. |
| **R-2** | **First-time two-layer self-host** (eRPC + HyperIndex) on Railway — unknown deployment friction. | S0's disposable eRPC stand-up de-risks S1-T2. Kaironic runway absorbs iteration. Deployment #1 is deliberately thin (2 contracts, 1 chain). S1-T2 + S2-T4 are the two L's — start each early in its sprint. |
| **R-3** | **The consumer repoint is one-way.** | Structural mitigation — stable L5 gateway (S3-T1) + staged verification (S2-T5 + soak), not rollback. Post-handback recovery = gateway upstream-swap. |
| **R-4** | **eRPC cache-Postgres sizing unknown.** | S1-T3 starts small; S3-T3 disk alert catches under-sizing; Railway Postgres resizes. |
| **R-5** | **score-api cross-repo** — empty-safe fixes deploy on score-api's own cycle. | S3-T4 is time-boxed (½ day) + a HARD gate; unsafe paths surface immediately and block the score-api repoint leg only — mibera-honeyroad handback (S3-T5 step 1) is not blocked by it. |
| **R-6** | **bd-1kg / bd-3nb pre-existing build defects** (`sf-vaults.ts` tsc, unscoped `pnpm test`). | NOT introduced by this cycle; the DISS-001 autoload-glob fix should keep scoped `codegen` clear of `sf-vaults`. S2-T2 surfaces — not silently fixes — if they recur. |

## Definition of Done

All r4 acceptance criteria met (SDD §15): **AC-1**, **AC-1b**, **AC-2**, **AC-2b**,
**AC-2c**, **AC-3**…**AC-13**. (AC-2 / AC-2c were met by the completed Sprint 1 and are
re-confirmed by S2-T1's `verify-belt-config.js` re-run after the data-source edit.)
`/backing` renders live loan data via the L5 gateway; score-api resolves the Deployment
#1 entity subset; all 3 PRD goals validated E2E.

---

## Appendix C — Goal Traceability

PRD goals (`prd.md` §2): **G1** restore `/backing` · **G2** first belt / factory pattern ·
**G3** preserve the schema contract (one-env-var consumer recovery).

| Goal | Contributing tasks |
|---|---|
| **G1** — Restore `/backing` | S0-T2, S2-T1, S2-T3, S2-T4, S2-T5, S3-T1, S3-T2, S3-T3, S3-T4, S3-T5, **S3-T7** |
| **G2** — First belt / factory pattern | S0-T2, S1-T1, S1-T2, S1-T3, S1-T4, S2-T4, **S3-T7** |
| **G3** — Preserve schema contract | S2-T1, S2-T3, S2-T5, S3-T1, S3-T4, S3-T5, S3-T6, **S3-T7** |

Every goal has contributing tasks. **S3-T7** is the E2E goal-validation task in the final
sprint (P0 — Must Complete). No warnings.

> **Reuse note**: Sprint 1 (the completed belt-config build — `config.mibera.yaml`,
> `verify-belt-config.js`, `src/belts/mibera/`) contributes to **G2** and **G3** but is
> not re-listed as a re-sprint task; SDD r4 §12 designates it *reused, not redone*.

---

## SDD r4 Carry-Forward

This re-sprint regenerates against **SDD r4** (`grimoires/loa/sdd.md` §12 build
sequencing). r4 re-architected Deployment #1 from a single self-host into the **L0–L6
bottom-up factory stack** — eRPC as the shared L2 substrate (§3); the belt indexes via
JSON-RPC through eRPC, retiring r3's HyperSync data source (§4.1); `src/belts/<belt>/` is
a factory invariant (§4.3); L5 federation pulled forward as a design input (§9.2). The
four operator decisions (SDD §11, 2026-05-20) — public+free-tier RPC, paid-Railway-OK,
dedicated eRPC, measure-no-preset — are baked into S0–S3 above. All 16 r2 Flatline
findings + r3's stable-gateway resolution + DISS-001 remain in force, carried into the
r4 SDD sections this plan cites.
