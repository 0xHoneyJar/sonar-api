# API Surface

> Ride 2026-07-19 · budget <2000 tokens

## Package scripts `[GROUNDED: package.json:5-30]`

| Script | Purpose |
|--------|---------|
| `codegen` / `dev` / `start` | Envio codegen / dev / start |
| `test` / `test:hasura` / `test:gate` | Vitest suite + Hasura contract + SQD §4.5 gate |
| `verify:belt-*` / `verify:svm-contract` / `verify:action-contract` | Contract guards |
| `validate:*-canonical` / `validate:evm-sales` | Live canonical validators |
| `s5:parity-dryrun` | Canonical parity dry-run |
| `self` / `self:check` / `self:write` | sonar-self CLI (ACVP) |
| `pulse` / `cost` | Ops pulse + Railway cost model |
| `codegen:mibera` / `typecheck:mibera` | Scoped mibera belt |

## Indexer handlers

- **[GROUNDED]** Green hub: `src/EventHandlers.ts` side-effect imports all `src/handlers/*`
- **[GROUNDED]** Per-contract `handler: src/EventHandlers.ts` in `config.yaml`
- **[GROUNDED]** Handlers self-register via Envio `indexer.onEvent` (Envio 3.2.1 pattern)

## Kitchen HTTP (Hono)

- **[GROUNDED]** Modules: `src/kitchen/{auth,config-patcher,ingest-worker,hasura-status-reader,...}.ts`
- **[GROUNDED]** Image: `Dockerfile.kitchen`
- **[INFERRED]** Routes match README `/v1/collections/...` status + ingest

## GraphQL (Hasura)

- **[GROUNDED]** Entity schema in `schema.graphql` (95 types) → Postgres → Hasura
- **[GROUNDED]** Consumer alias documented as `sonar.0xhoneyjar.xyz/v1/graphql`

## Ops CLIs / scripts

| Path | Role |
|------|------|
| `scripts/promote.sh` | Blue/green BELT_UPSTREAM flip (gate precondition) |
| `scripts/run-sqd-45-gate.ts` | SQD §4.5 gate runner |
| `src/self/cli/sonar-self.ts` | Self/ACVP emit/check/write |
| `src/sense/cli/*` | Sense CLI |

## Canonical library API (not HTTP)

- `mapEvm*` / `mapSvm*` → `NftActivity` (`src/canonical/map-*.ts`)
- `activityParityKey` / parity compare (`src/canonical/parity.ts`)
- `emit` helpers (`src/canonical/emit.ts`)
