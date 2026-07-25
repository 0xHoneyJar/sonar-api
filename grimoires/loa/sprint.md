---
hivemind:
  schema_version: "1.0"
  artifact_type: technical-rfc
  product_area: "sonar-api — EVM Collection Onboarding Contract v1"
  workstream: delivery
  priority: high
  learning_status: directionally-correct
  source: team-internal
---

# Sprint Plan — EVM Collection Onboarding Contract v1

> **Status**: draft · **Date**: 2026-07-07 · **Repo**: 0xHoneyJar/sonar-api
> **Traces**: `grimoires/loa/prd.md` (FR-1..FR-6), `grimoires/loa/sdd.md` v1.1 (§8 Development Phases).
> **Phase**: `/sprint-plan` → feeds `/run sprint-plan`.

## Executive Summary

Onboard EVM collections against ONE versioned contract instead of reverse-engineering the per-collection
`Action`-overlay grammar. Two planes (SDD §1.1): **P1** = the `Token` ownership read model (the FR-2 build,
unblocks inventory-api#27) and **P2** = the already-built-inert canonical `NftActivity` stream (adopted via
the S5/S6 handshake). **This autonomous run implements Sprint 1 only** — the schema `@index` change, codegen,
tests, and a committed reindex runbook. FR-3/FR-4 (S5 parity, S6 go-live) are cross-building and
operator-gated; FR-5 (onboarding doc + watermark) is partly blocked on OQ-1.

**FR-6 (Sprint 1.5, un-deferred per #115 comment 4911466984)** — uniform priced EVM sale decode — is a
copy-adapt of the already-written `seaport.ts` decode extended to mainnet (chain 1) Azuki so it feeds a
non-null canonical `value` (SDD §5.5, §8 Phase 1.5). Its CODE half (config + handler + belt-parity + tests)
is agent-implementable; the mainnet BACKFILL + KF-013 redeploy are OPERATOR-GATED (same §3.4 discipline as
Sprint 1's reindex). It slots between Sprint 1 and Sprint 2 because the priced rows it produces are the raw
input the Sprint-2 S4 adapter surfaces canonically.

## Sprint Overview

| Sprint | Theme | FR | Autonomy | This run? |
|--------|-------|----|----------|-----------|
| 1 | Token ownership index | FR-2 | AGENT-IMPLEMENTABLE (prod reindex operator-gated) | **YES** |
| 1.5 | Uniform priced EVM sale decode (mainnet Seaport → Azuki) | FR-6 | CODE agent-implementable (config + handler + belt-parity + tests); mainnet backfill + KF-013 redeploy OPERATOR-GATED | No |
| 2 | S5 consumer-parity handshake | FR-3 | adapter/harness agent-implementable; decision operator-paired | No |
| 3 | S6 go-live + gate flip | FR-4 | OPERATOR-GATED (live secrets, prod backfill) | No |
| 4 (Final) | Onboarding contract + FR-1 designation | FR-5/FR-1 | docs agent-implementable; FR-5b BLOCKED on OQ-1 | No |

> **Sequencing rationale** (SDD §8): FR-2 is independent, urgent, unblocks a shipped consumer → first.
> FR-6 is an independent copy-adapt producing the raw priced rows the S4 adapter needs → Phase 1.5, before
> Sprint 2. FR-3/FR-4 need the score-mibera consumer + real data + live secrets → operator-paired, follow.
> **Scope guard**: the open P0 beads `bd-yqs`/`bd-bua`/`bd-4zf`/`bd-qcyp` (S2–S5) belong to the
> **svm-deep-history-spike** cycle — parked/operator-gated; this run MUST NOT pick them up.

---

## Sprint 1: Land the Token ownership index (FR-2) · unblocks inventory-api#27

### Sprint Goal

Make `type Token` (owner→tokenIds) indexed and populatable so inventory-api#27's `getNftsForOwner(Mibera)`
returns a correct non-empty list reconciling with `holdings.tokenCount`. Autonomous scope = schema change +
codegen + tests + committed reindex runbook; the prod reindex is operator-executed post-merge (SDD §3.4 hard
rule: "do NOT run a live reindex from an agent session").

### Deliverables

- `schema.graphql` `Token` with `@index` on `owner`, `collection`, `isBurned` (fresh on main — no
  belt-factory cherry-pick).
- Regenerated Envio types; green build.
- Reconciliation-invariant test (FR-2c).
- Committed reindex runbook `grimoires/loa/runbooks/token-index-reindex.md`.

### Acceptance Criteria

- [ ] `pnpm codegen` succeeds; generated types carry the three new `Token` indexes; `pnpm build` green.
- [ ] Reconciliation test passes on a seeded fixture (`len(getNftsForOwner) == holdings.tokenCount`) and
      **fails** if a token is dropped from enumeration.
- [ ] Reindex runbook committed with 4 steps + verification queries + the operator-led guard.
- [ ] **Post-merge (operator-run) acceptance**: after the operator executes the runbook,
      `getNftsForOwner(Mibera)` is non-empty in prod and reconciles with `holdings.tokenCount` (closes
      inventory-api#27).

### Technical Tasks

- **Task 1.1** — Add `@index` on `Token.owner`/`collection`/`isBurned` in `schema.graphql` (~L350), matching
  indexed peers (`schema.graphql:287,294,305`); run Envio codegen. Verify: codegen + typecheck pass; a schema
  assertion test confirms the three directives.
- **Task 1.2** — Reconciliation-invariant test (SDD §3.3): seed mint N → owner enumerates N tokens AND
  `tokenCount == N`; dropping a token turns it red. File: new test under `test/` mirroring existing
  token/handler tests + fixture. Verify: `pnpm test <file>` green.
- **Task 1.3** — Author `grimoires/loa/runbooks/token-index-reindex.md` grounded in
  `candies-holder-balance-reindex.md` / `apiculture-green-belt-reindex.md`: additive → from-genesis reindex
  (`DROP … CASCADE` recreates `Token` populated + indexed) → auto-track at cutover; scoped (coordinate window
  with belt STABLE Caddy alias); include verification queries. Verify: references resolve; operator-executable.

### Dependencies

- None (FR-2 is self-contained per SDD §8). Envio toolchain (`pnpm codegen`/`build`) present in
  `package.json`. No new dependencies.

### Security Considerations

- Index-only, additive schema change — no auth path, no trust boundary, no new external input.
- The prod reindex `DROP … CASCADE`s the schema; this is the load-bearing safety item — it is
  **operator-gated** and executed behind the belt STABLE alias so live traffic never points at the surface
  being rebuilt (SDD §3.4 step 3). No agent-run live reindex.

### Risks & Mitigation

- **R-1 (branch divergence)**: re-implement fresh on main, not a cherry-pick of the belt-factory branch.
- **Reindex touching prod serving**: scoped window behind STABLE alias; operator-gated execution.

### Success Metrics

- inventory-api#27 closed; `getNftsForOwner(Mibera)` non-empty; reconciliation invariant holds in prod.

---

## Sprint 1.5: Uniform priced EVM sale decode (FR-6) · mainnet Seaport → Azuki price · *planned, not this run*

### Sprint Goal

Make **every** indexed EVM collection emit the SAME priced, classified Seaport sale so score-api runs ONE
consumer path — starting with mainnet (chain 1) Azuki, whose 107k transfers currently produce 0 priced
sales (canonical `value` null). Copy-adapt of the already-written `seaport.ts` decode (native +
wrapped-native → `amountPaid`, `seaport.ts:103-114`); **no new contract surface** — the sale shape is FR-1's
sealed `verb="sale"` + `value` wei + `decimals` field set (SDD §5.5).

> **Autonomy split (mark it clearly):**
> - **CODE — AGENT-IMPLEMENTABLE**: `TRACKED_COLLECTIONS` mainnet entry, chain-1 `Seaport` binding + belt
>   config parity, registration-path reconcile, chainId-carry constraint, and tests. All App-zone edits with
>   green-build verification.
> - **OPERATOR-GATED (do NOT run from an agent session, SDD §5.5/§3.4)**: the mainnet backfill — a **KF-013
>   `ENVIO_RESTART` redeploy** on `belt-indexer-selfhost` + a **scoped chain-1 Azuki reindex from
>   `start_block`**. Committed as a runbook step; executed post-merge by the operator.

### Scope: MEDIUM (5 agent tasks + 1 operator-gated task)

### Deliverables

- [ ] `TRACKED_COLLECTIONS` mainnet Azuki entry (`0xed5af388653567af2f388e6224dcc93746104133` → `{chainId:1,
      wrappedNativeToken:"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"}`) — WETH + key **LOWERCASED** (R-12).
- [ ] Chain-1 `Seaport` binding (v1.6 `0x0000000000000068F116a894984e2DB1123eB395`, explicit `start_block`)
      in `config.yaml` **and** `config.mibera.yaml`; `Seaport@1` in `BELT_CONTRACTS`; extended
      `test/azuki-chain1-tracked-erc721.test.ts` coverage; `verify:belt-config` green.
- [ ] Reconciled Seaport registration path so the handler actually fires for chain-1 Azuki (R-11).
- [ ] chainId-aware SALE handling: the `chainId` column (`seaport.ts:165`) carried through to
      `metadata.chain_id`; the Sprint-2 S4 SALE projection MUST filter/carry `chainId` (R-9, OQ-5 caveat).
- [ ] WETH-settled Azuki fixture unit test that goes red if the lowercasing regresses (R-12).
- [ ] Operator runbook step: KF-013 redeploy + scoped chain-1 Azuki reindex from `start_block`.

### Acceptance Criteria

- [ ] **[FR-6b]** An Azuki `OrderFulfilled` writes `MintActivity{activityType:SALE, chainId:1,
      amountPaid>0}`; a WETH-settled fixture yields `amountPaid>0` (the lowercasing test would fail if WETH
      equality at `seaport.ts:110` silently mismatched → `amountPaid=0` → dropped at `seaport.ts:146`).
- [ ] `verify:belt-config` green with the `Seaport@1` entry; `config.yaml`/`config.mibera.yaml` at parity
      (no silent belt config drift, R-10).
- [ ] Registration path fires `handleSeaportOrderFulfilled` for chain-1 Seaport events (R-11 reconciled) —
      a decode that never runs is a silent 0-sales miss.
- [ ] **[FR-6c]** ETH/WETH-only accepted: a non-ETH-ERC-20-settled sale sums to `amountPaid=0n` and is
      skipped (not emitted as a zero-priced sale); documented as the ~71%-coverage v1 baseline (N5).
- [ ] **Post-merge (operator-run)**: after the KF-013 redeploy + reindex, a real mainnet Azuki OpenSea sale
      surfaces as canonical `NftActivity.value` non-null end-to-end (confirmed via the Sprint-2 S4 adapter).

### Technical Tasks

- **Task 1.5.1** → **[G1]** — Add the mainnet Azuki + WETH entry to `TRACKED_COLLECTIONS` (`seaport.ts:37`),
  both address and `wrappedNativeToken` **lowercased** (lookups compare `.toLowerCase()` at
  `seaport.ts:84,110,123`). Verify: typecheck + build green; a lookup test resolves the Azuki key.
- **Task 1.5.2** → **[G1]** — Add the chain-1 `Seaport` node (address
  `0x0000000000000068F116a894984e2DB1123eB395`, explicit `start_block` at/after Azuki deploy `14162194`)
  under the `- id: 1` network in `config.yaml` (chain 1 has Azuki `TrackedErc721` at `config.yaml:596` but
  no Seaport node — contrast Berachain `config.yaml:901-904`); mirror into `config.mibera.yaml` (chain-1
  Azuki already at `config.mibera.yaml:345`); add the `Seaport@1` entry to `BELT_CONTRACTS`; extend the
  `test/azuki-chain1-tracked-erc721.test.ts` gate pattern. Verify: `verify:belt-config` green
  (sprint-bug-172 / #118 checklist).
- **Task 1.5.3** → **[G1]** — Reconcile the Seaport registration path (R-11): belt
  `EventHandlers.mibera.ts:51` imports `handleSeaportOrderFulfilled`, but `seaport.ts` self-registers via
  `indexer.onEvent` (`seaport.ts:62`) with no such export on this branch. Confirm/wire whichever path is
  active for chain-1 Azuki. Verify: a test asserting the handler is invoked for a chain-1 `OrderFulfilled`.
- **Task 1.5.4** → **[G1]** — chainId-carry constraint (R-9, OQ-5): confirm the `chainId` column
  (`seaport.ts:165`) is written on the SALE/PURCHASE rows and carried into `metadata.chain_id`; record the
  binding constraint that the Sprint-2 S4 SALE projection MUST filter/carry `chainId` and MUST NOT
  hard-filter `chainId IN (80094,8453)` (the `MintActivity.id` omits chainId; Base Seaport was DEFERRED
  "until downstream repos add chainId filters", `config.yaml:685-689` — mainnet re-triggers it). Verify: the
  chainId assertion on a chain-1 SALE fixture.
- **Task 1.5.5** → **[G1]** — WETH-settled Azuki fixture unit test (R-12): a mainnet sale settled in WETH
  yields `amountPaid>0` and a priced SALE; the test goes red if WETH is stored checksummed. Verify:
  `pnpm test <file>` green; flipping the key to checksummed turns it red.
- **Task 1.5.OP** *(OPERATOR-GATED — not this run)* — Post-merge: KF-013 `ENVIO_RESTART` redeploy on
  `belt-indexer-selfhost` + scoped chain-1 Azuki reindex from `start_block` (same §3.4 discipline — no
  agent-run live reindex). Verify: real Azuki sales appear with `amountPaid>0` in prod.

### Dependencies

- Sprint 1 (fresh-on-main baseline). The **canonical `value` only *surfaces*** once the Sprint-2 S4 adapter
  exists — but the raw priced `MintActivity` rows must be produced first, so Sprint 1.5 precedes Sprint 2
  (SDD §8). No new npm dependencies — Envio config + existing `seaport.ts` decode only.
- OQ-5 is **RESOLVED** (SDD): no mainnet-specific SALE-row wiring inside S4; `map-evm.ts` is pure +
  per-collection, so Azuki chain-1 rows are picked up for free once produced — provided the S4 projection is
  chainId-aware (Task 1.5.4 constraint → binds Sprint 2 Task 2.1).

### Security Considerations

- App-zone config/handler edits only — no auth path, no new trust boundary. The load-bearing safety item is
  **cross-chain SALE contamination (R-9)**: because `MintActivity.id` omits chainId, an un-filtered
  downstream join would blend chain-1 Azuki sales with 80094/8453 rows. The chainId-carry constraint
  (Task 1.5.4) is the un-block gate, not optional.
- The mainnet reindex is **operator-gated** (KF-013 redeploy) behind the belt STABLE alias — same discipline
  as Sprint 1's reindex; no agent-run live reindex.

### Risks & Mitigation

- **R-9 (cross-chain SALE contamination)**: S4 projection + all consumers filter/carry `chainId`.
- **R-10 (silent belt config drift)**: `config.mibera.yaml` parity + `BELT_CONTRACTS` gate + `start_block` +
  `azuki-chain1` test + `verify:belt-config` green.
- **R-11 (registration-path mismatch)**: reconcile the import-vs-`onEvent` path before relying on FR-6.
- **R-12 (checksummed WETH mis-config)**: store WETH + Azuki keys lowercased; WETH-fixture test catches the
  silent `amountPaid=0` drop.

### Success Metrics

- Azuki mainnet sales priced (`amountPaid>0`), surfacing as canonical `NftActivity.value` non-null; one
  uniform consumer path for score-api instead of `operator`/`viaMarketplace`/SVM branches; `verify:belt-config`
  green (zero config drift).

---

## Sprint 2: S5 consumer-parity handshake (FR-3) · *planned, not this run*

### Sprint Goal

Prove the canonical `NftActivity` stream loses nothing score-mibera relies on (presence + value parity)
before any go-live. Cross-building, operator-paired.

### Deliverables

- S4 EVM Hasura adapter; `canonical.json` + `legacy.json` for a slice; `s5-parity-dryrun.ts` result;
  value-parity pass; documented `canonicalOnly` decision.

### Acceptance Criteria

- [ ] `s5-parity-dryrun.ts`: `legacyOnly` empty + `matched > 0`; `verbDisagreements` read first.
- [ ] Separate value-parity pass over `matched` sales (FR-3b) — a demoted sale blocks.
- [ ] `canonicalOnly` routing-hop over-emits DECIDED with real topology (FR-3c), documented.

### Technical Tasks

- **Task 2.1** — S4 EVM Hasura adapter (slugify name→`collection_key`; name→address for `metadata.contract`;
  bigint→string + logIndex; **join `MintActivity × MiberaTransfer`**, never generic `Transfer`;
  **contract-scoped SALE projection that filters/carries `chainId`** so Azuki chain-1 sales (from Sprint 1.5)
  surface without cross-chain contamination — R-9/OQ-5; MUST NOT hard-filter `chainId IN (80094,8453)`).
- **Task 2.1b** — Confirm the FR-6 priced Azuki `value` surfaces non-null end-to-end through the new adapter.
- **Task 2.2** — Produce `canonical.json` (mapper over slice) + `legacy.json` (score-mibera tuples, same slice).
- **Task 2.3** — Run the dry-run + value-parity + over-emit decision.

### Dependencies

- Sprint 1. S5 dry-run runs BEFORE any backfill (handoff runbook). Real score-mibera data (operator-paired).

### Security Considerations

- Read-only comparison over externally-sourced legacy tuples — collision-proof `(tx, asset_ref, verb)` JSON key
  (SDD `parity.ts`) prevents false-merge → false GREEN masking a loss.

### Risks & Mitigation

- **R-2 (value divergence)**: value-parity is a separate hard gate; a demoted sale blocks.

### Success Metrics

- `legacyOnly` empty on a real slice; value-parity passed.

---

## Sprint 3: S6 go-live prerequisites + flip the gate (FR-4) · *planned, OPERATOR-GATED, not this run*

### Sprint Goal

Satisfy the S6 prerequisites and flip `SONAR_CANONICAL_EMIT_ENABLED` for score-mibera without silent loss or
chain breakage. OPERATOR-GATED (live secrets, prod backfill).

### Deliverables

- prev-hash decision (in-memory + chain-reset OR durable); distinct signer seed; `recovery` config; applied
  `action-projection.sql`; full backfill; gate flip; `nft.mint.detected` deprecation schedule.

### Acceptance Criteria

- [ ] FR-4a/b/c/d met (build via `makeCanonicalEmitterIfEnabled`; distinct
      `SONAR_CANONICAL_SIGNING_SEED_HEX`; recovery wired).
- [ ] `canonical_action` promoted `pending-exposure → live`; backfill counts reconcile (idempotent by
      content-addressed `event_id`).
- [ ] Gate flipped for score-mibera; ≥30d `nft.mint.detected` overlap scheduled.

### Technical Tasks

- **Task 3.1** — prev-hash strategy (R-4). **Task 3.2** — emitter/secret/recovery wiring. **Task 3.3** —
  projection SQL + promotion. **Task 3.4** — backfill + reconcile. **Task 3.5** — gate flip + deprecation.

### Dependencies

- Sprint 2 (parity GREEN). Live secrets + prod access (operator).

### Security Considerations

- Distinct signer seed (never reuse `SONAR_SIGNING_SEED_HEX`); the keyId guard is label-only, so the
  consumer's signature verifier is the loud backstop (SDD §5.4). Separate publisher hash chain (F1).

### Risks & Mitigation

- **R-4 (prev-hash re-genesis on restart)**: select durable store if the consumer verifies the chain.

### Success Metrics

- Gate live; consumer scoring on canonical; zero silent-loss alarms over the overlap window.

---

## Sprint 4: Onboarding operational contract (FR-5) + FR-1 designation · *planned, partially blocked*

### Sprint Goal

Turn onboarding into a single lookup: config descriptor + checklist + FR-1 designation doc + ONE coverage
watermark; reclassify raw `Action` as legacy. Prove end-to-end that a new collection onboards without grammar
excavation.

### Deliverables

- Config-shape descriptor + onboarding checklist (catches #120/#95); FR-1 designation doc (schema + verb
  vocabulary + versioning rule); coverage watermark read model; capacity envelope; `Action`→legacy note.

### Acceptance Criteria

- [ ] A single onboarding doc reproduces collection-N+1 onboarding without grammar excavation (Acceptance-3).
- [ ] **[BLOCKED — OQ-1]** ONE `(collectionKey, chainId)→lastIndexedBlock` watermark, reconciled with belt.
- [ ] Capacity envelope committed (FR-5c) — the envelope, not fixed numbers.
- [ ] Raw `Action` table reclassified *legacy* (still serving un-migrated consumers — N1).

### Technical Tasks

- **Task 4.1** — Config descriptor + checklist + FR-1 designation doc.
- **Task 4.2** — **[BLOCKED OQ-1]** coverage watermark read model (SDD §3.6), reconciled with belt-PRD owner.
- **Task 4.3** — Capacity envelope (BOEHM-shaped spike, OQ-3).
- **Task 4.E2E: End-to-End Goal Validation** — onboard one *new* EVM collection end-to-end using only the
  committed onboarding doc + descriptor (no code archaeology): config it, verify P1 `getNftsForOwner` returns
  its tokens and P2 activity flows, and confirm the coverage watermark reports its indexed block. Document the
  evidence. This validates G1–G4 of the PRD as one runnable pass.

### Dependencies

- Sprints 1–3 (P1 index live; P2 canonical live). OQ-1 resolved with belt-PRD owner (gates Task 4.2 only).

### Security Considerations

- Onboarding checklist encodes the config-correctness that prevents mis-tracked collections (#120/#95) — a
  data-integrity guard, not a code path.

### Risks & Mitigation

- **R-5 (two watermarks)**: OQ-1 mandates ONE surface co-owned with belt before Task 4.2.

### Success Metrics

- New collection onboarded via doc-only in one pass; onboarding time drops from "excavation" to "lookup".

---

## Risk Register

| ID | Risk | Sprint | Mitigation |
|----|------|--------|-----------|
| R-1 | Belt-factory branch divergence on #153 | 1 | Re-implement fresh on main |
| R-2 | Sale value-parity divergence | 2 | Separate value-parity hard gate |
| R-4 | prev-hash re-genesis on restart | 3 | Durable store if consumer verifies chain |
| R-5 | Two watermark contracts | 4 | OQ-1: ONE surface co-owned with belt |
| R-9 | Cross-chain SALE contamination — `MintActivity.id` omits chainId; mainnet re-triggers the Base Seaport deferral | 1.5 → 2 | S4 projection + consumers filter/carry `chainId` (un-block gate, not optional) |
| R-10 | Silent belt config drift — chain-1 binding in `config.yaml` only | 1.5 | `config.mibera.yaml` parity + `BELT_CONTRACTS` gate + `start_block` + `azuki-chain1` test + `verify:belt-config` |
| R-11 | Seaport registration-path mismatch — import vs `indexer.onEvent` self-register | 1.5 | Reconcile the active path before relying on FR-6 |
| R-12 | Checksummed WETH mis-config — lookups compare lowercase → WETH sums to 0, priced-sale silently dropped | 1.5 | Store WETH + Azuki keys lowercased; WETH-fixture unit test |

## Open Blockers

| # | Blocker | Gates | Status |
|---|---------|-------|--------|
| OQ-1 | Watermark: reuse belt `sync_status` or ONE new read model? | **Sprint 4 Task 4.2 only** — NOT Sprint 1 | Resolve with belt-PRD owner before Sprint 4 |
| OQ-3 | Capacity envelope numbers at ~100 collections | Sprint 4 Task 4.3 spike | Open |
| OQ-5 | Is the S4 SALE adapter chain-scoped for mainnet Azuki? | Sprint 1.5 / Sprint 2 | **RESOLVED** (SDD): no new mainnet wiring inside S4; `map-evm` is per-collection, picks up Azuki rows for free once produced — S4 projection MUST be chainId-aware (R-9) |

## Appendix

### A. PRD Feature Mapping

FR-2→Sprint 1 · FR-6→Sprint 1.5 · FR-3→Sprint 2 · FR-4→Sprint 3 · FR-5/FR-1→Sprint 4.

### B. SDD Component Mapping

P1 Token read model (§3.2)→Sprint 1 · Seaport priced-sale decode (§5.5, §1.4/§1.5)→Sprint 1.5 ·
S5 `parity.ts` (§5.3)→Sprint 2 · S6 `emit.ts` (§5.4)→Sprint 3 · watermark (§3.6) + descriptor (§4.3)→Sprint 4.
