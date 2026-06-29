---
title: "Sprint Plan: sonar-api → Managed Envio (Phase A — Stand-Up + Measured Ratification)"
trust_tier: operator-authored
read_state: unread
confidence: 0.6
decay_class: working
last_confirmed: 2026-06-23
operator_signed: self_attested
---

# Sprint Plan: sonar-api → Managed Envio (Phase A — Stand-Up + Measured Ratification)

**Version:** 1.0 (managed-Envio Phase A)
**Date:** 2026-06-17
**Author:** Sprint Planner Agent (ARCH · OSTROM, craft lens)
**PRD Reference:** `grimoires/loa/prd.md` (r2, Flatline-hardened)
**SDD Reference:** `grimoires/loa/sdd.md` (v1.0, §5.5 gate core + R1 fallback)
**Cycle:** `indexing-managed-envio` · **Repo HEAD at design time:** `1e812628`
**Supersedes:** the prior `sprint.md` (sonar-belt-factory v2.0 — already archived to `grimoires/loa/context/sprint-sonar-belt-factory-v2-SUPERSEDED-2026-05-22.md`). That plan's premise (self-host Envio belts on Railway, beat managed on cost) was **inverted** by the loa-finn TCO experiment.

> **Grounding legend:** `[CODE:file]` = codebase reality read · `> file:Lnn` = doc quote · `(git:SHA)` = commit evidence · `[ASSUMPTION]` = ungrounded claim flagged · 🔐 = live security action · 🔒 = operator-gated.

---

## Executive Summary

Phase A stands the **existing 6-chain Envio HyperIndex source up on managed Envio Cloud** for one real billing cycle, to produce the single `measured` cost + toil number that ratifies-or-revises the indexing-strategy ADR and closes `bd-buho` (loa-finn). The indexer **already exists and is live at HEAD** (`Dockerfile.belt` runs `envio@3.0.0-alpha.17` on `config.yaml`/`config.mibera.yaml`) — this is **a deploy-and-measure exercise, not a build** (sdd.md:51-56). The work product is **the §5.5 validation harness** that proves a managed-Envio measurement would be valid **before the 30-day billing clock starts**, plus the **R1 fallback** for the one failure mode that can block the whole direction (events-pillar unable to publish from Cloud).

Phase A is **additive and reversible** (NFR-3): live serving (Railway green/blue behind the Caddy stable-alias gateway) is untouched throughout — no consumer repointed, no Railway service retired, no alias swapped.

> **Two highest-risk items are FRONT-LOADED as early spikes:**
> 1. **🔐 Rotate the exposed `SONAR_SIGNING_SEED_HEX` (`bd-54c`) — Sprint 1, Task 1.1, FIRST.** A *known-compromised* Ed25519 seed signs live NATS events right now; every event between exposure and rotation is forgeable (Flatline SKP-001, CRITICAL 950 — the highest-scored finding). **Independent of the migration**; not a Phase-B footnote.
> 2. **G-A3 / OQ-3 events-pillar blocker-decider — Sprint 2.** Test the *in-process* events-pillar's private-repo postinstall (`scripts/rebuild-events-dist.sh` → `@0xhoneyjar/events`) **inside Envio Cloud's build sandbox** + NATS TLS egress + Ed25519 signing to a **TEST subject**. This is the likely blocker that decides "delete all Railway" vs **R1** (standalone publisher). Tested before any spend.

**The §5.5 gate (G-A1…G-A5) must ALL pass GREEN before Sprint 5's billing clock starts.** Sprint 5 is the only sprint that costs money.

**Total Sprints:** 5 (S1–S5; global IDs 177–181) · **Sprint Duration:** ~2.5 engineering-days each (S5 is a 30-day measurement wall-clock with bounded engineering touch) · **Scope:** Phase A only. **Phase B (consumer repoint + Railway teardown) is OUT — hard-gated on `bd-buho` ratifying** (§ Out-of-Scope below).

---

## Goals (from PRD §3)

| ID | Goal | Measurement | Validation |
|----|------|-------------|------------|
| **G-1** | Produce the `measured` 1x row — real $/mo (`cost_basis` = Envio Cloud invoice + tier + footprint) + setup toil-hours + 30d incident count on the **full 6-chain footprint**, flipping the loa-finn crossover `quote → measured`, emitting `RATIFY` or a revised number. | 1 real invoice, normalized steady-state | loa-finn `indexing:read` |
| **G-2** | Validate **functional parity, not just $**: GraphQL footprint entities (93 + `chain_metadata`), the NATS events-pillar publish, and a decision on per-token ownership. | 100% GraphQL sample; events verdict; per-token decision | FR-4/FR-5/FR-6 |
| **G-3** | De-risk the managed direction: confirm Envio HyperSync coverage for all 6 chains (esp. Zora 7777777) and that the events-pillar can run on managed Envio — or identify the blocker before Phase B is ever unlocked. | HyperSync 6-chain confirmed; events egress confirmed or blocker documented | G-A3 / NFR-4 |

---

## Sprint Overview

| Sprint | GID | Theme | Scope | Key Deliverables | Dependencies |
|--------|-----|-------|-------|------------------|--------------|
| **S1** | 177 | Security pre-action + gate foundation (Phase A.0 + A.1 head) | MEDIUM (6) | 🔐 seed rotation; separate Phase-A key + secrets model; G-A5 footprint correction; G-A1 HyperSync restore; G-A2 version match | None (S1-T1 unblocks all) |
| **S2** | 178 | Events-pillar reachability blocker-decider (G-A3 / OQ-3) + R1 fallback contingency (A.1b) | MEDIUM (5) | G-A3 in-process pillar test on a Cloud canary → TEST subject; R1 standalone-publisher build IFF G-A3 fails | S1 (key + Cloud account + G-A1/G-A2) |
| **S3** | 179 | Per-token scope + §5.5 gate close-out | SMALL (3) | G-A4 per-token spike + parity sizing; gate-record asserting G-A1…G-A5 ALL GREEN | S1, S2 |
| **S4** | 180 | Backfill + GraphQL parity | SMALL (3) | 6-chain backfill to head; `freshness_lag_s`; GraphQL parity sample (N per chain × collection) | S3 (gate GREEN) |
| **S5** | 181 | Measured 30-day cycle + ratify + E2E validation (final) | MEDIUM (5) | 🔒 30-day cycle w/ as-it-happens toil; invoice normalization; `indexing:capture`→`indexing:read`→ratify; close `bd-buho`; E2E goal validation | S4; **G-A1…G-A5 GREEN** |

> **Hard barrier:** the FR-7 billing clock (start of S5) does NOT start until S3 records G-A1…G-A5 all GREEN (SDD §2 invariant; §9 "billing clock is a hard barrier between A.2 and A.3").

---

## Sprint 1 (GID 177): Security Pre-Action + Gate Foundation

**Scope:** MEDIUM (6 tasks) · **Duration:** ~2.5 days · **Maps to:** SDD Phase A.0 + A.1 head

### Sprint Goal
Eliminate the live signing-seed exposure, establish the separate Phase-A key + third-party secrets model, and bring the three machine-verifiable pre-deploy gates (footprint, HyperSync restore, version match) to GREEN — so Sprint 2's blocker-decider canary can deploy on a clean, version-matched, correctly-scoped config.

### Deliverables
- [ ] 🔐 `SONAR_SIGNING_SEED_HEX` rotated across all live green services (new Railway env value + restart); old seed no longer signs anything. `bd-54c` closed.
- [ ] A **separate Phase-A Ed25519 signing key** provisioned (distinct `signing_key_id`, NOT the production seed) + a documented third-party secrets model (how the key + NATS CA reach Cloud, scoped lifetime, revocation).
- [ ] loa-finn stand-up runbook footprint corrected from "93 Berachain contracts" → **6-chain** (`1·10·42161·7777777·80094·8453`). G-A5 pass artifact.
- [ ] A **Cloud-targeted config branch** with HyperSync restored (zero `erpc.railway.internal`). G-A1 pass artifact (codegen log + grep-zero).
- [ ] Managed Envio Cloud version probed vs `3.0.0-alpha.17`; G-A2 verdict (compatible OR bounded-delta-as-task).

### Acceptance Criteria
- [ ] 🔐 Old seed value is provably out of rotation (Railway env shows new value; service restarted; an attestation signed after rotation verifies against the new key, an old-seed signature does not).
- [ ] Phase-A key's `signing_key_id` is distinct from production; documented secrets-delivery model exists and names how Cloud receives the key + CA (env var vs secret store) (SKP-002 / R7).
- [ ] G-A5: loa-finn runbook line reads 6-chain footprint; committed in loa-finn and referenced from the gate record (sdd.md:279).
- [ ] G-A1: `envio codegen` dry-run against the Cloud-targeted config is **clean**; `grep -c 'erpc.railway.internal'` over the Cloud config = **0**; HyperSync data source present for all 6 chains. Base (8453) HyperSync break-glass (`ENVIO_API_TOKEN`) is NOT flagged as a regression (sdd.md:219).
- [ ] G-A2: Cloud `envio` version recorded; if it differs from `3.0.0-alpha.17`, the schema-field delta (the `rpc` vs `rpc_config` drift class, config.mibera.yaml:223-225 `[CODE]`) is enumerated and bounded as an explicit task — NOT discovered mid-cycle.

### Technical Tasks
- [ ] **Task 1.1: 🔐 Rotate `SONAR_SIGNING_SEED_HEX` NOW (DO FIRST, blocks nothing — independent live action).** New Railway env value across every green service that holds it; restart; verify post-rotation signing. Close `bd-54c`. → **[G-3]** *(Flatline SKP-001 CRITICAL 950; sdd.md:167)*
- [ ] **Task 1.2: 🔒 Provision a separate Phase-A signing key + write the third-party secrets model.** Distinct seed/`signing_key_id`; document delivery to Cloud (env vs secret store), scoped lifetime, revocation. Never give the production seed to Envio's infra. → **[G-3]** *(SKP-002 HIGH 750; sdd.md:168-169, R7)*
- [ ] **Task 1.3: G-A5 — correct the loa-finn runbook footprint to 6-chain.** Edit `~/Documents/GitHub/loa-finn/src/research/standups/envio-hyperindex.md` footprint line `93 Berachain contracts` → all 6 chains; commit in loa-finn; reference from gate record. → **[G-1, G-3]** *(IMP-003 avg 901 — highest-scored; sdd.md:267-279)*
- [ ] **Task 1.4: G-A1 — author the Cloud-targeted config branch (HyperSync restore, FR-1).** Remove the per-chain bare `rpc:` block (`for: sync` + `for: live` → `erpc.railway.internal:4000`) so HyperSync becomes Envio's default source, OR add explicit `hypersync_config` per chain. Assert against the field name the Cloud version expects (couples to 1.5). → **[G-3]** *(IMP-008 avg 836.5; sdd.md:207-221; de-HyperSync commits `01d19638`/`cb0c2f4e`/`d7f38fef`)*
- [ ] **Task 1.5: G-A1 verification — codegen dry-run + zero-erpc grep on the Cloud config.** Commit the codegen log + the grep-zero result as the gate pass artifact. → **[G-3]**
- [ ] **Task 1.6: 🔒 G-A2 — probe managed Envio Cloud's `envio` version; bound any delta.** Record version; if it differs, run the 1.5 codegen against the Cloud version's schema and capture field renames as a bounded task; an unbounded skew HALTS. → **[G-1, G-3]** *(SKP-003 HIGH 760, R6; sdd.md:223-230)*

### Dependencies
- None blocking. Task 1.1 is independent and runs immediately. Tasks 1.4–1.6 need the Envio Cloud account (🔒 operator-gated) for the version probe; the config branch + codegen can proceed locally before the account exists.

### Security Considerations
- **Trust boundaries:** the production signing seed is the crown jewel; rotation (1.1) shrinks the live-exposure window; the separate Phase-A key (1.2) prevents handing the production seed to a third party (Envio Cloud).
- **External dependencies:** managed Envio Cloud will hold the Phase-A key + NATS CA — define the custody model (1.2) before any publish.
- **Sensitive data:** Ed25519 seeds (PEM/hex), NATS CA (PEM body, Path-ε convention, sdd.md:171). Never log or commit seed material.

### Risks & Mitigation
| Risk | Prob | Impact | Mitigation |
|------|------|--------|------------|
| Seed already publicly leaked (not just transcript-local) | Med | High | Rotate NOW (1.1) regardless; conservative call (bd-54c note) |
| Cloud pins a different alpha → unbounded schema drift | Med | Invalidates parity / balloons scope | G-A2 (1.6) bounds the delta as a task or HALTS before deploy (R6) |
| `rpc`-vs-`rpc_config` naming drift silently rejected by Cloud schema | Med | G-A1 false-pass | Assert against the Cloud version's field name, not the local alpha's (couples 1.4↔1.6) |

### Success Metrics
- 1 rotated seed; 1 separate Phase-A `signing_key_id`; secrets-model doc exists.
- G-A1 codegen clean + `erpc.railway.internal` count = 0; HyperSync source for 6/6 chains.
- G-A2 version recorded; delta = 0 or bounded-task-count recorded.
- G-A5 runbook footprint = 6 chains.

---

## Sprint 2 (GID 178): Events-Pillar Reachability Blocker-Decider (G-A3 / OQ-3) + R1 Fallback Contingency

**Scope:** MEDIUM (5 tasks; 2 of which are conditional on G-A3 FAIL) · **Duration:** ~2.5 days · **Maps to:** SDD Phase A.1 (G-A3) + A.1b (R1)

### Sprint Goal
Settle the single architectural question that decides "delete all Railway" vs keeping a standalone publisher: can the **in-process** events-pillar actually run on managed Envio Cloud? Test it on a real Cloud canary deploy — build sandbox, NATS egress, and signing — publishing only to a TEST subject. If it cannot, build the named R1 fallback and re-verify.

### Deliverables
- [ ] A **canary managed Envio Cloud deploy** built from the Sprint-1 Cloud-targeted config branch (additive; no production subjects, no consumer touch).
- [ ] A **G-A3 verdict**: the in-process publish path (vendored `@0xhoneyjar/events`) either runs on Cloud and a signed synthetic mint event verifies on a TEST subject, OR a documented blocker (which build/egress/custody constraint failed).
- [ ] **OQ-3 answered:** whether Cloud's build sandbox runs `scripts/rebuild-events-dist.sh` (custom postinstall + git clone of the cluster-pinned loa-freeside SHA).
- [ ] **IFF G-A3 FAILS:** an R1 standalone NATS publisher (cluster-resident, Phase-A key, Redis-backed `PrevHashStore`, outbox/reorg-safe semantics) + a re-run G-A3 against it.

### Acceptance Criteria
- [ ] (a) **Exact subject set** enumerated: every `test.nft.mint.detected.<slug>.v1` for the slugs the 6 publishing handlers emit — `mibera-shadow`, `mibera-collection`, `mibera-sets`, `mibera-zora`, `mibera-liquid-backing`, `mibera-staking`, `purupuru-apiculture` (`CollectionSlug` `[CODE:events-publisher.ts:135-142]`; subject via `nftMintDetectedTopic` `[CODE:events-publisher.ts:340]`).
- [ ] (b) **Signature verified** against the **Phase-A** `signing_key_id` (NOT production) — `LocalEd25519Signer.fromSeedHex(seedHex, "sonar-api-1")` `[CODE:events-publisher.ts:262]`.
- [ ] (c) **Sample size** ≥ N synthetic mint events (N pragmatic; SKP-002 canary minimum = 1, prefer several).
- [ ] (d) **TEST/shadow subject ONLY** — `test.` prefix; **never** a production subject (NFR-3 / SKP-001: concurrent production publish from the canary = duplicated/unsequenced/conflicting events corrupting production state).
- [ ] (e) **Named executor** runs and signs off the G-A3 record (Phase-A KRANZ Act-1 coordinator).
- [ ] G-A3 tests the **actual in-process path on a real Cloud deploy**, not just NATS reachability from an arbitrary host (sdd.md:250).
- [ ] **On FAIL:** R1 publisher is cluster-resident (seed never leaves the cluster), uses a Redis-backed `PrevHashStore` (NOT `InMemoryPrevHashStore` which resets to GENESIS on restart, `[CODE:events-publisher.ts:62-67]`), publishes to TEST subjects, and a re-run G-A3 against it passes — OR R1 is escalated as HALT.

### Technical Tasks
- [ ] **Task 2.1: 🔒 Stand up the canary Cloud deploy from the Cloud-targeted config branch.** Production tier (FR-2); additive; record the quoted $/mo + tier name verbatim the moment it is given (→ `cost_basis`). → **[G-1, G-3]**
- [ ] **Task 2.2: G-A3 / OQ-3 — verify the in-process events-pillar on Cloud.** Confirm whether the build sandbox runs `rebuild-events-dist.sh` (postinstall + external git clone) so `@0xhoneyjar/events` is present at runtime; if the sandbox accepts only stock handlers + config, the in-process path is **structurally unavailable** → R1 regardless of NATS reachability (sdd.md:154,250, OQ-3). → **[G-2, G-3]**
- [ ] **Task 2.3: G-A3 — trigger ≥N synthetic mints; verify signed envelopes on TEST subjects.** TLS/mTLS egress per the existing posture (`tls://`/`nats+tls://` or `nats://`+`NATS_TLS_CA`, plaintext refused, `[CODE:events-publisher.ts:166-187]`); subscriber verifies Ed25519 against the Phase-A `signing_key_id`; record the G-A3 pass/fail artifact + named executor sign-off. **FAIL → STOP the cycle; trigger Task 2.4.** → **[G-2, G-3]** *(IMP-005 avg 831.5; SKP-001/002 CRITICAL 880)*
- [ ] **Task 2.4 (CONDITIONAL — only if 2.3 FAILS): Build the R1 standalone NATS publisher (§3).** Cluster-resident (Railway service or freeside cell, private NATS access); GraphQL-poll with durable per-collection cursor `(blockNumber, logIndex)` (fallback Cloud webhook); `LocalEd25519Signer` Phase-A key in-cluster; **Redis-backed `PrevHashStore`**; adopt the fuller Ponder `nats-publisher.ts` outbox/reorg-safe/DLQ model where feasible (NOT the simpler in-handler one — re-porting without outbox is a reliability regression per PRD §7). → **[G-2, G-3]** *(SKP-001 closure; sdd.md:283-322)*
- [ ] **Task 2.5 (CONDITIONAL — only if 2.4 built): Re-run G-A3 against the R1 fallback** (TEST subject) + record that the measured `cost_usd_month` MUST then include the fallback-service line item (the ratified architecture becomes "Cloud + standalone publisher", sdd.md:324-326). → **[G-1, G-3]**

### Dependencies
- **Sprint 1:** Phase-A key + secrets model (1.2), G-A1 clean Cloud config (1.4-1.5), G-A2 version verdict (1.6), Envio Cloud account (🔒).
- R1 deployment target (Railway service vs freeside cell) is OQ-7 — decided only on G-A3 FAIL; cell maintainer (zerker) owns.

### Security Considerations
- **Trust boundaries:** the canary uses the **Phase-A** key only; the production seed never reaches Cloud. R1 (if built) keeps the seed entirely in-cluster — Cloud exposes GraphQL only (shrinks the third-party trust boundary, SKP-002).
- **External dependencies:** `@0xhoneyjar/events` is materialized from a cluster-pinned loa-freeside SHA via git clone — the integrity-sensitive build step OQ-3 probes.
- **Sensitive data:** TEST-subject isolation is the load-bearing non-interference control (NFR-3).

### Risks & Mitigation
| Risk | Prob | Impact | Mitigation |
|------|------|--------|------------|
| Cloud build sandbox rejects the custom postinstall (vendored events pkg) | Unknown | Forces R1 even if NATS reachable | G-A3 tests the real in-process path (OQ-3); R1 is the named fallback |
| Cloud denies private-NATS egress or seed custody | Med | Blocks in-process pillar | G-A3 STOP → R1 keeps seed in-cluster, GraphQL-poll source |
| Canary accidentally publishes to a production subject | Low | Corrupts production state | TEST-prefix-only acceptance gate (d); reviewed before any publish |
| R1 inherits `InMemoryPrevHashStore` GENESIS-on-restart bug | Med | Breaks hash chain for `chainStore` subscribers | Redis-backed `PrevHashStore` mandated (2.4) |

### Success Metrics
- 1 canary Cloud deploy; G-A3 verdict recorded (PASS with ≥N verified signed events on TEST subjects, OR documented blocker).
- OQ-3 answered (sandbox runs postinstall: yes/no).
- If R1: 1 standalone publisher passing G-A3 against the fallback; fallback cost line item noted for `cost_basis`.

---

## Sprint 3 (GID 179): Per-Token Scope + §5.5 Gate Close-Out

**Scope:** SMALL (3 tasks) · **Duration:** ~2.5 days (≤1 day of which is the per-token spike) · **Maps to:** SDD Phase A.1 tail (G-A4) + the §5.5 ALL-GREEN barrier

### Sprint Goal
Make the per-token-ownership decision with a deadline (re-port to Envio handlers vs measure-with-accepted-gap), size the GraphQL parity sample, and close the §5.5 gate by recording that G-A1…G-A5 are ALL GREEN — the hard barrier the billing clock cannot cross until satisfied.

### Deliverables
- [ ] A **per-token decision** (G-A4): re-port the `token` projection into the Envio handlers, OR measure-without-it. If measure-without-it, an **operator-signed accepted-gap** is queued for Sprint 5 ratification (FR-6).
- [ ] A **sized GraphQL parity sample** plan: N per chain × collection (NOT a single wallet, IMP-007).
- [ ] A **gate record** asserting G-A1, G-A2, G-A3, G-A4, G-A5 = ALL GREEN, with each pass artifact referenced. This is the explicit barrier; the clock does not start until it exists.

### Acceptance Criteria
- [ ] G-A4: per-token decision is made and recorded **before** any backfill (Sprint 4) — not deferred to ratification (SKP-004 remediation; the decision lands at G-A4, sdd.md:265).
- [ ] The spike confirms the re-port bound: the helper at `ponder-runtime/src/handlers/token-projection/shared.ts` is **pure + collection-agnostic** (last-write-wins by `(blockNumber, logIndex)`; per-collection `isBurnTransfer()`; `token` re-derivable from the Transfer log; sole consumer = inventory-api Stash) `[CODE]`. A re-port = port `shared.ts` + wire 3 collections' Transfer handlers (carried by `bd-jyn`/`bd-1jg`/`bd-d2b`).
- [ ] If measure-without-it: the accepted-gap is drafted and flagged for operator signature — *"the ADR shall not ratify a cost for a lesser-featured product without explicit sign-off"* (prd.md:79).
- [ ] Parity sample size N is recorded per chain × collection.
- [ ] The gate record links: G-A1 codegen log + zero-erpc grep (S1), G-A2 version verdict (S1), G-A3 TEST-subject verdict + executor sign-off (S2), G-A4 decision + N (this sprint), G-A5 6-chain runbook line (S1). Any RED → HALT (do NOT start the clock).

### Technical Tasks
- [ ] **Task 3.1: G-A4 — per-token blast-radius spike (≤1 day) + decision.** Reuse `token-projection/shared.test.ts` pure-helper tests `[CODE]`; confirm the re-port bound; decide re-port vs accepted-gap; record the decision + rationale. → **[G-2]** *(IMP-002 avg 866.5, SKP-004 HIGH 740; sdd.md:252-265)*
- [ ] **Task 3.2: Size the FR-4 parity sample** — N per chain × collection across the footprint collections (Mibera/Tarot/Fractures/MST + the HoneyJar set) + the 93 entities + `chain_metadata`. → **[G-2]** *(IMP-007; sdd.md:357-359)*
- [ ] **Task 3.3: Assemble the §5.5 gate record — assert G-A1…G-A5 ALL GREEN.** A single committed artifact referencing all five pass artifacts; any RED HALTS the billing clock. → **[G-1, G-2, G-3]** *(SDD §2 invariant: "Only when G-A1…G-A5 are GREEN does FR-7's billing clock start")*

### Dependencies
- **Sprint 1** (G-A1, G-A2, G-A5 artifacts) and **Sprint 2** (G-A3 verdict + executor sign-off) must be complete; this sprint cannot record ALL-GREEN otherwise.

### Security Considerations
- No new secrets. The gate record references the Phase-A key's `signing_key_id` used in G-A3 (S2), confirming separate-key discipline held.

### Risks & Mitigation
| Risk | Prob | Impact | Mitigation |
|------|------|--------|------------|
| Per-token re-port balloons past the ≤1-day spike bound | Low | Delays clock | Helper is pure/collection-agnostic — bound is small; if it exceeds, choose accepted-gap (FR-6) |
| Measuring a lesser-featured indexer ratifies the wrong cost | High (if measure-without-it) | Apples-to-oranges ratification | Operator-signed accepted-gap REQUIRED at FR-8 (3.1 + S5) |
| A gate slips to RED at close-out | Med | Clock must not start | Fail-closed: HALT; remediate the specific gate; re-run |

### Success Metrics
- 1 per-token decision recorded with rationale; accepted-gap drafted if applicable.
- Parity N sized per chain × collection.
- 1 gate record: G-A1…G-A5 = ALL GREEN (or an explicit HALT with the RED gate named).

---

## Sprint 4 (GID 180): Backfill + GraphQL Parity

**Scope:** SMALL (3 tasks) · **Duration:** ~2.5 days · **Maps to:** SDD Phase A.2

> **Pre-clock.** Backfill + parity sizing happen here; the FR-7 billing clock starts in Sprint 5. This sprint runs only after Sprint 3's gate record is ALL-GREEN.

### Sprint Goal
Backfill the 6-chain managed-Envio deploy to head and prove GraphQL functional parity against the live green on a sized sample — any drift halts before the measured cycle begins.

### Deliverables
- [ ] The 6-chain source backfilled to head on managed Envio Cloud; `freshness_lag_s` recorded per chain vs the live green head (FR-3).
- [ ] A GraphQL parity result: sampled N per chain × collection (sized in S3) vs live green — 100% match on the sample, or a HALT with the drift documented (FR-4).

### Acceptance Criteria
- [ ] All 6 chains (`1·10·42161·7777777·80094·8453`) backfill to head; Zora (7777777) confirmed first-class on HyperSync at this point (R4 resolved as supported; verify in practice during backfill).
- [ ] `freshness_lag_s` recorded per chain.
- [ ] Parity sample: a known wallet's holdings across the footprint collections + the 93 entities + `chain_metadata` — **100% on the sample** to proceed; **any drift HALTS** (FR-4).
- [ ] Parity comparison runs against the **same Envio engine version on both sides** (G-A2 guarantee) — comparing two alpha versions invalidates the claim (SKP-003; sdd.md:427).

### Technical Tasks
- [ ] **Task 4.1: 🔒 Deploy 6-chain source to Cloud + backfill to head; record `freshness_lag_s` per chain.** → **[G-1, G-3]** *(FR-3; sdd.md:452)*
- [ ] **Task 4.2: GraphQL parity sample (N per chain × collection) vs live green; 100% or HALT.** → **[G-2]** *(FR-4; sdd.md:453)*
- [ ] **Task 4.3: Record the parity verdict + (if re-port chosen in S3) confirm per-token entities present in the Cloud GraphQL surface.** → **[G-2]**

### Dependencies
- **Sprint 3:** gate record ALL-GREEN. **Sprint 1:** Cloud config + version match (so both sides are the same engine version).

### Security Considerations
- Read-only parity sampling against live green (no mutation, no consumer repoint). NFR-3 holds.

### Risks & Mitigation
| Risk | Prob | Impact | Mitigation |
|------|------|--------|------------|
| GraphQL drift on the sample | Med | Invalidates the cost as a parity number | HALT (FR-4); root-cause before clock; partial cost is interpretable only with the drift noted |
| Zora HyperSync coverage gap in practice | Low (resolved as supported) | Blocks full 6-chain | RPC fallback for Zora only + note (NFR-4) |
| Backfill slower/costlier than expected | Med | Skews `freshness_lag_s` / early spend | Record honestly; one-time backfill cost excluded from steady-state `cost_usd_month` (FR-7 normalization) |

### Success Metrics
- 6/6 chains at head; `freshness_lag_s` recorded.
- Parity sample = 100% on N per chain × collection (or documented HALT).

---

## Sprint 5 (GID 181, FINAL): Measured 30-Day Cycle + Ratify + E2E Goal Validation

**Scope:** MEDIUM (5 tasks) · **Duration:** 30-day measurement wall-clock with bounded engineering touch · **Maps to:** SDD Phase A.3 + A.4

> **🔒 The only sprint that costs money. The FR-7 billing clock starts HERE — and ONLY after Sprint 3's gate record shows G-A1…G-A5 ALL GREEN.** Operator-gated: account billing, the 30-day wait, and invoice retrieval are operator actions.

### Sprint Goal
Run one normalized 30-day managed-Envio billing cycle with as-it-happens toil logging, capture the `measured` row into the loa-finn hash-chained ledger, ratify-or-revise the indexing-strategy ADR, and close `bd-buho` — then validate all three PRD goals end-to-end.

### Deliverables
- [ ] One 30-day billing cycle run on managed Envio Cloud; **every intervention logged as-it-happens** to the loa-finn toil ledger (setup minutes + `toil_incidents_30d` count + minutes each).
- [ ] Pre-set early-halt criteria (cost ceiling + incident count + halt authority) defined **before** the clock starts (OQ-4).
- [ ] A normalized steady-state `cost_usd_month` (calendar-days vs invoice billing-period; exclude one-time setup/credits/taxes; tier + overage model noted; + fallback line item if R1 was built).
- [ ] The `measured` row captured via `pnpm indexing:capture add` and `indexing:read` rendering RATIFY or a documented revision; `bd-buho` closed.
- [ ] If measure-without-it on per-token: the **operator-signed accepted-gap** attached to ratification (FR-6).
- [ ] E2E goal validation evidence (Task 5.E2E).

### Acceptance Criteria
- [ ] Early-halt thresholds + halt authority set before the clock (OQ-4); if cost-overrun or incident threshold is hit, HALT + label the partial cycle interpretable (sdd.md:401-404).
- [ ] Invoice normalized to steady-state; "invoice amount" definition resolved (credits/overages/taxes/tier discounts — OQ-5/IMP-011); recorded with `cost_basis` = "Envio Cloud invoice `<date>`, tier `<name>`, footprint = **6 chains**" (+ fallback line if R1).
- [ ] The loa-finn ledger is hash-chained and **refuses to render a quote as `measured`** (NFR-2/R2); `indexing:read` validates the chain before render.
- [ ] `bd-buho` closed with a `measured` 1x row on the 6-chain footprint; ADR ratified-or-revised; the trust caveat lifted.
- [ ] No production subject was ever published to; `BELT_UPSTREAM` never repointed; no Railway service retired; no alias swapped (NFR-3 held through the whole cycle).

### Technical Tasks
- [ ] **Task 5.1: 🔒 Define early-halt criteria (cost ceiling + incident count + halt authority) before starting the clock (OQ-4).** → **[G-1]** *(IMP-004 avg 842.5; sdd.md:401-404)*
- [ ] **Task 5.2: 🔒 Run the 30-day cycle; log toil as-it-happens to the loa-finn ledger; honor early-halt criteria.** → **[G-1]** *(FR-7)*
- [ ] **Task 5.3: 🔒 Normalize the invoice → steady-state `cost_usd_month`** (calendar-days vs billing-period; exclude one-time setup/credits/taxes; resolve OQ-5 invoice-amount definition). → **[G-1]** *(IMP-006 avg 784, IMP-011)*
- [ ] **Task 5.4: 🔒 `pnpm indexing:capture add --row '…cost_source:"measured"…'` → `indexing:read` → ratify-or-revise → close `bd-buho`.** Attach the operator-signed accepted-gap if measure-without-it was chosen. → **[G-1, G-2]** *(FR-8; sdd.md:459-461)*
- [ ] **Task 5.E2E: End-to-End Goal Validation.** **Priority: P0 (Must Complete).** **Goal Contribution: All (G-1, G-2, G-3).** → **[G-1, G-2, G-3]**

### Task 5.E2E — Validation Steps

| Goal ID | Goal | Validation Action | Expected Result |
|---------|------|-------------------|-----------------|
| **G-1** | Measured 1x row on 6-chain footprint, ratify-or-revise | `pnpm indexing:read` in loa-finn; inspect the `measured` row's `cost_basis` (invoice + tier + 6-chain footprint) + `toil_incidents_30d` | `RATIFY` (or documented revision); `bd-buho` closed; ledger renders `measured`, refuses quote |
| **G-2** | Functional parity (GraphQL + events-pillar + per-token decision) | GraphQL: S4 100% sample result. Events: S2 G-A3 verdict (works or R1). Per-token: S3 decision (ported or signed accepted-gap) | All three documented; if any drift/gap, it is explicit and (per-token) operator-signed |
| **G-3** | De-risk managed direction (6-chain HyperSync incl. Zora; events-pillar runnable or blocker) | Confirm Zora (7777777) backfilled at head (S4); G-A3 verdict shows events-pillar runnable on Cloud OR R1 named (S2) | HyperSync 6-chain confirmed; events path resolved (in-process OR R1); no unknown blocker remains |

**Acceptance Criteria:**
- [ ] Each goal validated with documented evidence (link the loa-finn ledger row, the S4 parity result, the S2 G-A3 record, the S3 per-token decision).
- [ ] Integration points verified: the `measured` row's footprint = 6 chains; the parity comparison ran same-engine-version both sides.
- [ ] No goal marked "not achieved" without explicit justification (e.g., a documented revision is a valid G-1 outcome).

### Dependencies
- **Sprint 4** (backfill + parity GREEN) and **Sprint 3** (gate ALL-GREEN — the hard clock barrier).
- **`bd-buho`** (loa-finn) is the external gate this sprint closes; the loa-finn hash-chained ledger (`pnpm indexing:capture` / `indexing:read`) must be operational.

### Security Considerations
- NFR-3 is the hard rule for the entire cycle: no production publish, no repoint, no retirement, no alias swap — any such step is Phase B.

### Risks & Mitigation
| Risk | Prob | Impact | Mitigation |
|------|------|--------|------------|
| 6-chain Cloud price ≫ recollected ~$70 | Med | Revises (not ratifies) the verdict | That is the point of measuring; record honestly; ledger refuses quote-as-measured (R2) |
| Mid-cycle incident inflates toil | Med | Affects the toil metric | Log as-it-happens; early-halt if threshold exceeded; partial cycle labeled interpretable |
| Pro-rated/credit-laden invoice misread as steady-state | Med | Wrong `cost_usd_month` | Normalization (5.3): calendar-days vs billing-period, exclude one-time/credits/taxes (IMP-006/011) |
| Ratifying a lesser-featured indexer without sign-off | High (if accepted-gap) | Bad ADR | Operator-signed accepted-gap mandatory at FR-8 (5.4) |

### Success Metrics
- 1 normalized `measured` row in the loa-finn ledger (6-chain footprint).
- `indexing:read` emits RATIFY or a documented revision; `bd-buho` closed.
- 3-way parity documented (GraphQL 100% sample; events verdict; per-token decision).
- All three PRD goals validated E2E with linked evidence.

---

## Out-of-Scope — Phase B (HARD-GATED on `bd-buho` ratifying)

> Captured so the intent isn't lost (PRD §8). **Not started until `bd-buho` closes RATIFY.** Designed-not-built (SDD §9 Phase B).

- **Consumer repoint** — inventory-api (`SONAR_GRAPHQL_ENDPOINT`), score-api (`ENVIO_GRAPHQL_URL`), apdao-auction-house, score-mibera, mibera-codex, dimensions. Each verified from its *running* env, not committed defaults (the #71 scar).
- **Railway teardown** — the "delete the complete Railway" end-state — gated on 3 carve-outs that do NOT trivially delete: (1) events-pillar has a confirmed home (Cloud publishes, or R1 standalone service); (2) eRPC shared cluster proxy (blast radius beyond sonar — decide explicitly); (3) the stable-alias gateway / DID-pinning (R5 — keep the gateway or move the alias to DNS).
- **Alias swap** (`BELT_UPSTREAM` → Envio Cloud URL via `scripts/promote.sh`).

> 🔐 **Note:** `SONAR_SIGNING_SEED_HEX` rotation (`bd-54c`) is **NOT** deferred to Phase B — it is **Sprint 1, Task 1.1**, a live security action done immediately (PRD §8, SKP-001).

---

## Risk Register

| ID | Risk | Sprint | Prob | Impact | Mitigation | Owner |
|----|------|--------|------|--------|------------|-------|
| SEC | `SONAR_SIGNING_SEED_HEX` compromised, signing live events | S1 | **High (live)** | Forgeable events now | **Rotate NOW** (1.1, bd-54c); independent of migration | zerker |
| R1 | Events-pillar can't run on managed Envio (egress/seed-custody/in-process pkg) | S2 | Med | **Blocks direction** | G-A3 (TEST subject) before clock; §3 R1 fallback named/designed; cost includes fallback | KRANZ Act-1 / zerker |
| BUILD | Cloud build sandbox rejects custom postinstall (vendored events pkg) | S2 | Unknown | Forces R1 even if NATS reachable | G-A3 tests the real in-process path on Cloud (OQ-3) | operator |
| R6 | Envio version drift (alpha.17 vs Cloud) | S1 | Med | Invalidates parity / balloons scope | G-A2 before deploy; bound delta as task (SKP-003) | operator |
| R3 | Per-token divergence (Envio lacks #69) | S3 | High | Apples-to-oranges | G-A4 deadline; pure helper bounds re-port; accepted-gap if not (FR-6) | operator |
| R7 | Third-party secret exposure (Cloud holds seed + CA) | S1/S2 | Med | Trust-boundary expansion | Separate Phase-A key (SKP-002); R1 keeps seed in-cluster | zerker |
| R4 | Zora (7777777) HyperSync coverage in practice | S4 | Low (resolved: supported) | Blocks full 6-chain | Confirm at backfill; RPC fallback for Zora only + note (NFR-4) | operator |
| R2 | 6-chain Cloud price ≫ recollected ~$70 | S5 | Med | Revises (not ratifies) | The point of measuring; ledger refuses quote-as-measured | operator |

---

## Success Metrics Summary

| Metric | Target | Measurement Method | Sprint |
|--------|--------|--------------------|--------|
| Seed rotated | 1 (bd-54c closed) | Railway env shows new value; post-rotation signature verifies new key | S1 |
| G-A1 HyperSync restore | codegen clean; `erpc.railway.internal` count = 0; 6/6 chains HyperSync | codegen log + grep | S1 |
| G-A2 version match | compatible or bounded-task | Cloud version probe + schema-field diff | S1 |
| G-A5 footprint | 6-chain | loa-finn runbook line | S1 |
| G-A3 events-pillar | ≥N signed events verified on TEST subjects, OR documented blocker | canary deploy → synthetic mints → subscriber verify | S2 |
| G-A4 per-token | decision made + parity N sized | spike + decision record | S3 |
| §5.5 gate | G-A1…G-A5 ALL GREEN | gate record artifact | S3 |
| GraphQL parity | 100% on N-per-chain×collection sample | sample vs live green, same engine version | S4 |
| `freshness_lag_s` | recorded per chain | post-backfill measurement | S4 |
| Measured `cost_usd_month` | 1 normalized steady-state row | loa-finn `indexing:capture`/`read` | S5 |
| ADR outcome | ratified-or-revised; `bd-buho` closed | loa-finn `indexing:read` emits RATIFY | S5 |

---

## Dependencies Map

```
S1 (security + gate foundation) ───┬──▶ S2 (G-A3 blocker-decider + R1?) ──▶ S3 (G-A4 + §5.5 ALL-GREEN)
  1.1 seed rotation (independent)  │      2.4/2.5 R1 only on G-A3 FAIL          │
  1.4-1.6 Cloud config + version ──┘                                            │  [HARD CLOCK BARRIER]
                                                                                ▼
                                                            S4 (backfill + parity) ──▶ S5 (30-day measured + ratify + E2E)
                                                              4.x pre-clock              5.2 clock STARTS HERE 🔒
```

---

## Appendix

### A. PRD Functional-Requirement Mapping

| PRD FR | Sprint | Status |
|--------|--------|--------|
| FR-1 (Restore HyperSync) | S1 (1.4-1.5, G-A1) | Planned |
| FR-2 (Deploy 6-chain to Cloud; record cost_basis) | S2 (2.1) | Planned |
| FR-3 (Backfill to head; freshness_lag_s) | S4 (4.1) | Planned |
| FR-4 (GraphQL parity sample) | S4 (4.2-4.3); sized S3 (3.2) | Planned |
| FR-5 (Events-pillar parity, TEST subject) | S2 (2.2-2.3, G-A3) | Planned |
| FR-6 (Per-token decision w/ deadline) | S3 (3.1, G-A4) | Planned |
| FR-7 (30-day cycle; toil; early-halt; normalize) | S5 (5.1-5.3) | Planned |
| FR-8 (Capture + ratify; close bd-buho) | S5 (5.4) | Planned |

### B. SDD Component / §5.5 Gate Mapping

| SDD Component / Gate | Sprint | Status |
|----------------------|--------|--------|
| Phase A.0 — security pre-action (seed rotation, separate key) | S1 (1.1-1.2) | Planned |
| G-A5 — footprint correction | S1 (1.3) | Planned |
| G-A1 — HyperSync restored (Cloud config + codegen) | S1 (1.4-1.5) | Planned |
| G-A2 — version match | S1 (1.6) | Planned |
| G-A3 — events-pillar reachability (in-process / OQ-3) | S2 (2.1-2.3) | Planned |
| §3 R1 — standalone NATS publisher (contingent) | S2 (2.4-2.5, only on G-A3 FAIL) | Planned (dormant) |
| G-A4 — per-token scope + parity sizing | S3 (3.1-3.2) | Planned |
| §5.5 gate record — ALL GREEN barrier | S3 (3.3) | Planned |
| Phase A.2 — backfill + parity | S4 | Planned |
| Phase A.3/A.4 — measured cycle + ratify | S5 | Planned |

### C. PRD Goal Mapping

| Goal ID | Goal Description | Contributing Tasks | Validation Task |
|---------|------------------|--------------------|-----------------|
| **G-1** | Measured 1x row on 6-chain footprint; ratify-or-revise; close bd-buho | S1: 1.3, 1.6 · S2: 2.1, 2.5 · S3: 3.3 · S4: 4.1 · S5: 5.1, 5.2, 5.3, 5.4 | S5: 5.E2E |
| **G-2** | Functional parity (GraphQL + events-pillar + per-token decision) | S2: 2.2, 2.3, 2.4 · S3: 3.1, 3.2, 3.3 · S4: 4.2, 4.3 · S5: 5.4 | S5: 5.E2E |
| **G-3** | De-risk managed direction (6-chain HyperSync incl. Zora; events-pillar runnable or blocker) | S1: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6 · S2: 2.1, 2.2, 2.3, 2.4, 2.5 · S4: 4.1 | S5: 5.E2E |

**Goal Coverage Check:**
- [x] All PRD goals have at least one contributing task (G-1, G-2, G-3 all mapped).
- [x] All goals have a validation task in the final sprint (S5 Task 5.E2E covers G-1, G-2, G-3).
- [x] No orphan tasks — every task is annotated `→ **[G-N]**`.

**Per-Sprint Goal Contribution:**

- S1: G-3 (foundation: security + 3 gates), G-1 (partial: footprint + version → valid cost basis).
- S2: G-2 (partial: events-pillar verdict), G-3 (de-risk: events egress), G-1 (partial: cost_basis quote + fallback line).
- S3: G-2 (per-token decision + parity sizing), G-1/G-3 (gate close-out enabling a valid measurement).
- S4: G-2 (GraphQL parity), G-1/G-3 (backfill + freshness).
- S5: G-1 (measured + ratify), G-2 (3-way parity documented), G-3 (Zora at head; events resolved); E2E validation of all goals.

---

*Generated by Sprint Planner Agent (ARCH · OSTROM, craft lens). Plans Phase A only; Phase B is hard-gated on `bd-buho`.*
