# Consistency Report

> `/ride` 2026-07-19 · Pattern analysis (flag only — no renames)

## Consistency score: **7.5 / 10**

Strong domain patterns in handlers + schema; some dual naming from Envio port / belt eras.

## Naming patterns

| Domain | Pattern | Examples | Consistency |
|--------|---------|----------|-------------|
| Handlers | `src/handlers/<domain>.ts` kebab | `tracked-erc721.ts`, `henlo-vault.ts` | High |
| Entities | PascalCase GraphQL types | `TrackedHolder`, `Token`, `Action` | High |
| Collection keys | string `collectionKey` / `collection` | Tracked* vs HoneyJar-family Token | Medium — dual vocab |
| Belt entry | `EventHandlers.ts` vs `EventHandlers.mibera.ts` | Green vs scoped | Intentional |
| SVM modules | `sqd-*`, `*-loader.ts` | `sqd-client.ts`, `warehouse-loader.ts` | High |
| Scripts | verb-noun / gate names | `promote.sh`, `run-sqd-45-gate.ts` | High |
| Tests | `*.test.ts` under `test/` | 500+ files | High |
| Docker | `Dockerfile.<service>` | belt, gateway, kitchen, erpc, svm-webhook | High |

## Organization

```
src/
  EventHandlers.ts     # green belt side-effect import hub
  handlers/            # Envio event handlers (autoload + explicit)
  belts/mibera/        # scoped blue/mibera config entry
  canonical/           # NftActivity map/emit/parity (Effect)
  svm/                 # Solana deep history + live tail
  kitchen/             # HTTP collection ordering
  self/ · sense/       # operator CLIs / ACVP
  evm/ · labels/ · lib/
```

## Conflicts / improvement opportunities

| ID | Issue | Breaking? | Recommendation |
|----|-------|-----------|----------------|
| N-01 | `collection` vs `collectionKey` field names across entities | Yes if unified naively | Document mapping; don't mass-rename |
| N-02 | Some schema types still use `@entity` decorator | No (Envio accepts) | Align with Envio style guide over time |
| N-03 | Package name `envio-indexer` vs product `freeside-sonar` / config `thj-indexer` | No | Triple alias is tribal — document in reality |
| N-04 | `@types/node@20` with `engines.node>=22` | No | Bump types when convenient |
| N-05 | Cursor rule Node 20 vs engines 22 | Tooling confusion | Fix rule (see drift D-001) |

## Breaking-change flags (do not implement in ride)

- Renaming GraphQL entities (`Action`, `TrackedHolder`, etc.) — consumer blast radius
- Collapsing green/mibera entry files — deploy surface
- Merging SVM warehouse + SQD naming without contract tests
