# Entry Points

> Ride 2026-07-19

## Primary

| Entry | Command / path | Notes |
|-------|----------------|-------|
| Indexer | `pnpm start` → `envio start` | Needs codegen + config.yaml |
| Dev | `pnpm dev` / `TUI_OFF=true pnpm dev` | Local HyperIndex |
| Codegen | `pnpm codegen` | After schema/config change |
| Tests | `pnpm test` | Vitest |

## Deploy images

| Dockerfile | Service |
|------------|---------|
| Dockerfile.belt | Envio indexer (NODE_OPTIONS=12288 default) |
| Dockerfile.gateway | Caddy consumer alias |
| Dockerfile.kitchen | Collection ordering API |
| Dockerfile.erpc | RPC proxy |
| Dockerfile.svm-webhook | SVM webhook path |

## Notable env vars (from code scan)

`ENVIO_*`, `BELT_UPSTREAM`, `DATABASE_URL` / `ENVIO_PG_*`, `HASURA_*`, `HYPERSYNC`/`ENVIO_API_TOKEN`, `SQD_*`, `HELIUS_*`, `SERVICE_TOKEN`, `NODE_OPTIONS`, `EXPECTED_CHAINS`, `PROMOTION_MODE`, `GOLDEN_SAMPLES`

Full dump: `reality/env-vars.txt`.

## Runtime constraints

- **[GROUNDED]** Node `>=22.0.0` (`package.json`)
- **[GROUNDED]** pnpm packageManager pinned
- **[DISPUTED]** Cursor HyperIndex rule still says Node v20 — see drift D-001
