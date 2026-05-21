---
session: 3
date: 2026-05-20
type: kickoff
status: planned
---

# Session 3 — Mibera ecosystem sovereign indexer (kickoff)

## Scope
- Deploy + backfill the **Berachain ecosystem leg** (8-contract belt, committed `7408ceb`) → measure sync speed (experiment #1 metric) + re-track Hasura.
- Add **Base** (FriendtechShares, MiberaMaker333), **Optimism** (MiberaSets, MiberaZora1155, MirrorObservability, TrackedErc721-lore), **Ethereum** (MiladyCollection) legs — eRPC additive multi-chain + belt extension per chain.
- Validate all 4 chains (reconcile vs on-chain) → **ONE** score-api `ENVIO_GRAPHQL_URL` repoint → gateway.
- Log observations to the Hivemind Lab experiment charter throughout.

## Artifacts
- Build doc (source of truth): `grimoires/loa/specs/enhance-session-3-mibera-ecosystem-indexer.md`
- Experiment charter + obs log: `grimoires/loa/context/mibera-sovereign-indexer-experiment.md` (local)
- Coverage scope: `grimoires/loa/context/score-api-coverage-scope.md` (local)

## Prior session (Session 2)
Took it from broken `/backing` → DISS-003 eRPC findings A+B fixed → full belt→eRPC→Hasura→gateway stack
LIVE on Railway → `/backing` restored on honeyroad.xyz (PRD G1) → score-api scoped+designed → Berachain
ecosystem belt-leg built+verified (`7408ceb`).

## Decisions made (locked)
- Single multi-chain indexer = **extend the Mibera belt** (one Hasura/endpoint), NOT belts+federation (defer).
- Scope = 4 chains / ~13 contracts (Zerker-confirmed); Arb+Zora dropped.
- **eRPC from start (zero flicks)**; bounded HyperSync = per-chain escape hatch only.
- **All 4 chains → validate → ONE repoint** (no incremental).
- Paid RPC = HyperRPC, last resort (left Alchemy+QuickNode).
- Experiment frame (Hivemind Lab): resolve sovereign viability + **sync speed** + cost envelope per chain.
- Tests + prod-promotion rigor = before the repoint (deferred).
