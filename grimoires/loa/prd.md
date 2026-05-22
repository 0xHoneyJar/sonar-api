# Product Requirements Document — sonar-api Belt-Factory

> **Cycle**: `sonar-belt-factory` · **Created**: 2026-05-21 · **Persona**: SHIP/ARCH (BARTH + protocol/noether)
> **Builds on**: `grimoires/loa/context/arch-brief-freeside-sonar-stack.md` (ACTIVE, operator-promoted 2026-05-20) · `SCALE.md` Decision Log D4
> **Supersedes data-source assumption of**: archived `indexer-belt-rebuild` cycle (Mibera belt, merged PR #13)
> **Grounding legend**: `[CODE:file]` = codebase reality · `> file:line` = doc quote · `(Direction 2026-05-21 QN)` = operator AskUserQuestion answer this session

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

`sonar-api` (formerly `freeside-sonar`, repo origin `0xHoneyJar/sonar-api`) is the THJ sovereign on-chain indexer — today a **single Envio HyperIndex deployment** ingesting 41 contract definitions across 6 chains into 93 GraphQL entities, serving CubQuests, score-api, Set&Forgetti, ApiologyDAO, and the Mibera substrate `[CODE:reality/architecture-overview.md]`.

Its structural bottleneck: **one deployment indexing 6 chains means any contract-source addition forces a full reindex of all chains**, blocking every consumer for 30 min–several hours.

> "the structural fix is in Decision Log D4 (per-chain deployment split)." — `SCALE.md:21`

This cycle is **D4's kickoff**: decompose the monolith into **independently-deployable, pure-product belts**, each owning its own runtime + schema + substrate; declare them to `loa-freeside`'s federation via a **BeaconV3** contract; and structure the new serving layer on the **Effect `domain/ports/live/mock`** pattern. Belts become sovereign data producers; the federation layer (loa-freeside registry + MCP gateway) becomes the cross-cutting + analytics consumer. Multi-tenant hosted; decoupled enough that a future tenant (e.g. AP DAO) can self-host cheaply.

---

## Problem Statement

### The Problem
A monolithic indexer cannot scale across products or tenants. Adding or changing one product's source re-indexes everything, and there is no contract-shaped seam for consumers (or future tenant operators) to bind to other than a raw Hasura URL.

### User Pain Points
- **Consumers** (apdao-auction-house, score-mibera, mibera-codex, dimensions) "see stale or missing data" during any reindex `> SCALE.md:15`.
- **Operators** must run blue-green + page 4+ consumer maintainers for any source addition `> SCALE.md:80` — config-tightening gave "negligible UX improvements in backfill time" `> SCALE.md:21`.
- **Prospective tenants** (AP DAO) cannot run their own slice without inheriting the whole monolith.

### Current State `[CODE:reality/]`
- One Envio HyperIndex V3 deployment (`b5da47c` authoritative + `914708e` mirror) `> claims-to-verify.md:T3`.
- 41 contracts / 93 entities / 30 handler modules / 6 chains (ETH, OP, ARB, Base, Berachain-primary, Zora).
- eRPC shared cache substrate live; cache compounds across belts (empirically confirmed this session: Bera re-sync accelerated ~1,620 → 6,593 blk/s as cache warmed).
- Belt-factory primitive exists (`config.mibera.yaml` + `src/belts/mibera/` + `verify-belt-config` gate; ADR-008 belt-as-unit-of-publication).

### Desired State
N independently-deployable pure-product belts; a source change reindexes only its belt's chains; each belt declares itself to loa-freeside via BeaconV3; consumers reach belts through the federation gateway; uptime guarded by SLO + an Effect mock/live test harness.

---

## Goals & Success Metrics

### Primary Goals
1. **G1 — Full migration**: every existing indexed item sorted into a pure-product belt. *Not just AP DAO — the whole monolith, migrated together.* (Direction 2026-05-21 Q-scope)
2. **G2 — Blast-radius isolation**: a source change reindexes only its belt's chains, zero impact on other belts. (D4 payoff)
3. **G3 — Federation contract**: sonar-api declares its belts via a spiked BeaconV3 contract; consumers route through loa-freeside, not raw Hasura URLs.
4. **G4 — Uptime**: sync-lag SLO defined + monitored; Effect mock/live harness green as a CI gate.

### Key Performance Indicators (success gates — operator-confirmed, Direction 2026-05-21 Q-success)
| KPI | Target |
|---|---|
| **Blast-radius proof** | Adding/changing a source in belt X reindexes ONLY belt X's chains; other belts untouched (measured: 0 reindex events on sibling belts) |
| **BeaconV3 declared + routed** | sonar-api declares to loa-freeside registry; ≥1 consumer reaches a belt through the federation gateway (spike-level: contract validated against `loa-freeside/packages/beacon-schema`) |
| **Uptime SLO + harness green** | Sync-lag SLO thresholds defined + monitored; Effect live/mock harness passes in CI |
| **All items sorted into belts** | 41/41 contracts + 93/93 entities assigned to a belt; none orphaned in a monolith remainder |

### Constraints
- **Own-vs-rent sovereignty ladder** `> arch-brief §2`: OWN indexer/schema/gateway/eRPC/cache; RENT free RPC + Railway; DEFER paid HyperSync (currently used only as Base break-glass).
- **Multi-tenant hosted** now; no packaged installable this cycle, but belts decoupled so future self-host is cheap. (Direction 2026-05-21 Q-tenancy)
- **ClickHouse/Dune deferred** to a fast-follow; it lives at the federation layer, not in belts. (Direction 2026-05-21 Q-serving)

---

## User Personas & Use Cases

### Primary Persona: Indexer Operator (us / zerker)
- **Job**: add/change a product's sources without re-syncing unrelated products; keep all consumers green.
- **Use case**: "Add an apdao contract → only the apdao belt reindexes; Mibera/score stay live."

### Secondary Persona: Consumer App (score-api, mibera-honeyroad, CubQuests, Set&Forgetti, dimensions, mibera-codex, future Quest API / Dune)
- **Job**: query authoritative on-chain data through one consistent, discoverable endpoint.
- **Use case**: "score-api federates across the mibera + berachain-core + paddle belts via the gateway, not N hardcoded Hasura URLs."

### Tertiary Persona: Tenant Operator (AP DAO)
- **Job**: consume (and possibly later self-host) their belt without inheriting the monolith.
- **Use case**: "AP DAO's belt runs in our multi-tenant infra now; the decoupling means they could lift it out later." (Direction 2026-05-21 Q-tenancy)

---

## Functional Requirements

### FR-0: S0 Calibration Spike — Envio multi-deployment mechanics (gates the sprint)
Before sprint commitment, a half-day spike verifies: (a) how Envio runs N independent deployments (separate Postgres? separate Railway service? schema subset per belt?), (b) per-belt infra cost, (c) Envio per-mutation reset semantics (closes SCALE.md D6). **Output finalizes the belt count** — cost may consolidate some products. (Direction 2026-05-21 Q-cost: "S0 spike decides")
> Sources: operator CLAUDE.md S0-spike doctrine (untested integration path), SCALE.md:D6

### FR-1: Belt taxonomy — pure-product partition
Partition all 41 contracts / 93 entities into **pure-product belts**; cross-consumer needs handled at federation, never by consumer-shaped belts. (Direction 2026-05-21 Q-boundaries: "Pure product belts + federate")

**Seeded candidate taxonomy** (final partition + count is the first `/architect` deliverable, informed by FR-0):

| Belt | Contracts (candidate) | Chains |
|---|---|---|
| `honeyjar` | HoneyJar (×6 chains), HoneyJar2/3/4/5Eth, Honeycomb, MoneycombVault | ETH·ARB·Zora·OP·Base·Bera *(cross-chain rollup)* |
| `mibera` | MiberaCollection/Premint/Staking/Sets/Zora/LiquidBacking, Seaport, MirrorObservability, MiladyCollection | Bera·OP·ETH |
| `sf-vaults` | SFVaultERC4626, SFMultiRewards, SFVaultStrategyWrapper, HenloVault | Bera |
| `apdao` | ApdaoAuctionHouse, TrackedErc721 (seat) | Bera |
| `berachain-core` | FatBera×2, BeaconDeposit, BlockRewardController, AutomatedStake, Validator×3, BgtToken | Bera |
| `aquabera` | AquaberaVault, AquaberaVaultDirect | Bera |
| `crayons` | CrayonsFactory, CrayonsCollection | Bera |
| `purupuru` | PuruApiculture1155 | Base |
| *(to place in /architect)* | PaddleFi, CandiesMarket1155, CubBadges1155, GeneralMints, FriendtechShares, TrackedErc20 — currently bundled in the shipped score-api-footprint belt; move to product homes | Bera/Base |

**Rule**: utility contracts that serve multiple products (`BgtToken`, `TrackedErc721/Erc20`) and shared entity *shapes* (`Action`, `Mint`, `Holder`, `Token`) index in exactly ONE belt; other consumers read them through the gateway — never duplicated in indexing. (Direction 2026-05-21 Q-cross-cutting)

### FR-2: Per-belt independent deployment
Each belt = its own deployable unit (Envio deployment + persistence + serving), parameterized by `config.<belt>.yaml` + `src/belts/<belt>/` + the `verify-belt-config` fidelity gate (extends the existing factory primitive).

### FR-3: Blast-radius isolation
A source addition/change in belt X triggers reindex of belt X's chains only. Verified by an observable proof (sibling belts show 0 reindex events). Blue-green per SCALE.md guardrails applies per belt.

### FR-4: BeaconV3 declaration (spike, not full wiring)
sonar-api authors a BeaconV3 declaration for its belts, validated against `loa-freeside/packages/beacon-schema`. Full registry aggregation + MCP-gateway routing is a follow-up joint cycle with loa-freeside. (Direction 2026-05-21 Q-federation: "Spike contract now, wire later")
> Manifest authoring → beacon construct (Construct Resolution table)

### FR-5: Effect serving/ports layer
The new serving/gateway/ports layer adopts `domain/ports/live/mock` + a single Effect provide-site ("strengthen the core"); Envio HyperIndex handlers stay as-is and become **live adapters behind ports** ("push deps to the edge"). (Direction 2026-05-21 Q-effect: "Structure at serving/ports layer")
> construct-effect-substrate is `status: candidate` — adopt structure, not a full runtime rewrite.

### FR-6: Uptime SLO + test/mock harness
Define sync-lag SLO thresholds (seed from SCALE.md Guardrail 2) + wire monitoring; the Effect mock/live split provides a CI test harness gating belt changes.

### FR-7: Federation-layer cross-cutting contract (design only)
Cross-product aggregation (e.g. score-api across mibera + berachain-core + paddle) and the future ClickHouse/Dune OLAP path are specified as **federation-layer** concerns, not belt concerns. This cycle locks the contract shape; wiring + ClickHouse are deferred. (Direction 2026-05-21 Q-cross-cutting + Q-serving)

---

## Non-Functional Requirements

### Performance
- Sync-lag within SLO per belt; cold first-sync per (belt × chain) bounded by free-RPC + eRPC throughput (the central hypothesis of the arch brief `> arch-brief §5`).

### Scalability
- N belts scale horizontally; **eRPC cache compounds** — first belt per chain pays cold-sync, every belt after rides warm cache `> arch-brief §4`. Bera/Base/OP/ETH already warm; only ARB/Zora belts pay fresh cold-sync.

### Security
- Secrets in env, never inline `> arch-brief §4` (SDD §9.3 rejected hardcoded Postgres password). Per-belt credential isolation.

### Reliability
- Blue-green schema rollout per belt (SCALE.md Guardrail 1); stable consumer alias (SCALE.md D2 / Guardrail 5) is a precondition for safe cutover and may be pulled in.
- Effect mock/live harness as a regression gate.

### Compliance
- N/A (no regulatory scope).

---

## Technical Considerations

### Architecture Notes
- L0–L6 belt-factory stack `> arch-brief §3`: chains → free RPC → **eRPC substrate** → belt indexers → belt APIs → **gateway (federation)** → consumers. This cycle realizes L3 (per-belt) + L5 (BeaconV3 federation) + the Effect contract shape across them.
- Cross-chain NFT rollups stay *within* one belt (e.g. honeyjar across 6 chains); cross-*product* aggregation is the gateway's job. (Direction 2026-05-21 assumption 2, confirmed)

### Integrations
- **loa-freeside** (v7.0.0) — BeaconV3 sealed schema (`packages/beacon-schema`), registry (`packages/freeside-registry`), MCP federation gateway (`apps/mcp-gateway`). The "home aware of all connected APIs."
- Railway (hosting), Postgres (persistence), Hasura/Envio GraphQL (serving), free public RPC (Chainlist).

### Dependencies
- Envio HyperIndex V3 (`alpha.17` pinned), eRPC, loa-freeside team for BeaconV3 schema readiness (mitigated: spike-not-wire).

### Technical Constraints
- `config.yaml`/`schema.graphql` changes can trigger multi-hour reindex `> claims-to-verify.md:T1`.
- Berachain needs explicit `hypersync_config` `> claims-to-verify.md:T2`.
- `BERACHAIN_TESTNET_ID = 80094` is mislabeled — 80094 IS mainnet `> claims-to-verify.md:T4`.

---

## Scope & Prioritization

### In Scope (this cycle)
- FR-0 S0 spike → FR-1 taxonomy → FR-2 per-belt deploy → FR-3 blast-radius proof → FR-4 BeaconV3 spike → FR-5 Effect serving layer → FR-6 uptime harness → FR-7 federation contract (design).
- Migrate **all** existing indexed items into belts (incl. re-scoping the shipped Mibera belt to pure-product).

### In Scope (Future Iterations)
- Full BeaconV3 + MCP-gateway federation wiring (joint cycle with loa-freeside).
- ClickHouse/Dune OLAP analytics path at the federation layer.
- Tenant self-host packaging (AP DAO and others).

### Explicitly Out of Scope
- ClickHouse this cycle. · Packaged installable / self-host this cycle. · score-api `ENVIO_GRAPHQL_URL` repoint (separate, deferred). · Full federation gateway wiring.

### Priority Matrix
P0: FR-0, FR-1, FR-2, FR-3. P1: FR-5, FR-6. P2: FR-4, FR-7.

---

## Success Criteria

### Launch Criteria
- [ ] All 41 contracts / 93 entities assigned to a belt (no monolith remainder).
- [ ] Blast-radius proof: a source change reindexes only its belt's chains (sibling belts: 0 reindex).
- [ ] BeaconV3 declaration validates against `loa-freeside/packages/beacon-schema`; ≥1 consumer routed via gateway (spike level).
- [ ] Sync-lag SLO defined + monitored; Effect mock/live harness green in CI.
- [ ] eRPC capacity verified for the migration's cold-syncs (SCALE.md SKP-003 pre-flight).

---

## Risks & Dependencies

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Envio multi-deployment mechanics/cost unknown | High | High | **FR-0 S0 spike** before sprint commit; finalizes belt count |
| R2 | N× infra cost (N belts × Postgres × Railway) | Med | Med | S0 cost calibration; cost-driven consolidation allowed |
| R3 | Cross-cutting entity tension (shared shapes, score-api footprint) | Med | High | Federation-layer resolution (FR-7); one-belt-indexes rule (FR-1) |
| R4 | BeaconV3 cross-repo dependency on loa-freeside team/schema | Med | Med | Spike-not-wire (FR-4) decouples from their availability |
| R5 | construct-effect-substrate is `status: candidate` (1 project) | Low | Med | Structure-only adoption at serving layer; Envio handlers untouched |
| R6 | Simultaneous cold-syncs during full migration | Med | Med | eRPC warm cache (Bera/Base/OP/ETH warm); blue-green per belt; stagger |
| R7 | Re-scoping the just-shipped Mibera belt regresses score-api coverage | Med | High | Re-validate against score-api#151 footprint after re-partition |
| R8 | Ledger pollution (loa-framework cycles in sonar-api ledger) | Low | Low | Flagged for separate cleanup; does not block this cycle |

### Dependencies
- loa-freeside (BeaconV3 schema), Railway, free RPC, eRPC substrate (live), AP DAO team (handoff coordination, non-blocking this cycle).

> **Sources**: arch-brief-freeside-sonar-stack.md (L0–L6 stack, sovereignty ladder, eRPC), SCALE.md (D4, D6, D2, guardrails), reality/architecture-overview.md + claims-to-verify.md (codebase), loa-freeside README (BeaconV3/registry/gateway), Direction AskUserQuestion answers 2026-05-21 (scope, boundaries, tenancy, serving, effect depth, federation, cost).
