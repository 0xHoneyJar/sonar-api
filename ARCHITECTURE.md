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
- The background ingest worker requires `KITCHEN_WORKER_ENABLED=true` and an
  explicit preparation port. `local_config` is the hermetic non-production seam.
  Production uses `KITCHEN_PREPARATION_PORT=belt_config_batch` with a drain
  strategy (`KITCHEN_BELT_CONFIG_PATH`, `KITCHEN_BELT_CONFIG_PATCH_WEBHOOK`, or
  `KITCHEN_PREPARATION_DRAIN=external_scale`). The worker claims a batch and
  materializes it once (single config rewrite / webhook / restart). Operators
  may also `POST /v2/collection-preparations/batch` (1–50 items) so admission
  is one round-trip. `/health` remains process liveness; `/ready` follows drain
  availability so jobs are never accepted into an immortal queue. Ethereum uses
  `EthTrackedErc721`; other supported EVM networks use `TrackedErc721`. ERC-1155
  and Solana preparation fail typed without mutation.
- Bearer auth via `SERVICE_TOKEN`

**Public GraphQL:** `belt-gateway` (Caddy) → `belt-hasura-selfhost` → `/v1/graphql`

**Do not deploy or reference `ponder-runtime/`** — it was removed. Agents: if you see Ponder in old grimoires, treat it as historical.
