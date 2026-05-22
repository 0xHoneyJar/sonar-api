# Sprint Plan — sonar-api Belt-Factory (`sonar-belt-factory`)

**Version:** 1.0
**Date:** 2026-05-21
**Author:** Sprint Planner Agent (SHIP/ARCH · BARTH + protocol/noether, craft lens)
**PRD Reference:** `grimoires/loa/prd.md` (sonar-belt-factory)
**SDD Reference:** `grimoires/loa/sdd.md` r6 (Flatline-remediated · 9 blockers + 10 high-consensus integrated)
**Cycle:** `sonar-belt-factory` · ledger global sprint range **172–176**

---

## Executive Summary

Decompose the monolithic `sonar-api` Envio indexer (1 deployment · 41 contracts · 93 entities · 6 chains) into **12 independently-deployable pure-product belts**, each owning its own runtime + schema-subset + Postgres; declare them to `loa-freeside` via a spiked **BeaconV3** contract; and add an **Effect `domain/ports/live/mock`** serving layer with a sync-lag SLO + mock/live CI harness.

The cycle is **gated by FR-0** — a half-day calibration spike (S0) that PROVES Envio multi-deployment mechanics (per the §17 R-D HARD EXIT criteria) before any belt ships. Sequencing follows SDD §13 + the §17 remediation→sprint mapping. The shipped ecosystem belt stays the **sole score-api source** all cycle (R-B no-split-brain); new belts backfill **dark**; cutover + decommission are deferred to the next cycle behind a hard guard (AC-R7 PASS).

**Total Sprints:** 5 (S0–S4)
**Sprint Duration:** S0 = half-day (calibration spike); S1–S4 ≈ 2.5 days each
**Sovereignty posture:** OWN indexer/schema/gateway/eRPC; RENT free RPC + Railway; HyperSync = Base break-glass only.

### PRD Goals (G-N traceability — see Appendix C)

| ID | Goal | KPI gate |
|----|------|----------|
| **G1** | Full migration — every contract/entity sorted into a pure-product belt (41/41 + 93/93, no monolith remainder) | All items sorted into belts (measured at **S1 exit**, §17 R-A / B6) |
| **G2** | Blast-radius isolation — a source change reindexes only its belt's chains | 0 reindex events on sibling belts (AC-FR3 sibling-monotonicity CI probe) |
| **G3** | Federation contract — sonar-api declares belts via spiked BeaconV3; ≥1 consumer routed | `build-beacon-json` exit 0 against `loa-freeside/packages/beacon-schema` (spike) |
| **G4** | Uptime — sync-lag SLO defined + monitored; Effect mock/live harness green as CI gate | SLO monitor wired (managed env, D3) + harness green in CI |

---

## Sprint Overview

| Sprint | Global | Theme | Scope | FR / §17 | Key Deliverables | Dependencies |
|--------|--------|-------|-------|----------|------------------|--------------|
| **S0** | 172 | Envio multi-deployment calibration spike (GATES ALL) | SMALL (3) | FR-0 · R-D · OQ-1 | Q-a/b/c answered · Option A codegen+tsc PROOF or Option B fallback · alpha.17 vs alpha.14 confirmed · per-belt $/mo → belt count finalized | None |
| **S1** | 173 | Factory generalization + belt authoring | LARGE (7) | FR-1 · FR-2 · R-A | Parameterized `verify-belt-config` · `config.<belt>.yaml` + `src/belts/<belt>/` for confirmed belts · GeneralMints placed · crayons/purupuru resolved (41/41) | S0 clean exit |
| **S2** | 174 | Belt deployment + blast-radius proof + R7 reconciliation | MEDIUM (6) | FR-2 · FR-3 · R-B · R-E | Belts deployed (ENVIO_RESTART per belt) · dark backfill · blast-radius CI probe PASS · score-api footprint reconciliation PASS · decommission HARD GUARD | S1 |
| **S3** | 175 | Effect serving/ports layer + uptime harness | LARGE (7) | FR-5 · FR-6 · R-C | `domain/ports/live/mock` structure · single-runtime + suffix CI gates · sync-lag SLO (managed env) · mock/live CI harness · eRPC/gateway HA + degraded fallbacks | S2 |
| **S4** | 176 | BeaconV3 spike + federation contract + E2E validation | MEDIUM (6) | FR-4 · FR-7 · R-F | `beacon.yaml` validates exit 0 · minimal typed Federation port shape · federation contract design · **E2E goal validation (G1–G4)** | S3 |

---

## Sprint S0 (Global 172): Envio Multi-Deployment Calibration Spike — GATES THE ENTIRE CYCLE

**Scope:** SMALL (3 tasks) · **Duration:** half-day (max) · **Priority:** P0 (FR-0)
**Persona:** ARCH (the-arcade + protocol) · operator S0-spike doctrine (untested integration path)

> **No belt ships until S0 exits clean.** S0 deletes its scratch artifacts after audit — NET 0 LOC to the cycle beyond the documented findings + the generalized re-init runbook (S0 doctrine: spike-not-wire).

### Sprint Goal
Prove Envio multi-deployment mechanics + the §17 R-D hard exit criteria, and finalize the belt count, before committing to belt migrations.

### Deliverables
- [ ] `grimoires/loa/a2a/<sprint>/s0-multideploy-calibration.md` answering Q-a (how Envio runs N deployments), Q-b (per-belt $/mo), Q-c (per-mutation reset semantics → closes SCALE.md D6)
- [ ] A **real `envio codegen` + `tsc` build** for ≥1 representative belt proving Option A (per-belt physical schema subset) compiles — OR a documented decision to fall back to Option B (shared schema, subset-populated, empty-safe)
- [ ] Envio version reconciliation: `alpha.17` (PRD) vs `alpha.14` (reality A1) confirmed on the pinned version, codegen tested against it (OQ-1)
- [ ] Per-belt cost number + N-belt total + explicit consolidation recommendation
- [ ] Generalized KF-013 re-init runbook ("any belt `<X>`") replacing SCALE.md Guardrail 1's `WARNING (SKP-004)` "unverified" labeling
- [ ] **Belt count confirmed by operator** (pair-point) — §4 candidate is 12 belts; S0 cost may consolidate

### Acceptance Criteria (S0 HARD EXIT — §3.3 + §17 R-D)
- [ ] Q-a/Q-b/Q-c each have a written, grounded answer
- [ ] **Option A proof OR Option B fallback decision is made on real build evidence** — no belt ships on an unproven codegen path (R-D, Flatline B1-CRITICAL/B2)
- [ ] Pre-codegen reference check: for the representative belt, every entity its handlers reference is in that belt's subset (or surfaced as a purity signal / genuine shared shape)
- [ ] Envio version pinned + codegen-verified (OQ-1 resolved)
- [ ] D6 closed: per-mutation reset semantics stated definitively
- [ ] Operator-confirmed belt count
- [ ] Scratch artifacts deleted post-audit (NET 0 LOC)

### Technical Tasks
- [ ] **S0-T1**: Multi-deployment mechanics + cost (Q-a/Q-b) — confirm belt = own Railway service + own Postgres + own `config.<belt>.yaml` generalizes to ≥3 simultaneous belts (not just the 2 prod mirrors `b5da47c`/`914708e`); measure 1 Railway service + 1 Postgres $/mo; produce N-belt total + consolidation recommendation. Confirm eRPC stays shared. → **[G1, G2]**
- [ ] **S0-T2**: Option A codegen+tsc PROOF + version reconciliation (R-D + OQ-1) — pin Envio version (alpha.17 vs alpha.14); run pre-codegen entity-reference check for one representative belt; run a real `envio codegen` + `tsc --noEmit` against the per-belt physical schema subset; if it fails, document Option B (shared schema, subset-populated, empty-safe) as the mandatory fallback. → **[G1, G2]**
- [ ] **S0-T3**: Reset semantics + re-init runbook (Q-c / D6 / KF-013) — confirm `isInitialized()` checks table-existence not config-hash (plain redeploy resumes + silently skips new contracts); document the `ENVIO_RESTART`-seeds-then-resume primitive generalized to any belt; close SCALE.md D6; **DO NOT retry `ENVIO_PG_SSL_MODE=false`** (KF-013 misdiagnosis, recurrence-aware). Delete scratch artifacts after audit. → **[G2]**

### Dependencies
- None (first sprint). Strong prior evidence from KF-013 + the shipped belt de-risks the spike.

### Security Considerations
- **Trust boundaries**: spike runs against Railway managed Postgres over SCRAM/SSL — credentials in env, never inline (PRD §Security; SDD §9.3 rejected hardcoded PG password).
- **External dependencies**: no new deps; exercises the existing Envio `alpha.17` pin + eRPC substrate.
- **Sensitive data**: Postgres + Railway credentials — per-belt credential isolation; secrets via env only.

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Option A breaks TS codegen (missing Envio bindings, R10/R-D) | Med | High | Real codegen+tsc build IS the test; Option B empty-safe fallback is pre-decided |
| Envio version mismatch corrupts belt builds (OQ-1) | Med | Med | Confirm pin + test codegen before any belt build |
| N× infra cost too high (R2) | Med | Med | Cost number drives operator consolidation decision; `paddle`/eRPC-shared amortize |
| Re-init dead-end re-attempt (KF-013) | Low | Med | Recurrence-aware: skip `ENVIO_PG_SSL_MODE=false`; use seeds-then-resume |

### Success Metrics
- Calibration doc complete with definitive Q-a/b/c answers
- Codegen build exit 0 (Option A) or documented Option-B decision
- Per-belt $/mo measured; belt count operator-confirmed

---

## Sprint S1 (Global 173): Factory Generalization + Belt Authoring

**Scope:** LARGE (7 tasks) · **Duration:** 2.5 days · **Priority:** P0 (FR-1, FR-2)
**Persona:** ARCH (the-arcade + protocol + noether, craft lens)

> Extends the existing factory primitive (`config.mibera.yaml` + `src/belts/mibera/` + `verify-belt-config`) to the operator-confirmed belt partition. **This cycle generalizes — it does not invent.** Branch-state check before authoring (operator doctrine): `ls`/`find` each belt's handler modules against the cycle branch; a missing module is the FR-1 purity signal.

### Sprint Goal
Generalize the belt factory to the full pure-product partition and author config + handlers + schema-subset for every confirmed belt, achieving 41/41 contracts + 93/93 entities placed.

### Deliverables
- [ ] `scripts/verify-belt-config.js` parameterized per belt via a `belts/<belt>/contracts.manifest.json` (`{name, chainId}` pairs); zero-dependency design preserved
- [ ] `config.<belt>.yaml` for every confirmed belt (contracts subset + chains subset; data source = shared eRPC `rpc_config` per chain)
- [ ] `src/belts/<belt>/EventHandlers.<belt>.ts` per belt (imports only that belt's handler modules; DISS-001 per-belt-entrypoint invariant)
- [ ] Per-belt `schema.graphql` subset per S0's Option-A/B decision
- [ ] GeneralMints placement resolved (S1 exit, §17 R-A)
- [ ] crayons ⟷ purupuru platform-vs-project resolved (S1 exit, §17 R-A)

### Acceptance Criteria (S1 EXIT — §16 + §17 R-A)
- [ ] `verify-belt-config <belt>` exit 0 for every belt (field-identical to `config.yaml`: address/start_block/field_selection)
- [ ] `envio codegen` + `tsc --noEmit` exit 0 per belt
- [ ] **41/41 contracts placed** — GeneralMints homed; crayons/purupuru boundary decided (closes the B6 launch-gate; "all assigned" is asserted at S1 exit, NOT at planning)
- [ ] **93/93 entities** each live in exactly one belt's schema-subset
- [ ] One-belt-indexes-it rule honored: `BgtToken`/`TrackedErc20` indexed once (berachain-core); `TrackedErc721` references split apdao-Bera / mibera-OP; `TrackedHolder` written per-instance, NOT owned by berachain-core (R-A)

### Technical Tasks
- [ ] **S1-T1**: Parameterize `verify-belt-config` (§5.3) — replace hard-coded `BELT_CONTRACTS` with per-belt `contracts.manifest.json`; assert per-(contract,chain) field-identity to `config.yaml`; preserve zero-dep invariant; extend existing `test/verify-belt-config.test.ts`. → **[G1, G2]**
- [ ] **S1-T2**: Author NFT/product belts — `honeyjar`, `honeycomb`, `cubquests`, `mibera` (incl. CandiesMarket1155 + MiladyCollection + Seaport), `sf-vaults` configs + scoped handler entrypoints + schema subsets. → **[G1]**
- [ ] **S1-T3**: Author Berachain/protocol belts — `apdao` (incl. TrackedErc721 Bera-seat), `berachain-core` (incl. BgtToken + TrackedErc20 indexed-once), `aquabera` configs + entrypoints + schema subsets. → **[G1]**
- [ ] **S1-T4**: Author remaining product belts — `paddle` (PaddleFi pure), `friendtech` (⚠ KF-012 op-stack getLogs-liar applies — verify getLogs per chain), `crayons`, `purupuru` configs + entrypoints + schema subsets. → **[G1]**
- [ ] **S1-T5**: Resolve GeneralMints placement (R-A exit) — home it to the belt consuming its `MintEvent`; update manifest + config + schema subset; close 41/41. → **[G1]**
- [ ] **S1-T6**: Resolve crayons ⟷ purupuru platform-vs-project (R-A exit) — decide belt boundary = platform (crayons indexes all launched collections) vs project (purupuru standalone); operator pair-point if ambiguous; record decision. → **[G1]**
- [ ] **S1-T7**: Per-belt schema-subset composition (§5.2) — apply S0's Option A (per-belt physical `schema.graphql`) or Option B (shared schema, empty-safe) decision uniformly; verify cross-cutting shapes (`Action`/`Mint`/`Holder`/`Token`/`CollectionStat`) defined per-belt-that-writes, federation merge deferred to FR-7. → **[G1]**

### Dependencies
- S0 clean exit (belt count confirmed; Option A/B decided; version pinned).

### Security Considerations
- **Trust boundaries**: belt configs reference `config.yaml` as source-of-truth; `verify-belt-config` is the fidelity gate against drift.
- **External dependencies**: no new runtime deps; reuses shared `src/handlers/*` + `src/lib/*` (handlers never forked).
- **Sensitive data**: per-belt env credentials; eRPC URLs per chain route (no direct L1 RPC).

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Cross-cutting entity tension (shared shapes, R3) | Med | High | One-belt-indexes rule (FR-1); shapes written per-belt, merged at federation (FR-7) |
| Handler references out-of-subset entity (R10) | Med | Med | Branch-state check + S0 codegen proof; out-of-subset ref = purity signal → move contract |
| GeneralMints/crayons-purupuru unresolved at S1 exit (R-A) | Med | High | Hard S1 exit criteria; operator pair-point; cheap to revise (decoupled belts) |
| KF-012 getLogs-liar on friendtech (Base) | Med | High | Per-chain getLogs verification before trusting belt data (R9) |

### Success Metrics
- 41/41 contracts + 93/93 entities placed (12 belts, or S0-consolidated count)
- `verify-belt-config` + codegen + tsc green for every belt

---

## Sprint S2 (Global 174): Belt Deployment + Blast-Radius Proof + R7 Reconciliation

**Scope:** MEDIUM (6 tasks) · **Duration:** 2.5 days · **Priority:** P0 (FR-2, FR-3)
**Persona:** SHIP (the-arcade + protocol) · KF-013 re-init pattern operational

> Each belt = own Envio deployment + own Postgres + own Railway service. New belts backfill **dark** (§17 R-B): the shipped ecosystem belt stays the SOLE score-api source — no double-serve, no split-brain. The temporary double-index is the accepted, bounded blue-green cost. **HARD DECOMMISSION GUARD: do not decommission the shipped ecosystem belt until AC-R7 PASS; cutover deferred to next cycle.**

### Sprint Goal
Deploy every belt as an independent eRPC-routed deployment, prove blast-radius isolation via a CI probe, and reconcile the score-api footprint against the new-belt union — all while the shipped belt keeps serving score-api unchanged.

### Deliverables
- [ ] Each confirmed belt deployed: own Railway service + own Postgres, eRPC-routed per chain, re-initialized via its own `ENVIO_RESTART` toggle (KF-013 generalized runbook)
- [ ] New belts backfill DARK — indexed but NOT served to score-api (R-B)
- [ ] Blast-radius CI probe: `chain_metadata` sibling-monotonicity, triggered on any `config.<belt>.yaml` / belt-schema change (R-E)
- [ ] `grimoires/loa/a2a/<sprint>/blast-radius-proof.md`
- [ ] `grimoires/loa/a2a/<sprint>/score-api-footprint-reconciliation.md` (AC-R7)
- [ ] HARD decommission guard wired (deploy-gate, not a runbook note) — blocks shipped-belt decommission until AC-R7 PASS

### Acceptance Criteria (§16 + §17 R-B/R-E)
- [ ] **AC-FR3**: blast-radius probe PASS — adding a source to belt X re-inits only belt X; sibling belts show monotonic `latest_processed_block` + non-decreasing `num_events_processed` (0 reindex events on siblings). Probe runs as a **CI job** (durable, non-skippable), not a manual runbook step.
- [ ] **AC-R7**: score-api footprint reconciliation PASS — the entity-count check (`MiberaLoan 176 · MiberaTransfer 39,714 · MintActivity 10,000 · NftBurn 39 · BgtBoostEvent 1.47M · Erc1155MintEvent 7,607 · Action 2.07M · FriendtechTrade 1,317 · PaddleSupply 363 · MintEvent 3,588 · MiberaStakedToken 1,603 · TreasuryActivity 11,819`) against the new-belt union matches the shipped belt within reconciliation tolerance; NO score-api entity dropped
- [ ] Shipped ecosystem belt remains the sole score-api source (no consumer repoint; score-api#151 deferred)
- [ ] Decommission guard blocks until AC-R7 PASS
- [ ] eRPC warm-cache + per-chain getLogs verification (R9) before trusting any new belt's data

### Technical Tasks
- [ ] **S2-T1**: Deploy belts independently (FR-2) — per belt: Railway service + Postgres; `Dockerfile.belt` `ENVIO_RESTART`-gated CMD; seed-then-resume re-init (KF-013); eRPC `rpc_config` per chain (Bera/Base/OP/ETH warm, ARB/Zora cold). Stagger to avoid simultaneous cold-syncs (R6). → **[G1, G2]**
- [ ] **S2-T2**: Dark-backfill discipline (R-B) — new belts index but are NOT served to score-api; document the bounded double-index window; the shipped belt is unchanged. → **[G2]**
- [ ] **S2-T3**: Blast-radius CI probe (FR-3 / R-E) — `chain_metadata` snapshot-before/after probe asserting sibling-monotonicity; wire as a CI job triggered on `config.<belt>.yaml` / belt-schema change; write `blast-radius-proof.md`. → **[G2]**
- [ ] **S2-T4**: score-api footprint reconciliation (AC-R7 / §4.5) — entity-count union check vs shipped belt; record to `score-api-footprint-reconciliation.md`; gate on tolerance match. → **[G1, G3]**
- [ ] **S2-T5**: HARD decommission guard (R-B binding) — a deploy-gate that refuses shipped-ecosystem-belt decommission until AC-R7 PASS + (next-cycle) federation coverage proven. → **[G3]**
- [ ] **S2-T6**: Per-chain getLogs verification + blue-green per belt (R9 / SCALE.md Guardrails 1+4) — verify KF-012 getLogs-liar doesn't recur per new belt's chain; per-source health probe (a new source produces a stat row within N blocks); blue-green per belt. → **[G2]**

### Dependencies
- S1 (belt configs + handlers + schema subsets authored, codegen green).

### Security Considerations
- **Trust boundaries**: free-RPC eth_getLogs is UNTRUSTED on op-stack (KF-012 lies with empty-200); reconciliation count gaps + eRPC error metrics are the detection.
- **External dependencies**: Railway managed Postgres per belt (SCRAM/SSL); eRPC shared substrate (live).
- **Sensitive data**: per-belt Postgres credentials isolated; `ENVIO_RESTART` toggle scoped per service.

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Re-scope regresses score-api coverage (R7) | Med | High | AC-R7 reconciliation gate; shipped belt sole source; hard decommission guard; cutover deferred |
| Double-serve / split-brain (R-B / Flatline B3,B7) | Med | High | Dark backfill only; ONE authoritative source; bounded double-index is accepted cost |
| Simultaneous cold-syncs (R6) | Med | Med | eRPC warm cache; stagger; dense belts (Base friend.tech, ETH Milady) may need paid archive RPC upstream |
| KF-012 getLogs-liar recurs on new chain (R9) | Med | High | Per-chain getLogs verification before trust; reconciliation catches silent loss |

### Success Metrics
- Blast-radius probe: 0 reindex events on siblings (CI PASS)
- AC-R7 reconciliation: 0 dropped score-api entities
- All confirmed belts deployed + backfilling

---

## Sprint S3 (Global 175): Effect Serving/Ports Layer + Uptime Harness

**Scope:** LARGE (7 tasks) · **Duration:** 2.5 days · **Priority:** P1 (FR-5, FR-6)
**Persona:** ARCH (the-arcade + protocol) · construct-effect-substrate (`status: candidate`, structure-only)

> Structure-only adoption at the NEW serving/gateway layer; **Envio handlers stay as-is and become live adapters behind ports** ("push deps to the edge"). NOT a runtime rewrite of the indexer (R5). §17 R-C adds eRPC + gateway HA with degraded direct fallbacks.

### Sprint Goal
Add the Effect `domain/ports/live/mock` serving layer with enforced single-runtime + suffix gates, wire a managed-environment sync-lag SLO monitor, and ship the mock/live CI harness as a belt-change gate — with HA + degraded fallbacks for the shared SPOFs.

### Deliverables
- [ ] `serving/` package: `domain/` (Schema only) · `ports/` (`*.port.ts`) · `live/` (`*.live.ts` wrapping Envio belt GraphQL) · `mock/` (`*.mock.ts` fixtures)
- [ ] Single `ManagedRuntime.make` site in `serving/runtime/runtime.ts`
- [ ] Sync-lag SLO thresholds (seeded from SCALE.md Guardrail 2) + a managed-environment monitor (GitHub Actions scheduled / Railway scheduled service — NOT a dev laptop, D3)
- [ ] Effect mock/live CI harness gating belt changes
- [ ] eRPC HA (≥2 stateless instances) + degraded direct-L1 fallback; gateway HA (≥2 instances) + direct-belt-URL fallback (R-C)

### Acceptance Criteria (§16 AC-FR6 + §8 gates + §17 R-C)
- [ ] **single-runtime grep gate** = exactly 1 `ManagedRuntime.make(` site (note the `\(` to avoid the cycle-2 self-match footgun)
- [ ] **suffix-pairing gate** — every `serving/ports/*.port.ts` has a matching `serving/live/*.live.ts` (no MISSING)
- [ ] Sync-lag SLO defined per belt × chain (PROPOSED/observation-only until 1 week baselined); monitor runs from a managed env (D3); alert distinguishes "backfilling at S0-measured rate" (healthy) from "stalled" (failure)
- [ ] Mock path green: federation/serving logic composes belt fragments into the score-footprint shape (no network)
- [ ] Live path green: belt endpoint reachable + score-api entities resolve
- [ ] eRPC + gateway HA documented + degraded fallbacks (direct-L1 / direct-belt-URL) specified in §11

### Technical Tasks
- [ ] **S3-T1**: `serving/domain/` Schemas (FR-5) — `belt.ts` (Belt = Schema.Struct: id, chains, endpoint, entities[]) + `score-footprint.ts` (federation result shape); no effects in domain. → **[G4]**
- [ ] **S3-T2**: `serving/ports/` interfaces (FR-5) — `belt-source.port.ts` (BeltSource: query a belt's GraphQL by entity) + `federation.port.ts` (Federation: compose across belts, FR-7 shape). → **[G3, G4]**
- [ ] **S3-T3**: `serving/live/` + single provide-site (FR-5 / §8.2) — `belt-source.live.ts` wrapping the Envio belt GraphQL HTTP (Effect at the boundary, handlers untouched); the single `ManagedRuntime.make` in `serving/runtime/runtime.ts`. → **[G4]**
- [ ] **S3-T4**: `serving/mock/` fixtures + CI grep gates (§8.2/§8.3) — `belt-source.mock.ts` deterministic fixtures; wire the single-runtime grep gate + the suffix-pairing find-loop gate as CI. → **[G4]**
- [ ] **S3-T5**: Sync-lag SLO + managed-env monitor (FR-6 / §9.1 / D3) — per belt × chain `chain_head − latest_processed_block` probe; thresholds seeded from SCALE.md Guardrail 2 (observation-only); scheduled from a managed env; cold-sync-vs-stalled alert discrimination. → **[G4]**
- [ ] **S3-T6**: Mock/live CI harness (FR-6 / §9.2) — mock path (federation composes score-footprint, no network) + live path (belt endpoint smoke + score-api entities resolve); both green = belt change allowed. → **[G4]**
- [ ] **S3-T7**: SPOF HA + degraded fallbacks (R-C) — eRPC HA (≥2 stateless behind one internal address) + degraded direct-L1 fallback; gateway HA (≥2 instances) + consumers retain direct per-belt GraphQL URLs as fallback; document in §11; fold HA cost into S0 calibration awareness. → **[G2, G4]**

### Dependencies
- S2 (belts deployed + reachable endpoints for the live adapter + live harness path).

### Security Considerations
- **Trust boundaries**: serving layer speaks Effect at the boundary; belt GraphQL endpoints are the trusted upstream; public read-only on-chain data (auth: none).
- **External dependencies**: `effect ^3.10.0` (beacon-schema peerDep) — pinned; construct-effect-substrate structure adopted, not as a framework runtime dependency.
- **Sensitive data**: no new secrets; gateway routes to belt endpoints over internal addresses.

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| construct-effect-substrate immaturity (R5) | Low | Med | Structure-only at serving layer; Envio handlers untouched |
| Shared SPOF (eRPC/gateway) outage (R-C / Flatline B9,B4) | Med | High | HA (≥2 instances) + degraded direct-L1 / direct-belt-URL fallbacks |
| SLO false alarms during cold backfill | Med | Med | Alert distinguishes backfill-at-S0-rate from stalled (S0 rate is load-bearing input) |
| single-runtime grep self-match footgun | Low | Low | Use `\(` in the grep gate (cycle-2 documented footgun) |

### Success Metrics
- Both CI grep gates pass (1 runtime site; 0 missing live adapters)
- Mock + live harness green in CI
- SLO monitor live in a managed env; HA + fallbacks documented

---

## Sprint S4 (Global 176, Final): BeaconV3 Spike + Federation Contract + E2E Validation

**Scope:** MEDIUM (6 tasks) · **Duration:** 2.5 days · **Priority:** P2 (FR-4, FR-7) + E2E
**Persona:** ARCH (the-arcade + protocol) · manifest authoring → **beacon construct** (Construct Resolution)

> Spike, not full wiring (FR-4). FR-7 is design-only but the **minimal typed Federation port shape lands this cycle** (§17 R-F) so AC-FR7 is objective. Registry aggregation + mcp-gateway routing + ClickHouse are deferred joint follow-ups.

### Sprint Goal
Author and validate a BeaconV3 declaration for sonar-api's belts, land the minimal typed Federation port shape + federation contract design, and run end-to-end validation of all PRD goals.

### Deliverables
- [ ] `beacon.yaml` at repo root declaring sonar-api's belts against `@freeside/beacon-schema@0.2.0` BeaconV3
- [ ] `app/.well-known/beacon.json` produced by `build-beacon-json` (exit 0)
- [ ] Minimal typed Federation port shape in `serving/ports/federation.port.ts` (R-F) — objective AC-FR7
- [ ] Federation contract design doc: `Action`/`Mint`/`Holder`/`Token` union semantics + score-api fan-out/composition + ClickHouse/Dune as a federation-layer (not belt) concern; additive-only invariant
- [ ] E2E goal validation report (G1–G4)

### Acceptance Criteria (§16 AC-FR4 + §17 R-F)
- [ ] **AC-FR4**: `npx build-beacon-json --in beacon.yaml --out app/.well-known/beacon.json` exits 0 (decodes clean against `BeaconV3Schema`)
- [ ] `is.one_liner` ≤120 chars; `is.scope` 2–7 entries ≤100 chars; `is_not` ≥2 entries each starting "Does NOT"/"Will NOT"/"Refuses to"; `cycle_state` = `{ status: candidate, since: 2026-05-21, next_review: ≤+180d }`
- [ ] `composes_with` ships `{}` if loa-freeside hasn't published the referenced Tag (MAY-LATITUDE-5 pushback — verify Tag availability before claiming composition; `optionalWith(default {})`)
- [ ] **AC-FR7**: minimal typed Federation port shape lands; federation realization (fan-out vs true composition) designed but NOT wired; public URL + GraphQL contract designed to be additive-only
- [ ] E2E validation: all PRD goals validated with documented evidence

### Technical Tasks
- [ ] **S4-T1**: Author `beacon.yaml` (FR-4 / §7.1) — populate `is`/`is_not`/`acvp_invariants` (e.g. `event_completeness` → `score-api-footprint-reconciliation.md` proof_artifact) / `sealed_schemas` (per-belt schema subsets, hashed) / `cycle_state`; V2 `mcp` block (shape: data, streamable-http, auth: none, pricing: free, publisher 0xHoneyJar). → **[G3]**
- [ ] **S4-T2**: Validate against beacon-schema (FR-4 / §7.2) — run `build-beacon-json`; verify Tag availability before adding `composes_with.loa-freeside`, else ship `composes_with: {}`. → **[G3]**
- [ ] **S4-T3**: Minimal typed Federation port shape (R-F) — define the gateway↔belt query interface in `federation.port.ts` so AC-FR7 is objective; port shape lands, wiring deferred. → **[G3]**
- [ ] **S4-T4**: Federation contract design (FR-7 / §10) — document `Action`/`Mint`/`Holder`/`Token` union semantics; score-api federation across mibera+berachain-core+paddle (fan-out (a) vs composition (b)); ClickHouse/Dune as federation-layer concern (deferred); the additive-only binding constraint (public URL + GraphQL contract unchanged when belts added). → **[G3]**
- [ ] **S4-T5**: Update `known-failures.md` + runbooks — fold S0 generalized re-init runbook + any new degradation observed during the cycle into `known-failures.md` (append-only); ensure KF-012/KF-013 references current. → **[G1, G2]**
- [ ] **S4-T6 (E2E)**: see Task 176.E2E below. → **[G1, G2, G3, G4]**

### Task 176.E2E: End-to-End Goal Validation

**Priority:** P0 (Must Complete)
**Goal Contribution:** All goals (G1, G2, G3, G4)

**Description:** Validate that all PRD goals are achieved through the complete implementation.

**Validation Steps:**

| Goal ID | Goal | Validation Action | Expected Result |
|---------|------|-------------------|-----------------|
| G1 | Full migration | Count placed contracts/entities across all belt manifests + schema subsets | 41/41 contracts + 93/93 entities placed; no monolith remainder (S1-exit measure) |
| G2 | Blast-radius isolation | Run the blast-radius CI probe: add a source to one belt, snapshot sibling `chain_metadata` before/after | 0 reindex events on sibling belts (sibling-monotonic PASS) |
| G3 | Federation contract | `build-beacon-json` against beacon-schema; confirm Federation port shape exists | exit 0; typed Federation port present; ≥1 consumer reachable through a belt endpoint (spike) |
| G4 | Uptime | Confirm SLO monitor runs in a managed env; run the mock/live CI harness | SLO thresholds defined + monitored; harness green in CI |

**Acceptance Criteria:**
- [ ] Each goal validated with documented evidence (linked artifacts in `grimoires/loa/a2a/<sprint>/`)
- [ ] Integration points verified (eRPC → belt → serving/port → consumer/beacon)
- [ ] AC-R7 reconciliation re-confirmed (no score-api regression); decommission guard still armed (cutover next cycle)
- [ ] No goal marked "not achieved" without explicit justification

### Dependencies
- S3 (serving/ports layer + Federation port file exists for R-F); S2 (footprint reconciliation artifact for the acvp_invariant proof).

### Security Considerations
- **Trust boundaries**: `beacon.json` is public declaration metadata; the `composes_with` Tag hash is recomputed against the live Honeycomb Tag definition (validator-side).
- **External dependencies**: `@freeside/beacon-schema@0.2.0` (pinned); loa-freeside Tag availability is the only cross-repo coupling (decoupled via spike-not-wire + `composes_with: {}` fallback).
- **Sensitive data**: none new; declaration describes public on-chain data surfaces.

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| BeaconV3 cross-repo dependency on loa-freeside Tag (R4 / §7.2) | Med | Med | Spike-not-wire; `composes_with: {}` fallback (`optionalWith(default {})`) |
| AC-FR7 unobjective without a port shape | Med | Med | R-F: minimal typed Federation port lands this cycle |
| E2E surfaces a missed goal late | Low | High | Goal traceability enforced per sprint (Appendix C); E2E is P0 |

### Success Metrics
- `build-beacon-json` exit 0
- Typed Federation port shape present; federation design documented
- All 4 PRD goals validated with evidence

---

## Risk Register (cycle-level, from PRD §Risks + SDD §14)

| ID | Risk | Likelihood | Impact | Mitigation | Owning Sprint |
|----|------|-----------|--------|------------|---------------|
| R1 | Envio multi-deployment mechanics/cost unknown | Med (KF-013 de-risks) | High | FR-0 S0 spike; finalizes belt count | S0 |
| R2 | N× infra cost | Med | Med | S0 cost calibration; consolidation allowed; eRPC shared | S0 |
| R3 | Cross-cutting entity tension | Med | High | One-belt-indexes rule (FR-1); federation merge (FR-7) | S1, S4 |
| R4 | BeaconV3 cross-repo dependency | Med | Med | Spike-not-wire; `composes_with: {}` fallback | S4 |
| R5 | construct-effect-substrate candidate maturity | Low | Med | Structure-only at serving layer | S3 |
| R6 | Simultaneous cold-syncs during migration | Med | Med | eRPC warm cache; blue-green per belt; stagger | S2 |
| R7 | Re-scoping shipped belt regresses score-api | Med | High | AC-R7 reconciliation; sole-source; hard decommission guard; cutover deferred | S2 |
| R8 | Ledger pollution (loa-framework cycles) | Low | Low | Separate cleanup; non-blocking | — |
| R9 | KF-012 getLogs-liar recurs on new belt chain | Med | High | Per-chain getLogs verification; reconciliation catches loss | S1, S2 |
| R10 | Envio codegen tolerance for per-belt schema subset | Med | Med | S0 codegen+tsc proof; Option B empty-safe fallback | S0, S1 |
| R-B | Double-serve / split-brain across sources | Med | High | Dark backfill; ONE authoritative score-api source | S2 |
| R-C | Shared SPOF (eRPC/gateway) outage | Med | High | HA + degraded direct fallbacks | S3 |

---

## Self-Review Checklist

- [x] All MVP features (FR-0…FR-7) accounted for across S0–S4
- [x] Sprints build logically (S0 gates → S1 author → S2 deploy/prove → S3 serve/monitor → S4 declare/validate)
- [x] Each sprint feasible as a single iteration (3–7 tasks; S0 capped at half-day)
- [x] All deliverables + acceptance criteria are checkboxed + testable
- [x] Technical approach aligns with SDD §13 sequencing + §17 remediation→sprint mapping
- [x] §17 remediations threaded: R-A (S1 exits) · R-B (S2 dark backfill + decommission guard) · R-C (S3 HA) · R-D (S0 hard exit) · R-E (S2 CI probe) · R-F (S4 Federation port)
- [x] Risks identified with mitigation + owning sprint
- [x] Dependencies explicit per sprint
- [x] All PRD goals (G1–G4) mapped to tasks (Appendix C)
- [x] All tasks annotated with goal contributions
- [x] E2E validation task (176.E2E) in the final sprint (P0)

---

## Appendix C: Goal Traceability

PRD goals are G1–G4 (auto-assigned from the PRD "Primary Goals" section G1–G4; KPI gates per PRD "Key Performance Indicators" + SDD §16).

| Goal | Description | Contributing Tasks |
|------|-------------|--------------------|
| **G1** | Full migration (41/41 + 93/93 into pure-product belts) | S0-T1, S0-T2, S1-T1, S1-T2, S1-T3, S1-T4, S1-T5, S1-T6, S1-T7, S2-T1, S2-T4, S4-T5, 176.E2E |
| **G2** | Blast-radius isolation (source change reindexes only its belt) | S0-T1, S0-T2, S0-T3, S1-T1, S2-T1, S2-T2, S2-T3, S2-T6, S3-T7, S4-T5, 176.E2E |
| **G3** | Federation contract (BeaconV3 declared + routed spike) | S2-T4, S2-T5, S3-T2, S4-T1, S4-T2, S4-T3, S4-T4, 176.E2E |
| **G4** | Uptime (sync-lag SLO + Effect mock/live harness CI gate) | S3-T1, S3-T2, S3-T3, S3-T4, S3-T5, S3-T6, S3-T7, 176.E2E |

**Goal coverage check:** every goal G1–G4 has ≥1 contributing task — no orphaned goals. E2E validation task (176.E2E) present in final sprint. No warnings.

---

> **Sources:** `grimoires/loa/prd.md` (sonar-belt-factory · FR-0…FR-7 · G1–G4 · KPIs · risks) · `grimoires/loa/sdd.md` r6 (§3 S0, §4 taxonomy, §5 deployment, §6 blast-radius, §7 BeaconV3, §8 Effect, §9 SLO/harness, §10 federation, §13 sequencing, §16 acceptance mapping, §17 Flatline remediation) · `grimoires/loa/known-failures.md` (KF-012 getLogs-liar, KF-013 re-init) · `grimoires/loa/ledger.json` (cycle `sonar-belt-factory`, global range 172–176).
