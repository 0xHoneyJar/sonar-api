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
> **Traces**: `grimoires/loa/prd.md` (FR-1..FR-5), `grimoires/loa/sdd.md` (§8 Development Phases).
> **Phase**: `/sprint-plan` → feeds `/run sprint-plan`.

## Executive Summary

Onboard EVM collections against ONE versioned contract instead of reverse-engineering the per-collection
`Action`-overlay grammar. Two planes (SDD §1.1): **P1** = the `Token` ownership read model (the FR-2 build,
unblocks inventory-api#27) and **P2** = the already-built-inert canonical `NftActivity` stream (adopted via
the S5/S6 handshake). **This autonomous run implements Sprint 1 only** — the schema `@index` change, codegen,
tests, and a committed reindex runbook. FR-3/FR-4 (S5 parity, S6 go-live) are cross-building and
operator-gated; FR-5 (onboarding doc + watermark) is partly blocked on OQ-1.

## Sprint Overview

| Sprint | Theme | FR | Autonomy | This run? |
|--------|-------|----|----------|-----------|
| 1 | Token ownership index | FR-2 | AGENT-IMPLEMENTABLE (prod reindex operator-gated) | **YES** |
| 2 | S5 consumer-parity handshake | FR-3 | adapter/harness agent-implementable; decision operator-paired | No |
| 3 | S6 go-live + gate flip | FR-4 | OPERATOR-GATED (live secrets, prod backfill) | No |
| 4 (Final) | Onboarding contract + FR-1 designation | FR-5/FR-1 | docs agent-implementable; FR-5b BLOCKED on OQ-1 | No |

> **Sequencing rationale** (SDD §8): FR-2 is independent, urgent, unblocks a shipped consumer → first.
> FR-3/FR-4 need the score-mibera consumer + real data + live secrets → operator-paired, follow.
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
  bigint→string + logIndex; **join `MintActivity × MiberaTransfer`**, never generic `Transfer`).
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

## Open Blockers

| # | Blocker | Gates | Status |
|---|---------|-------|--------|
| OQ-1 | Watermark: reuse belt `sync_status` or ONE new read model? | **Sprint 4 Task 4.2 only** — NOT Sprint 1 | Resolve with belt-PRD owner before Sprint 4 |
| OQ-3 | Capacity envelope numbers at ~100 collections | Sprint 4 Task 4.3 spike | Open |

## Appendix

### A. PRD Feature Mapping

FR-2→Sprint 1 · FR-3→Sprint 2 · FR-4→Sprint 3 · FR-5/FR-1→Sprint 4.

### B. SDD Component Mapping

P1 Token read model (§3.2)→Sprint 1 · S5 `parity.ts` (§5.3)→Sprint 2 · S6 `emit.ts` (§5.4)→Sprint 3 ·
watermark (§3.6) + descriptor (§4.3)→Sprint 4.
