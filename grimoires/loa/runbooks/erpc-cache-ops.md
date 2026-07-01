# Runbook — eRPC cache volume (#73)

## Problem

Finalized cache policy uses `ttl: 0` (intentional — preserves deep-genesis re-sync speedup). Volume can hit 100%, taking the `Postgres` cache service offline and breaking all cache writes.

## Durable fix (do not add blanket finalized TTL)

1. Keep working baseline volume (100 GB after 2026-06-15 stopgap).
2. **Alarm at ~75% disk** on Railway `Postgres` (eRPC cache) service.
3. **Prune decommissioned chains only** via [`scripts/erpc-cache-prune.sql`](../../scripts/erpc-cache-prune.sql) + `VACUUM`.
4. Revert `logLevel: info` → `warn` in [`erpc.yaml`](../../erpc.yaml) after steady-state re-measure.

## Related

- Issue #73 — eRPC finalized cache unbounded
- Issue #71 — Railway cleanup (pair volume + service retirement)
- Issue #72 — getLogs-liar upstream hardening
