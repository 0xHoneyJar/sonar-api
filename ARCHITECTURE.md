# sonar-api architecture

**Runtime: Envio HyperIndex only.** The indexer runs on Railway as `belt-indexer-selfhost` (`Dockerfile.belt` → `pnpm envio start`).

**Kitchen HTTP (ordering-service):** `src/kitchen/` → Railway service **`kitchen-api`** (`Dockerfile.kitchen`).

- `GET/POST /v1/collections/{chain_id}/{contract_address}/*`
- Reads index status from belt Hasura GraphQL (`TrackedHolder`, `Token`)
- Ingest queue on belt Postgres (`kitchen_ingest_jobs`)
- Canonical physical preparation jobs are keyed by shared `deployment_id` plus the
  operation-scoped `ownership_index.v1` capability version. Legacy EVM routes
  and `/v2/collection-preparations` join through one admission transaction;
  subscriber/order correlations are stored separately from physical work.
- The background ingest worker requires both `KITCHEN_WORKER_ENABLED=true` and
  the explicit `KITCHEN_PREPARATION_PORT=local_config` seam. This proves
  ERC-721 adapter selection and leasing hermetically, but is not a production
  config/deploy port. `/health` remains process liveness; production admission
  and `/ready` remain unavailable until a durable preparation drain port exists,
  so requests are not accepted into an immortal queue. Ethereum uses `EthTrackedErc721`; other supported EVM
  networks use `TrackedErc721`. ERC-1155 and Solana preparation fail typed
  without mutation.
- Bearer auth via `SERVICE_TOKEN`

**Public GraphQL:** `belt-gateway` (Caddy) → `belt-hasura-selfhost` → `/v1/graphql`

**Do not deploy or reference `ponder-runtime/`** — it was removed. Agents: if you see Ponder in old grimoires, treat it as historical.
