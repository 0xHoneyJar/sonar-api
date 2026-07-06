---
hivemind:
  schema_version: "1.0"
  artifact_type: launch-plan
  product_area: "sonar-api — self-hosted deep-history SVM indexer (spike cycle)"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "sprint the SVM deep-history indexer spike — GATE-1 probe + lake-adapter seam + generalized §4.5 gate (runnable) then GATE-3 resource canary + GATE-4 schema + FR-7 decision record (needs-a-box); 3-axis coverage/parity/resource verdict, cost axis dropped per Boehm"}
  learning_status: directionally-correct
  source: team-internal
trust_tier: operator-authored
read_state: read
confidence: 0.8
decay_class: working
last_confirmed: 2026-07-06
operator_signed: self_attested
---

# Sprint Plan: Self-Hosted Deep-History SVM Indexer — Spike Cycle

**Version:** 1.0
**Date:** 2026-07-06
**Author:** Sprint Planner Agent (simstim Phase 3)
**PRD Reference:** grimoires/loa/prd.md
**SDD Reference:** grimoires/loa/sdd.md
**Decision records:** grimoires/loa/context/2026-07-06-gate1-envio-vs-sqd-coverage.md · grimoires/loa/context/2026-07-06-boehm-economics-svm-indexer.md
**Cycle:** svm-deep-history-spike · **Global sprint IDs:** 190 (S1), 191 (S2)

---

## Executive Summary

This is a **derisking spike cycle**, not a production deploy. The deliverable is a **decision
record** (PRD FR-7): a per-lake matrix on **three axes — coverage, parity, resource** — that returns
a framework/lake verdict (default **Envio** if GATE-1 genesis passes AND parity/resource match SQD;
else **SQD**, the §4.5-proven floor). The **cost axis between the two lakes is DROPPED** — both are
free-lake self-host with identical cost curves (Boehm economics doc §4); FR-5 collapses to a small
self-host-param **calibration**, not a lake-vs-lake comparison.

The single load-bearing architectural insight (SDD §0): our decoder `decodeSqdBlocks` is
**lake-agnostic at the token-balance-row level**, so we build **ONE** thin `LakeAdapter` seam and
drive the **same** decoder + **same** §4.5 gate against each lake. `decodeSqdBlocks` is
**DO-NOT-CHANGE** — it is the §4.5-proven shared parity harness.

Sprints are cut by the /simstim dispatch contract — **what's runnable in-session** vs **what needs a
box**:

**Total Sprints:** 2
**S1 (RUNNABLE-IN-SESSION):** GATE-1 probe + lake-adapter seam + generalized parity gate → dispatch via `/run`.
**S2 (NEEDS-A-BOX + synthesis):** GATE-3 resource canary (bead → hand off with exact commands) + GATE-4 schema dry-run + FR-7 decision record.

---

## Sprint Overview

| Sprint | Theme | Key Deliverables | Dispatch | Dependencies |
|--------|-------|------------------|----------|--------------|
| 1 (g190) | Runnable — GATE-1 probe + adapter seam + parity gate | Envio genesis-depth probe result; `LakeAdapter` port + 2 adapters; generalized `runParityGate`; GATE-2 slice of FR-7 | `/run` (in-session, code + cheap probes) | None |
| 2 (g191) | Needs-a-box — resource canary + schema + decision record | GATE-3 resource envelope (bead handoff); GATE-4 schema dry-run; **FR-7 decision record** + go/no-go | beads for a box + in-session synthesis | Sprint 1 (adapters + passing parity gate) |

---

## Sprint 1 (g190): Runnable — GATE-1 Probe, Lake-Adapter Seam, Generalized Parity Gate

**Scope:** MEDIUM (3 tasks)
**Duration:** 2.5 days
**Dispatch:** in-session code + cheap HTTP probes — `/run sprint-1`

### Sprint Goal
Close the one open GATE-1 sub-question (does Envio HyperSync-Solana reach genesis for the target
mints?) and build the lake-adapter seam + generalized §4.5 gate so both lakes decode through the
**same** proven harness and produce measured GATE-2 parity — all without touching the decoder or
spending a metered dollar.

### Deliverables
- [ ] Envio HyperSync-Solana genesis-depth probe result for pythians + smb_gen2 mints (reaches-mint? / earliest-slot / gaps), emitted as the GATE-1 slice of the FR-7 record.
- [ ] SQD Portal genesis-depth baseline probe (block-0 expected — the proven-floor control).
- [ ] `src/svm/lake-adapter.ts` — the `LakeAdapter` port + lake-neutral type aliases (no decoder change).
- [ ] `SqdPortalAdapter` (thin conformance wrapper of `SqdClient`) + `EnvioHyperSyncAdapter` (HyperSync-direct, HTTP-first, measured field mapping).
- [ ] Generalized `runParityGate(adapter, fixture)` — the §4.5 gate parameterized by `LakeAdapter`.
- [ ] GATE-2 slice of the FR-7 record: both lakes' match_rate / divergences / unexpected against the pythians fixture.

### Acceptance Criteria
- [ ] GATE-1 probe hits the **HyperSync-Solana endpoint directly** (HTTP), NEVER the RPC slot-handler; run logs prove no metered call was made.
- [ ] GATE-1 probe reports, per collection, `reachesGenesis: bool`, `earliestSlotObserved`, and `gaps[]` vs each mint's known mint-slot. If Envio is shallow → record it, stop, and mark GATE-1 FAIL (SQD floor holds).
- [ ] `LakeAdapter` is a pure contract; `SqdBlock`/`SqdTokenBalanceRow` are aliased to `LakeBlock`/`TokenBalanceRow` with **zero change to `decodeSqdBlocks`**.
- [ ] **Failing-test-first**: a Vitest unit test for `EnvioHyperSyncAdapter` row-mapping (HyperSync token-balance row → `TokenBalanceRow`) is written and RED before the adapter exists, then GREEN — mapping is lossless and passes `validateBalRow`.
- [ ] **Failing-test-first**: a conformance test asserts `SqdPortalAdapter` produces identical `stream()`/`currentHeight()` behavior to raw `SqdClient` (no behavior change).
- [ ] `runParityGate` preserves the shipped metric contract EXACTLY: two-sided, ≥0.99 match, ≤1% divergence, `unexpected===0`, cap-must-not-fire (else divergences are truncation) — same as test/sqd-45-gate-integration.test.ts:166-189.
- [ ] The SQD lane through `runParityGate` reproduces the shipped result (1767/1767, 0 divergences) — regression floor intact.
- [ ] The Envio lane through `runParityGate` reproduces the **pythians 1767-event fixture ≥0.99 two-sided** (GATE-2 pass), OR records a parity gap as a framework FAIL (not a silent divergence).
- [ ] Vacuous-pass doctrine preserved: an empty/below-floor reconcile HARD-FAILS, never PASSes.
- [ ] BB gate on the PR that lands the seam + generalized gate.

### Technical Tasks

- [ ] **Task 1.1 (GATE-1 close-out): Envio HyperSync-Solana genesis-depth probe** → **[G-1]**
  Cheap-and-loud HTTP probe of the HyperSync-Solana endpoint for pythians + smb_gen2 mints; confirm it
  reaches the mint slots (the one open GATE-1 sub-question, gate1:32,50-52). Run the SQD baseline probe
  as the block-0 control. HyperSync-direct only — no RPC slot-handler, no metered spend. Emit the GATE-1
  slice of the FR-7 record. **If Envio is shallow → stop, SQD floor, skip the Envio lane in 1.3.**
- [ ] **Task 1.2 (lake-adapter seam): `LakeAdapter` port + SqdPortalAdapter + EnvioHyperSyncAdapter** → **[G-5, G-2]**
  Write `src/svm/lake-adapter.ts` (port + neutral aliases, no decoder change). `SqdPortalAdapter` wraps
  the existing `SqdClient` (already conforms — add `name` + `earliestSlotFor`). `EnvioHyperSyncAdapter`
  consumes HyperSync-direct (HTTP-first per the ladder; add the Rust client dep only if GATE-3 throughput
  later demands it), mapping its token-balance columns → `TokenBalanceRow`. **Field mapping is a MEASURED
  artifact** (from Task 1.1), never presumed. Test-first: RED row-mapping + conformance tests before code.
- [ ] **Task 1.3 (generalized §4.5 gate): `runParityGate(adapter, fixture)`** → **[G-2]**
  Generalize test/sqd-45-gate-integration.test.ts from `client` → `adapter` (identical metric contract).
  Run BOTH lakes against the SAME committed pythians fixture (SHA256-verified). SQD reproduces
  1767/1767 (regression floor); Envio must reproduce ≥0.99 two-sided (GATE-2). Emit the GATE-2 slice of
  FR-7. **`decodeSqdBlocks` is untouched** — it is the shared harness under both adapters.

### Dependencies
- None (first sprint). Free lakes (SQD Portal, HyperSync-Solana) + the committed §4.5 fixture + registry (pythians, smb_gen2 present).

### Security Considerations
- **Trust boundaries**: lake rows are UNTRUSTED substrate — the Envio adapter normalizes INTO the existing `validateBalRow` path (reject-don't-coerce; >10% malformed-rate escalation). No new trust root; DAS stays the ownership trust root (KF-018).
- **External dependencies**: ideally NONE added (HTTP path via stdlib `fetch`). At most the HyperSync Rust client, and only as a GATE-3-measured decision — not a default.
- **Sensitive data**: none. Both lakes are open/free; `SQD_API_KEY` optional. `SqdAuthRequiredError`-style guard surfaces any spend door instead of retrying into it.

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Envio HyperSync genesis shallow / not block-0 | Med | High (kills incumbency default) | GATE-1 probe FIRST + cheap, before any sync; SQD floor ready |
| Envio field-mapping guessed wrong | Med | Med | Mapping is a MEASURED GATE-1 artifact; parity gate catches mis-maps as divergence |
| Accidentally using RPC slot-handler (metered) | Low | High | Design pins HyperSync-direct; run logs asserted metered-free in AC |
| Decoder assumed lake-agnostic but isn't | Low | High | Two-sided parity on BOTH lakes vs the SAME fixture is exactly the falsification test |

### Success Metrics
- GATE-1: `reachesGenesis` recorded for 2 collections × 2 lakes with earliest-slot evidence.
- GATE-2: SQD 1767/1767; Envio match_rate ≥ 0.99 two-sided (or a documented FAIL).
- New production-shaped LOC ≈ one seam file + 2 adapters; decoder diff = 0 lines.

---

## Sprint 2 (g191, Final): Needs-a-Box — Resource Canary, Schema Convergence, FR-7 Decision Record

**Scope:** MEDIUM (3 tasks)
**Duration:** 2.5 days
**Dispatch:** Tasks 2.1 + 2.2 are **beads for a box** (hand off with exact commands, NOT run in-session); Task 2.E2E is in-session synthesis.

### Sprint Goal
Measure the resource envelope on real hardware, confirm decoded rows converge onto the existing
schema without clobbering, then synthesize the measured coverage/parity/resource matrix into the FR-7
decision record and a go/no-go for the production-deploy cycle.

### Task 2.E2E: End-to-End Goal Validation (= FR-7 decision record)

**Priority:** P0 (Must Complete)
**Goal Contribution:** All goals (G-1, G-2, G-3, G-4, G-5)

**Description:**
The FR-7 decision record IS the E2E goal validation — it asserts every PRD goal against measured
evidence and returns the framework verdict + go/no-go. Written to
`grimoires/loa/context/2026-07-06-lake-decision-record.md`.

**Validation Steps:**

| Goal ID | Goal | Validation Action | Expected Result |
|---------|------|-------------------|-----------------|
| G-1 | Go/no-go on Envio-for-Solana + characterized SQD fallback | Fill GATE-1..3 matrix; apply the decision rule | Verdict = Envio (if genesis PASS AND parity/resource ≥ SQD) else SQD floor, with numbers |
| G-2 | Chosen framework reproduces §4.5 reference | `runParityGate` result per lake (from S1) | ≥0.99 two-sided, same PK, same ambiguity handling |
| G-3 | Measured scale envelope | GATE-3 canary wall-clock + peak RAM + storage + request-count, extrapolated to 20/100 | Fits a box below metered at 100-scale; binding resource named; no KF-015 OOM |
| G-4 | Self-host param calibration (NOT lake-vs-lake cost) | Calibrate `m_sync` (CPU-hrs), `m_store` (bytes/event); confirm co-location on belt-indexer box | Marginal-per-collection ≈ $0; crossover DECIDED, not re-opened (Boehm §4) |
| G-5 | Rows land in existing `svm.collection_event` + pass §4.5 | GATE-4 dry-run upsert (Task 2.2) | 0 PK collisions, 0 clobbered rich rows, §4.5 ≥0.99 two-sided |

**Acceptance Criteria:**
- [ ] The FR-7 record contains, with measured evidence: GATE-1→4 pass/fail each with numbers; the framework verdict + why; box sizing + sync-time + storage for the canary extrapolated to 20 and 100; the self-host param calibration (NOT a lake-vs-lake cost comparison — that axis is DROPPED per Boehm §4); the schema-convergence confirmation; the go/no-go for the production-deploy cycle.
- [ ] The per-lake matrix scores on **coverage / parity / resource ONLY** (3 axes); GATE-4 never flips the lake (it only sizes a migration).
- [ ] Each goal is either validated with evidence or explicitly justified as not-achieved.

### Technical Tasks

- [ ] **Task 2.1 (NEEDS-A-BOX — GATE-3 resource spike): full-genesis canary sync per lake** → **[G-3, G-4]**
  Bead for a box (hand off with exact commands, NOT in-session). Full-collection genesis sync of
  **pythians + mandatory dense smb_gen2** on each passing lake. Measure **peak RAM** (vs KF-015 OOM),
  **wall-clock**, **storage**, and **request-count** (the density-wall metric). Answer THE derisking
  question: does native full-sync collapse the ~400k mint-filtered-windowed request count (Strategy B
  full-block-scan vs Strategy A mint-filtered-windowed, SDD §8.1)? Boehm sub-metric: does it co-locate on
  the existing belt-indexer Railway box (the $0-marginal assumption)? Extrapolate box sizing to 20 → 100;
  name the binding resource. HyperSync-direct only; cheap-and-loud progress logging that survives pipes.
- [ ] **Task 2.2 (NEEDS-A-BOX — GATE-4 schema convergence): dry-run upsert** → **[G-5]**
  Bead for a box (piggybacks on the rows produced by 2.1; needs a scratch schema/DB). Dry-run
  `upsertCollectionEvents(..., {ifAbsentOnly:true})` of decoded rows onto `svm.collection_event` (or a
  scratch schema): assert **0 PK collisions**, **0 clobbered rich rows** (insert-if-absent never
  clobbers a richer Helius-classified row). Decide the `source` value for the winning lake
  (`envio-hypersync` needs idempotent migration 005, precedent migration 003) + cursor-column naming
  (reuse `sqd_cursor_slot` documented, or add `lake_cursor_slot`). GATE-4 is a design decision, NOT a
  framework switch.
- [ ] **Task 2.E2E (FR-7 decision record):** synthesize GATE-1..4 measured slices into the decision record + go/no-go (schema in SDD §5.3). See E2E table above. → **[G-1, G-4, all]**

### Acceptance Criteria

Task 2.1 (GATE-3 resource):
- [ ] Handed off as a box bead with **exact runnable commands** (not executed in-session); HyperSync-direct only, no metered spend.
- [ ] Peak RAM, wall-clock, storage, and **request-count** recorded per lake for pythians AND dense smb_gen2; no KF-015-class OOM (or resize-and-document, never bump-and-pray).
- [ ] The density-wall question answered with numbers: Strategy A (mint-filtered-windowed) vs Strategy B (full-block-scan) request-count per lake.
- [ ] Boehm co-location sub-metric answered: does the sync fit the existing belt-indexer Railway box headroom, or need its own service?
- [ ] Box sizing extrapolated to 20 and 100 collections with the binding resource (RAM / storage / wall-clock) named.

Task 2.2 (GATE-4 schema convergence):
- [ ] Dry-run upsert asserts **0 PK collisions** and **0 clobbered rich rows** (insert-if-absent) against `svm.collection_event` or a scratch schema — no production write.
- [ ] `source` value decided for the winning lake + cursor-column naming decided (reuse `sqd_cursor_slot` documented, or add `lake_cursor_slot` via idempotent migration 005); GATE-4 does not flip the lake.

Task 2.E2E (FR-7 decision record): see the E2E Goal Validation acceptance criteria above.
- [ ] BB gate on any PR that lands from this sprint.

### Dependencies
- **Sprint 1**: the `LakeAdapter` + both adapters + a passing (or FAIL-recorded) `runParityGate` — Task 2.1's canary sync drives the adapters; the decision record consumes S1's GATE-1/GATE-2 slices.
- Local box (or Railway headroom) for 2.1/2.2; free lakes only.

### Security Considerations
- **Trust boundaries**: same as S1 — lake rows validated through `validateBalRow`; auth-appears-on-free-lake throws immediately (no retry-into-spend). Dry-run upsert runs against a scratch schema, never clobbering production rich rows.
- **External dependencies**: no new metered provider without operator approval; box is the only new resource.
- **Sensitive data**: none new.

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Density wall recurs on full-sync | Med | High | GATE-3 measures Strategy A AND B request-count per lake; native full-sync (B) is the hypothesized escape |
| KF-015-class OOM on dense canary | Med | High | RAM is a GATE-3 pass/fail; we run the lake adapter, NOT the Node Hyperindex runtime that OOM'd; `seenMints` is the only unbounded state, bounded by \|mints\|; measure to confirm — NEVER bump-and-pray (KF-015 reading guide) |
| Co-location assumption ($0 marginal box) wrong | Low-Med | Med | Boehm sub-metric tests it explicitly (fits belt-indexer headroom vs needs own service) |
| Storage at 100 collections unaffordable | Low | Med | GATE-3 extrapolates; ~6 MB/collection → ~600 MB at 100, bounded in the calibration |
| Schema PK collision / clobber | Low | High | GATE-4 dry-run asserts 0 collisions + 0 clobbers before any real write |

### Success Metrics
- GATE-3: peak RAM (MB), wall-clock (s), storage (MB), request-count recorded per lake for pythians + smb_gen2; box sizing extrapolated to 20/100 with binding resource named.
- GATE-4: 0 PK collisions, 0 clobbered rows on dry-run.
- FR-7 decision record written with a GO/NO-GO and all 5 PRD goals validated.

---

## Risk Register

| ID | Risk | Sprint | Probability | Impact | Mitigation | Owner |
|----|------|--------|-------------|--------|------------|-------|
| R1 | Envio HyperSync genesis shallow / not block-0 | 1 | Med | High | GATE-1 probe FIRST, cheap; SQD proven floor ready | spike |
| R2 | Envio field-mapping guessed wrong | 1 | Med | Med | Mapping is a measured GATE-1/2 artifact; parity gate catches mis-maps | spike |
| R3 | Accidental RPC slot-handler (metered spend) | 1-2 | Low | High | HyperSync-direct pinned; metered-free asserted in AC + run logs | spike |
| R4 | Density wall recurs on full-sync | 2 | Med | High | GATE-3 measures Strategy A + B request-count per lake | box |
| R5 | KF-015-class OOM on dense canary | 2 | Med | High | RAM is GATE-3 pass/fail; lake adapter not Node runtime; never bump-and-pray | box |
| R6 | Co-location $0-marginal assumption wrong | 2 | Low-Med | Med | Boehm sub-metric tests belt-indexer headroom fit | box |

---

## Success Metrics Summary

| Metric | Target | Measurement Method | Sprint |
|--------|--------|-------------------|--------|
| GATE-1 genesis depth | reachesGenesis recorded per lake × collection | HTTP probe vs known mint-slots | 1 |
| GATE-2 parity | SQD 1767/1767; Envio ≥0.99 two-sided | `runParityGate` vs pythians fixture | 1 |
| Decoder change | 0 lines | git diff on `sqd-collection-event-source.ts` | 1 |
| GATE-3 resource | peak RAM / wall-clock / storage / request-count per lake | box canary + RSS sampler + request telemetry | 2 |
| GATE-4 schema | 0 PK collisions, 0 clobbers | dry-run upsert on scratch schema | 2 |
| FR-7 decision record | GO/NO-GO + verdict + 5 goals validated | in-session synthesis of measured slices | 2 |

---

## Dependencies Map

```
Sprint 1 (g190) ─────────────────────────▶ Sprint 2 (g191)
   │                                            │
   ├─ 1.1 GATE-1 probe (runnable) ──┐           ├─ 2.1 GATE-3 resource canary (box)
   ├─ 1.2 LakeAdapter seam ─────────┼─ adapters ┤   drives adapters from S1
   └─ 1.3 generalized §4.5 gate ────┘ + parity  ├─ 2.2 GATE-4 schema dry-run (box)
                                                └─ 2.E2E FR-7 decision record (synthesis)
```

---

## Appendix

### A. PRD Feature Mapping

| PRD Feature (FR) | Sprint | Task | Status |
|------------------|--------|------|--------|
| FR-1 coverage probe (Envio genesis + SQD baseline) | 1 | 1.1 | Planned |
| FR-3 decode parity (generalized §4.5 gate) | 1 | 1.2, 1.3 | Planned |
| FR-2 canary full-sync (resource) | 2 | 2.1 | Planned |
| FR-4 scale extrapolation | 2 | 2.1 | Planned |
| FR-5 cost model → self-host param calibration ONLY (Boehm: lake-vs-lake cost DROPPED) | 2 | 2.E2E | Planned |
| GATE-4 schema convergence (PRD §8 #5 / G-5) | 2 | 2.2 | Planned |
| FR-7 decision record | 2 | 2.E2E | Planned |
| FR-6 Subsquid fallback spike | — | (runs only if an Envio gate fails; not scheduled — SQD is the proven floor) | Conditional |

### B. SDD Component Mapping

| SDD Component | Sprint | Task | Status |
|---------------|--------|------|--------|
| C1 `LakeAdapter` port (NEW) | 1 | 1.2 | Planned |
| C2 `SqdPortalAdapter` (wrap SqdClient) | 1 | 1.2 | Planned |
| C3 `EnvioHyperSyncAdapter` (NEW) | 1 | 1.2 | Planned |
| C4 `decodeSqdBlocks` (SHARED · DO NOT MODIFY) | — | (untouched — regression floor) | Fixed |
| C5 Parity/resource harness (generalized §4.5 gate) | 1 / 2 | 1.3 / 2.1 | Planned |
| Migration 005 (source value + cursor naming) | 2 | 2.2 | Conditional (if Envio wins) |

### C. PRD Goal Mapping

| Goal ID | Goal Description | Contributing Tasks | Validation Task |
|---------|------------------|-------------------|-----------------|
| G-1 | Go/no-go on Envio-for-Solana + characterized SQD fallback | S1: 1.1 | S2: 2.E2E |
| G-2 | Chosen framework reproduces §4.5 reference (parity) | S1: 1.2, 1.3 | S2: 2.E2E |
| G-3 | Measured full-sync scale envelope (RAM/time/storage) | S2: 2.1 | S2: 2.E2E |
| G-4 | Self-host param calibration (lake-vs-lake cost DROPPED — Boehm §4) | S2: 2.1, 2.E2E | S2: 2.E2E |
| G-5 | Rows land in existing `svm.collection_event` + pass §4.5 | S1: 1.3; S2: 2.2 | S2: 2.E2E |

**Goal Coverage Check:**
- [x] All PRD goals have at least one contributing task (G-1..G-5 covered)
- [x] All goals have a validation task in the final sprint (2.E2E)
- [x] No orphan tasks (all 5 tasks trace to ≥1 goal)

**Per-Sprint Goal Contribution:**

Sprint 1: G-1 (coverage decision input), G-2 (parity complete), G-5 (partial: parity through shared gate)
Sprint 2: G-3 (complete), G-4 (calibration complete), G-5 (complete: schema convergence), + E2E validation of all goals

### D. Constraints Ledger (operator-stated, carried into every task)

- [ ] `decodeSqdBlocks` (`src/svm/sqd-collection-event-source.ts`) is **DO-NOT-CHANGE** — the §4.5-proven shared harness.
- [ ] **No metered spend** — HyperSync-direct only, NEVER the RPC slot-handler; SQD Portal + HyperSync free lakes are the substrate.
- [ ] **§4.5 = range-complete decode acceptance** (not ownership completeness); DAS stays the ownership trust root (KF-018).
- [ ] **Failing-test-first** on the code tasks (1.2 adapter row-mapping + conformance; 1.3 generalized gate).
- [ ] **BB gate** on any PR that lands from this cycle; spikes are throwaway (not committed as production code) but the seam + harness are written at production quality where they'd survive.
- [ ] Cost axis between Envio and SQD is **DROPPED** (identical free-lake cost, Boehm §4) — FR-5 is self-host-param calibration only; no lake-vs-lake cost-comparison tasks.

---

*Generated by Sprint Planner Agent · simstim Phase 3 · svm-deep-history-spike cycle*
