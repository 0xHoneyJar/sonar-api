---
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "sonar-api — EVM belt-indexer zero-downtime re-platform (Seam B harden → Seam A lake+decode)"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "onboard a new community to the EVM belt with ZERO serving downtime and no full 6-chain re-backfill — near-term via a proven per-chain blue/green cutover (D4 + stable alias), structural via own-the-lake raw-ingest-once → re-runnable-decode ported from the proven SVM SQD pattern, so adding the Nth collection is a decode over rows we already hold, not a re-fetch"}
  learning_status: directionally-correct
  source: team-internal
---

# PRD — EVM Belt-Indexer Zero-Downtime Re-Platform

> **Status**: draft · **Date**: 2026-07-06 · **Repo**: 0xHoneyJar/sonar-api (thj-envio / freeside-sonar)
> **Phase**: /plan-and-analyze output → feeds /architect. **Sibling PRD**: `grimoires/loa/prd.md`
> (SVM deep-history indexer) — NOT superseded; this PRD is the EVM belt track and lives beside it.
> **Golden-path note**: `/build` etc. default to `prd.md`; point them at this file explicitly for
> the belt track (`/architect grimoires/loa/prd-belt-zero-downtime.md`).
> **Lens**: BOEHM (risk-driven spiral; retire the largest risk per cycle, gate commitment on
> retired risk). Companion decision record: `grimoires/loa/context/2026-07-06-indexer-zero-downtime-architecture.md`.
> **Spine**: a **downtime-elimination** PRD. Primary acceptance criterion is measured serving
> continuity (0 rows-dark seconds) through an add — not a feature count.

---

## 1. Problem Statement

Onboarding a community to the EVM belt today can take the live indexer **DARK for ~3h / 0 rows
served**. Adding any contract with pre-head history forces `ENVIO_RESTART=1 --restart` = wipe +
re-backfill **all 6 chains**, because envio's `isInitialized()` keys on **table-existence, not
config hash** — a new contract's history is only ingested via full restart, with no incremental
per-contract backfill.

> **Sources**: `2026-07-06-indexer-zero-downtime-architecture.md:§0,§3C` (code-confirmed envio
> `isInitialized()` behavior); `known-failures.md` KF-013 (--restart→SEED→BACKFILL); `SCALE.md`
> (D6 mutation-type table, SKP-003).

At the #121 scale target — **~100 communities @ ~10/day** — every batch collapses into one full
6-chain reindex, and the dark window **grows** with chain heads + contract count. The current
add-path is the Kitchen ingest worker (`src/kitchen/ingest-worker.ts`): it "patches
`TrackedErc721` in belt config, polls until indexed" — head-forward tracking, but a
pre-head-history contract still routes into the restart.

> **Sources**: `ARCHITECTURE.md:5-9` (Kitchen worker patches belt config); #121 scale target;
> `2026-07-06-indexer-zero-downtime-architecture.md:§0`.

**Priority order (operator, standing)**: **DOWNTIME ≫ compute.** We can spend compute (backfill,
2× transient infra); we cannot stop serving/ingesting. Fixing the dark window is the #1 goal;
minimizing compute is secondary.

**The field's verdict** (research, same decision record): nobody at scale reindexes to add a
contract. They split along one of two seams — **(A) ingest-raw-once / decode-many** (Dune, Nansen,
Arkham, Covalent — adding a contract is a downstream *decode*), or **(B) deploy-isolation + atomic
alias flip** (SQD slots/tags, Goldsky tags, SubQuery staging→prod). Our belt does neither: it
points live Hasura *at the surface it is rebuilding*.

> **Sources**: `2026-07-06-indexer-zero-downtime-architecture.md:§1-§3` (primary company sources
> cited inline there: docs.dune.com, docs.sqd.ai, docs.goldsky.com, goldrush.dev, etc.).

**Decisive in-repo fact (grounded reframe):** Seam A **already exists in this repo, for Solana** —
SQD Portal free lake (raw, block 0) → `decodeSqdBlocks` (re-runnable decode, untouched across the
whole spike, parity-proven 1767/1767) → `svm.collection_event`, via a **memory-light** range-
partitioned loader (RAM 153 MB). So the EVM "go for A" is **porting a proven in-repo pattern to the
6 EVM chains**, not greenfield design. And SQD has an EVM Portal + processor, so the same client/
loader shape applies to EVM.

> **Sources**: `2026-07-06-lake-decision-record.md:12-24` (GO on SQD; `decodeSqdBlocks`;
> `src/svm/sqd-parallel-loader.ts` 13/13 tests; RAM 153 MB); `src/svm/` inventory
> (`sqd-loader.ts`, `warehouse-loader.ts`, `sqd-collection-event-source.ts`) — Explore map §6.

---

## 2. Goals & Success Metrics

| # | Goal | Metric (measurable) | Baseline → Target |
|---|------|---------------------|-------------------|
| **G-1** | Kill downtime-on-add | rows-dark seconds during an add (measured on the served alias) | ~10,800 s (~3h) → **0** |
| **G-2** | Bound add blast radius | # chains re-scanned to add one contract | 6 → **1** |
| **G-3** | Flatten marginal add cost | infra + read cost of the Nth collection (BOEHM self-host curve) | full 6-chain re-backfill → **~$0 re-decode/range-backfill, free lake reads** |
| **G-4** | Retire KF-015 on add | heap-OOM crash-loops during add-driven sync | present (12GB heap band) → **0** (memory-light loader) |
| **G-5** | Prove the cutover, not assert it | GATE-A executed on staging: continuous serve across a flip, no split-brain | unexecuted → **PASS, logged** |

> **Sources**: G-1/G-2 from `2026-07-06-indexer-zero-downtime-architecture.md:§4-§5`; G-3 from
> `2026-07-06-boehm-economics-svm-indexer.md:§1-§3` (bounded-flattening self-host curve); G-4 from
> KF-015; G-5 from Explore map §4 (GATE-A unexecuted; `NODE_OPTIONS` not baked; `SDD §7.4` dangling).

**Non-goal metric guardrail**: compute is explicitly *allowed to rise* (2× transient belts, range
re-backfill) in service of G-1. Do not trade serving continuity to save compute.

---

## 3. Users & Stakeholders

| Stakeholder | Need | Citation |
|-------------|------|----------|
| **score-api (#121, #163)** | uninterrupted holder reads across an add; a stable GraphQL URL + a stable raw-PG `DATABASE_URL` signal for which belt is live | `promote.sh:8-11` (publishes current-belt DB signal to Score); #121 |
| **Kitchen ingest worker** | an add-path that does NOT trigger a global restart | `ARCHITECTURE.md:5-9` |
| **Operator (zerker)** | one gated, reversible cutover procedure; no split-brain; keep-broken-green-for-postmortem | `promote.sh:22-27,113-121` |
| **Public GraphQL consumers** | the `sonar.0xhoneyjar.xyz/v1/graphql` alias never changes across a swap | `Caddyfile:47-51` |

---

## 4. Functional Requirements

Two tracks. **Track B (near-term)** kills downtime on the *current Envio belt* by making the
already-built cutover machinery **proven + consistent**, with the **per-chain split (D4) as the
keystone**. **Track A (structural)** ports the proven SVM lake+decode pattern to EVM so an add
becomes a re-decode, not a re-fetch. D4 is the shared unlock (it is Track B's blast-radius fix AND
Track A's per-chain loader unit).

### Track B — Near-term: proven per-chain blue/green cutover (D4 + harden)

- **FR-B1 (D4 per-chain split — keystone).** The system shall run the belt as **one deployment
  per chain** (6 belts) behind a Hasura remote-schema/stitching layer, so that *when* a contract is
  added, *the system shall* re-scan **only that contract's chain**.
  - Rationale: bounds blast radius 6→1 (G-2); is the natural unit for Track A's per-chain lake
    loaders; and de-risks SKP-003 (a 6-chain *simultaneous* reindex 429-storms RPC).
  - **Correction to prior framing** `[EVIDENCE: Explore map §4]`: D4 is **not** required for memory
    — blue/green already fits because blue/green are *separate Railway services with separate
    Postgres* (KF-015's 12GB heap does not stack: blue=4-chain/default heap + green=6-chain/12GB in
    distinct 24GB containers). D4 is justified by blast-radius, SKP-003, and Track-A alignment.
  > Sources: `SCALE.md` D4; Explore map §2,§4,§5; `config.yaml` (6 chains), `config.mibera.yaml` (4).

- **FR-B2 (stable consumer alias + gated atomic swap).** The system shall serve every consumer
  through a **stable alias** (Caddy `BELT_UPSTREAM`) whose swap is performed **only** by
  `promote.sh` after a **non-skippable** `promotion-gate.js` PASS (sole-writer, fail-closed).
  *If* a swap is attempted without a fresh gate PASS, *the system shall* abort (anti-SKP-001
  split-brain). The gate requires **both belts live + distinct** concurrently (expansion mode
  refuses blue-vs-blue).
  - **Consistency debt to retire** `[EVIDENCE: Explore map §2,§6-contradictions]`: reconcile the
    doc disagreement where `SCALE.md` D2 calls the alias "TODO" while `Caddyfile`+`promote.sh` treat
    it as the built sole-writer path. Ratify one truth.
  > Sources: `promote.sh:8-11,79-99,88-90`; `promotion-gate.js:530-542`; `Caddyfile:47-51`;
  > `SCALE.md:76,127,341` (Guardrail 5 precondition; D2 "TODO"); SKP-001.

- **FR-B3 (zero-drop apply).** At swap time *the system shall* apply the flip with **0 dropped
  requests** — default **Option B** (loopback-only Caddy admin → graceful `caddy reload`); *if*
  loopback reload is infeasible on Railway, *the system shall* fall to **Option C** (≥2 gateway
  replicas → rolling redeploy). No re-decision needed; pick per measured behavior.
  - Open fragility: `promote.sh` today flips a **Railway env var** (`BELT_UPSTREAM`); the zero-drop
    graceful-reload is the *intended* apply path but is unproven on Railway. Prove B or adopt C.
  > Sources: `promote.sh:35-38`; `Caddyfile:4-10` (`admin localhost:2019`).

- **FR-B4 (execute GATE-A — prove it).** The system shall execute, on a staging pair, an
  end-to-end proof: add one contract to green, catch green to head, flip the alias, and demonstrate
  **continuous serve (0 dropped queries)** and **no split-brain**. GATE-A PASS is the gate that
  retires the in-place `--restart` as the standing add procedure.
  > Sources: `2026-07-06-indexer-zero-downtime-architecture.md:212-214,251` (GATE-A defined,
  > unexecuted).

- **FR-B5 (durable ops hygiene).** The system shall: **(a)** bake `NODE_OPTIONS=--max-old-space-size`
  into `Dockerfile.belt` so any belt deploy inherits the KF-015 heap fix (currently a green-only
  service var); **(b)** provide the missing `scripts/rollback-belt.sh` OR reconcile its callers onto
  `promote.sh --rollback`; **(c)** retire the **dangling `SDD §7.4`** — `/architect` shall author
  the real, versioned cutover SDD section (Option B/C, gate, rollback triggers) that `promote.sh`
  and `Caddyfile` currently cite into a void.
  > Sources: Explore map §3 (dangling SDD anchors), §4 (`NODE_OPTIONS` not baked), §5 (missing
  > `rollback-belt.sh`); KF-015 reading guide (bake NODE_OPTIONS into Dockerfile.belt).

### Track A — Structural: own-the-lake raw-ingest-once → decode-many (port SVM pattern to EVM)

- **FR-A1 (own-the-lake raw ingest).** The system shall ingest raw EVM chain data (logs/tx/traces)
  **once** from the **SQD Portal EVM** free lake into **our own store** (the lake we own and query),
  reusing the proven SVM loader shape (`src/svm/sqd-*loader.ts`, `warehouse-loader.ts`). Raw is
  written once and **not re-fetched** to add a collection.
  - Operator intent (Q&A): "ingest the data into our own lake and query our own data and decode" —
    self-host the raw copy, do not decode-on-read against a vendor.
  > Sources: operator answer (this session); `2026-07-06-lake-decision-record.md:12-24`;
  > `src/svm/` inventory; KF-020 self-host doctrine.

- **FR-A2 (separated, re-runnable decode).** The system shall decode raw → typed rows via a
  standalone **EVM decode step** (analog of `decodeSqdBlocks`), so that *when* a collection is
  added, *the system shall* **re-decode / range-backfill only that collection** over rows already
  held — **no re-fetch, no `--restart`, no 6-chain reindex.**
  > Sources: `2026-07-06-indexer-zero-downtime-architecture.md:§3A,§4-S2`; `decodeSqdBlocks` precedent.

- **FR-A3 (serve unchanged behind the same alias).** The system shall serve decoded EVM rows via
  Hasura behind the **same Caddy alias** (FR-B2), so cutting a chain from Envio-belt-served to
  lake-served requires **no consumer change** (the alias is the seam; Track B's cutover harness is
  the migration mechanism).
  > Sources: `Caddyfile:47-51`; `2026-07-06-indexer-zero-downtime-architecture.md:§5-fallback`.

- **FR-A4 (memory-light).** The lake loader + decode shall run **memory-light** (SVM precedent:
  153 MB range-partitioned), retiring KF-015's 6-chain fused-fetcher heap ceiling.
  > Sources: `2026-07-06-lake-decision-record.md` G-3 (RAM 153 MB); KF-015.

- **FR-A5 (parity gate before cutover).** Before any chain cuts over to lake-served, *the system
  shall* prove **decoded EVM rows match the current Envio belt output** for that chain (a GATE-2-style
  parity check, analog of the SVM 1767/1767), gating the alias flip.
  > Sources: `2026-07-06-lake-decision-record.md` G-2 (parity-proven); `parity-check.sh`.

---

## 5. Technical & Non-Functional Requirements

- **NFR-1 (zero downtime — the load-bearing NFR).** Any add or cutover shall hold serving continuity
  at **0 rows-dark seconds** on the alias. This overrides compute economy.
- **NFR-2 (self-host doctrine, KF-020).** The raw lake shall be self-hosted from free lakes (SQD
  Portal / HyperSync); **no metered read path** becomes a default dependency without a BOEHM gate.
  Goldsky Mirror / Covalent GoldRush remain the **characterized fallback** only (managed decoded CDC
  into our Postgres) — invoked if operating per-chain blue/green + lake proves too heavy, not as the
  first move.
- **NFR-3 (RPC 429 budget, SKP-003).** No procedure shall trigger a **simultaneous** multi-chain
  cold reindex against RPC; range-partition + stagger + prefer HyperSync/SQD-lake reads.
- **NFR-4 (reversibility).** Every cutover shall be reversible via a gated/ungated rollback that
  keeps the broken belt hot for postmortem (no fix-in-place).
- **NFR-5 (provenance of "which belt is live").** The current-belt `DATABASE_URL` signal to raw-PG
  consumers (Score #163) shall flip atomically with the GraphQL alias.
> Sources: KF-020, SKP-001/003, `promote.sh:8-11,22-27,113-121`,
> `2026-07-06-indexer-zero-downtime-architecture.md:§5`.

---

## 6. Scope & Prioritization

- **MVP (Track B, downtime kill NOW)**: FR-B1 (D4) + FR-B2 + FR-B3 + FR-B4 (GATE-A) + FR-B5.
  Outcome: an add takes the belt to **0 downtime** and re-scans **1 chain**, on the *existing Envio
  engine*. This is shippable without Track A.
- **Phase 2 (Track A, structural)**: FR-A1–FR-A5. Outcome: an add becomes a **re-decode**, retiring
  re-fetch entirely and KF-015 with it. Cut chains over one at a time behind the Track-B alias
  (parity-gated), lowest-volume chain first.
- **Explicitly OUT of scope**:
  - The **SVM deep-history** lane (`prd.md`, `src/svm/`) — separate PRD; this PRD *reuses its
    pattern* but does not re-plan it.
  - **Ponder** — removed (`ARCHITECTURE.md:15`); ignore `deploy-blue.sh`'s "Ponder blue belt" text
    and the Ponder-migration cutover lane (`snapshot-pre-cutover.sh`, missing `rollback-belt.sh`)
    except to reconcile overloaded "blue" vocabulary.
  - A **ClickHouse/dbt medallion** warehouse — the Dune/Covalent decode-locus is the *reference
    model*, not an adopt-wholesale target; our decode is the SVM-style typed-decode step (FR-A2),
    not a dbt project (revisit only if decode SQL outgrows it).

---

## 7. Risks & Dependencies

| ID | Risk | Severity | Retired by | Go/No-Go gate |
|----|------|----------|-----------|---------------|
| R-1 | **SKP-001 split-brain** on a non-atomic swap | High | FR-B2 sole-writer + fail-closed gate | GATE-A: no split-brain observed |
| R-2 | **Two-belts-live unproven** on current deploy (asserted, never measured) | High | FR-B4 | GATE-A: both belts serve concurrently |
| R-3 | **SKP-003 429-storm** on multi-chain simultaneous reindex | High | FR-B1 (D4) + NFR-3 | green reaches head w/o sustained 429 |
| R-4 | **KF-015 OOM** on add-driven sync | Med (mitigated) | FR-B5(a) bake NODE_OPTIONS; FR-A4 memory-light loader | no OOM crash-loop on add |
| R-5 | **Doc debt** — dangling `SDD §7.4`, missing `rollback-belt.sh`, alias "built vs TODO" disagreement | Med | FR-B5(b,c) + FR-B2 reconcile | `/architect` emits versioned §7.4; scripts resolve |
| R-6 | **Option B (caddy reload) infeasible on Railway** → seconds blip | Med | FR-B3 fall to Option C (≥2 replicas) | measured 0-drop on B, else C proven |
| R-7 | **EVM decode parity drift** vs Envio belt | High (Track A) | FR-A5 parity gate | per-chain parity PASS before flip |
| R-8 | **SQD Portal EVM coverage/retention** insufficient for a chain's genesis | Med (Track A) | GATE-1-style coverage probe per chain (as SVM did) | block-0→head reachable, else characterized fallback (NFR-2) |

**Dependencies**: SQD Portal EVM lake (external, free); Railway (services + per-service RAM caps);
Hasura remote-schema/stitching (for D4); the proven SVM `src/svm` loader/decoder shape (internal,
reused); `promote.sh`/`promotion-gate.js`/`Caddyfile` (internal, harden).

**Spiral gates (BOEHM)** — commitment gates on retired risk, fallback held in reserve:
`GATE-A (prove B) → GATE-B (D4 blast-radius: Base add re-scans Base alone) → per-chain GATE-1
(coverage) + GATE-2 (parity) before each Track-A cutover`. Characterized fallback:
Goldsky/Covalent managed decoded CDC into our Postgres (NFR-2) if self-host per-chain lake proves
too heavy — kept characterized, not run by default.

---

## 8. Traceability

Every requirement above cites either a repo file (`file:line`), a decision record
(`2026-07-06-indexer-zero-downtime-architecture.md`, `2026-07-06-lake-decision-record.md`,
`2026-07-06-boehm-economics-svm-indexer.md`), a known-failure (KF-013/015/016/020), `SCALE.md`
(D2/D4/SKP-001/003/D6), or the operator's answers in this /plan-and-analyze session (decode locus =
own-the-lake port of SVM pattern; D4 as keystone; new PRD file). Primary external company sources
for the seam models are cited inline in `2026-07-06-indexer-zero-downtime-architecture.md` (Dune,
SQD, Goldsky, Covalent, Nansen, Arkham, SubQuery, The Graph, Ponder, Envio, pgroll).
