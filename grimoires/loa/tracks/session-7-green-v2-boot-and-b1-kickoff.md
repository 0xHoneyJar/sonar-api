---
session: 7
date: 2026-05-29
type: kickoff
status: planned
---

# Session 7 — green-v2 boot → B-1 green belt → app repoint (kickoff)

## Scope
- **Boot green-v2** (the fresh-green re-cutover) to take the 4 RLAI-confirmed gap handlers LIVE — frees Ruggy (NATS mints), Score (candies), cubquests (badges). This is the highest-value step: it's what actually live-unblocks them.
- **Port the 6 remaining green-belt B-1 groups** (G-apdao → C-moneycomb → E-henlo-vault → A-validator → F-set-and-forgetti → B-honeyjar + Arbitrum/Zora), each via `code-implement-and-review` + an RLAI parity-ledger row.
- **Repoint the live apps** off the dead hosted Envio (914708e) onto the sovereign belt-gateway; then retire blue.

## Artifacts
- Build doc: `specs/enhance-green-v2-boot-and-b1-greenbelt.md` (source of truth — sequences all 3)
- Boot runbook: `specs/green-v2-boot-spec.md` (the blue-green-v2 re-cutover, step-by-step + division of labor)
- green-belt B-1 doc: `specs/enhance-b1-and-global-flip.md`
- RLAI parity gate: `evals/sonar-migration/` (12 graded rows; the reusable rigor template)

## Prior session
Session 6 cut Mibera over to ponder (gateway → green, field-parity fixed). This session (the RLAI sweep) found + fixed 4 *silent* "registered-but-unsubscribed" gap handlers (GeneralMints/mint_event, BgtToken, CubBadges1155, CandiesMarket1155) + ported henlo + mirror — all committed to PR #49, FAGAN-approved, but NOT deployed (build_id forces a fresh boot).

## Decisions made
- **The boot is a blue-green-v2 re-cutover, not a hot-add** (build_id discipline) — stand up `belt-indexer-green-v2` on schema `ponder_v2`, import + cold-sync + validate, then repoint belt-hasura-green's tracked schema. green-v1 + blue stay HOT as failback.
- **Division of labor**: [operator] deploys green-v2 (Step 1 — has Railway access + secrets); [agent] drives import/backfill/validate (Steps 2-3); [operator+agent] the sacred repoint (Step 4).
- **The RLAI ledger is the B-1 parity gate** — every group port is graded against the live territory (probe → adversarial refute → ledger row), never trusted from the spec/diff. *The map is not the territory.*
- **Missed mints are NOT re-announced** — the backfill writes them to the table (queryable) but the `isLiveEvent` gate suppresses historical NATS emits. Only future mints announce.
- Appendix C of migration-A ("accept-frozen-only") was wrong for 4 of the 8 — corrected via the RLAI UPDATE.
