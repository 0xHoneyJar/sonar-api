---
session: 1
date: 2026-05-19
type: kickoff
status: planned
---

# Session 1 — Indexer Belt Rebuild (kickoff)

## Scope

- Rebuild the dead Envio hosted indexer as **self-hosted, per-belt HyperIndex deployments** on Railway.
- Decompose the monolith into **4 belts**: Mibera · HoneyJar · Purupuru · Sprawl. One repo / one building / per-belt config files / per-belt Railway services.
- **Deployment #1 = the fire fix**: `MiberaLiquidBacking` + `MiberaCollection` on Berachain — recovers mibera-honeyroad's `/backing` loan display. Target live before ~2026-05-27.
- Build construct: `construct-noether`.

## Artifacts

- Build doc: `grimoires/loa/specs/indexer-belt-rebuild.md` — source of truth (context, belt model, deployment #1 sequence, ARCH decisions, verify)

## Prior session

No prior indexer session — `NOTES.md` records only "Initial Loa framework setup." This kickoff originated in a **mibera-honeyroad** architecture session (2026-05-19) that diagnosed the Envio death, ran the on-chain loan diagnosis (CLEAR), and walked the belt decomposition with the operator. The stale `sprint.md` / cycle-048 is unrelated Loa-framework review-pipeline maintenance — not indexer work.

## Decisions made

- **4 belts**, decomposed by project (chain-agnostic). Belt = backend mental-model grouping by contract-ownership — NOT a consumption boundary; consumers compose across belts at the API layer.
- **One building, one repo, per-belt config files** (`config.<belt>.yaml`), shared `src/handlers/` + `schema.graphql`, one Railway service per belt config.
- **Self-host the existing HyperIndex** — the hosted service died, the code didn't. Not a rewrite.
- **Deployment #1 scoped thin** — 2 contracts (`MiberaLiquidBacking` + `MiberaCollection`). A belt's config grows; consumers never re-point.
- **~14 contracts archived** (Crayons, SFVault, Aquabera, FatBera, validator-infra-not-consumed-by-Mibera, Henlo, ApdaoAuctionHouse) — revive only if a breakage surfaces.
- `BgtToken` + `ValidatorWithdrawalModule` + `ValidatorDepositRouter` + `FriendtechShares` → Mibera belt (Mibera consumes them).
- The `puru-erc1155-fix-plan.md` folds into the Purupuru belt deployment — not deployment #1.
- **Two frozen-contract consumers** (confirmed 2026-05-19 vs Zerker's score-api intel): mibera-honeyroad (`/backing` loan routes) + score-api (`envio-client.ts`, 12 entities — type + field names exact). Rebuild preserves `schema.graphql` verbatim. `Action` is cross-belt; score-api's multi-belt composition is an open decision for when belts beyond Mibera ship — does NOT block deployment #1.

## Loan diagnosis (2026-05-19, on-chain)

VERDICT: CLEAR. 19 active loans, 0 imminent. Soonest expiry loan #134 due 2026-05-30 → ~10.5-day buffer. Concentration: 15/19 loans = one borrower; 6/24 cluster (#146–#155) matures within ~20 min.
