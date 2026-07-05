---
hivemind:
  schema_version: "1.0"
  artifact_type: product-spec
  product_area: "sonar-api — Layer-1 indexing migration to managed Envio"
  workstream: delivery
  priority: high
  jtbd: {category: functional, description: "stand up the existing 6-chain Envio source on managed Envio Cloud for ONE measured billing cycle, producing the missing `measured` number that ratifies-or-revises the indexing-strategy ADR — without touching consumers, retiring Railway, or losing the per-token / events-pillar features"}
  learning_status: directionally-correct
  source: team-internal
trust_tier: operator-authored
read_state: unread
confidence: 0.6
decay_class: working
last_confirmed: 2026-06-23
operator_signed: self_attested
---

> ⚠️ **STALE / FRAMING FALSIFIED — see `grimoires/loa/drift-report.md` (2026-06-29).**
> This PRD belongs to the **parked `indexing-managed-envio` cycle**. Its two load-bearing
> premises were both **falsified by what actually shipped** (PR #101, `main`):
> (1) it treats **sovereign-Ponder-on-Railway** as the *current* Layer-1 — Ponder was
> **reverted to vestigial**; Envio is the live runtime (`Dockerfile.belt` runs `envio start`).
> (2) it frames the **target as managed Envio Cloud** — the cutover landed as
> **self-hosted Envio on Railway** (the managed-Cloud attempt hit the KF-015 OOM @3.2.1
> and was abandoned). Do **not** treat this doc as a forward plan or as current-state
> truth. Body retained as the parked cycle's record; see drift findings PD-4/PD-6.

# PRD — sonar-api Layer-1 indexing → Managed Envio (Phase A: stand-up + measured ratification)

> **Cycle**: `indexing-managed-envio` · **Revision**: r3 (2026-06-17 — **canary verdict folded in**: the "redeploy the existing source" premise is REFUTED; managed Envio requires a feature-sized envio alpha.17→3.2.1 API migration. r2 was Flatline-hardened; `grimoires/loa/a2a/flatline/prd-review.json`) · **Persona**: KRANZ (Act 1 coordinate) + ARCH (OSTROM, craft lens)
> **Supersedes**: `prd.md` r2 "Consolidated Belt + Blue-Green Promotion" (`sonar-belt-factory`) — archived at `grimoires/loa/context/prd-sonar-belt-factory-r2-SUPERSEDED-2026-05-22.md`. That PRD's premise (self-host Envio on Railway, <$100/mo, beat "Envio ~$300") was **inverted** by the loa-finn TCO experiment: toil flips the winner to *managed* at a $3.59/hr breakeven.
> **Gates on**: `bd-buho` (loa-finn, P1) — the ratification gate. This PRD plans the work that closes it.
> **Builds on**: `grimoires/loa/context/2026-06-15-indexing-strategy-reframe-adr.md` (the ADR) · `2026-06-16-indexing-tco-verdict.md` (the verdict) · `2026-06-16-phase-a-envio-standup-coordinate.md` (KRANZ Act-1 runbook).
> **Grounding legend**: `[CODE:file]` = code reality I read · `> file:line` = doc quote · `(git:SHA)` = commit evidence · `(op 2026-06-17)` = operator decision this session.

## 1. Executive Summary

The indexing-strategy ADR's direction — **move Layer-1 off sovereign-Ponder-on-Railway to managed Envio** — is *settled in direction, unratified in number*. The only Envio price that exists is the operator's recollected ~$70/mo (`vendor-quote`, never measured on the real footprint). **Phase A produces the one missing `measured` number** by standing the existing 6-chain Envio source up on managed Envio Cloud for one real billing cycle, then ratifies-or-revises the ADR and closes `bd-buho`.

Grounding correction baked into this plan: "going back to Envio" is **not a code migration and not a repo-revert** (op 2026-06-17 framing tested against git). The Envio source is **live at HEAD** — `Dockerfile.belt` runs `envio@3.0.0-alpha.17` on `config.yaml` (green, 6-chain) / `config.mibera.yaml` (blue) `[CODE:Dockerfile.belt]`. The only code change Phase A needs is **restoring HyperSync** (the source was deliberately de-HyperSync'd for the self-host cost cut — `git:01d19638` *"strip HyperSync entirely … cluster-owned eRPC"*; managed Envio Cloud *bundles* HyperSync). Everything else is a deploy + measure.

Phase A is **additive and reversible**: nothing consumer-facing moves, nothing is retired. Consumer repoint and Railway teardown are **Phase B — hard-gated on `bd-buho` ratifying** and out of scope here (captured in §8 so the intent isn't lost).

> ### ⚠️ Canary verdict (2026-06-17) — the "only restoring HyperSync" claim above is SUPERSEDED
> A live Envio Cloud canary (`canary/envio-cloud-hypersync` on `0xHoneyJar/sonar-api`, deploy instance `sonar-api-3`) proved the path is *reachable* — connect ✓, version ✓, install/postinstall ✓ (the lazy `@0xhoneyjar/events` import works on Cloud → OQ-3 answered), codegen ✓, FatBera same-address merge ✓ — but the indexer **crash-loops at runtime**: every handler `import … from "generated"` fails because **envio Cloud runs the latest `3.2.1`, and the source is on the deprecated `3.0.0-alpha.17` API.** alpha.17→3.2.1 is a **breaking API rewrite, not a config fix**: handler registration `ContractName.Event.handler(cb)` (exports, `from "generated"`) → `indexer.onEvent({contract,event}, cb)` (side-effecting, auto-discovered, `from "envio"`); `generated/` is gone (now `.envio/` module augmentation); `config.yaml`'s `handler:` model + `EventHandlers.ts` aggregation are obsolete; the test harness changed (`TestHelpers.MockDb` → `createTestIndexer`). Scope: **all 31 handlers + `EventHandlers.ts` + `src/lib/{actions,erc721-holders}.ts` + `config.yaml` + the test suite** — extensive but **mechanical** (entity read/write logic via `context.Entity.get/set` largely survives; the registration wrapper + imports + config + tests change).
>
> **NEW REQUIREMENT (gates the deploy + `bd-buho`):** port the Envio source to `3.2.1` BEFORE the managed deploy can run + be measured. This is **hidden one-time setup-toil not in the loa-finn TCO model** — record it as a `cost_basis` input when `bd-buho` is finally measured (the verdict's "toil flips the winner" counted ongoing ops toil, not this upfront port). Operator decision (op 2026-06-17): **commit to managed Envio; plan + execute the 3.2.1 migration as its own `/implement`-gated sprint.**

## 2. Problem Statement

### The problem
> ADR (`…reframe-adr.md:17-27`): the experiment voted *move to managed*, but "**DO NOT RATIFY** as settled until a managed config runs one real billing cycle." `bd-buho` is the gate. The verdict (`…tco-verdict.md:31-35`): "the 1x head-to-head is **VENDOR-QUOTE** … the *direction* is settled; the *number* is not."

### Sub-problems surfaced by codebase grounding (load-bearing — these shape the measurement)
1. **Mis-framing**: "revert to a git commit" would destroy ~20 commits of Ponder-era work (the per-token ownership port `git:f69ee402…d7fb271d`) that the ADR calls "orthogonal, proceeds regardless." Refuted as a repo-revert; the kernel ("the source still exists") is true and stronger — it's *live at HEAD*.
2. **HyperSync stripped**: current config routes via `erpc.railway.internal` for self-host (`git:01d19638`, `cb0c2f4e`, `d7f38fef`, 2026-05-27). Managed Envio Cloud needs bundled HyperSync. `[CODE:config.mibera.yaml:228-366]`
3. **Feature divergence**: per-token `token` ownership (#69, Jun 2026) lives in `ponder-runtime/src/handlers/`. The Envio handlers (`src/handlers/*.ts`, `src/EventHandlers.ts`) froze **2026-03-17** `(git)` and **do not have it**. Standing up Envio = measuring a *lesser-featured* indexer unless the logic is re-ported.
4. **Events-pillar side-effect**: sonar isn't only a GraphQL server — it publishes signed mint events to the cluster NATS JetStream (cluster-events-pillar-v1 / ACVP). `src/lib/events-publisher.ts` is called from 6 Envio handlers `[CODE]`; the Ponder green has a fuller version (`ponder-runtime/src/lib/nats-publisher.ts` + outbox + reorg-safe + DLQ). Managed Envio Cloud must be able to run this (private-NATS egress + Ed25519 signing seed) — **unverified, possible blocker** (§10 R1).

### Current state `[CODE:reality]`
- Deployed indexer **is Envio HyperIndex** on Railway: `belt-indexer` (blue, `config.mibera.yaml`) + green (`config.yaml`, 6 chains: 1·10·42161·7777777·80094·8453), `envio@3.0.0-alpha.17`, fed by cluster-owned `eRPC` (HyperSync token deleted). A newer **Ponder green-v3** (`ponder-runtime/`) carries the per-token + fuller-pillar work.
- **Stable-alias gateway exists**: Caddy `reverse_proxy {$BELT_UPSTREAM}` on `$PORT` — *"URL never changes; belt recovery = swap BELT_UPSTREAM"* `[CODE:Caddyfile, Dockerfile.gateway]`. This is the OSTROM seam; consumers read it, the backend is swappable behind it.
- Consumers **hardcode the Envio deployment-DID** (`b5da47c` / `914708e`) `> SCALE.md:current-state` — the root of "blue-green is hard."

### Desired state (Phase A)
A managed Envio Cloud deployment of the 6-chain source, synced to head, **at functional parity** (GraphQL + events-pillar + per-token decision) with the live green, run for one billing cycle with **toil + $ measured**, feeding a ratify-or-revise decision on the ADR. Live serving is untouched.

## 3. Goals & Success Metrics

| # | Goal |
|---|------|
| **G1** | Produce the `measured` 1x row — real $/mo (`cost_basis` = Envio Cloud invoice + tier + footprint) + setup toil-hours + 30d incident count — on the **full 6-chain footprint**, flipping the loa-finn crossover `quote → measured` and emitting `RATIFY` (or a revised number). |
| **G2** | Validate **functional parity, not just $**: GraphQL footprint entities (the 93 + `chain_metadata`), the NATS events-pillar publish, and a decision on per-token ownership. A cheaper-but-lesser indexer is not a ratification. |
| **G3** | De-risk the managed direction: confirm Envio HyperSync coverage for all 6 chains (esp. Zora 7777777) and that the events-pillar can run on managed Envio — or identify the blocker before Phase B is ever unlocked. |

### KPIs (gates)
| KPI | Target |
|---|---|
| Measured $/mo recorded with `cost_basis` | 1 real invoice, full 6-chain |
| Toil logged as-it-happens (not post-hoc) | setup minutes + `toil_incidents_30d` |
| GraphQL parity sample vs live green | 100% on footprint entities; any drift halts |
| Events-pillar publish on managed | confirmed working OR documented blocker |
| ADR outcome | ratified-or-revised; `bd-buho` closed |

## 4. Users & Stakeholders
- **Operator** — attention cost is a first-class metric here (the whole TCO thesis). The stand-up steps (account, Discord quote, deploy) are operator-gated.
- **Downstream GraphQL consumers** — inventory-api (`SONAR_GRAPHQL_ENDPOINT`), score-api (`ENVIO_GRAPHQL_URL`), apdao-auction-house, score-mibera, mibera-codex, dimensions. **Phase B**; in Phase A they keep reading live green untouched.
- **Events-pillar consumers** — whatever subscribes to cluster-events-pillar-v1 NATS subjects. A stakeholder for the G2 parity check (their feed must not silently degrade if managed Envio adopts).

## 5. Functional Requirements (Phase A)

| ID | Requirement |
|----|-------------|
| **FR-1** | **Restore HyperSync.** When deploying to managed Envio Cloud, the config shall use Envio's bundled HyperSync, not `erpc.railway.internal`. Implement by reverting the de-HyperSync RPC changes (`git:01d19638`/`cb0c2f4e`/`d7f38fef`) on a Cloud-targeted config branch, OR re-adding `hypersync_config` per chain. |
| **FR-2** | **Deploy the existing 6-chain source** (`config.yaml` + `config.mibera.yaml`) to managed Envio Cloud (Production tier). Record the quoted $/mo + tier name verbatim the moment it is given (→ `cost_basis`). |
| **FR-3** | **Backfill to head** on all 6 chains; record `freshness_lag_s` per chain vs the live green head. |
| **FR-4** | **GraphQL parity** — sample a known wallet's holdings across the footprint collections (Mibera/Tarot/Fractures/MST + the HoneyJar set) and the 93 entities + `chain_metadata` vs live green. 100% on the sample to proceed; any drift halts. |
| **FR-5** | **Events-pillar parity (auditable + non-interfering).** Confirm the managed deploy publishes signed mint events to the cluster NATS, with concrete acceptance: (a) the **exact subject set** enumerated, (b) signature **verified against a specific `signing_key_id`**, (c) sample size ≥ N events, (d) **published to a TEST/shadow subject, never the production subjects** (preserves NFR-3 — no double-publish during the trial), (e) named executor. If managed Envio cannot reach a private NATS over TLS or hold the seed → STOP and trigger the R1 fallback (do not start the cycle). |
| **FR-6** | **Per-token ownership decision — with a deadline.** Before the cycle starts (gate G-A4), decide: re-port the per-token `token` logic into the Envio handlers for true parity, OR measure-without-it. If measure-without-it, FR-8 ratification REQUIRES an **operator-signed accepted-gap** — *the ADR shall not ratify a cost for a lesser-featured product without explicit sign-off.* (See §10 R3.) |
| **FR-7** | **Run one 30-day billing cycle — only after §5.5 gate passes.** Log every intervention to the loa-finn toil ledger **as it happens** (`toil_incidents_30d` + minutes each). Define **early-halt criteria** (cost-overrun or incident thresholds → halt + label the partial cycle interpretable). Normalize the invoice: record **calendar-days covered vs invoice billing-period**, and exclude one-time setup/credits/taxes so `cost_usd_month` is steady-state, not a pro-rated artifact (→ FR-8 `cost_basis`). |
| **FR-8** | **Capture + ratify** — `pnpm indexing:capture add --row '…cost_source:"measured"…'` then `pnpm indexing:read` (in loa-finn) → ratify-or-revise the ADR → close `bd-buho`. The captured `cost_usd_month` is the **normalized steady-state** (per FR-7), obtained by the operator, recorded in the loa-finn ledger `cost_basis` with tier + overage model noted. |

## 5.5 Phase-A Validation Gate (pre-cycle — ALL must pass before the 30-day clock starts)

> The verdict's whole point is a *valid measurement*. Paying for a 30-day cycle that proves the approach invalid (events-pillar can't run, version mismatch, wrong footprint) is wasted spend. This gate converts §10's mitigations into an **execution-order barrier**: the billing clock (FR-7) does not start until every check below is GREEN. (Flatline IMP-001/003/008, SKP-002/003.)

| Gate | Check | Pass criterion |
|------|-------|----------------|
| **G-A1 — HyperSync restored** | `envio codegen` dry-run against the Cloud-targeted config | clean codegen; **zero `erpc.railway.internal` references**; `hypersync_config` present for all 6 chains (machine-verifiable). |
| **G-A2 — version match** | Managed Envio Cloud's `envio` version vs the source's `3.0.0-alpha.17` schema/handler API | versions compatible, OR the upgrade delta is identified and bounded as a task — NOT discovered mid-cycle. |
| **G-A3 — events-pillar reachability** | NATS TLS egress + Ed25519 signing from a managed Cloud deploy → **TEST subject** | reachable + signature verifies against a known `signing_key_id`. **FAIL → STOP**: trigger R1 fallback; do not start the cycle. |
| **G-A4 — parity scope set** | per-token blast-radius spike (≤1 day) + parity sample sizing | per-token decision made (FR-6); parity sample = pragmatic **N per chain × collection** (not a single wallet). |
| **G-A5 — footprint correct** | loa-finn runbook footprint = **6-chain** (not Berachain-only) | the under-scope is corrected as a precondition (else every downstream cost is unreliable). |

**Only when G-A1…G-A5 are GREEN does FR-7's billing clock start.**

## 6. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| **NFR-1 — footprint parity** | Full 6 chains, identical contract set, same time window — or the comparison is noise (verdict's measurement-integrity principle). The loa-finn runbook's "Berachain-only, 93 contracts" footprint is **under-scoped** — correct it to 6-chain. |
| **NFR-2 — measurement integrity** | $ is tagged `measured` only after a real invoice exists; toil logged as-it-happens; the loa-finn ledger is hash-chained and refuses a tampered chain. |
| **NFR-3 — reversibility / non-interference** | Green (and blue) stay HOT through all of Phase A. The managed stand-up is additive — no consumer repointed, no Railway service retired, no alias swapped. Phase A is one `git revert` + a Cloud teardown away from never-happened. |
| **NFR-4 — HyperSync coverage** | All 6 chains must be Envio HyperSync first-class. Berachain (80094) verified (verdict footnote); ETH/OP/Arb/Base likely; **Zora (7777777) unverified** — confirm at quote time. |

## 7. Technical Considerations
- **Source identity**: Envio HyperIndex, `envio@3.0.0-alpha.17`, 6 chains across `config.yaml` (all 6) + `config.mibera.yaml` ({1,10,80094,8453}). Two configs = one footprint.
- **The seam**: Caddy gateway, `reverse_proxy {$BELT_UPSTREAM}`. Phase B sets `BELT_UPSTREAM` → the Envio Cloud URL (or keeps the gateway as the stable alias so consumers never see the new DID). Phase A leaves it pointed at live green.
- **Events-pillar**: the Envio handlers' `events-publisher.ts` is *simpler* than the Ponder `nats-publisher.ts` (no outbox/reorg-safe/DLQ). Adopting managed Envio without re-porting the outbox is a **reliability regression** for the pillar even if egress works.

## 8. Scope & Prioritization

**IN (Phase A — this PRD):** FR-1…FR-8. Stand up, validate parity (3-way: GraphQL + pillar + per-token), measure one cycle, ratify. Additive, reversible, no consumer/Railway change.

**OUT (Phase B — HARD-GATED on `bd-buho` ratifying):**
- Consumer repoint (inventory-api, score-api, apdao/score-mibera/codex/dimensions) — each verified from its *running* env, not committed defaults (the #71 scar).
- **Railway teardown** — the "delete the complete Railway after" end-state (op 2026-06-17). Right as the goal (~$50–130/mo), but **gated on 3 carve-outs that do NOT trivially delete**:
  1. **Events-pillar** has a confirmed home (managed Envio Cloud can publish, or it moves to a small dedicated service) — R1.
  2. **eRPC** — shared cluster RPC proxy ("keep the free eRPC for Alchemy savings"); blast radius beyond sonar. Decide explicitly before deleting `erpc` + its cache.
  3. **Stable-alias gateway** — consumers hardcode the deployment-DID; managed Envio = a new DID. Keep the gateway (or move the alias to DNS/Cloudflare) so the swap stays behind the contract — R5.
- 🔐 **Rotate the exposed `SONAR_SIGNING_SEED_HEX` (`bd-54c`) NOW — not "own timeline."** Flatline escalated this (SKP-001) and was right to: a *known-compromised* Ed25519 seed is signing live NATS events right now; every event between exposure and rotation is forgeable and unfalsifiably attributable to whoever holds the seed. This is a **live security action, independent of the migration — do it immediately**, not as a Phase-B item.
- 🔑 **Managed deploy uses a SEPARATE signing key** (SKP-002) — adopting managed Envio hands the signing seed + private NATS CA to a third party (Envio's infra). Do **not** give the production seed to a third party; provision a distinct key for the managed deploy and define the third-party secrets model before any production publish.

## 9. Success Criteria
- `bd-buho` closed with a `measured` 1x row on the 6-chain footprint; loa-finn `indexing:read` emits `RATIFY` (or a documented revision).
- ADR ratified-or-revised with the measured number + the trust caveat lifted.
- 3-way functional parity documented: GraphQL 100% sample, events-pillar verdict (works/blocker), per-token decision (ported/gap-flagged).
- HyperSync 6-chain coverage confirmed (incl. Zora).

## 10. Risks & Dependencies

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| **R1** | **Events-pillar may not run on managed Envio** — can Envio Cloud handlers reach the private cluster NATS (TLS + CA) and hold the signing seed? Plus: the Phase-A test must NOT publish to production subjects (double-publish interference — SKP-001), and there is no named fallback architecture/ownership yet (SKP-001). | **Could block the whole direction** | Gate **G-A3** validates egress + signing to a **test subject** before the cycle. If blocked: the pillar becomes a small standalone publisher service (named owner + security model) and "delete all Railway" is off. Define the fallback shape in the SDD. |
| **R2** | **6-chain Envio Cloud price ≫ the recollected ~$70** (which may have been a smaller/older footprint). | Could **revise** the verdict, not ratify | That is the point of measuring. Record the real number honestly; the ledger refuses to render a quote as measured. |
| **R3** | **Per-token feature divergence** — Envio handlers lack #69's per-token ownership (Ponder-only, Jun 2026). | Apples-to-oranges measurement | FR-6 decision: re-port to Envio handlers, or measure-and-flag. |
| **R4** | ~~Zora (7777777) HyperSync unverified~~ — **RESOLVED 2026-06-17 (op): HyperSync supports Zora.** | Closed | n/a |
| **R5** | **Consumers hardcode the deployment-DID** — managed Envio = new DID. | Phase-B blast radius | Front Envio Cloud with the existing stable-alias gateway; never let consumers pin the raw `indexer.hyperindex.xyz/<DID>` URL. |
| **R6** | **Envio version drift** — the source pins `envio@3.0.0-alpha.17` (self-host); managed Cloud may run a different/newer alpha with breaking schema/API changes, turning "deploy-and-measure" into an unplanned migration (SKP-003 / IMP-012). | Could invalidate the deploy or balloon scope | Gate **G-A2** verifies version compatibility before the cycle; bound any upgrade delta as an explicit task. |
| **R7** | **Third-party secret exposure** — managed Envio holds the Ed25519 signing seed + private NATS CA in Envio's infra (SKP-002). | Security / trust-boundary expansion | Separate signing key for the managed deploy (§8); never share the production seed; define the third-party secrets model in the SDD. |
| **R8** | **Envio is EVM-only** — the repo already carries a `@solana/web3.js` dep; an eventual Solana indexing need cannot run on Envio HyperIndex (op 2026-06-17: "we'll eventually want Solana"). | Future architecture, **not Phase A** | Out of scope here. Flag for the eventual multi-VM/Layer-2 decision: Solana needs a separate indexer (Envio won't cover it). Does not affect the Phase-A EVM footprint. |

> **Resolved this session (op 2026-06-17):** Zora HyperSync = supported (R4 closed). Cost model known from prior hosted-Envio use; the de-risk found **cost-fit is not a barrier** — `field_selection` + `start_block` tightening already applied, Cloud bundles HyperSync (drops the self-host RPC line), and the footprint is consumer-fixed (no bloat to cut). The only cost variable is footprint growth since the ~$70 hosted era, which `bd-buho` measures. The genuine risk remains **OQ-3** (events-pillar postinstall on Cloud), which is architectural, not financial.

**Dependencies:** `bd-buho` (loa-finn, the gate this PRD closes) · Envio Cloud account + Discord 6-chain price quote (operator-gated) · the loa-finn hash-chained ledger (`pnpm indexing:capture` / `indexing:read`) · the loa-finn stand-up runbook (`src/research/standups/envio-hyperindex.md`, footprint corrected to 6-chain).

> **Sources**: `…reframe-adr.md`, `…tco-verdict.md`, `…phase-a-envio-standup-coordinate.md`, `SCALE.md`, `Caddyfile`/`Dockerfile.gateway`/`Dockerfile.belt`/`config.yaml`/`config.mibera.yaml`/`src/lib/events-publisher.ts`/`ponder-runtime/src/lib/nats-publisher.ts` `[CODE]`, git history (`01d19638`, `cb0c2f4e`, `d7f38fef`, `ec2dbd7e`, `f69ee402`), AskUserQuestion (op 2026-06-17).
