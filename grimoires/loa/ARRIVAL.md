# ARRIVAL — You are here

> **Read this first. Then stop expanding context until a task forces it.**
> Compressed 2026-07-19 for future agents. Erasure over accretion.
> Reconstructibility target: from this file alone, you can act without drowning.

## What this repo is (one breath)

**freeside-sonar** — self-hosted **Envio HyperIndex 3.2.1** belt indexing **6 EVM chains + Solana**, served over Hasura/GraphQL behind a gateway. Package name `envio-indexer`. Config name `thj-indexer`. Product name freeside-sonar. Three names, one runtime.

```
CODE  >  reality/  >  planning prd/sdd  >  legacy docs / NOTES sludge
```

Nothing below overrides `src/`, `config.yaml`, `schema.graphql`, `package.json`.

> **Note:** `prd.md` / `sdd.md` are digest-sealed by `promotion-receipt.sonar-score-v1.json`. Do not add banners there — this file is the door.

## Load order (max 4 files before coding)

| # | If you need… | Load |
|---|--------------|------|
| 1 | Orientation | **this file** |
| 2 | Code map | `reality/index.md` → one spoke only |
| 3 | **Planning / implement a feature** | `prd.md` + `sdd.md` (active on main: Sonar→Score truth contract) |
| 4 | **What the code actually is today** | `reality/as-built-prd.md` + `reality/as-built-sdd.md` |

Optional fifth (ops scars only): `INDEX.md` → jump to one `KF-NNN` **Reading guide** — never the whole `known-failures.md`.

## Closed questions (do not re-open)

| Question | Answer | Evidence |
|----------|--------|----------|
| Ponder or Envio? | **Envio.** `ponder-runtime/` gone. No `ponder-ci.yml`. Live CI gate = `belt-build.yml`. | `.github/workflows/belt-build.yml:1-14` |
| Node 20 or 22? | **≥22** | `package.json` engines; `.cursor/rules/hyperindex.mdc` |
| Is `NftActivity` a GraphQL entity? | **No.** Package DTO from `@0xhoneyjar/events`, mapped in `src/canonical/`. PG ownership surface includes `Token` (`schema.graphql:350`). | `src/canonical/map-evm.ts` |
| Which PRD? | **Feature work → `prd.md`/`sdd.md` on this branch tip (main: Sonar→Score truth contract).** Named siblings (`prd-belt-zero-downtime.md`, onboarding drafts) are parallel tracks. Code snapshot → `reality/as-built-*.md`. | `prd.md` header |
| Semver tags? | **None by design here.** Identity = git SHA + Railway deploy, not `v*`. | `git tag` empty; governance-report |
| SQD parallel loader? | **Present** (`src/svm/sqd-parallel-loader.ts`). Tests: `pnpm test:sqd-parallel`. Run: `pnpm sqd:parallel -- --collection <key> --from-slot 0 --concurrency 20`. Restored from `9c33df84`. | GAP-002 closed |

## Alias card (erase naming thrash)

| Name | Where | Means |
|------|-------|-------|
| freeside-sonar | README / product | Human name |
| thj-indexer | `config.yaml` `name:` | Envio project name |
| envio-indexer | `package.json` `name` | npm package |
| green belt | `config.yaml` + `src/EventHandlers.ts` | Live multi-chain indexer |
| Kitchen | `src/kitchen/` | HTTP collection onboarding |
| promote | `scripts/promote.sh` | Swap `BELT_UPSTREAM` after gate |
| sqd:parallel | `package.json` script | GATE-3 range-partitioned SVM backfill CLI |

## DO NOT READ (unless the task names them)

These are high-token, low-signal for cold start:

- `NOTES.md` body below the top **ARRIVAL** banner — operator ledger, not agent briefing (archive holds history)
- Full `known-failures.md` (1029 lines) — use `INDEX.md` → one KF
- `grimoires/loa/tracks/*`, `proposals/*`, old `a2a/sprint-*` — unless bead/PR points there
- Root `docs/**` runbooks — unless you are doing that named cutover
- Entire `test/` tree — run the named gate (`pnpm test`, `test:gate`) instead of browsing

## Chains (memorize once)

`1 · 10 · 8453 · 42161 · 7777777 · 80094` + SVM (SQD / warehouse / Helius). From `config.yaml`.

## If you feel lost

You are adding branches. Stop. Re-read the **Closed questions** table. Open one code file. Do not open a second planning doc until the first has a `file:line` answer.
