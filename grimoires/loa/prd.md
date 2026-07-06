---
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "sonar-api — self-hosted deep-history indexer for SVM NFT collections"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "derisk Envio-vs-Subsquid with measured spikes then self-host a full-sync-from-genesis Solana indexer into svm.collection_event, so deep NFT holding-history costs sync-compute not vendor credits and the marginal cost of the next collection is ~zero"}
  learning_status: directionally-correct
  source: team-internal
---

# PRD — Self-Hosted Deep-History Indexer for SVM (Solana) NFT Collections

> **Status**: draft · **Date**: 2026-07-06 · **Repo**: 0xHoneyJar/sonar-api (thj-envio)
> **Phase**: /plan-and-analyze output → feeds /architect
> **Spine**: this is a **derisking PRD**. Its acceptance criteria are **spike results**, not a
> presumed framework. The build is gated on evidence the spikes produce.

## 1. Problem Statement

score-api (#121) needs **holding-history over time** — when a wallet entered a collection, how
long it held, whether it flips — to score behavior. The shipped SQD live-tail lane (#140-#142)
provides the *forward feed* from onboarding, and the Helius DAS snapshot provides *current
ownership*. Neither reaches **deep history** (genesis → onboarding), which is the interval most
of the holding-behavior signal lives in.

The historical constraint has been **cost**: we previously bought hosted Subsquid/Envio, and when
that became unaffordable the reflex was to reach for **metered reads** (Helius credits, Dune
egress) — a week-long saga of quota-outs and ~100× cost misses (KF-018, KF-020,
[[metered-provider-spike-protocol]]).

The correction (operator, 2026-07-06): **the constraint is HOSTING, not data.** The data lakes
are free (SQD Portal from block 0; Envio HyperSync). Hosted Subsquid/Envio charge to *run the
indexer for you*. We can **self-host the same indexer** — a box + genesis sync-time — and own the
extraction. We already run this pattern: the belt-indexer is self-hosted Envio Hyperindex on
Railway for EVM ([[sonar-is-pure-index]]). This PRD extends that pattern to Solana deep history.

> **Sources**: KF-020 + [[self-host-indexer-first]]; SQD lane #140-#142; two-lane ADR
> `grimoires/loa/context/2026-07-05-warehouse-supply-lane-adr.md`; #121; Phase-interview 2026-07-06.

## 2. Goals & Success Metrics

**Business objective**: own a **scalable** deep-history extraction where the **marginal cost of
adding a collection ≈ zero** (sync-time + storage on the same box), replacing metered reads whose
cost scales linearly-and-punishingly with reads/collections.

> **The scalability thesis is the north star** (operator): "indexer is more scalable — it lets us
> index and capture data and swap out or add collections. Paying for API/enhanced API is NOT
> scalable cost-wise. Use our skillsets to build and extract data into our warehouse."

**Success = the spike phase produces:**
- **G-1 (decision)**: a go/no-go on **Envio-for-Solana** against explicit gates (§5), with a
  **characterized Subsquid fallback** if any Envio gate fails. Default is Envio (incumbency);
  Subsquid only if Envio fails a gate.
- **G-2 (parity)**: the chosen framework's decode **reproduces the §4.5 reference** — the pythians
  bounded fixture (1,767 events, live-verified by the SQD lane) — same content-addressed PK, same
  ambiguity handling. Measured, not asserted.
- **G-3 (scale envelope)**: measured full-sync **wall-clock + peak RAM + storage growth** for a
  canary, extrapolated to **~20 collections now / 100 ceiling**, with a box sizing that fits a
  full sync + steady state (RAM discipline vs KF-015 OOM).
- **G-4 (cost proof)**: a **model-scalability** comparison — self-host (near-fixed box, marginal
  per-collection ≈ sync+storage) vs metered (linear reads) — showing self-host is the floor and
  where, if ever, the curves cross.
- **G-5 (integration)**: deep-history rows land in the **existing `svm.collection_event`** schema
  (PK `{tx_signature}:{nft_mint}:{instruction_index}`, insert-if-absent) and **pass the existing
  §4.5 gate** as the batch lane of the two-lane lambda.

**Non-goals for THIS effort**: not a production deployment (that's the post-decision build);
not a re-architecture of the live-tail or snapshot lanes; not ownership-completeness from windowed
data (KF-018 doctrine — deep history is range-complete decode, DAS stays the ownership trust root).

> **Sources**: Phase-interview 2026-07-06 (scale ~20→100; cost = model-scalability); §4.5 gate
> `test/sqd-45-gate-integration.test.ts`; two-lane ADR.

## 3. Users & Stakeholders

- **Primary consumer**: score-api (#121) — reads `svm.collection_event` for holding-behavior.
- **Operator (@zksoju)**: owns the cost/scalability decision; makes the final framework call *only
  if* Envio fails a gate (else default Envio holds).
- **Maintainer (zerker)**: sonar-api / warehouse.

**[ASSUMPTION A1]** This is **derisking/enrichment, not blocking** score-api's current needs — the
live-tail already feeds it forward; deep history is additive. *If wrong (it's blocking), the spike
phase reprioritizes fastest-to-first-collection over most-scalable, and G-3/G-4 thoroughness
yields to speed.*

## 4. Functional Requirements — the Spike Phase (the deliverable)

The PRD's core "features" are **throwaway spikes** (not `/implement` code) whose measured outputs
are the acceptance criteria. Two execution surfaces (operator-confirmed split):

| Surface | Runs | Why |
|---|---|---|
| **Executor MCP** (remote TS sandbox) | Coverage/data-lake **API probes** only | No local FS / no indexer runtime — good for "does the dataset reach genesis for these mints" |
| **Local** (spin-up-sync-measure) | Resource / wall-clock / decode-parity | A real indexer must run against a real box to measure RAM/time/storage |

- **FR-1 (coverage probe, MCP + HTTP)**: confirm Envio HyperSync Solana **coverage + genesis
  depth** for the target mints; confirm the same for Subsquid's Solana dataset (fallback). Output:
  a coverage table per framework per collection (reaches-mint? / earliest-slot / gaps?).
- **FR-2 (canary full-sync, local)**: sync **pythians** (has the §4.5 fixture) **+ one dense
  blue-chip (SMB gen2)** from genesis on Envio; record peak RAM, wall-clock, storage, request/rate
  behavior. Blue-chip is mandatory — a quiet collection alone under-measures the envelope.
- **FR-3 (decode parity, local)**: reconcile Envio's decoded events for the pythians window
  against the **§4.5 reference fixture** — same PK, ≥0.99 match, two-sided (no surplus), same
  ambiguous-group handling. Reuse `test/sqd-45-gate-integration.test.ts` semantics.
- **FR-4 (scale extrapolation)**: from FR-2/FR-3, model box size + sync-time + storage for 20 and
  100 collections; identify the binding resource (RAM per KF-015? storage? sync wall-clock?).
- **FR-5 (cost model)**: self-host $/mo (near-fixed) with marginal-per-collection ≈ sync+storage,
  vs the already-priced metered path (Helius/Dune) at 20 and 100 collections — the crossover proof.
- **FR-6 (Subsquid fallback spike)**: **runs only if** an Envio gate (§5) fails — repeat FR-1-3
  for Subsquid to characterize the fallback before switching.
- **FR-7 (decision record)**: a scored go/no-go + the framework verdict + the sizing/cost numbers,
  written to `grimoires/loa/context/` as the input to `/architect`.

**Anti-inference**: the spikes MEASURE; they do not presume. A framework "supports Solana" only if
FR-1 shows coverage to the needed depth AND FR-3 shows decode parity.

## 5. Technical & Non-Functional — the Envio Go/No-Go Gates

Decision rule (operator): **Default Envio; fall to Subsquid only if a gate fails.** Gates evaluated
in order; first failure triggers FR-6.

| Gate | Pass condition | Fail → |
|---|---|---|
| **GATE-1 Coverage** | Envio HyperSync reaches genesis for the target mints (FR-1) | Subsquid fallback |
| **GATE-2 Parity** | Envio decode reproduces §4.5 pythians fixture ≥0.99, two-sided (FR-3) | Subsquid fallback |
| **GATE-3 Fits a reasonable box** | canary full-sync peak RAM + steady-state fit a box whose cost is decisively below metered at 100-collection scale; no KF-015-class OOM (FR-2/FR-4) | Subsquid fallback OR resize + document |
| **GATE-4 Schema convergence** | decoded rows map cleanly onto `svm.collection_event` PK + insert-if-absent merge (no PK collision, no clobber) | design change, not a framework switch |

**Non-functional constraints:**
- **No metered spend without operator approval** ([[metered-provider-spike-protocol]]); the free
  data lakes (SQD Portal, HyperSync) are the substrate. Any paid axis → shaped probe + quote +
  budget guard + canary first.
- **Cheap-and-loud failure design**: spikes must fail fast and visibly (the walk-train lesson) —
  bounded canary, progress logging that survives pipes, no 4-hour silences.
- **BB gate** on any PR that lands from this cycle; spikes themselves are throwaway (not committed
  as production code).
- **§4.5 as the acceptance oracle** — deep history is *range-complete decode* reconciliation, never
  an ownership-completeness claim (KF-018; DAS stays the ownership trust root).
- **Deploy target**: Railway (belt-indexer incumbent) unless GATE-3 extrapolation proves it wrong
  at 100-collection scale.

> **Sources**: KF-015 (Envio OOM); §4.5 gate; two-lane ADR; Phase-interview 2026-07-06.

## 6. Scope & Prioritization

**MVP (this cycle)** = the spike phase (FR-1→FR-7) producing the decision record. **Explicitly not**
the production indexer deploy — that's the next cycle, gated on this one's go/no-go.

**Phase-1 canary set**: pythians (parity) + SMB gen2 (density). **Extrapolation target**: 20 now →
100 ceiling.

**Out of scope**: production deploy; live-tail/snapshot changes; Base/EVM; ownership-completeness
from events; any new metered provider.

## 7. Risks & Dependencies

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Envio HyperSync Solana coverage is shallow / not genesis** | med | GATE-1 probe FIRST, cheaply, before any sync effort; Subsquid fallback ready |
| **Full-sync density wall recurs** (the ~400k-request problem) | med | it was specific to *mint-filtered windowed* scanning; FR-2 tests whether *native full-sync* avoids it — this is THE derisking question, measured not assumed |
| **KF-015-class OOM on the canary** | med | RAM is a GATE-3 pass/fail; measure peak on the dense blue-chip, size the box to it |
| **Decode parity gap** (framework decodes differently than our §4.5 reference) | med | GATE-2 reconciles against the live-verified fixture; a gap is a framework fail, not a silent divergence |
| **Storage growth at 100 collections** unaffordable | low-med | FR-4 extrapolates; storage is cheap relative to metered reads, but bounded in the cost model |
| **Executor MCP can't run the resource spikes** | resolved | split surface: MCP for coverage, local for sync-measure (operator-confirmed) |

**Dependencies**: free SQD Portal + Envio HyperSync availability; local box for FR-2/FR-3; the
committed §4.5 fixture + gate; Railway (target). No paid dependency without approval.

## 8. Acceptance Criteria (the go/no-go)

The cycle is **done** when the decision record (FR-7) contains, with **measured evidence**:
1. Envio gate results (GATE-1→4), pass/fail each, with numbers.
2. The framework verdict (Envio, or Subsquid-if-Envio-failed) + why.
3. Box sizing + sync-time + storage for the canary, extrapolated to 20 and 100.
4. The model-scalability cost proof (self-host marginal-per-collection vs metered linear).
5. A schema-convergence confirmation (decoded → `svm.collection_event`, §4.5 parity ≥0.99 two-sided).
6. A go/no-go for the production-deploy cycle that follows.

> **Sources**: whole-document synthesis; operator Phase-interview + pre-gen gate 2026-07-06.
