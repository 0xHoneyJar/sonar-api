# Software Design Document — Indexer Belt Rebuild, Deployment #1

> **Cycle**: indexer-belt-rebuild · **Deployment #1** (the fire fix)
> **Implements**: `grimoires/loa/prd.md` (r2) · **Build doc**: `grimoires/loa/specs/indexer-belt-rebuild.md`
> **Date**: 2026-05-19 · **Build construct**: `construct-noether`
> **Revision**: r3 — r2 integrated the Flatline SDD review (§12); r3 adds the
> stable-gateway recovery model (§9.1) per the 2026-05-19 sprint-phase review.
> **Grounding**: handler cross-contract analysis (this session) — see §3.2.

## 1. Overview

Deployment #1 stands up the **Mibera belt** — a self-hosted Envio HyperIndex deployment on
Railway, indexing exactly two Berachain contracts (`MiberaLiquidBacking`,
`MiberaCollection`), serving a GraphQL endpoint that two consumers repoint to via a single
environment variable each.

It is additive **up to the consumer repoint** — that repoint is the commit point (§9). No
handler code changes, no schema changes. The design has one load-bearing element —
**config `field_selection` fidelity, mechanically enforced** (§5).

## 2. The Belt Architecture

Per loa-freeside ADR-008 (the factory model):

```
freeside-sonar  (ONE repo / ONE building)
├── src/handlers/        shared — all belts reuse the same handler code
├── schema.graphql       shared — frozen consumer contract
├── config.yaml          the monolith config (retired as the live indexer)
├── config.mibera.yaml   ← Deployment #1 creates this — Mibera belt scope
├── config.honeyjar.yaml   (later)
├── config.purupuru.yaml   (later)
└── config.sprawl.yaml     (later)
```

Each `config.<belt>.yaml` is a complete HyperIndex config scoped to that belt's contracts,
mapping to **its own Railway service** (HyperIndex container + Postgres) syncing
independently. Deployment #1 creates the first config + the first service.

**Why per-belt configs, not per-belt repos**: HyperIndex is one config per indexer
instance; sharing `src/handlers/` + `schema.graphql` keeps one codebase and one frozen
schema. A belt config *grows* — consumers never re-point when coverage widens.

## 3. Component Design

### 3.1 `config.mibera.yaml` (NEW — the deliverable)

A HyperIndex config:

- **`name`** — belt-scoped indexer name.
- **`networks`** — one entry: Berachain, chain id `80094`, data source per §3.4 / FR-0.
- **`contracts`** — exactly two, event ABIs + per-event `field_selection` copied verbatim
  from `config.yaml` (§5):

  **`MiberaLiquidBacking`** — `0xaa04F13994A7fCd86F3BbbF4054d239b88F2744d`, start_block
  `3971122`. 9 events: `LoanReceived(uint256 loanId, uint256[] ids, uint256 amount, uint256 expiry)` ·
  `BackingLoanPayedBack(uint256 loanId, uint256 newTotalBacking)` ·
  `BackingLoanExpired(uint256 loanId, uint256 newTotalBacking)` ·
  `ItemLoaned(uint256 loanId, uint256 itemId, uint256 expiry)` ·
  `LoanItemSentBack(uint256 loanId, uint256 newTotalBacking)` ·
  `ItemLoanExpired(uint256 loanId, uint256 newTotalBacking)` ·
  `ItemPurchased(uint256 itemId, uint256 newTotalBacking)` ·
  `ItemRedeemed(uint256 itemId, uint256 newTotalBacking)` · `RFVChanged(uint256 indexed newRFV)`.

  **`MiberaCollection`** — `0x6666397dfe9a8c469bf65dc744cb1c733416c420`, start_block
  `3837808`. 1 event: `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)`.

The config is produced by extracting the two contracts' blocks from `config.yaml`.
Addresses, start_blocks, **and `field_selection`** are diffed against `config.yaml` and
mechanically verified (§5.3, PRD FR-1).

### 3.2 Handler reuse — verified self-contained

`src/handlers/mibera-liquid-backing.ts` and `src/handlers/mibera-collection.ts` are reused
**as-is, zero code changes**. A cross-contract dependency analysis this session (PRD FR-2,
addressing Flatline blocker SKP-001·880) confirmed:

- **Zero cross-contract entity dependencies.** Every entity each handler reads back, it
  created itself in an earlier event of the *same* contract.
- **Imports are pure.** `recordAction` (`src/lib/actions.ts`) is a stateless write helper;
  `mint-detection.ts` helpers are pure comparisons; `constants.ts` are static maps.
- **The `TrackedErc721` double-write risk is already engineered out.** `config.yaml:716-717`
  excludes the Mibera collection address from the `TrackedErc721` contract list. The Mibera
  collection's `TrackedHolder` rows have a *single* writer — `handleMiberaCollectionTransfer`.

**Conclusion**: a config scoped to only these two contracts is **data-equivalent to the
monolith** for the consumer entities — by *static* analysis. §6's local dev run is the
empirical confirmation.

Entities written: `mibera-liquid-backing.ts` → `MiberaLoan`, `MiberaLoanStats`,
`TreasuryItem`, `TreasuryStats`, `TreasuryActivity`, `DailyRfvSnapshot`, `Action`;
`mibera-collection.ts` → `MiberaTransfer`, `MintActivity`, `NftBurn`, `NftBurnStats`,
`TrackedHolder`, `MiberaStakedToken`, `MiberaStaker`, `Action`.

### 3.3 `schema.graphql` reuse

Reused **verbatim** — the frozen consumer contract (PRD NFR-1). Entities fed only by
out-of-scope contracts stay empty (empty ≠ error — §7). No entity/field renamed.

### 3.4 Railway deployment

One Railway project; deployment #1 is its first service.

- **Service** — HyperIndex built from this repo, run against `config.mibera.yaml`.
- **Config selection** — HyperIndex defaults to `config.yaml`. The belt service points it
  at `config.mibera.yaml` via the **Railway build step copying `config.mibera.yaml` →
  `config.yaml`** in the service's working tree (version-independent; sidesteps any
  `--config`-flag uncertainty). If the installed Envio version supports an explicit
  `--config` / `ENVIO_CONFIG` selector, that is the preferred alternative — confirmed at
  implementation.
- **Build command** — `pnpm install --frozen-lockfile && pnpm envio codegen` (exact
  invocation confirmed against `package.json` + the installed Envio version).
- **Start command** — `pnpm envio start` (or the repo's start script).
- **Database** — a provisioned **persistent PostgreSQL** instance (Railway plugin).
  HyperIndex requires Postgres; persistence is mandatory or a container restart loses
  sync state.
- **Environment variables** (enumerated, PRD FR-3b): Postgres connection URL; the
  Berachain data-source endpoint (§FR-0); HyperIndex/chain config; any RPC API key. Secrets
  live in Railway env, never in `config.mibera.yaml` or git.

## 4. Data Flow

```
Berachain 80094 ──(HyperSync berachain.hypersync.xyz, or RPC fallback)──▶ HyperIndex
   │                                                            src/handlers/ run │
   ▼                                                                              ▼
[ MiberaLiquidBacking events ]                                          PostgreSQL (Railway)
[ MiberaCollection.Transfer  ]                                                   │
                                                                                 ▼
                                                  GraphQL endpoint (Railway URL, §9 hardened)
                                                     │                              │
                            NEXT_PUBLIC_ENVIO_URL ───┘                              └── ENVIO_GRAPHQL_URL
                                     ▼                                                       ▼
                            mibera-honeyroad /backing                            score-api envio-client.ts
```

## 5. Config `field_selection` Fidelity — mechanically enforced

HyperIndex only exposes transaction/block fields a config *requests*. The correctness risk
is a `field_selection` that omits a field a handler reads — producing silently-wrong data,
no crash. Known field dependencies:

1. **`MiberaCollection.Transfer` requires `transaction_fields: [hash, value]`.**
   `mibera-collection.ts:73` reads `event.transaction.value` → `MintActivity.amountPaid`;
   omitting `value` silently writes `0n`.
2. **`MiberaLiquidBacking` `LoanReceived`/`ItemLoaned`/`ItemPurchased`/`ItemRedeemed`
   require `from`.** Handlers read `event.transaction.from` for `user`/`buyer`/`depositor`/
   actor fields (incl. the `Action:treasury_purchase` buyer).

### 5.3 Automated structural check (NEW — replaces manual diff)

A CRITICAL invariant guarded only by a human "copy verbatim + eyeball the diff" process is
itself a risk (Flatline SKP-001·870 / ·760). Deployment #1 ships a **structural
verification check**:

- A script — `scripts/verify-belt-config.<sh|ts>` — parses `config.mibera.yaml` and
  `config.yaml`, and for **every event of both belt contracts** asserts the
  `field_selection` (transaction_fields, block_fields) is byte-identical to the
  corresponding `config.yaml` entry. It also asserts addresses + start_blocks match.
- It exits non-zero on any mismatch and is wired as a **build/CI gate** (and runnable
  locally pre-commit).
- This makes per-event manual analysis unnecessary — fidelity for all 10 events
  (incl. the 5 `MiberaLiquidBacking` events not individually analyzed above) is enforced
  uniformly and mechanically (resolves Flatline IMP-003).

## 6. Handler-Correctness & Endpoint Verification (FR-2, FR-4)

- **Build gate** — `pnpm codegen` + `pnpm tsc --noEmit` clean; §5.3 config check passes.
  Necessary, not sufficient.
- **Local dev run (FR-2, AC-4)** — run the indexer locally against `config.mibera.yaml`
  (`pnpm envio local docker up` + `pnpm envio start`, exact commands per the repo).
  Reproducible exit criteria — three GraphQL queries against the local endpoint, expected
  results recorded:
  1. `query { MiberaLoan(limit: 5) { id loanedTo timestampDue backingOwed } }` — non-empty.
  2. `query { MiberaTransfer(limit: 5) { id from to tokenId } }` — non-empty.
  3. `query { MintActivity(where: {amountPaid: {_gt: "0"}}, limit: 5) { id amountPaid } }`
     — at least one row (proves the §5.1 `value` field flows end-to-end).
- **Deterministic loan reconciliation (FR-4, AC-6)** — pin an exact Berachain block height
  past finality (recorded in the verification artifact). Query the endpoint for active
  loans at that height. Independently read on-chain `MiberaLiquidBacking`: `backingLoanId`,
  then `backingLoanDetails(id)` + `backingLoanExpired(id)` for `id` in `0..backingLoanId-1`.
  The endpoint's active set MUST equal the on-chain active set at that block. The expected
  count (≈19 per the 2026-05-19 diagnosis) is recorded as the reference for the pinned
  block — the gate is exact equality, not a fuzzy number.

## 7. score-api Partial-Restoration Contract (FR-5)

| Entity | Source contract | Deployment #1 |
|---|---|---|
| `MiberaLoan` | MiberaLiquidBacking | ✅ resolves |
| `MiberaTransfer` | MiberaCollection | ✅ resolves |
| `MintActivity` | MiberaCollection | ✅ resolves |
| `NftBurn` | MiberaCollection (mibera) | ⚠️ mibera burns only (no Milady) |
| `Action` (`treasury_purchase`) | MiberaLiquidBacking | ✅ resolves |
| `PaddleSupply`, `PaddleLiquidation`, `BgtBoostEvent`, `MintEvent`, `Erc1155MintEvent`, `CandiesBacking`, `FriendtechTrade` | out-of-scope contracts | ⬜ empty arrays |

**Partial coverage is more dangerous than no coverage** — a consumer may compute
plausible-but-wrong aggregates over the 7 empty entities. **Empty ≠ error**: uncovered
entities return empty GraphQL arrays, never schema/endpoint errors.

**Pre-repoint safety audit — a HARD acceptance gate (AC-9), not a recommendation:**
- **Owner**: the engineer executing deployment #1.
- **Scope**: each of the 7 uncovered entities, as consumed in
  `score-api/trigger/utils/envio-client.ts`.
- **Exit criterion**: every uncovered-entity query path is confirmed empty/null-safe — an
  empty array does not crash or NaN-poison wallet scoring. Any unsafe path is a score-api
  fix that **blocks the `ENVIO_GRAPHQL_URL` repoint**.
- **Artifact**: findings recorded in `grimoires/loa/a2a/<sprint>/score-api-empty-safe-audit.md`.

## 8. Observability (NFR-5)

The original incident was a *silent* 404. Concrete requirements:

- **Healthcheck** — the Railway service healthcheck targets HyperIndex's health/status
  endpoint; Railway restarts the service on failure. Cadence: Railway default (~30s);
  failure threshold: 3 consecutive.
- **Sync-lag alert** — alert when `chain_head_block − indexed_block` exceeds a threshold
  (initial: > ~300 blocks **or** > 10 min of wall-clock lag, tuned after the first
  historical sync completes). A stalled sync is the silent-death class.
- **Postgres disk** — alert on the Railway Postgres disk-usage metric at ≥ 80%.
- **Alert destination** — Railway's built-in service notifications to the operator, plus a
  webhook to the team ops channel. The exact channel is an operator config step at
  deploy time; the *requirement* is that service-down / sync-stalled / disk-high are not
  silent.

## 9. Rollback, Security & Blast Radius

### 9.1 Recovery — stable gateway, not fix-forward (corrects PRD NFR-2; r3)

The PRD called the consumer repoint "one revertible env var" — wrong (Flatline
SKP-002·830). r2 corrected it to "fix-forward"; the sprint-phase review (3 CRITICALs)
correctly pushed further — fix-forward under outage pressure is not a recovery plan. r3
resolves it with a **stable gateway**:

- **Consumers repoint to a stable gateway URL, never the raw Railway service URL.** A
  lightweight reverse proxy (Railway service or Cloudflare Worker) holds a stable public
  URL; its upstream target — the current belt's GraphQL endpoint — is a single config
  value.
- **The one-way repoint happens once**, to the gateway. Swapping the belt behind it (a new
  deployment, a rollback to a prior good belt, an emergency target) is then an
  **operator-controlled upstream change** with zero consumer impact — the structural
  fallback.
- **Before the repoint** — deployment #1 is fully reversible (a new Railway service + new
  URL; tear it down, nothing else affected).
- **The repoint is staged**: consumers repoint to the gateway only after the belt endpoint
  passes §6 FR-4 deterministic reconciliation **and** a soak (≥2 h synced-to-head,
  healthcheck green, sync-lag quiet). mibera-honeyroad first (loan UI is the fire);
  score-api after its §7 empty-safe audit.
- **Post-handback recovery**: if the belt degrades, repoint the gateway upstream — fast,
  operator-controlled, no consumer change, no outage-pressure code fix.

### 9.2 GraphQL endpoint hardening

The endpoint is public and unauthenticated (consumers need it; data is public read-only
on-chain data). To prevent trivial DoS / expensive-query abuse (Flatline SKP-002·750):

- **Rate limiting** — per-IP request rate limit at the Railway/proxy layer.
- **Query-complexity / depth limit** — cap GraphQL query depth and complexity so a single
  query cannot exhaust the indexer (HyperIndex/Hasura-layer setting, or proxy).
- These are scoped into deployment #1 (operator elected full integration).

### 9.3 Blast radius

Additive only; no contract interaction, no on-chain writes, no auth paths. Secrets are
Railway env vars. The only irreversible step is the consumer repoint (§9.1) — gated on
§6 verification.

## 10. Verification → Acceptance Criteria Mapping

| SDD section | PRD / new acceptance criteria |
|---|---|
| §3.4 FR-0 outcome | AC-1 |
| §3.1 + §5.3 automated check | AC-2 |
| §6 build gate + §5.3 check | AC-3 |
| §6 local dev run (3 queries) | AC-4 |
| §3.4 Railway + Postgres | AC-5 |
| §6 deterministic reconciliation at pinned block | AC-6 |
| §8 observability (healthcheck, sync-lag, disk) | AC-7 |
| §9.1 staged repoint → mibera-honeyroad | AC-8 |
| §7 pre-repoint empty-safe audit (hard gate) | AC-9 |
| §3.3 schema reuse | AC-10 |
| §5.3 `field_selection` structural check passes in CI | AC-11 (new) |
| §9.2 endpoint rate-limit + complexity cap live | AC-12 (new) |
| §9.1 stable gateway URL live + upstream-swap verified | AC-13 (new, r3) |

## 11. Risks & Open Decisions

- **RPC-fallback historical sync** — if FR-0 forces public RPC, historical sync from
  start_block `3837808` may be slow/rate-limited. Prefer HyperSync; §8 sync-lag alert
  detects a stall. Known caveat.
- **First-time Railway HyperIndex self-host** — unknown deployment friction; the 10.5-day
  buffer absorbs iteration.
- **The repoint is one-way** (§9.1) — mitigated by staged verification, not by rollback.
- **Open (post-#1)** — cross-belt `Action` fragmentation: when belts beyond Mibera ship,
  score-api must query multiple endpoints or freeside-sonar exposes a federation endpoint.
  Resolve before the HoneyJar belt. Does not block deployment #1.

## 12. Flatline Review Integration (r2)

Revised per the 2026-05-19 3-model headless Flatline SDD review of r1 (claude-headless +
codex-headless + gemini-headless; full confidence, 88% agreement). All 15 findings
integrated:

- **6 high-consensus** — IMP-001 (partial-coverage danger → §7), IMP-002 (deployment
  commands → §3.4), IMP-003 (5 un-analyzed events → resolved by §5.3 mechanical check),
  IMP-004 (audit as verifiable AC → §7/AC-9), IMP-005 (concrete healthcheck → §8),
  IMP-006 (exact reference block → §6).
- **1 disputed** — IMP-009 (AC-4 reproducible: dev command + 3 queries → §6).
- **8 blockers** — SKP-001·870 + SKP-001·760 (field_selection automated check → §5.3),
  SKP-002·830 (stranded rollback → §9.1, corrects PRD NFR-2), SKP-004·710 (observability
  spec → §8), SKP-003·720 (Postgres disk alert → §8), SKP-001·850 (partial-data
  degradation → §7), SKP-003·740 (audit as hard gate → §7/AC-9), SKP-002·750 (endpoint
  hardening → §9.2).

Full result: `grimoires/loa/a2a/flatline/sdd-review.json`.
