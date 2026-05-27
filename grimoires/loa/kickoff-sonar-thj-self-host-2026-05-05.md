---
session: kickoff-sonar-thj-self-host
date: 2026-05-05
operator: zksoju
mode: KRANZ runbook (cross-world cutover · operator-paced) + OSTROM lens at deploy-template design
slice: A — single deployed self-hosted instance on Freeside AWS (B = per-tenant split DEFERRED)
parent: parallel agent's sovereign-infra handoff at /tmp/freeside-sovereign-handoff.md
status: ready-to-execute
not_in_scope:
  - splitting freeside-sonar into per-domain or per-chain microservices (defer until second tenant materializes)
  - extracting freeside-sonar-schemas as a published npm package (defer; current repo IS the schema layer)
  - score-mibera / score-dashboard consumer code changes (parallel agent owns inventory)
  - apdao-auction-house — already self-sufficient via viem multicall (zero indexer dep)
  - new contract-source additions
---

# Sonar-THJ Self-Host Migration — KRANZ cutover runbook

> **One-line context**: managed Envio billing pressure + Reservoir shutdown + Alchemy 429 (apdao session 2026-05-04/05) prove the managed-SaaS-as-substrate pattern is structurally fragile for non-revenue product. Move the THJ ecosystem indexer to Freeside-owned AWS infra. Single deployed instance for now (Slice A); modular split when warranted (Slice B, deferred).

## Why now

- **Cost**: Envio reached out about delayed billing. Operator can't carry the SaaS bill on a non-revenue DAO.
- **Sovereignty mandate**: "the entire intent of Freeside is sovereign infrastructure" — operator decree 2026-05-05.
- **Validated by today's friction**: Reservoir shut down (managed NFT API alternative gone) · Alchemy 429 quota cap forced apdao unwire · Envio Berachain backfill 28% in 10hr · all three managed-substrate dependencies failed in one window.
- **Pattern proven**: `project-purupuru/sonar` is the working self-hosted Envio Docker shape (Postgres + Hasura + Envio binary). We don't have to invent the recipe; we have to copy it.

## Architectural framing (OSTROM lens)

**Slice A — ship a single deployed instance.**
- Mirror `project-purupuru/sonar`'s Docker compose: Postgres + Hasura + Envio binary + persistent storage volume.
- Use this repo's `config.yaml` + `schema.graphql` + `src/handlers/` unchanged as the single-instance config.
- Single GraphQL endpoint exposed at e.g. `https://sonar-thj.freeside.0xhoneyjar.xyz` (or similar Freeside-owned domain).
- Score-mibera + score-dashboard + future consumers point at this one endpoint.

**Slice B — modular split — DEFERRED.**
- Operator's reframe: "what is freeside-sonar now would become just schemas/contracts. then [the deployed indexer becomes] sonar-thj or split smaller services consumable via different endpoints."
- This is the right end-state shape, but it conflates two refactors. **Don't do both at once.** Slice A solves the actual problem (sovereignty + cost) without the ops surface multiplication. Slice B drops out cleanly later when:
  - A second tenant materializes (purupuru-only consumer, external partner, etc.)
  - One world's indexer load justifies isolation
  - Or the schemas package is needed by a third party
- Until that happens: YAGNI.

**Architectural hook to design INTO Slice A so Slice B drops out cleanly:**

The AWS deploy MUST be a **template**, not a one-off. Inputs:
- `config.yaml` (chains + contracts)
- `schema.graphql` (entities)
- `src/handlers/` (event-handler code)

Output: a stack that can be reproduced for any future tenant by swapping inputs. Concretely: terraform module OR Helm chart OR templated docker-compose. Whatever shape is chosen, the deploy spec is parameterized over the inputs above.

This is the freeside-modules-as-installables doctrine in action — **sealed schemas + typed ports** is an INTERFACE shape, not a deployment-topology shape. A single `sonar-thj` deployment can already expose sealed schemas via typed ports today; per-world sonars later just instantiate the template with different inputs.

## Coordinate Act — what to read first

| Source | What it tells you |
|---|---|
| `project-purupuru/sonar` (especially `Dockerfile`, `docker-compose.yaml`) | The proven self-host shape · Postgres + Hasura + Envio binary |
| This repo's `config.yaml` (1,000+ lines) | The chains, contracts, handlers, start_blocks — input #1 to the deploy template |
| This repo's `schema.graphql` (1,238 lines) | The entity surface consumers query — input #2 |
| This repo's `src/handlers/` | Event-handler code — input #3 |
| This repo's `DEPLOYMENT_GUIDE.md` + `SCALE.md` (PR #6 from earlier this cycle) | Existing operator runbook + 5 guardrails the parallel agent already shipped |
| Memory entry `project_apdao_alchemy_unwind_complete_2026_05_05.md` | The substrate-truth doctrine + viem multicall fallback pattern (relevant for consumer cutover validation) |
| Parallel agent's handoff packet `/tmp/freeside-sovereign-handoff.md` | Broader scope: score-mibera + score-dashboard inventory + construct-freeside distillation |

## Mirror Act — substrate readiness

Spin up the self-hosted instance in PARALLEL with managed Envio still serving. Both running. No consumer cutover yet.

| Component | What | Where |
|---|---|---|
| EC2 instance (or equivalent) | Envio indexer binary + Postgres + Hasura | Freeside AWS account · sized for Berachain RPC throughput |
| RPC endpoint | Berachain mainnet (and any other chain in `config.yaml`) | Free public RPC (https://rpc.berachain.com etc.) OR Freeside-owned RPC if scaled. HyperSync endpoints (per PR #10) for chains that support it. |
| GraphQL endpoint | Hasura on top of indexer Postgres | Freeside-owned subdomain (TBD — `sonar-thj.freeside.0xhoneyjar.xyz`?) |
| Persistent storage | Postgres data volume | EBS or equivalent · backed up |
| Monitoring | Sync-lag SLO probe (per `SCALE.md` Guardrail 2) | CloudWatch + alert channel |

Backfill from genesis on the supported chains. Watch:
- Berachain (HyperSync per PR #10) — should be minutes-to-hour
- ETH / Arbitrum / Optimism / Base / Zora (HyperSync auto-discovered per existing config) — minutes per chain

## Verify Act — three-layer gate spec

### Layer 1 — Smoke
- [ ] Hasura GraphQL endpoint returns `chain_metadata` for all 6 chains
- [ ] Block-height per chain matches managed Envio's within N blocks
- [ ] `TrackedHolder` row count for `apdao_seat`, `mibera_tarot`, fractures (top-known collections) matches managed within ±0.5%
- [ ] `Holder` row counts on HoneyJar1-6 across chains match within ±0.5%

### Layer 2 — Substrate equivalence (per consumer)
For score-mibera + score-dashboard, run the SAME consumer queries against managed and self-hosted side-by-side. Diff results. Investigate any divergence beyond block-lag tolerance.

### Layer 3 — Operator gate
- [ ] Parallel agent's score-mibera/score-dashboard inventory completed (per their handoff)
- [ ] All identified queries pass equivalence
- [ ] Operator GO/NO-GO signed in this runbook

## Flip Act — stable-alias cutover

The bridgebuilder review on freeside-sonar PR #6 already flagged **stable consumer alias** as Guardrail 5 — this is where it pays off.

1. **DNS or proxy alias**: define `sonar-thj.freeside.0xhoneyjar.xyz` (or similar Freeside-owned URL) as the canonical consumer endpoint. Initially routes to managed Envio.
2. **Consumer cutover (per consumer, sequentially)**:
   - score-dashboard: flip its `ENVIO_GRAPHQL_ENDPOINT` env to the alias. Confirm green.
   - score-mibera: same.
   - Any other consumer: same.
3. **Alias cutover**: once all consumers are on the alias, point the alias at the self-hosted endpoint. Single DNS change.
4. **Grace window**: keep managed Envio alive for 24-48hr after alias flip. Watch for divergence.
5. **Decommission**: cancel managed Envio billing only after grace window passes clean.

apdao-auction-house **does NOT** need the alias — it's already on viem multicall (zero indexer dep, validated this session). Don't re-couple.

## Distill Act — feed `construct-freeside`

This migration's load-bearing patterns belong in the freeside construct so the next migration (purupuru? mibera-only? external tenant?) inherits the recipe.

Distillation candidates surfaced from the apdao session that ALSO apply here:

1. **Substrate-truth audit** — gate before trusting any "operator-of-record" data. SELECT count vs on-chain `totalSupply` (or equivalent). Random spot-check ownership for N samples.
2. **Stable consumer alias** — never let a consumer hardcode a deployment ID. Always route through a Freeside-owned alias the operator can swap.
3. **Block-pinned reads** for governance audit-trail integrity (relevant for any consumer that uses indexer data for vote-weight calculation).
4. **Cache-share across users** — single global cache key + per-user filter. N concurrent unique-user queries should share 1 substrate scan per cache window.
5. **Time-box "wait for upstream"** — set explicit timer on managed-substrate dependencies before pivoting to viable interim.
6. **Repo rename gotcha** — gh CLI auto-redirects; not a bug. Distinguish `freeside-sonar` (renamed THJ-wide indexer) from `project-purupuru/sonar` (Puru-only self-hosted).
7. **Managed-SaaS dep rot** — Reservoir shutdown + Alchemy quota + Envio billing all hit the same week. Sovereign-stack hypothesis empirically validated.

## What NOT to ship in Slice A (BARTH discipline · explicit cuts)

- ❌ NO per-tenant deployment split
- ❌ NO `freeside-sonar-schemas` package extraction — current repo IS the schema layer; extract when second tenant exists
- ❌ NO new contract-source additions (mid-migration is the wrong time)
- ❌ NO score-mibera/score-dashboard code changes (parallel agent's territory)
- ❌ NO apdao re-coupling (it's already on viem multicall · sovereign by another path)
- ❌ NO "while I'm at it" — KRANZ ban: scope creep is mode-bleeding

## Slice A done-bar (operator-paced)

- [ ] Self-hosted Docker stack live on Freeside AWS, mirroring `project-purupuru/sonar` shape
- [ ] All 6 chains backfilled to head, sync-lag < N blocks
- [ ] `TrackedHolder` for `apdao_seat` populated (≥1,934 holders to match on-chain truth)
- [ ] Layer-1 substrate equivalence: top-10 entity row counts match managed Envio ±0.5%
- [ ] Layer-2 per-consumer equivalence: score-mibera + score-dashboard sanity passes
- [ ] Stable alias DNS configured · canonical consumer endpoint live
- [ ] Consumer cutover complete (score-mibera + score-dashboard pointed at alias)
- [ ] 24-48hr grace window passed clean on managed Envio
- [ ] Managed Envio billing canceled · sovereign substrate live
- [ ] AWS deploy authored as TEMPLATE (terraform/helm/compose) — not a one-off — so future per-world sonars reuse it
- [ ] Distillation captured in `construct-freeside` (per parallel agent's broader scope)
- [ ] Retro at `grimoires/freeside/cultivations/sonar-thj-self-host-2026-05-{DD}.retro.md`

## Slice B — what gets deferred until needed

When ANY of these triggers, revisit Slice B:

1. A second tenant emerges (purupuru-only sonar consumer, external partner request, mibera-only spin-out, etc.)
2. The unified `sonar-thj` instance can't keep up with combined query load on a single Postgres
3. Per-world sovereignty becomes a separate political / financial requirement
4. Schema versioning across consumers requires independent rollout cadence

When Slice B fires:
- Extract `freeside-sonar-schemas` as a published package (npm or git)
- Per-world sonar instances consume the schemas package + their own subset of `config.yaml`
- Federation layer (consider freeside-mcp-gateway as the routing surface)
- Retire single-instance config
- This is **future** work; document the architectural hook in Slice A's deploy-template design but do not pre-implement.

## Coordination with parallel agent

Parallel agent (per `/tmp/freeside-sovereign-handoff.md`) owns:
- score-dashboard + score-mibera clone + consumer surface inventory
- Distillation into `construct-freeside`
- Broader sovereign-infra playbook drafting
- Calling in `construct-protocol` + `construct-noether` for craft + security review

This kickoff (Slice A specifically) is the EXECUTION PATH inside the broader plan. Parallel agent's inventory feeds Layer 2 of the Verify Act here. No conflict.

When parallel agent's PR lands, this runbook's Layer-2 spec gets concrete consumer queries.

## Key references

| topic | path |
|---|---|
| Parallel agent handoff | `/tmp/freeside-sovereign-handoff.md` |
| Self-host shape reference | `https://github.com/project-purupuru/sonar` |
| HyperSync config | this repo's `config.yaml` (post PR #10 sha `6ad3327`) |
| SCALE.md guardrails (PR #6 sha `6de151eb`) | `SCALE.md` in this repo |
| apdao Alchemy unwind | memory entry `project_apdao_alchemy_unwind_complete_2026_05_05.md` |
| viem multicall pattern reference | `apdao-auction-house/lib/seat-snapshot.ts` |
| KRANZ persona | `~/bonfire/construct-freeside/identity/KRANZ.md` |
| Modules-as-installables doctrine | `~/vault/wiki/concepts/freeside-modules-as-installables.md` |

---

*Kickoff authored 2026-05-05 by KRANZ-flavored Claude Opus 4.7 (1M). Slice A — single deployed instance for sovereignty + cost. Slice B (modular tenant split) deferred until second tenant materializes. Operator-paced. Per KRANZ P5: telemetry over claims. Per KRANZ P10: calm is a method.*
