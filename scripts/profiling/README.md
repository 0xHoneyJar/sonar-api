# Mission 1 profiling helpers

Read-only samplers from the Codex indexing-time-compression research.

| Script | Use when |
|--------|----------|
| `sample-progress-graphql.sh` | No DB URL; hits public/Hasura GraphQL (`BELT_GRAPHQL_URL`) |
| `sample-progress.sh` | Direct `DATABASE_URL` to active Belt Postgres |
| `postgres-observability.sql` | `psql` WAL / wait / size snapshot |
| `hash-ownership.sh` / `isomorphism-checks.sql` | Golden ownership checks |

**Never** set `ENVIO_RESTART` from these scripts. Prefer GraphQL sampling against the live gateway for production observation.

Example (3 minutes):

```bash
mkdir -p .run/evidence
INTERVAL_SECONDS=10 SAMPLES=18 \
  bash scripts/profiling/sample-progress-graphql.sh \
  > .run/evidence/mission-01-progress.ndjson
```
