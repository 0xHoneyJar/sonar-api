# Software Design Document — freeside-sonar, the Belt-Factory Stack

> **Cycle**: indexer-belt-rebuild · **Deployment #1** (the Mibera belt, on the scaled stack)
> **Implements**: `grimoires/loa/prd.md` (r2) · **Build doc**: `grimoires/loa/specs/indexer-belt-rebuild.md`
> **Date**: 2026-05-20 · **Build construct**: `construct-noether`
> **Revision**: **r4** — re-architected per the promoted ARCH brief
> `grimoires/loa/context/arch-brief-freeside-sonar-stack.md`. r4 adopts the L0–L6
> bottom-up stack; introduces **eRPC as the shared L2 substrate** (one deploy, all
> belts × all chains); **retires FR-0's HyperSync assumption** (HyperSync is paid —
> the project is free-only); makes per-belt `src/belts/<belt>/` handler-entrypoint
> directories a **factory invariant**; and pulls **§11 cross-belt federation forward
> as an L5 design input**. r3 (stable-gateway recovery), r2 (Flatline SDD review),
> and r1 are superseded but their findings carry forward — see §13.
> **Stance**: this is an **experimental pressure test, run as science** — state a
> hypothesis, build the experiment, observe, reason from the result. Runway is
> **kaironic and ample** (~10 days as of 2026-05-20). "Risk" below means *an unknown
> to measure*, never *a deadline to fear*.
> **Grounding**: `arch-brief-freeside-sonar-stack.md` · `erpc-rpc-fallback-contingency.md`
> (absorbed) · handler cross-contract analysis (§4.2) · Sprint 1 shipped artifacts
> (`config.mibera.yaml`, `src/belts/mibera/`, `scripts/verify-belt-config.js`).

## 1. Overview

freeside-sonar is **one repo / one building** that publishes **belts** — one
self-hosted Envio HyperIndex deployment per project. This SDD designs the **belt-factory
stack** the whole factory stands on, and lands **Deployment #1** — the **Mibera belt** —
as *instance #1* of that scaled pattern, not as a one-off fire-fix.

Two facts surfaced during Sprint 1 forced the re-architecture:

1. **HyperSync is paid; the project is free-only** (operator, 2026-05-20). The r3 PRD
   FR-0 — *"keep HyperSync if it serves Berachain free"* — is resolved **dead**. The belt
   cannot use HyperSync. It indexes via **JSON-RPC**, through a shared caching proxy.
2. **The factory is 4 belts × up to 6 chains, not one belt.** The data source is not a
   per-belt config detail — it is a **shared substrate** the whole factory rests on.

The design principle (operator, 2026-05-20): *first principles, move down the stack,
build what we know how to build, then build up.* The data-source problem pushed the
design **down** to a new layer — **L2, the eRPC substrate** — and the build sequence
goes **bottom-up**: build L2 solid, then the L3 belt on it, then L5.

Deployment #1 stays **thin** — the Mibera belt indexes exactly two Berachain contracts
(`MiberaLiquidBacking`, `MiberaCollection`) and serves a GraphQL endpoint that two
consumers repoint to via one environment variable each. It is additive **up to the
consumer repoint** — that repoint is the commit point (§10). No handler code changes,
no schema changes.

## 2. The L0–L6 Stack

The factory is a layered station. **A layer is only as sound as the layer beneath it**,
so the layers are built bottom-up.

```
L6  consumers      mibera-honeyroad /backing · score-api · future apps
 ▲                 touch ONLY L5 — never a raw belt endpoint
L5  gateway        stable public URL — 1 belt: proxy · N belts: federation (§9)
 ▲
L4  belt APIs      N × GraphQL endpoints — one per belt (Envio-generated)
 ▲
L3  belt indexers  Envio HyperIndex × {mibera · honeyjar · purupuru · sprawl}
 ▲                 shared src/handlers + schema.graphql · per-belt src/belts/<belt>/
L2  eRPC SUBSTRATE  ◄ BUILD FIRST. ONE shared deploy. cache + hedge + failover.
 ▲                   multi-chain-capable; Deployment #1 wires Berachain only.
L1  free RPC       public + free-tier RPC endpoints ($0), multiple per chain
 ▲
L0  chains         ETH · ARB · Zora · OP · Base · Berachain
```

| Layer | What it is | Own / Rent | Deployment #1 scope |
|---|---|---|---|
| **L0** chains | The chains. Given. | — | Berachain `80094` only |
| **L1** free RPC | Public JSON-RPC endpoints + free-tier accounts (Alchemy/dRPC/etc.) — multiple per chain, all $0. | rent, $0 | Berachain endpoints + accounts selected in S0 (§3) |
| **L2** eRPC | ONE shared caching/hedging/failover proxy in front of L1. **The foundation.** | **own** | built multi-chain-capable, Berachain wired (§3) |
| **L3** belt indexers | Envio HyperIndex, one per belt. `rpc_config` → eRPC. Shared `src/handlers/` + `schema.graphql`; per-belt `src/belts/<belt>/` entrypoint. | **own** | the Mibera belt (§4) |
| **L4** belt APIs | One GraphQL endpoint per belt. | own (Envio-generated) | the Mibera belt's endpoint (§7) |
| **L5** gateway | Stable public URL. 1 belt → simple proxy; N belts → federation. | **own** | simple proxy, *federation-ready interface* (§9) |
| **L6** consumers | Apps. Repoint by one env var each. | — | mibera-honeyroad + score-api (§8) |

**The sovereignty ladder** (own vs rent, as axioms):

| | Layer | Posture |
|---|---|---|
| **OWN** — build + operate | L2 eRPC substrate · L3 indexers · L4/L5 APIs/gateway · L2 cache store | full control |
| **RENT** — data layer, $0 | L1 RPC — public / free-available endpoints (free-tier accounts = deferred fallback) | the free-only constraint lives **here** |
| **RENT** — hosting, paid OK | Railway hosting | operator decision 2026-05-20 — optimize for reliability, not minimal cost |
| **DON'T** (yet) | paid HyperSync · hosted indexers · self-hosted L1 archive nodes | deferred / rejected |

eRPC is a *known, deployable, configurable* component — so **L2 is the floor we build
this round.** Self-hosted archive nodes (a further down-move toward full data-source
sovereignty) are deferred until L2 is solid and node-ops is a known quantity.

### 2.1 The factory repo layout (loa-freeside ADR-008)

```
freeside-sonar  (ONE repo / ONE building)
├── src/handlers/                  shared — all belts reuse the same handler logic
├── src/belts/<belt>/              ◄ FACTORY INVARIANT (§4.3) — per-belt handler-
│   └── EventHandlers.<belt>.ts       registration entrypoint, one dir per belt
├── schema.graphql                 shared — frozen consumer contract
├── config.yaml                    the monolith config (retired as the live indexer)
├── config.mibera.yaml             ← Deployment #1 — Mibera belt scope (Sprint 1)
├── config.honeyjar.yaml             (later belt)
├── config.purupuru.yaml             (later belt)
├── config.sprawl.yaml               (later belt)
├── erpc.yaml                      ◄ NEW (§3) — the shared L2 eRPC substrate config
└── scripts/verify-belt-config.js  ← Deployment #1 — config-fidelity gate (Sprint 1)
```

Each `config.<belt>.yaml` is a complete HyperIndex config scoped to that belt's
contracts, mapping to **its own Railway service** (HyperIndex container + Postgres),
syncing independently. **Why per-belt configs, not per-belt repos**: HyperIndex is one
config per indexer instance; sharing `src/handlers/` + `schema.graphql` keeps one
codebase and one frozen schema. A belt config *grows* — consumers never re-point when a
belt's coverage widens.

## 3. L2 — the eRPC Substrate (the heart of r4)

eRPC is a JSON-RPC caching / load-balancing / failover proxy. In this architecture it is
**one deployment**, sitting in front of L1, serving **all belts × all chains**.

### 3.1 Why shared, not per-belt

Scoping eRPC per-belt (the earlier "eRPC → S2 contingency, scoped to chain 80094"
framing in the absorbed contingency brief) is **wrong**. eRPC is **factory
infrastructure**, like the building's electrical service:

- **One deploy, all belts.** Every belt's HyperIndex points its `rpc_config` at the same
  eRPC URL. Adding belt #2 adds zero eRPC infrastructure.
- **The cache compounds — the load-bearing economic argument.** eRPC caches finalized
  blocks. The *first* belt on a given chain pays the cold sync; **every belt after rides
  the warmed cache.** Belt #2 on Berachain reuses belt #1's cached finalized ranges.
  Bottom-up gets *cheaper* as the factory scales — this is the reason the architecture
  is shaped this way, not a nice-to-have.

### 3.2 `erpc.yaml` — the L2 config (NEW deliverable)

A single `erpc.yaml` at repo root, **multi-chain-capable but Berachain-wired** for
Deployment #1 (do not boil the ocean — §11 OD-4):

- **Projects / upstreams** — one logical project; per-chain upstream groups. Deployment
  #1 declares the **Berachain `80094`** upstream group only. The schema MUST accommodate
  adding ETH / ARB / Base / OP / Zora upstream groups later as a **purely additive**
  edit (no restructuring) — that is the multi-chain-capability requirement.
- **Per-chain upstreams = a free public L1 cluster.** Each chain's group lists multiple
  $0 endpoints — anonymous public / free-available RPC endpoints (Chainlist + the chain's
  documented public RPC) — so eRPC hedges and fails over across them (operator decision
  2026-05-20, refined: **no free-tier-account signups**; §11 OD-1). Berachain coverage is
  thinner than Base/Arbitrum — the specific `80094` endpoints are selected and verified
  in S0. **Free-tier accounts** (Alchemy / dRPC / etc.; better `eth_getLogs` limits,
  still $0) are a **deferred fallback** — wired only if S0 measures public-only as
  inadequate.
- **Reorg-safe cache policy** — finalized blocks → effectively infinite TTL (immutable
  history); chain-tip / unfinalized blocks → short TTL or cache-bypass. eRPC tracks
  finality natively; the config sets the finality-distance / TTL policy per chain.
- **Hedged requests + health tracking** — eRPC issues hedged requests across a chain's
  endpoint cluster, tracks per-endpoint error rate / latency, and auto-blacklists
  degrading endpoints. This is what turns "unreliable free RPC" into "reliable enough to
  index on."
- **Persistence** — eRPC's cache store is a **PostgreSQL** instance, **owned** (Railway
  Postgres plugin). This is a *second* Postgres, distinct from each belt's HyperIndex
  Postgres. Sizing is an open decision (§11 OD-2).
- **Secrets in env, never inline.** The source research doc this design absorbs
  *hardcoded a Postgres password inside `erpc.yaml`* — **rejected** (see §12.4 and the
  absorbed `erpc-rpc-fallback-contingency.md`). The cache-store connection string and
  any keyed endpoints are Railway environment variables; `erpc.yaml` references them by
  variable name only and is safe to commit to git.

### 3.3 eRPC hosting

eRPC runs as **its own dedicated Railway service** with **its own cache Postgres**,
within the one Railway project — not co-located in a belt's container — because it is
shared infrastructure with an independent lifecycle (operator decision 2026-05-20,
§11 OD-2). It exposes an internal/private URL that belt HyperIndex services target.
**Paid Railway hosting is accepted** (operator decision 2026-05-20) — the free-only
constraint applies to the L1 data layer, not hosting; optimize eRPC + its Postgres for
reliability. Initial cache-Postgres sizing is tuned in S1.

### 3.4 The hard problem — cold first-sync (the central hypothesis)

eRPC makes **re-syncs** free and fast. It does **not** make **first** syncs free.

The first `(belt × chain)` sync pulls full history — the Mibera belt from block
`3837808` — through **rate-limited free L1 RPC**. That is slow and *can stall*. Because
the cache compounds (§3.1), it is the **first belt per chain** that pays the cold sync,
not every belt — but someone pays, and the rate is unknown.

This is **the central hypothesis the pressure test verifies**:

> **H1** — *Free public Berachain RPC, fronted by eRPC caching + hedging, can cold-sync
> the Mibera belt from block `3837808` to chain head at a usable rate.* "Usable" is
> **not** a preset threshold — S0 measures the rate and reports the number; the operator
> judges viability from it (operator decision 2026-05-20). Public-only is the hardest
> case for H1; free-tier accounts remain a deferred fallback.

H1 is **not hand-waved and not assumed**. The re-sprint opens with the **S0 calibration
spike** (§11 OD-3) — a half-day experiment that measures the cold-sync throughput of
free Berachain RPC + eRPC from `3837808`. **S0 produces data**: a directional cold-sync
rate. If the observed rate is genuinely slow, that is an *observed result to reason
from* — it informs background-backfill design, sync-lag thresholds (§7.4), and possibly
staggered belt launches so the cache is warm — *not* a panic, because runway is kaironic
and ample. S0 is the **experiment that sequences S1+**, not a fear-gate.

This SDD specs the belt to **background-backfill** (sync runs as the service's own work,
the endpoint serves whatever range is synced so far) and **§7.4 sync-lag alerting** to
catch a stall. The deterministic loan reconciliation (§6) is pinned to a block **past
the synced frontier** at verification time, so it remains exact even mid-backfill.

## 4. L3 — the Mibera Belt Indexer

### 4.1 `config.mibera.yaml` — re-pointed to eRPC (MODIFIED, Sprint 1 artifact)

Sprint 1 shipped `config.mibera.yaml` — a HyperIndex config scoped to the two Mibera
contracts, with event ABIs + per-event `field_selection` extracted **verbatim** from
`config.yaml`. **r4 changes one thing: the data source.**

- **`name`** — `mibera-belt` (belt-scoped indexer name; unchanged).
- **`handlers`** — `src/belts/mibera` (the §4.3 factory invariant; unchanged).
- **`networks` / `chains`** — one entry: Berachain, chain id `80094`.
- **Data source — `hypersync_config` → `rpc_config`.** The Sprint 1 config declares
  `hypersync_config.url: https://berachain.hypersync.xyz`. **r4 retires this.** The
  `chains[0]` entry instead declares an **`rpc_config`** whose URL is the **eRPC L2
  service URL** (§3.3). HyperIndex indexes Berachain over JSON-RPC, through eRPC.
  Auto-discovery is not relied on — the endpoint is explicit (mirrors the existing
  inline-comment rationale for pinning Berachain explicitly).
- **`contracts`** — exactly two, unchanged from Sprint 1:

  **`MiberaLiquidBacking`** — `0xaa04F13994A7fCd86F3BbbF4054d239b88F2744d`, start_block
  `3971122`. 9 events: `LoanReceived(uint256 loanId, uint256[] ids, uint256 amount, uint256 expiry)` ·
  `BackingLoanPayedBack(uint256 loanId, uint256 newTotalBacking)` ·
  `BackingLoanExpired(uint256 loanId, uint256 newTotalBacking)` ·
  `ItemLoaned(uint256 loanId, uint256 itemId, uint256 expiry)` ·
  `LoanItemSentBack(uint256 loanId, uint256 newTotalBacking)` ·
  `ItemLoanExpired(uint256 loanId, uint256 newTotalBacking)` ·
  `ItemPurchased(uint256 itemId, uint256 newTotalBacking)` ·
  `ItemRedeemed(uint256 itemId, uint256 newTotalBacking)` · `RFVChanged(uint256 indexed newRFV)`.

  **`MiberaCollection`** — `0x6666397dfe9a8c469bf65dc744cb1c733416c420`, start_block
  `3837808`. 1 event: `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)`.

Addresses, start_blocks, **and `field_selection`** are diffed against `config.yaml` and
mechanically verified by `scripts/verify-belt-config.js` (§5, PRD FR-1, AC-2 / AC-11).

### 4.2 Handler reuse — verified self-contained

`src/handlers/mibera-liquid-backing.ts` and `src/handlers/mibera-collection.ts` are
reused **as-is, zero code changes**. The cross-contract dependency analysis (PRD FR-2,
addressing Flatline blocker SKP-001·880) confirmed:

- **Zero cross-contract entity dependencies.** Every entity each handler reads back, it
  created itself in an earlier event of the *same* contract.
- **Imports are pure.** `recordAction` (`src/lib/actions.ts`) is a stateless write
  helper; `mint-detection.ts` helpers are pure comparisons; `constants.ts` are static
  maps.
- **The `TrackedErc721` double-write risk is engineered out.** `config.yaml:716-717`
  excludes the Mibera collection address from the `TrackedErc721` contract list. The
  Mibera collection's `TrackedHolder` rows have a *single* writer —
  `handleMiberaCollectionTransfer`.

**Conclusion**: a config scoped to only these two contracts is **data-equivalent to the
monolith** for the consumer entities — by *static* analysis. §6's local dev run is the
empirical confirmation.

Entities written: `mibera-liquid-backing.ts` → `MiberaLoan`, `MiberaLoanStats`,
`TreasuryItem`, `TreasuryStats`, `TreasuryActivity`, `DailyRfvSnapshot`, `Action`;
`mibera-collection.ts` → `MiberaTransfer`, `MintActivity`, `NftBurn`, `NftBurnStats`,
`TrackedHolder`, `MiberaStakedToken`, `MiberaStaker`, `Action`.

### 4.3 `src/belts/<belt>/` — the factory invariant (generalized)

Sprint 1 introduced `src/belts/mibera/EventHandlers.mibera.ts` as the DISS-001 fix. **r4
promotes it from a Mibera-specific fix to a factory invariant** — *every belt gets one.*

**The mechanism** (review finding DISS-001, verified against the shipped artifact):
Envio's `HandlerLoader.registerAllHandlers` (`node_modules/envio/src/HandlerLoader.res.mjs`)
**always** runs `autoLoadFromSrcHandlers(config.handlers)` — it globs
`<handlers>/**/*.{js,mjs,ts}` and imports **every** match, *independent of any
per-contract `handler:` field*. The top-level `handlers` key defaults to `src/handlers`.
If a belt config left `handlers` at the default, a scoped `envio codegen` build would
import **all** handler modules — including other belts' contracts the belt config never
declares — corrupting the scoped build.

**The invariant** (a factory rule, not a Mibera detail):

1. Every belt config sets `handlers: src/belts/<belt>`.
2. That directory contains **exactly one** file — `EventHandlers.<belt>.ts` — the belt's
   handler-registration entrypoint.
3. The entrypoint **imports the belt's handler modules** from shared `src/handlers/`
   (importing them runs their registration calls) and **re-exports** the handler consts
   so the imports are "used" (mirrors `src/EventHandlers.ts`).
4. The autoload glob therefore matches **only** the belt's entrypoint — a scoped
   `envio codegen --config config.<belt>.yaml` build never imports another belt's
   handler modules.
5. **Handler *logic* stays in shared `src/handlers/`** — unchanged, reused across belts.
   `src/belts/<belt>/` holds *registration wiring only*, never business logic.

HoneyJar / Purupuru / Sprawl belts each get a `src/belts/<belt>/EventHandlers.<belt>.ts`
when they ship — this is the documented norm, not an improvisation per belt. The
factory's belt-creation checklist (a §13 forward-pointer) MUST include "create
`src/belts/<belt>/` with the entrypoint" as a step.

### 4.4 `schema.graphql` reuse

Reused **verbatim** — the frozen consumer contract (PRD NFR-1). Entities fed only by
out-of-scope contracts stay empty (empty ≠ error — §8). No entity/field renamed.

### 4.5 Railway deployment — the L3 belt service

One Railway project. Deployment #1 provisions the eRPC service (§3.3), the eRPC cache
Postgres, **and** the Mibera belt service + its own Postgres.

- **Belt service** — HyperIndex built from this repo, run against `config.mibera.yaml`.
- **Config selection** — HyperIndex defaults to `config.yaml`. The belt service points
  it at `config.mibera.yaml` via the **Railway build step copying `config.mibera.yaml`
  → `config.yaml`** in the service's working tree (version-independent; sidesteps any
  `--config`-flag uncertainty). If the installed Envio version supports an explicit
  `--config` / `ENVIO_CONFIG` selector, that is the preferred alternative — confirmed at
  implementation.
- **Build command** — `pnpm install --frozen-lockfile && pnpm envio codegen` (exact
  invocation confirmed against `package.json` + the installed Envio version).
- **Start command** — `pnpm envio start` (or the repo's start script).
- **Database** — a provisioned **persistent PostgreSQL** instance (Railway plugin),
  **separate from the eRPC cache Postgres**. HyperIndex requires Postgres; persistence
  is mandatory or a container restart loses sync state.
- **Environment variables** (enumerated, PRD FR-3b): the belt-Postgres connection URL;
  **the eRPC L2 service URL** (the data source — §3.3, replacing the FR-0 HyperSync
  endpoint); HyperIndex/chain config. Secrets live in Railway env, never in
  `config.mibera.yaml` or git.

## 5. Config `field_selection` Fidelity — mechanically enforced

HyperIndex only exposes transaction/block fields a config *requests*. The correctness
risk is a `field_selection` that omits a field a handler reads — producing silently-wrong
data, no crash. Known field dependencies:

1. **`MiberaCollection.Transfer` requires `transaction_fields: [hash, value]`.**
   `mibera-collection.ts:73` reads `event.transaction.value` → `MintActivity.amountPaid`;
   omitting `value` silently writes `0n`.
2. **`MiberaLiquidBacking` `LoanReceived`/`ItemLoaned`/`ItemPurchased`/`ItemRedeemed`
   require `from`.** Handlers read `event.transaction.from` for `user`/`buyer`/`depositor`/
   actor fields (incl. the `Action:treasury_purchase` buyer).

### 5.1 Automated structural check (Sprint 1 artifact — `scripts/verify-belt-config.js`)

A CRITICAL invariant guarded only by a human "copy verbatim + eyeball the diff" process
is itself a risk (Flatline SKP-001·870 / ·760). Sprint 1 shipped the **structural
verification check**:

- `scripts/verify-belt-config.js` parses `config.mibera.yaml` and `config.yaml`, and for
  **every event of both belt contracts** asserts the `field_selection` (transaction_fields,
  block_fields) is byte-identical to the corresponding `config.yaml` entry. It also
  asserts addresses + start_blocks match.
- It exits non-zero on any mismatch and is wired as a **build/CI gate** (and runnable
  locally pre-commit).
- This makes per-event manual analysis unnecessary — fidelity for all 10 events is
  enforced uniformly and mechanically (resolves Flatline IMP-003).

**r4 note**: the check compares `field_selection` / addresses / start_blocks — fields
*unaffected* by the `hypersync_config` → `rpc_config` data-source change. The Sprint 1
script remains valid as-is; it does not assert anything about the data-source key.
**Factory generalization**: `verify-belt-config.js` SHOULD be parameterized (or
re-runnable per belt) so every future `config.<belt>.yaml` inherits the same gate — a
§13 forward-pointer.

## 6. Handler-Correctness & Endpoint Verification (FR-2, FR-4)

- **Build gate** — `pnpm codegen` + `pnpm tsc --noEmit` clean; §5.1 config check passes.
  Necessary, not sufficient.
- **Local dev run (FR-2, AC-4)** — run the indexer locally against `config.mibera.yaml`
  (`pnpm envio local docker up` + `pnpm envio start`, exact commands per the repo). For
  the local run, the belt may point at eRPC **or**, if eRPC is not yet up locally,
  directly at a free Berachain endpoint — the handler-emission proof is data-source-
  agnostic. Reproducible exit criteria — three GraphQL queries against the local
  endpoint, expected results recorded:
  1. `query { MiberaLoan(limit: 5) { id loanedTo timestampDue backingOwed } }` — non-empty.
  2. `query { MiberaTransfer(limit: 5) { id from to tokenId } }` — non-empty.
  3. `query { MintActivity(where: {amountPaid: {_gt: "0"}}, limit: 5) { id amountPaid } }`
     — at least one row (proves the §5 `value` field flows end-to-end).
- **Deterministic loan reconciliation (FR-4, AC-6)** — pin an exact Berachain block
  height **past finality and past the synced frontier** (recorded in the verification
  artifact). Query the endpoint for active loans at that height. Independently read
  on-chain `MiberaLiquidBacking`: `backingLoanId`, then `backingLoanDetails(id)` +
  `backingLoanExpired(id)` for `id` in `0..backingLoanId-1`. The endpoint's active set
  MUST equal the on-chain active set at that block. The expected count (≈19 per the
  2026-05-19 diagnosis) is recorded as the reference for the pinned block — the gate is
  exact equality, not a fuzzy number.

## 7. L4 — the Belt API & Observability

### 7.1 The belt GraphQL endpoint

L4 is the Envio-generated GraphQL endpoint of the Mibera belt service. It is **not** the
URL consumers touch — consumers touch L5 (§9). The belt endpoint is L5's *upstream
target*.

### 7.2 score-api Partial-Restoration Contract (FR-5)

| Entity | Source contract | Deployment #1 |
|---|---|---|
| `MiberaLoan` | MiberaLiquidBacking | ✅ resolves |
| `MiberaTransfer` | MiberaCollection | ✅ resolves |
| `MintActivity` | MiberaCollection | ✅ resolves |
| `NftBurn` | MiberaCollection (mibera) | ⚠️ mibera burns only (no Milady) |
| `Action` (`treasury_purchase`) | MiberaLiquidBacking | ✅ resolves |
| `PaddleSupply`, `PaddleLiquidation`, `BgtBoostEvent`, `MintEvent`, `Erc1155MintEvent`, `CandiesBacking`, `FriendtechTrade` | out-of-scope contracts | ⬜ empty arrays |

**Partial coverage is more dangerous than no coverage** — a consumer may compute
plausible-but-wrong aggregates over the 7 empty entities. **Empty ≠ error**: uncovered
entities return empty GraphQL arrays, never schema/endpoint errors.

**Pre-repoint safety audit — a HARD acceptance gate (AC-9), not a recommendation:**
- **Owner**: the engineer executing deployment #1.
- **Scope**: each of the 7 uncovered entities, as consumed in
  `score-api/trigger/utils/envio-client.ts`.
- **Exit criterion**: every uncovered-entity query path is confirmed empty/null-safe — an
  empty array does not crash or NaN-poison wallet scoring. Any unsafe path is a score-api
  fix that **blocks the `ENVIO_GRAPHQL_URL` repoint**.
- **Artifact**: findings recorded in `grimoires/loa/a2a/<sprint>/score-api-empty-safe-audit.md`.

### 7.3 The two-layer health story

r4's stack has **two** layers that can fail silently — L2 eRPC and L3 the belt. Both
need health signals; a healthy belt fed by a degraded eRPC is still a degraded factory.

- **L3 belt healthcheck** — the Railway belt service's healthcheck targets HyperIndex's
  health/status endpoint; Railway restarts the service on failure. Cadence: Railway
  default (~30s); failure threshold: 3 consecutive.
- **L2 eRPC healthcheck** — the Railway eRPC service's healthcheck targets eRPC's
  health/metrics endpoint. eRPC exposes per-upstream error-rate metrics; a chain whose
  whole endpoint cluster is blacklisted is an L2 outage and must alert.
- **Postgres disk** — alert on the Railway disk-usage metric at ≥ 80% for **both** the
  belt Postgres and the eRPC cache Postgres.

### 7.4 Sync-lag alert (the stall detector — the silent-death class)

The original incident was a *silent* 404. r4's analogue is a *silent cold-sync stall*
(§3.4). Concrete requirement:

- **Sync-lag alert** — alert when `chain_head_block − indexed_block` exceeds a threshold.
  Initial threshold: `> ~300 blocks` **or** `> 10 min` of wall-clock lag — **tuned after
  the S0 cold-sync calibration (§3.4) gives an observed throughput.** During the initial
  cold backfill the lag is *expected* to be large; the alert distinguishes "backfilling
  at the S0-measured rate" (healthy) from "stalled / making no progress" (the failure
  mode). The S0 rate is the load-bearing input that makes this alert meaningful.
- **Alert destination** — Railway's built-in service notifications to the operator, plus
  a webhook to the team ops channel. The exact channel is an operator config step at
  deploy time; the *requirement* is that L2-degraded / L3-down / sync-stalled / disk-high
  are not silent.

## 8. Data Flow

```
L0  Berachain 80094
        │  eth_getLogs / eth_getBlockByNumber / eth_getTransactionReceipt
L1  free public RPC endpoints  ──(multiple per chain, Chainlist)
        │
L2  eRPC substrate  ── cache (finalized → ∞ TTL) · hedge · failover · auto-blacklist
        │                          └── eRPC cache Postgres (owned)
        │  JSON-RPC (rpc_config → eRPC URL)
L3  Mibera belt — HyperIndex  ── src/belts/mibera entrypoint · src/handlers run
        │                          └── belt Postgres (owned, separate)
L4  belt GraphQL endpoint (Railway internal URL)
        │
L5  stable gateway URL  ── simple proxy now · federation-ready interface (§9)
        │                              │
L6   NEXT_PUBLIC_ENVIO_URL ────────────┘
            ▼                          └──────── ENVIO_GRAPHQL_URL
     mibera-honeyroad /backing                   score-api envio-client.ts
```

## 9. L5 — the Gateway (federation-ready by design)

### 9.1 Recovery — stable gateway, not fix-forward

The r1 PRD called the consumer repoint "one revertible env var" — wrong (Flatline
SKP-002·830). r4 keeps the r3 resolution: a **stable gateway**.

- **Consumers repoint to a stable gateway URL, never the raw Railway belt URL.** A
  lightweight reverse proxy (Railway service or Cloudflare Worker) holds a stable public
  URL; its upstream target — the current belt's L4 GraphQL endpoint — is a single config
  value.
- **The one-way repoint happens once**, to the gateway. Swapping the belt behind it (a
  new deployment, a rollback to a prior good belt, an emergency target) is then an
  **operator-controlled upstream change** with zero consumer impact — the structural
  fallback.
- **Before the repoint** — deployment #1 is fully reversible (new Railway services + new
  URLs; tear them down, nothing else affected).
- **The repoint is staged**: consumers repoint to the gateway only after the belt
  endpoint passes §6 FR-4 deterministic reconciliation **and** a soak (≥2 h
  synced-to-head, healthcheck green, sync-lag quiet). mibera-honeyroad first (loan UI is
  the fire); score-api after its §7.2 empty-safe audit.
- **Post-handback recovery**: if the belt degrades, repoint the gateway upstream — fast,
  operator-controlled, no consumer change, no outage-pressure code fix.

### 9.2 Federation-ready interface — §11 pulled forward (the L5 design input)

The r1–r3 SDDs deferred cross-belt `Action` fragmentation to a post-#1 open question.
**r4 pulls it forward as an L5 design input** — because the factory *is* N belts, and
retrofitting federation into a proxy designed only for one belt is exactly the
"retrofit" the bottom-up principle forbids.

The problem: post-split, each belt is its own HyperIndex DB + GraphQL endpoint, so the
`Action` entity (and any entity fed by contracts in multiple belts) **fragments across
belt databases**. `Action:treasury_purchase / mint / mint1155` come from Mibera-belt
contracts; `Action:hold1155` comes from `CubBadges1155` in the **HoneyJar belt**. A
consumer reading one URL sees only one belt's fragment.

**The L5 design constraint** (binding on Deployment #1's gateway, even though Deployment
#1 ships only the simple proxy):

- **Deployment #1 ships the gateway as a simple single-upstream proxy** (one belt, one
  upstream). Federation is **not built** in Deployment #1.
- **But the gateway's interface MUST be designed so federation is purely additive.** The
  config shape MUST be able to express *N* upstreams without restructuring; the public
  URL + the GraphQL contract consumers see MUST NOT change when a second belt is added.
- **Federation realization options** (decided before the HoneyJar belt ships, not now):
  (a) the gateway fans a query across N belt endpoints and merges results, or (b)
  freeside-sonar exposes a true GraphQL federation/composition endpoint. r4 does **not**
  pick between them — it requires only that Deployment #1's gateway not *foreclose*
  either. The cleaner realization of operator doctrine ("consuming apps compose data
  across belts at the API layer") is (b); (a) is the lower-effort first step.
- **score-api impact**: under Deployment #1, score-api points at the gateway and gets
  **partial** restoration (§7.2). Full `Action` restoration tracks the Mibera-belt
  widening + the HoneyJar belt + the L5 federation work. Deployment #1 is unaffected by
  the federation decision — it is L5 *design surface*, not L5 build scope.

## 10. Rollback, Security & Blast Radius

### 10.1 Reversibility

Deployment #1 is purely additive — new Railway services (eRPC, eRPC Postgres, belt,
belt Postgres) on new URLs. The dead hosted endpoint is already dead; nothing breaks by
standing up replacements. The **only irreversible step is the consumer repoint** (§9.1)
— gated on §6 verification and staged behind the soak.

### 10.2 GraphQL endpoint hardening

The L5 gateway URL is public and unauthenticated (consumers need it; data is public
read-only on-chain data). To prevent trivial DoS / expensive-query abuse (Flatline
SKP-002·750):

- **Rate limiting** — per-IP request rate limit at the L5 gateway / Railway layer.
- **Query-complexity / depth limit** — cap GraphQL query depth and complexity so a single
  query cannot exhaust the indexer (HyperIndex/Hasura-layer setting, or the gateway).
- These are scoped into deployment #1 (operator elected full integration).

### 10.3 L2 secrets posture

eRPC's cache-store credentials and any keyed L1 endpoints are **Railway environment
variables**. `erpc.yaml` references them by variable name only — **no inline
passwords** (§3.2; the absorbed contingency brief flagged the source research doc's
inline-password anti-pattern). `erpc.yaml` is safe to commit; the belt configs and the
gateway config follow the same rule.

### 10.4 Blast radius

| | New | Modified | Deleted |
|---|---|---|---|
| **Code / config** | `erpc.yaml`; gateway config | `config.mibera.yaml` (data source: `hypersync_config` → `rpc_config` → eRPC) | none |
| **Infra** | eRPC Railway service + Postgres; belt Railway service + Postgres; L5 gateway | — | — |
| **Handlers / schema** | none | none (handlers reused as-is; `schema.graphql` verbatim) | none |

Additive only; no contract interaction, no on-chain writes, no auth paths. The only
irreversible step is the consumer repoint (§9.1).

## 11. Risks & Open Decisions

r4's stance: each item below is **an unknown to measure**, not a deadline to fear.
Runway is kaironic and ample (~10 days as of 2026-05-20).

| ID | Risk / decision | Disposition |
|---|---|---|
| **R-1** | **Cold first-sync throughput** (§3.4, hypothesis H1). Free L1 RPC from block `3837808` may be slow or stall. | The **S0 calibration spike** (OD-3) measures it. Background-backfill design + §7.4 sync-lag alert catch a stall. Observed result drives sequencing. |
| **R-2** | **First-time self-host of a two-layer stack** (eRPC + HyperIndex) on Railway — unknown deployment friction. | The kaironic runway absorbs iteration. Deployment #1 is deliberately thin (2 contracts, 1 chain). |
| **R-3** | **The repoint is one-way** (§9.1). | Mitigated structurally by the stable gateway + staged verification, not by rollback. |
| **R-4** | **eRPC cache Postgres sizing** is unknown. | OD-2. Start small; the disk-usage alert (§7.3) catches under-sizing; Railway Postgres resizes. |

**Open decisions for the re-sprint** (do not block the architecture; they are S0/S1
inputs):

**Operator decisions (2026-05-20)** — resolved via AskUserQuestion *before* `/sprint-plan`,
so the re-sprint generates on answers, not assumptions:

- **RPC access** → eRPC's L1 cluster is **public / free-available endpoints only**
  (operator 2026-05-20, refined — free-tier-account signups skipped). Free-tier accounts
  (Alchemy/dRPC) remain a deferred fallback if S0 shows public-only is inadequate.
- **Hosting cost** → **paid Railway hosting is acceptable**; optimize for reliability.
  The free-only constraint is the L1 data layer, not hosting.
- **eRPC topology** → **dedicated** Railway service + own cache Postgres.
- **S0 yardstick** → **none preset**; S0 measures + reports the cold-sync rate, the
  operator judges viability from the number.

- **OD-1 — Free-RPC endpoint selection.** RESOLVED: **public / free-available endpoints
  only** (free-tier-account signups skipped — operator 2026-05-20). The specific
  **Berachain `80094`** public endpoints for the eRPC upstream group are enumerated +
  verified in **S0**. Free-tier accounts are a deferred fallback.
- **OD-2 — eRPC hosting.** RESOLVED: **dedicated** Railway service + own cache Postgres
  (§3.3). Initial cache-Postgres sizing tuned in **S1**.
- **OD-3 — Cold-sync throughput (the S0 experiment).** S0 is a half-day calibration
  spike: free Berachain RPC + eRPC, cold-sync from `3837808`, **measure + report the
  rate**. There is **no preset pass/fail bound** — the operator judges viability from
  the observed number. S0's output sequences S1+ and tunes the §7.4 sync-lag threshold.
- **OD-4 — Deployment #1 chain scope: Berachain-only.** Build eRPC L2
  **multi-chain-capable** (the schema accommodates additive ETH/ARB/Base/OP/Zora upstream
  groups) but **wire only Berachain now.** Do not boil the ocean.
- **OD-5 — L5 federation realization.** Simple proxy for Deployment #1; the
  federation-vs-fan-out choice (§9.2) is decided before the HoneyJar belt — but the
  Deployment #1 gateway interface MUST NOT foreclose either path.

## 12. Build Sequencing — build down, then up

The re-sprint (`/sprint-plan`) builds the stack **bottom-up**:

| Sprint | Layer | What it builds |
|---|---|---|
| **S0** | L1/L2 calibration | **The eRPC calibration spike** (§3.4 H1, OD-3) — a half-day experiment: can free Berachain RPC + eRPC cold-sync the belt from `3837808` at a usable rate? Selects the OD-1 endpoints. **Produces a cold-sync rate** that sequences S1+ and tunes §7.4. |
| **S1** | L2 | Build the eRPC substrate: `erpc.yaml` (multi-chain-capable, Berachain wired — §3.2), the eRPC Railway service + cache Postgres (§3.3). |
| **S2** | L3 | Re-point the Mibera belt to eRPC (`config.mibera.yaml` data source — §4.1) + verify (§6). The Sprint 1 belt artifacts are **reused** — Mibera is *instance #1* of the scaled pattern, not a throwaway. |
| **S3** | L4/L5/L6 | The L5 gateway (simple proxy, federation-ready — §9), endpoint hardening (§10.2), §7 observability, the staged consumer repoint + operator-paired handback. |

S0 is the **first experiment of the pressure test** — run it to *learn the cold-sync
rate*, then sequence from what is observed. Directionally this is correct: **build the
floor (L2) once**, then build up.

## 13. Forward-pointers for the factory (post-#1)

These are *not* Deployment #1 scope — they are the factory norms r4 establishes so later
belts inherit them rather than re-improvising:

- **Per-belt entrypoint** — every later belt creates `src/belts/<belt>/EventHandlers.<belt>.ts`
  (§4.3). This belongs on a belt-creation checklist.
- **Config-fidelity gate** — `scripts/verify-belt-config.js` SHOULD be parameterized so
  every `config.<belt>.yaml` inherits the §5.1 gate.
- **eRPC additive multi-chain** — adding a chain to the factory is a purely additive
  `erpc.yaml` upstream-group edit (§3.2) — no L2 restructuring.
- **L5 federation** — resolved before the HoneyJar belt (§9.2 / OD-5); the Deployment #1
  gateway interface is built not to foreclose it.
- **Self-hosted L1 archive nodes** — the *next* down-the-stack sovereignty move (full
  data-source ownership), deferred until L2 is solid and node-ops is a known quantity
  (§2 sovereignty ladder).

## 14. Revision History & Flatline Carry-Forward

**r4 (2026-05-20)** — re-architected per the promoted ARCH brief
`arch-brief-freeside-sonar-stack.md`. Adopts the L0–L6 bottom-up stack; introduces eRPC
as the shared L2 substrate (§3); retires FR-0's HyperSync assumption — the belt indexes
via JSON-RPC through eRPC (§3, §4.1); generalizes `src/belts/<belt>/` to a factory
invariant (§4.3); pulls §11 cross-belt federation forward as an L5 design input (§9.2).
Absorbs `erpc-rpc-fallback-contingency.md` (the eRPC analysis; its "park it, gated"
recommendation is superseded — eRPC is now L2 of the scaled stack, not a contingency).

**r3 / r2 / r1 carry-forward** — superseded by r4 but their findings remain in force:

- **r3** — stable-gateway recovery model (3 sprint-phase CRITICALs). Carried into §9.1.
- **r2 — Flatline SDD review** (2026-05-19, 3-model headless; 88% agreement; 15
  findings, all integrated):
  - 6 high-consensus — IMP-001 partial-coverage danger → §7.2; IMP-002 deployment
    commands → §4.5; IMP-003 un-analyzed events → §5.1 mechanical check; IMP-004 audit as
    verifiable AC → §7.2 / AC-9; IMP-005 concrete healthcheck → §7.3; IMP-006 exact
    reference block → §6.
  - 1 disputed — IMP-009 reproducible AC-4 → §6 (dev command + 3 queries).
  - 8 blockers — SKP-001·870 + SKP-001·760 field_selection automated check → §5.1;
    SKP-002·830 stranded rollback → §9.1; SKP-004·710 observability spec → §7.3 / §7.4;
    SKP-003·720 Postgres disk alert → §7.3; SKP-001·850 partial-data degradation → §7.2;
    SKP-003·740 audit as hard gate → §7.2 / AC-9; SKP-002·750 endpoint hardening → §10.2.
- **DISS-001** (Sprint 1 review) — Envio handler autoload globs the whole `handlers`
  directory → per-belt entrypoint directory + scoped `handlers:` key. Generalized to a
  factory invariant in §4.3.

Full prior results: `grimoires/loa/a2a/flatline/sdd-review.json`,
`grimoires/loa/a2a/sprint-1/reviewer.md`.

## 15. Verification → Acceptance Criteria Mapping

PRD r2 acceptance criteria, re-mapped onto the r4 stack. **FR-0 (HyperSync verification)
is retired** — its AC is replaced by the eRPC-substrate criteria. New r4 criteria are
marked.

| SDD section | Acceptance criterion |
|---|---|
| §3.4 / §12 S0 | **AC-1 (r4, replaces FR-0 AC)** — S0 calibration spike run; the free-RPC + eRPC cold-sync rate from block `3837808` is **measured and recorded** as an observed result. |
| §3.2 / §3.3 | **AC-1b (r4, new)** — `erpc.yaml` exists, multi-chain-capable, Berachain `80094` upstream group wired; eRPC Railway service + cache Postgres deployed; secrets in env, none inline. |
| §4.1 + §5.1 automated check | **AC-2** — `config.mibera.yaml` scoped to the two contracts on `80094`; `field_selection` / addresses / start_blocks byte-identical to `config.yaml` per `verify-belt-config.js`. |
| §4.1 data source | **AC-2b (r4, new)** — `config.mibera.yaml` data source is `rpc_config` pointed at the eRPC L2 URL; no `hypersync_config` remains. |
| §4.3 | **AC-2c (r4, new)** — `config.mibera.yaml` sets `handlers: src/belts/mibera`; that directory holds exactly the belt entrypoint; a scoped `envio codegen` imports no other belt's handler modules. |
| §6 build gate + §5.1 check | **AC-3** — `pnpm codegen` and `pnpm tsc --noEmit` run clean. |
| §6 local dev run (3 queries) | **AC-4** — a local dev run shows both handlers emitting correct entity data scoped to the two contracts. |
| §4.5 Railway + Postgres | **AC-5** — the belt Railway service + persistent belt Postgres deploy; HyperIndex syncs Berachain from start_blocks toward head through eRPC. |
| §6 deterministic reconciliation | **AC-6** — the endpoint's active-loan count reconciles exactly with on-chain `MiberaLiquidBacking` state at a pinned block past finality + past the synced frontier. |
| §7.3 / §7.4 observability | **AC-7** — L3 belt healthcheck, **L2 eRPC healthcheck**, sync-lag alert, and disk alerts (both Postgres) are live. |
| §9.1 staged repoint → mibera-honeyroad | **AC-8** — mibera-honeyroad `/backing` renders live loan data after the `NEXT_PUBLIC_ENVIO_URL` repoint to the gateway. |
| §7.2 pre-repoint empty-safe audit (hard gate) | **AC-9** — `envio-client.ts` audited; after the `ENVIO_GRAPHQL_URL` repoint, the deployment-#1 entity subset resolves and uncovered entities return empty arrays without errors. |
| §4.4 schema reuse | **AC-10** — `schema.graphql` unchanged; no entity or field renamed. |
| §5.1 structural check in CI | **AC-11** — the `field_selection` structural check is wired as a CI gate and passes. |
| §10.2 endpoint hardening | **AC-12** — the L5 gateway's per-IP rate limit + query depth/complexity cap are live. |
| §9.1 / §9.2 stable gateway | **AC-13** — the L5 gateway holds a stable public URL; an upstream-swap is verified; the gateway config can express N upstreams without restructuring (federation-ready). |
