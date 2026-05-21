# Session 1 — Indexer Belt Rebuild

> The hosted Envio indexer died. Rebuild it as self-hosted, per-belt deployments — starting with the one belt that's on fire.

## Context

The Envio **hosted** indexer (`indexer.hyperindex.xyz`) is **dead** — confirmed HTTP 404 across the base domain + deployment slugs `914708e` and `b5da47c` (2026-05-19). This repo (`freeside-sonar`, forked from `moose-code/thj`) IS the monolithic indexer that was deployed there.

Consequence: every downstream consumer reading that endpoint is degraded. **Two consumers depend on it directly:**
- **mibera-honeyroad** — the sacred `/backing` loan UI. Loan routes (`active-loans`, `expired-loans`, `user-loans`, `rfv-data`) read this indexer; users can't see loan state.
- **freeside-score / score-api** — wallet scoring. All reads in one file: `score-api/trigger/utils/envio-client.ts`. Its 12 entities are a frozen contract — see *Downstream Consumer Contract* below.

**On-chain loan diagnosis 2026-05-19 — VERDICT: CLEAR.** 19 active loans, 0 past expiry, 0 within 7 days. Soonest expiry: loan #134 due **2026-05-30**. So this is a *this-week build*, not a tonight-scramble. **Deployment #1 target: live before ~2026-05-27.**

The rebuild: stop renting a hosted indexer. Self-host. And decompose the monolith **by project** into independently-syncing **belts**.

## The factory model (ADR-008 — loa-freeside)

- `freeside-sonar` = **ONE building** — this one repo, one beacon.
- It publishes **belts** — one per project. A belt is the unit of publication.
- Each belt = **its own self-hosted HyperIndex deployment on Railway**, syncing **independently**. Syncing all projects in one indexer is too slow (the monolith's problem) and won't scale.

## The belt principle (operator doctrine, 2026-05-19)

A belt is a **backend mental-model grouping** — "which project owns this contract." It is **NOT** a consumption boundary. Consuming apps compose data **across belts** at the API layer; access is gated there by access level. Un-owned shared infra (BGT token, Berachain validator modules) lives in the belt of its consuming project. The indexer surfaces on-chain data; belt grouping is for *our* organization.

## The 4 belts

Source of truth for addresses + start_blocks: this repo's **`config.yaml`** (41 contracts, 6 chains: Ethereum `1`, Arbitrum `42161`, Zora `7777777`, Optimism `10`, Base `8453`, Berachain `80094`).

### 🐻 Mibera belt
`MiberaCollection` (10k 721) · `GeneralMints` (vm/shadows/gif) · `TrackedErc721` (fractures #1, #2-miladies, tarot) · `MiberaStaking` · `MiberaPremint` · **`MiberaLiquidBacking`** (★ loan/treasury — `0xaa04F13994A7fCd86F3BbbF4054d239b88F2744d`) · `CandiesMarket1155` (drugs/candies) · `MiberaSets` (OP) · `MiberaZora1155` (Zora) · `PaddleFi` (lending backend) · `MiladyCollection` (= fracture #2) · `MirrorObservability` (lore articles) · `Seaport` (trades) · `FriendtechShares` · `BgtToken` · `ValidatorWithdrawalModule` · `ValidatorDepositRouter`.

### 🍯 HoneyJar belt
`HoneyJar` ×6 · `Honeycomb` · `MoneycombVault` · `CubBadges1155`.

### 🌸 Purupuru belt
`PuruApiculture1155` + `puru_elemental_jani` + `puru_boarding_passes` + `puru_introducing_kizuna` — all ERC-1155 on Base. **See `grimoires/loa/puru-erc1155-fix-plan.md`** — a detailed existing plan that fixes the mis-registration of 3 of these (currently under `TrackedErc721`, which never fires because they emit `TransferSingle`/`TransferBatch`). That fix folds into the Purupuru belt deployment.

### 🌃 Sprawl belt
Greenfield. No `world-sprawl` contracts in the monolith config — enumerate during the Sprawl-belt deployment.

### Archived / dead — NOT indexed (revive only if a breakage surfaces)
`CrayonsFactory` · `CrayonsCollection` · `SFVault×3` · `TrackedErc20` · `AquaberaVault×2` · `FatBera×2` · `BeaconDeposit` · `BlockRewardController` · `AutomatedStake` · `HenloVault` · `ApdaoAuctionHouse` (~14 contracts retired).

## Downstream Consumer Contract — FROZEN

Two apps consume this indexer's GraphQL. Entity + field names are a **hard contract** — the rebuild MUST preserve them exactly. Self-hosting HyperIndex with the existing `schema.graphql` satisfies this. Do NOT rename entities or fields.

**Consumer 1 — mibera-honeyroad** (`/backing` loan UI). Repoint env: `NEXT_PUBLIC_ENVIO_URL`.

**Consumer 2 — score-api** (freeside-score, wallet scoring). All reads in one file: `score-api/trigger/utils/envio-client.ts`. Repoint env: `ENVIO_GRAPHQL_URL`. 12 frozen entities — type + every field name exact:

| Entity | Fed by | In deploy #1? |
|---|---|---|
| `MiberaLoan` | MiberaLiquidBacking | ✅ yes |
| `MiberaTransfer` · `MintActivity` | MiberaCollection | ✅ yes |
| `NftBurn` | MiberaCollection (mibera) · MiladyCollection (milady) | ⚠️ mibera only |
| `Action` | many contracts — cross-belt, see note | ⚠️ `treasury_purchase` only |
| `PaddleSupply` · `PaddleLiquidation` | PaddleFi | ❌ Mibera-belt widen |
| `BgtBoostEvent` | BgtToken | ❌ Mibera-belt widen |
| `MintEvent` | GeneralMints | ❌ Mibera-belt widen |
| `Erc1155MintEvent` | MiberaSets (OP) | ❌ Mibera-belt widen |
| `CandiesBacking` | CandiesMarket1155 | ❌ Mibera-belt widen |
| `FriendtechTrade` | FriendtechShares (Base) | ❌ Mibera-belt widen |

**Cross-belt fragmentation — OPEN DECISION (does NOT block deployment #1):** the `Action` entity is populated by contracts across MULTIPLE belts — `Action:treasury_purchase / mint / mint1155` from Mibera-belt contracts, `Action:hold1155` from `CubBadges1155` which lives in the **HoneyJar belt**. Post-split, each belt is its own HyperIndex DB + GraphQL endpoint, so `Action` rows fragment across belt databases. score-api reads ONE `ENVIO_GRAPHQL_URL` today. When belts beyond Mibera ship, score-api must either (a) query multiple belt endpoints and merge in `envio-client.ts`, or (b) the freeside-sonar building exposes a composition/federation endpoint that fans across belts (the cleaner realization of "compose at the API layer"). **Deployment #1 is unaffected** — score-api points at the Mibera-belt endpoint and gets partial restoration; full restoration tracks the Mibera-belt widening + the HoneyJar belt. Resolve the composition strategy before the HoneyJar belt ships.

## Load Order

Read before building:
1. `BUTTERFREEZONE.md` — what this repo is
2. `config.yaml` — the monolith config; the contract → address → chain → start_block source of truth
3. `schema.graphql` — entity definitions
4. `grimoires/loa/HANDLER_REGISTRY.md` + `grimoires/loa/ENTITY_REFERENCE.md` — handler + entity maps
5. `src/EventHandlers.ts` + `src/handlers/` — handler implementations
6. `grimoires/loa/puru-erc1155-fix-plan.md` — exemplar of a well-formed change plan in this repo; relevant to the Purupuru belt
7. This repo's memory: `grimoires/loa/memory/`

## Persona

**`construct-noether`** — the smart-contract construct (event handlers, contract reading, ABI work). If not installed in `.claude/constructs/packs/`, install via `/constructs`. Operator-named build construct.

## Key Structural Decision

**How does one repo deploy N belt-scoped subsets?** HyperIndex is one `config.yaml` per indexer instance. So:

> **Recommendation: per-belt config files.** `config.mibera.yaml`, `config.honeyjar.yaml`, `config.purupuru.yaml`, `config.sprawl.yaml` — each a HyperIndex config scoped to that belt's contracts. **Shared** `src/handlers/` + `schema.graphql` (one codebase). Each config → its own Railway service. The current monolith `config.yaml` is retired (or becomes the first belt config).

A belt's config **grows** — deployment #1's `config.mibera.yaml` is scoped thin (2 contracts); widen it later. Consumers never re-point when a belt's coverage grows.

## ARCH — Ostrom's Three Questions

- **Invariant**: the GraphQL **schema shape** — TWO consumers depend on exact entity + field names (mibera-honeyroad loan routes; score-api `envio-client.ts` — see *Downstream Consumer Contract*, 12 frozen entities). Self-hosting HyperIndex with the existing `schema.graphql` preserves it → consumers repoint via URL only. AND: `feedback_backing_is_sacred` — the loan data path must be correct, not just present.
- **Blast radius (deployment #1)**: NEW — `config.mibera.yaml`, a Railway service, a Dockerfile/Railway config. MODIFIED — none (handlers reused as-is). DELETED — none. The dead hosted endpoint is *already* dead; there is nothing to break by standing up a replacement.
- **Reversibility**: deployment #1 is purely additive — a new Railway service serving a new URL. If it's wrong, the fix is config-only. mibera-honeyroad's repoint is one env var (`NEXT_PUBLIC_ENVIO_URL`) — trivially revertible.

## What to Build — Deployment #1 (the fire fix)

Scope: **`MiberaLiquidBacking` + `MiberaCollection`** on Berachain `80094`. Dependency-ordered:

### 1. `config.mibera.yaml` — thin belt config
A HyperIndex config indexing exactly `MiberaLiquidBacking` (`0xaa04F1…2744d`) + `MiberaCollection` on Berachain `80094`. Pull both addresses + start_blocks from the existing `config.yaml`. Reuse the existing `schema.graphql` (unused entities stay empty — fine).

### 2. Verify the handlers fire
`MiberaLiquidBacking` + `MiberaCollection` handlers already exist in `src/handlers/` / `EventHandlers.ts` (they're in the monolith). Confirm they emit the entities mibera-honeyroad's loan routes query. The loan model: `backingLoanDetails(id)` → `(loanedTo, timestampDue, interestOwed, backingOwed, defaultCreatorFee)`; loans enumerated `0..backingLoanId-1`; `backingLoanExpired(id)` seizes. `pnpm codegen` + `pnpm tsc --noEmit` clean.

### 3. Self-host on Railway
HyperIndex is open-source — self-host it. Railway service running this indexer against `config.mibera.yaml`. One Railway project; this is the first service in it. Free public RPC for now (config currently uses `berachain.hypersync.xyz` HyperSync — keep HyperSync if it still serves Berachain free; else RPC fallback).

### 4. Verify the GraphQL endpoint
Endpoint up, syncs Berachain from the contracts' start_blocks, serves loan + collection data. Spot-check: query active loans, confirm 19 active (matches the 2026-05-19 diagnosis).

### 5. Hand back the URL
Both consumers repoint at the new Mibera-belt endpoint:
- **mibera-honeyroad** — set `NEXT_PUBLIC_ENVIO_URL` (Vercel). `/backing` recovers: `active-loans`, `expired-loans`, `user-loans`, `rfv-data`.
- **score-api** — set `ENVIO_GRAPHQL_URL` in `score-api/trigger/utils/envio-client.ts`. **Partial** restoration: deployment #1's two contracts feed `MiberaLoan`, `MiberaTransfer`, `MintActivity`, `NftBurn(mibera)`, `Action:treasury_purchase`. The rest restores as the Mibera belt widens + the HoneyJar belt ships.

## What NOT to Build

- **NOT all 4 belts at once.** Deployment #1 is Mibera-belt-thin (2 contracts). Widen + other belts come after.
- **NOT a handler rewrite.** Self-host the *existing* HyperIndex handlers. The hosted service died; the code didn't.
- **NOT the archived contracts.** ~14 retired — don't index them.
- **NOT the puru-erc1155 fix** in deployment #1 — that's a Purupuru-belt task; the plan already exists at `puru-erc1155-fix-plan.md`.
- **NOT the stale cycle-048 sprint** (`sprint.md` — Loa-framework review-pipeline maintenance, unrelated; leave it).
- **NOT per-belt schemas yet.** Shared `schema.graphql`; revisit only if it proves a problem.
- **NOT renaming entities or fields.** `schema.graphql` is a frozen consumer contract — mibera-honeyroad AND score-api read exact type + field names. Self-host the schema verbatim.

## Verify

- `pnpm codegen` + `pnpm tsc --noEmit` — clean
- Railway service deploys, HyperIndex syncs Berachain from start_blocks to head
- GraphQL endpoint returns loan data for `MiberaLiquidBacking`; active-loan count ≈ 19 (per the 2026-05-19 on-chain diagnosis — sanity check)
- mibera-honeyroad: set `NEXT_PUBLIC_ENVIO_URL` → `/backing` renders live loan data
- score-api: set `ENVIO_GRAPHQL_URL` → `envio-client.ts` entities resolve (partial set per deployment #1's scope — see What to Build step 5)

## Key References

| Topic | Path |
|---|---|
| Monolith config (addresses/start_blocks) | `config.yaml` |
| Entity definitions | `schema.graphql` · `grimoires/loa/ENTITY_REFERENCE.md` |
| Handler map | `grimoires/loa/HANDLER_REGISTRY.md` · `src/handlers/` |
| Purupuru belt fix (later) | `grimoires/loa/puru-erc1155-fix-plan.md` |
| Factory model / belts | loa-freeside ADR-008 · RFC #207 |
| Loan diagnosis + belt decomposition | mibera-honeyroad memory: `project_freeside_sonar_belts.md`, `project_envio_indexer_state.md` |

## Strategic Note

Operator, 2026-05-19: *"Now is the time we learn to actually build [indexers]. We cannot rely on other teams or SaaS products."* Deployment #1 is the fire fix AND the first in-house self-hosted indexer — a capability-building deliverable. Build it deliberately; it's the template for the other 3 belts.
