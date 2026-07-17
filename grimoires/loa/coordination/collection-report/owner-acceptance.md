# ACCEPT-SONAR — Owner Acceptance

| Field | Value |
|---|---|
| Task | `ACCEPT-SONAR` (`collection-report-coordinator-f09.40`) |
| Repository | `0xHoneyJar/sonar-api` (canonical repository; the legacy `0xHoneyJar/freeside-sonar` URL redirects here; this worktree tracks its `origin/main`) |
| Audited revision | `a68bbae0bf04e281a9b6b46fc3812c9dbb471afa` (2026-07-14) |
| Review binding | The exact submitted head is bound by the external Bridgebuilder review marker. It is intentionally not embedded here: changing a commit to write its own hash necessarily changes that hash. |
| PR delivery relationship | The audited implementation revision and submitted acceptance are in the same canonical repository. The rerunnable `git diff --name-only a68bbae0bf04e281a9b6b46fc3812c9dbb471afa..HEAD` probe must produce exactly the four evidence paths recorded in `baseline-audit.md`; any additional path invalidates this acceptance pending re-audit. |
| Master plan | coordinator `grimoires/loa/{prd,sdd,sprint}.md` v0.3 / 0.5 / 0.6 at `2c1be075e34f896704e0e8ff45500aeaddcd1a10` (file blobs `ef5847c06f880d99927a985a0ec7eaa3d216b4c0` / `5b431433954194ae181685f249caa42e772b2b6c` / `f76863bb2302bae660ad5a57a2a9ea4888be918d`) |
| Date | 2026-07-16 |
| Author role | Sonar boundary owner (KRANZ dispatch; no CR implementation) |
| **Overall verdict** | **conditional** |

This document is owner acceptance of Sonar’s planned interfaces and authority
boundary before CR issue creation. It is **not** a claim that `origin/main`
already implements the collection resolver, trust-stream producer, or
cross-VM Kitchen identity. Agreement in the coordinator PRD/SDD/sprint is
insufficient without this artifact (sprint §13).

---

## 1. Verdict summary

| Dimension | Verdict | One-line finding |
|---|---|---|
| Resolver contracts (CR-003/101/102 wire) | **blocked** (upstream) / **conditional** (Sonar commit) | No collection-resolver module or shared deployment wire on `main`; Sonar accepts ownership once CR-001 schemas exist |
| EVM probe capacity | **conditional** | Six belt chains; Kitchen can enqueue ERC-721 TrackedErc721 ingest; no interactive NFT recognition probe / V1 resolver budgets |
| Solana probe capacity | **conditional** | DAS CLI + curated registry exist; Kitchen has no Solana path; cNFT prepare unsupported; recognition≠prepare |
| Kitchen identity (CR-203 baseline) | **conditional** | Live EVM-only `(chain_id, contract)` PK; stores `order_id` as if Sonar owns the subscriber — must demote in migration |
| Trust-stream readiness (CR-011A) | **blocked** (upstream) / **conditional** (Sonar commit) | Events/NATS Ed25519 pillar ≠ CR-009 transactional outbox + epoch/sequence replay |
| Finality / capability policy (CR-101) | **blocked** (absent) | No versioned per-network finality-policy registry; no recognize/prepare/read_evidence health machine |
| Network disablement (CR-107) | **blocked** (absent) | No operator kill switch for recognition/prepare without deploy; worker env flags only |
| Operations ownership | **conditional** | Kitchen health + README triage exist; resolver/capacity/drain runbooks and CR-404 participation are unowned today |
| Mixed-version / flags / deploy / rollback | **conditional** | Accept SDD §16–17 matrix; current `main` has none of the collection-report flags |

**Overall: conditional.** Sonar accepts the *authority boundary* and will own
the listed CRs, but several surfaces are missing on `origin/main` and two
depend on Loa shared-protocol ratification (CR-001, CR-009). Downstream Sonar
implementation issues must not be marked ready until the closure conditions in
§8 are met. This is not an `accepted` rubber stamp of production readiness.

---

## 2. Interfaces Sonar produces or consumes

### 2.1 Present on `origin/main` (baseline evidence)

| Interface | Owner today | Shape | Evidence |
|---|---|---|---|
| Kitchen collection status | Sonar `kitchen-api` | `GET /v1/collections/:chain_id/:contract/status` | `src/kitchen/routes.ts`, `ARCHITECTURE.md` |
| Kitchen ingest enqueue | Sonar `kitchen-api` | `POST .../ingest` body `{ order_id, source, contact_email?, community_name? }` → `202 { job_id, status }` or already-indexed | `src/kitchen/routes.ts`, `src/kitchen/types.ts` |
| Kitchen job store | belt Postgres | `kitchen_ingest_jobs` PK `(chain_id, contract)` | `migrations/kitchen_ingest_jobs.sql`, `src/kitchen/postgres-ingest-store.ts` |
| Kitchen worker | Sonar | Patches `TrackedErc721` into `config.yaml`, optional restart webhook, polls Hasura until `holder_count > 0` | `src/kitchen/ingest-worker.ts`, `src/kitchen/config-patcher.ts` |
| Index readiness read | Hasura → `TrackedHolder` / `Token` | Holder/token counts as “indexed” proxy | `src/kitchen/hasura-status-reader.ts` |
| SVM collection registry | Sonar config | Curated `collectionKey` → mint map (not free-form resolve) | `src/svm/collection-registry.ts` |
| Solana DAS onboarding probe | CLI only | Read-only coverage verdict; no HTTP service contract | `src/svm/probe-collection.ts` |
| Service auth | Bearer `SERVICE_TOKEN` | All `/v1/collections/*` routes | `src/kitchen/auth.ts` |
| Optional events pillar | NATS + Ed25519 | Mint-detection envelopes; fail-soft when unset | `src/lib/events-publisher.ts`, README |

EVM belt networks present in `config.yaml` at audit: **1, 42161, 7777777, 10,
8453, 80094**. **Robinhood mainnet chain ID `4663` is absent.** Chain identity
evidence was retrieved on 2026-07-16 from Robinhood's authoritative live page,
[_Connecting to Robinhood Chain_](https://docs.robinhood.com/chain/connecting/):
its “Network Configuration” table reported `Chain ID 4663` for Robinhood Chain
mainnet and `46630` for testnet. The page is mutable, so future acceptance must
reverify the current value and retrieval date rather than inherit this
observation. This acceptance preserves the source excerpt bytes (including URL
and capture time) plus their SHA-256 in `robinhood-chain-source-capture.txt`
and `robinhood-chain-evidence.json`.

### 2.2 Required by plan; not present on `main`

| Planned interface | Owning CR | Status on `a68bbae0` |
|---|---|---|
| Shared `CollectionDeploymentRef` / identity digests | CR-001 (Loa) → Sonar consumer | **Absent** (`packages/protocol` is beacon-only) |
| Hermetic resolver contract + fixtures | CR-003 | **Absent** (no `src/resolver*`) |
| Hardened metadata egress boundary | CR-004 | **Absent** as resolver/report egress harness |
| Versioned capability registry + finality policy | CR-101 | **Absent** |
| Bounded resolver core (deadlines, concurrency, caches) | CR-102 | **Absent** |
| EVM NFT recognition probe adapter | CR-103 | **Absent** (Kitchen ingest ≠ recognition probe) |
| Solana resolver service adapter | CR-104 | **Absent** (CLI/registry only) |
| Recognition metrics + disable controls | CR-107 | **Absent** |
| Public trust-stream producer (capability/ownership) | CR-011A | **Absent** (events pillar is not CR-009) |
| Cross-VM Kitchen deployment-capability key | CR-203 | **Not started** (EVM legacy key live) |
| G6 network packets (Robinhood / Solana prepare) | CR-401 / CR-402 | **Not started** |

Wire identity Sonar will produce once CRs land (acknowledged, not implemented):

- Resolver responses: chain-qualified candidates, provenance, capability
  snapshot `(registry_epoch, registry_sequence)`, partial diagnostics;
  recognition ≠ index ≠ ready (SDD §5).
- Capability registry events → Ordering `capability_registry_views` projection.
- Kitchen: physical job per deployment+capability; command inbox idempotency;
  no subscriber list ownership (SDD §3.1, §10.2).
- Public evidence envelopes under CR-009 for capability/ownership (CR-011A).

Schema/version Sonar consumes: **pinned shared-protocol package from CR-001 /
CR-009** — version TBD at Loa ACCEPT; Sonar forbids hand-mirrored Dashboard
schemas (CR-005).

---

## 3. Authority boundaries

### 3.1 Sonar owns

- Declared mainnet capability registry (recognize / prepare / read_evidence).
- Bounded on-chain / DAS probes and physical index preparation (Kitchen + belt
  + SVM lanes).
- Versioned finality/freshness policy bindings for Sonar-produced evidence.
- Public capability/ownership trust-stream *producer* adoption (CR-011A) after
  CR-009 ratification.
- Per-network disable/drain signals and recognition observability (CR-107).
- Honest “recognize without prepare” declarations (esp. Solana / Robinhood).

### 3.2 Sonar must not own / must not infer

| Forbidden | Why | Current risk on `main` |
|---|---|---|
| Resolution sessions, confirmation, user report lifecycle | Ordering owns (SDD §5.1) | Kitchen stores `order_id` and overwrites on requeue — **must be demoted to correlation only in CR-203** |
| Subscriber lists / notification delivery | Ordering / Dashboard | `contact_email` / `community_name` on ingest jobs — treat as legacy; no new fan-in semantics |
| Logical collection equivalence from name/image similarity | Inventory + explicit evidence only | Do not auto-group in resolver |
| Browser-reachable resolver or arbitrary user RPC URLs | Dashboard BFF + declared registry only | N/A today; must stay server-only |
| Restricted Discord/identity streams | Identity / Shadow Audit (CR-011B) | Out of Sonar scope |
| Marketplace “verified” endorsement | Product principle | Recognition ≠ trust badge |
| Inheriting Ethereum finality for every EVM chain | SDD §5.2 | No registry yet — policy must be explicit per network including 4663 |

### 3.3 Boundary acknowledgment

Sonar **accepts** the SDD bounded-context split: physical resolver beside
Kitchen; Ordering calls Sonar; Sonar never writes resolution sessions; Inventory
enriches after chain recognition. Sonar **rejects** any plan that makes Kitchen
the system of record for multi-subscriber report orders.

---

## 4. Provisional capacity / headcount estimate

**Status: provisional pending U-9 operator confirmation.** These values are
planning inputs, not issue-ready commitments, until U-9 closes with an explicit
acknowledgement or replacement estimate.

Bottom-up estimate for Sonar-primary CRs only (sprint owner map). Assumes one
senior engineer familiar with this repo; excludes Loa CR-001/009 wait time and
operator Discord gate.

| CR | Complexity | Estimate (eng-days) | Uncertainty |
|---|---|---|---|
| CR-003 hermetic resolver proof | M | 3–5 | Low once CR-001 fixtures exist |
| CR-004 metadata egress harness | M | 4–6 | Medium (SSRF matrix breadth) |
| CR-011A public trust-stream producer | L | 8–12 | High (outbox/epoch novelty vs events pillar) |
| CR-101 capability registry | M | 5–8 | Medium (finality policy authorship) |
| CR-102 bounded resolver core | L | 8–12 | High (cache/invalidation + load) |
| CR-103 EVM NFT probe | L | 6–10 | Medium (proxy/standard fixtures) |
| CR-104 Solana resolver adapter | M | 4–6 | Low–medium (wrap existing DAS) |
| CR-107 observability + disable | M | 3–5 | Low |
| CR-203 Kitchen cross-VM identity | L | 10–15 | **High** (expand/dual-write/parity; live EVM jobs) |
| CR-401 Robinhood G6 | L | 5–8 | High (external RPC/index truth) |
| CR-402 Solana prepare parity | L | 8–14 | **High** (cNFT/classic coverage gaps) |
| Integration / mixed-version / ops (share of CR-005, 204A, 404) | — | 5–8 | Medium |

| Aggregate | Value |
|---|---|
| Central estimate | **~89 eng-days** (~4.5 eng-months calendar if single-threaded) |
| Range | **69–109 eng-days** |
| Aggregation | Direct sum of the per-CR ranges; central estimate is the range midpoint |
| Assumed headcount | **1.0 FTE Sonar** for foundation+S1; **+0.5 FTE** during CR-203 dual-write and CR-402 |
| Parallelism note | CR-003/004 can proceed after CR-001; CR-101–104 after CR-003; CR-203 after CR-103/104; CR-011A after CR-009 + CR-013 (production signing-key custody); CR-401/402 after G2A (resolver fixtures) + CR-203 |
| Retention commitment (CR-011A) | Capability registry views / evidence retention per SDD (~90 days after supersession for registry views); exact producer retention SLO **TBD in CR-011A issue** — not inventable here |
| V1 resolver budget Sonar must meet | ≤8 enabled mainnets, 6 concurrent probes, 4s global / 1.5s per-network (sprint thresholds) — **not measured on `main`** |

An issue without a reconfirmed estimate at creation time remains not-ready
(sprint §13).

---

## 5. Mixed-version behavior, flags, deploy, rollback

### 5.1 Acknowledged matrix (SDD §16–17)

| Pairing | Required behavior |
|---|---|
| New Ordering → old Sonar | Compatibility adapter **or** reject unsupported capability **before** order accept |
| New Sonar events → old Ordering | Ignore safely or translate at versioned boundary; never silent reinterpret |
| Rollback with in-flight jobs | Preserve accepted orders/evidence generations; no delete-based rollback |
| Dual-write Kitchen migration | Divergence **disables** new async preparation and pages ops (SDD §10.2) |

### 5.2 Feature flags Sonar will honor (server-evaluated)

- `collection_resolver_enabled`
- `collection_public_preparation_enabled` / async prep gates owned with Ordering
- `resolver_operation_enabled[namespace:reference:operation]`

None of these exist on `a68bbae0`. Closest live controls:
`KITCHEN_WORKER_ENABLED`, `SQD_LIVE_TAIL_ENABLED` (SVM loader only) — **not**
substitutes for capability health transitions.

### 5.3 Deploy position

1. Expand Kitchen schema / dual-write (CR-203) before new-key authority.
2. Shadow resolver + hermetic fixtures (CR-003) before any user-visible
   recognition flag.
3. Public trust-stream producer (CR-011A) before Ordering dependency-ledger
   closure (CR-012A) can consume Sonar edges.
4. Per-network G6 (CR-401/402) before production recognize/index enablement.

### 5.4 Rollback limits

- May disable a network’s recognize/prepare without destroying Kitchen history.
- May stop Kitchen worker / reject new ingest without deleting
  `kitchen_ingest_jobs`.
- Must **not** roll back by dropping pending jobs that Ordering still links.
- Must **not** claim Ethereum confirmation defaults for a newly enabled EVM
  network during emergency enablement.

---

## 6. Operations ownership

| Concern | Sonar owner? | Current state | Gap |
|---|---|---|---|
| Kitchen API health | Yes | `GET /health` | Thin |
| Kitchen auth/misconfig triage | Yes | README + `SERVICE_TOKEN` | Documented |
| Belt reindex / TrackedErc721 patch failures | Yes | Worker marks `failed` | No typed capability_disabled drain |
| Resolver latency / partial / zero-result | Yes (CR-107) | **Missing** | Must add before T0 enablement |
| Capability disable without deploy | Yes (CR-107) | **Missing** | Blocker for G6 |
| Trust-stream gap / epoch reset / key revoke | Yes (CR-011A) + Ordering ledger | **Missing** | Blocked on CR-009 |
| Capacity dashboard / incident runbook | Participant (CR-404) | SCALE.md / Kitchen FAQ only | Need shared ops runbook |
| Safe stop / resume | Yes | Worker env flag; no registry drain policy | Must version drain/revocation |

**Ops ownership acknowledgment:** Sonar on-call owns Kitchen + resolver +
capability registry health and disablement. Ordering owns subscriber-visible
Needs attention. Inventory owns curated equivalence disputes. Sonar pages on
Kitchen dual-read divergence and trust-stream producer failure.

---

## 7. Evidence paths and tests

### 7.1 Audit evidence (this acceptance)

| Claim | Path / proof |
|---|---|
| Audited worktree revision = sprint baseline sonar-api | The author-recorded command transcript is `grimoires/loa/coordination/collection-report/baseline-audit.md`. Independently rerun its repository-identity, commit-existence, baseline-inspection, and delivery-boundary commands; the transcript is advisory evidence, not a CI attestation. |
| Kitchen EVM-only key + `order_id` | The request requires `order_id` and the key is numeric `chainId` plus an EVM-shaped `0x` contract (`src/kitchen/types.ts:11-16`, `src/kitchen/types.ts:29-40`). The durable table stores `order_id` and uses `(chain_id, contract)` as its primary key (`migrations/kitchen_ingest_jobs.sql:4-16`). |
| Unconditional `TrackedErc721` patch | `appendTrackedErc721ToChainBlock` inserts the address into an existing `TrackedErc721` block or creates that block when absent (`src/kitchen/config-patcher.ts:51-94`); the ingest patch path calls it without a token-standard probe (`src/kitchen/config-patcher.ts:96-113`). |
| No collection resolver package | Negative structural probe: `test -z "$(find src -maxdepth 2 \( -type d -o -type f \) -path '*resolver*' -print)"`; protocol inventory probe: `find packages/protocol -maxdepth 2 -type f -print` returns only `packages/protocol/beacon.yaml`. The sole protocol artifact declares the existing GraphQL schema as the public protocol surface (`packages/protocol/beacon.yaml:86-94`), not a collection resolver. |
| Solana probe is CLI/registry | The probe identifies itself as read-only, documents CLI invocation, and explicitly performs no writes or registry mutation (`src/svm/probe-collection.ts:1-18`); its entry point reads CLI arguments and requires a Helius key (`src/svm/probe-collection.ts:60-65`). The registry is a static `collectionKey`/mint configuration map (`src/svm/collection-registry.ts:15-28`, `src/svm/collection-registry.ts:31-49`). |
| No Robinhood 4663 | The complete configured network headers are Ethereum `1`, Arbitrum `42161`, Zora `7777777`, Optimism `10`, Base `8453`, and Berachain `80094` (`config.yaml:569`, `config.yaml:626`, `config.yaml:634`, `config.yaml:642`, `config.yaml:675`, `config.yaml:719`); exact negative probe: `! rg -n '^  - id: 4663$' config.yaml`. |
| Kitchen unit suite green | `pnpm exec vitest run src/kitchen` → **7 files / 32 tests passed** (2026-07-16); the repository test recipe is Vitest (`package.json:12`, `package.json:37`). The seven source suites are `src/kitchen/auth.test.ts:1-43`, `src/kitchen/config-patcher.test.ts:1-74`, `src/kitchen/hasura-status-reader.test.ts:1-52`, `src/kitchen/ingest-worker.test.ts:1-99`, `src/kitchen/normalize.test.ts:1-37`, `src/kitchen/routes.test.ts:1-213`, and `src/kitchen/status.test.ts:1-70`. The run used sibling `node_modules` at audited SHA `a68bbae0bf04e281a9b6b46fc3812c9dbb471afa`; sibling and audited trees both resolve `pnpm-lock.yaml` to Git blob `802197fb7717e1ffb72fc4bcfd60b21bc7998350`. Dependency-tree equivalence was not independently proven by a clean install, so this is recipe-identity evidence rather than hermetic install provenance. |

### 7.2 Tests that must exist before Sonar CRs close (not claiming they exist)

| CR | Required verification (from sprint) |
|---|---|
| CR-003 | Hermetic EVM+Solana+multi-chain+partial+empty; no live RPC |
| CR-004 | SSRF/rebinding/redirect/decompression fixtures |
| CR-101 | Registry validation; disable removes network from search |
| CR-102 | Cancellation, timeout, cache, circuit breaker, load p50/p95 |
| CR-103 | ERC-721/1155/proxy/EOA/multi-network fixtures |
| CR-104 | DAS parity; **no Solana key lowercasing** |
| CR-107 | Synthetic disable + breaker |
| CR-011A | Duplicate/gap/epoch/stale key/revocation/failover |
| CR-203 | Old/new EVM status parity; race/requeue idempotency; Solana prepare-unsupported without schema fiction |
| CR-401/402 | G6 recognize/index/disable/failure packets |

---

## 8. Unresolved evidence and closure conditions

| ID | Severity | Unresolved evidence | Closure condition | Unblocks |
|---|---|---|---|---|
| U-1 | Blocker | CR-001 shared identity schemas not published | Loa ACCEPT + CR-001 fixtures consumable by Sonar | CR-003, CR-203 |
| U-2 | Blocker | CR-009 signed trust-envelope protocol not ratified | Loa CR-009 + CR-013 production signing-key custody / key registry pin | CR-011A |
| U-3 | Blocker | No capability registry / finality policies on `main` | CR-101 merges with per-network policies (no Ethereum default inheritance) | CR-102+, G6 |
| U-4 | Blocker | No operator network disable without deploy | CR-107 disable path + runbook drill | Production recognize flags |
| U-5 | High | Kitchen `order_id` / email fields imply order ownership | CR-203 design review: correlation-only; Ordering owns subscribers; expand→dual-write→parity | CR-204A |
| U-6 | High | Indexed ≈ `holder_count > 0` | CR-002 / ownership_index.v1 freshness + coverage binding | Honest ready evidence |
| U-7 | High | Solana prepare gaps (cNFT; classic coverage) | CR-402 G6 per coverage class; unsupported remains recognize-only | Solana async prep |
| U-8 | Medium | Resolver V1 latency/concurrency unmeasured | CR-102 load evidence against sprint thresholds | T0 production enablement |
| U-9 | Medium | Headcount not operator-confirmed | Operator ack of §4 estimate (or revised numbers) in coordinator | Issue creation readiness |
| U-10 | Medium | Metadata egress threat model unproven | CR-004 harness green | Live metadata in candidates |

**Coordinator rule:** Sonar CR implementation issues stay **not ready** while
U-1/U-2 are open for dependent CRs; U-3/U-4 block production recognition
enablement even if code lands behind flags.

---

## 9. Explicit non-claims

- Does **not** authorize implementing any CR in this dispatch.
- Does **not** accept production enablement of collection recognition.
- Does **not** treat Kitchen “indexed” as the Gate Leak report recipe’s
  `ownership_index.v1` ready.
- Does **not** accept Robinhood or Solana prepare as available.
- Does **not** equate NATS mint envelopes with CR-011A trust-stream adoption.

---

## 10. Sign-off

| Role | Status |
|---|---|
| Sonar boundary (this artifact) | **conditional** acceptance recorded |
| Operator confirmation of §4 capacity | **pending** (U-9) |
| Loa shared-protocol / envelope owners | **required** for U-1 / U-2 |

Strongest caveat: **live Kitchen still keys work by EVM `(chain_id, contract)`
and persists `order_id` as if Sonar owns the order**, while the plan requires
deployment-capability identity and Ordering-owned subscribers — treating today’s
Kitchen HTTP as the future resolver/prep contract would falsify fan-in and
rollback proofs.
