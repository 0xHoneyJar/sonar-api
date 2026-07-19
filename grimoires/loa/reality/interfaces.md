# External Interfaces

> Ride 2026-07-19

## Data lakes / RPC

| System | Role in code | Evidence |
|--------|--------------|----------|
| Envio HyperSync | EVM sync acceleration | Envio runtime + `ENVIO_API_TOKEN` ops notes |
| Chain RPCs / eRPC | Logs / fallback | `Dockerfile.erpc`, Part-4 gate notes in NOTES |
| SQD Portal | SVM genesis→head stream | `src/svm/sqd-client.ts`, `sqd-loader.ts` |
| Dune warehouse | SVM history supply lane | `src/svm/warehouse-loader.ts`, `src/svm/sql/` |
| Helius | SVM live tail / meter | `src/svm/helius-meter.ts`, webhook Dockerfile |

## Serving / platform

| System | Role | Evidence |
|--------|------|----------|
| Postgres | Indexer store | ENVIO_PG_* / pg client |
| Hasura | GraphQL API | cutover scripts, kitchen status reader |
| Caddy gateway | Alias + rate limit | `Dockerfile.gateway` |
| Railway | Hosting | cost model script, Dockerfiles |
| NATS | Events pillar (optional) | `nats` dep; prune/reconcile scripts |

## Contracts / packages

| Interface | Package / pin | Evidence |
|-----------|---------------|----------|
| NftActivity schema | `@0xhoneyjar/events` SHA pin | `package.json` cluster.eventsPin |
| Envio generated types | `generated` optionalDep | package.json |

## Auth surfaces

- Kitchen: bearer `SERVICE_TOKEN` (README)
- Hasura: admin secret (ops; not in app defaults)
- Gateway: public reads documented; write paths token-gated
