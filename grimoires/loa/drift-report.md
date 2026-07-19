# Three-Way Drift Report

> `/ride` 2026-07-19 · Code vs Legacy Docs vs Context
> Drift score: **72/100** (higher = healthier alignment). Critical items below.

## Summary

| Category | Count | Impact |
|----------|------:|--------|
| Hallucinated / conflicting | 2 | Critical |
| Ghost (documented, missing/weak in code) | 1 | High |
| Stale | 3 | High |
| Shadow (code exists, under-documented) | 4 | Medium |
| Missing (code, no docs) | 3 | Medium |
| Aligned | many | Healthy |

## Critical

### D-001 — Node.js version conflict `[RESOLVED 2026-07-19]`

| Source | Claim |
|--------|-------|
| `.cursor/rules/hyperindex.mdc` | Node.js v22+ (updated) |
| `package.json:69` | `"node": ">=22.0.0"` |
| `README.md` badge | Node 22+ |

**Verdict**: Aligned on 22+. GAP-001 closed.

### D-002 — Reality index mislabels active PRD `[STALE]`

| Source | Claim |
|--------|-------|
| `reality/index.md` (2026-07-06) | prd/sdd are belt zero-downtime planning |
| `prd.md` header (2026-07-07) | Canonical SoT = EVM Collection Onboarding Contract v1; belt PRD is sibling |

**Verdict**: Update reality hub (this ride).

### D-003 — Ponder vs Envio CI framing `[STALE/GHOST risk]`

| Source | Claim |
|--------|-------|
| Beads `bd-c7jv` | ponder-ci.yml claims production-gate over dead Ponder; Envio gates marked RETIRED |
| Live stack | `envio` 3.2.1, `config.yaml`, `src/EventHandlers.ts` |

**Verdict**: CI/docs naming likely ghosts live Envio path. Confirm workflows before trusting CI labels.

## High — verified claims

| ID | Claim | Status | Evidence |
|----|-------|--------|----------|
| C-01 | 6 EVM chain IDs in config | **VERIFIED** | `config.yaml` ids 1, 42161, 7777777, 10, 8453, 80094 |
| C-02 | 95 GraphQL entity types | **VERIFIED** | `schema.graphql` `^type ` count = 95 |
| C-03 | Green handler entry EventHandlers.ts | **VERIFIED** | `src/EventHandlers.ts:1-40`; config handler paths |
| C-04 | Token entity present | **VERIFIED** | `schema.graphql:350` |
| C-05 | TrackedTokenBalance handler | **VERIFIED** | `src/handlers/tracked-erc20.ts` |
| C-06 | Canonical NftActivity layer | **VERIFIED** | `src/canonical/{emit,map-evm,map-svm,parity}.ts` |
| C-07 | SQD SVM substrate modules | **VERIFIED** | `src/svm/sqd-*.ts` |
| C-08 | Kitchen service present | **VERIFIED** | `src/kitchen/*`, `Dockerfile.kitchen` |
| C-09 | Promote script present | **VERIFIED** | `scripts/promote.sh` |
| C-10 | SQD parallel loader (GATE-3 escape) | **VERIFIED** (restored 2026-07-19) | `src/svm/sqd-parallel-loader.ts` from `9c33df84`; tests 13/13; GAP-002 closed |
| C-11 | Warehouse two-lane ADR accepted | **CLAIMED: context ADR** | `context/2026-07-05-warehouse-supply-lane-adr.md` |
| C-12 | Lake decision GO on SQD | **CLAIMED: context** | `context/2026-07-06-lake-decision-record.md` |

## Shadows (code under-documented in root README)

1. `src/self/` ACVP / sonar-self CLI (`package.json` scripts `self*`)
2. `src/sense/` sense CLI/domain
3. `src/canonical/` NftActivity parity contract (documented in PRD more than README)
4. Multi-Dockerfile surface (belt, erpc, gateway, kitchen, svm-webhook)

## Ghosts / weak

1. Cursor HyperIndex rule Node v20 — contradicts engines (see D-001)
2. Any remaining "Ponder production" language in CI — treat as ghost until verified

## Aligned (healthy)

- Self-hosted Envio belt + Hasura + gateway alias narrative (README ↔ Dockerfiles ↔ promote.sh)
- Generic TrackedErc721 / collectionKey onboarding pattern
- Effect Schema usage in canonical layer matches PRD encoding doctrine

## Recommended next actions

1. ~~Fix Node version rule~~ — done (GAP-001)
2. ~~Confirm parallel loader~~ — restored (GAP-002)
3. Triage `bd-c7jv` CI inversion with workflow evidence (GAP-004)
4. Clarify NftActivity persistence model (GAP-005)
