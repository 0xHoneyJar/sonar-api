# sonar-api architecture

**Runtime: Envio HyperIndex only.** The indexer runs on Railway as `belt-indexer-selfhost` (`Dockerfile.belt` → `pnpm envio start`).

**Kitchen HTTP (ordering-service):** `src/kitchen/` → Railway service **`kitchen-api`** (`Dockerfile.kitchen`).

- `GET/POST /v1/collections/{chain_id}/{contract_address}/*`
- Reads index status from belt Hasura GraphQL (`TrackedHolder`, `Token`)
- Ingest queue on belt Postgres (`kitchen_ingest_jobs`)
- Background ingest worker (`src/kitchen/ingest-worker.ts`) when `KITCHEN_WORKER_ENABLED=true`: patches `TrackedErc721` in belt config, polls until indexed
- Bearer auth via `SERVICE_TOKEN`

**Public GraphQL:** `belt-gateway` (Caddy) → `belt-hasura-selfhost` → `/v1/graphql`

**Do not deploy or reference `ponder-runtime/`** — it was removed. Agents: if you see Ponder in old grimoires, treat it as historical.
