# Runbook — Railway service retirement (#71)

Target topology (post-Ponder cutover, Envio self-host canonical):

| Service | Role | Keep? |
|---------|------|-------|
| `erpc` | L2 RPC cache + hedge | **Yes** |
| `Postgres` | eRPC cache DB | **Yes** (monitor disk — #73) |
| `Postgres-*` (belt) | Envio belt DB | **Yes** |
| `belt-hasura-selfhost` | GraphQL | **Yes** |
| `belt-indexer-selfhost` | Envio HyperIndex | **Yes** |
| `belt-gateway` | Caddy public proxy | **Yes** |
| `kitchen-api` | ordering-service upstream | **Yes** |
| `svm-webhook` | Solana collection events | **Yes** |
| Ponder-era duplicates (`belt-indexer-green-v3`, `ponder-*`, extra Hasura) | Vestigial | **Retire** |

## Steps

1. Confirm traffic via `belt-gateway` + `kitchen-api` only (no Ponder endpoints).
2. Snapshot then decommission duplicate indexers / unused Postgres volumes.
3. Pair with eRPC cache alarm + prune runbook ([`erpc-cache-ops.md`](./erpc-cache-ops.md)).
4. Track ~$26/mo savings target from issue #71.
