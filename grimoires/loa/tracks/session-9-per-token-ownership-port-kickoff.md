---
session: 9
date: 2026-06-07
type: kickoff
status: planned
cycle: sonar-belt-factory
stakes: data-validity (HIGH)
---

# Session 9 — Per-token ownership port (kickoff)

## Scope
- Finish the Envio→Ponder migration's last structural gap: add the 721 per-token `token` ownership entity + handlers to green so `inventory-api`/the Stash can cut off the frozen blue belt.
- Net-new handlers the brief missed: `TrackedErc721Bera` (Tarot + Fractures) + `GeneralMints` secondary-transfer/burn fix (MST + GIF). Only Mibera was ledgered.
- `chain_metadata` freshness equivalent (green has none), operator-gated genesis reindex, inventory repoint, cutover + retire blue/green-v1/v2 + rotate `SONAR_SIGNING_SEED_HEX`.

## Artifacts
- Build doc (source of truth): `grimoires/loa/specs/enhance-per-token-ownership-port.md`
- Arch/context brief (HARDEN-corrected header): `grimoires/loa/context/per-token-ownership-port-brief.md`
- Beads (sonar-belt-factory cycle): `bd-jyn` S1a · `bd-1jg` S1b · `bd-d2b` S1c · `bd-3nh` S2 · `bd-gpc` S3-pre · `bd-r90` S3 (gated) · `bd-rr0` S4 · `bd-4kf` S5 · `bd-ok3` candies-count stopgap (optional)

## Prior session
Shipped the full sovereign-metadata migration (5 collections live), Mibera #7702 fix, the Stash (images + ownership), S4b (Berachain Alchemy killed), candies 1155 code (#68/#17). The belt forensics revealed inventory still reads frozen blue + green lacks per-token-721 ownership — this kickoff closes that.

## Decisions made
- Reindex stays (projection path was 1155-counts, not 721-ownership; grounded).
- S1 split into 3 handler tasks (Mibera/Tarot+Fractures/MST+GIF) after grounding found 2 of 3 handler groups missing or mint-only.
- Reindex (`bd-r90`) blocked behind all handler work + the genesis-boundary verify (`bd-gpc`); operator-led per ADR-010.
- Run via `code-implement-and-review` / `/run sprint` in `sonar-belt-factory`; HIGH-stakes → cheval multimodal council review cadence (single-model forbidden).

## Open operator decisions
1. Ship `bd-ok3` candies-count stopgap now, or wait for proper per-token cards?
2. `bd-gpc` result may force a true-genesis (not boundary-forward) reindex.
3. Reindex + cutover + `SONAR_SIGNING_SEED_HEX` rotation are operator-led (ADR-010).
