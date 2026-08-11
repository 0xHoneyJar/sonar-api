# Railway → Envio Hosted Service

Status: **in progress** (started 2026-08-11). Railway is still the live belt
until step 4 below passes; until then rollback is "do nothing" — nothing on
the Railway side is touched by steps 1–3.

Decisions already made (2026-08-11): consumers point **directly at the Envio
hosted URL** (no `sonar.0xhoneyjar.xyz` proxy survives the cutover); **paid
production tier**; deployment branch **`main`** (every merge deploys; Envio
keeps deployment versions with one-click rollback).

## Why

Self-host ops cost more than the fee (KF-020 rung 3): the KF-013
`ENVIO_RESTART` dance for every new contract, the ca-certificates TLS outage
of 2026-07-31, Hasura metadata desync that doesn't self-heal, and ~ten Railway
services to reason about. None of that is indexing work.

## What the repo already satisfies

| requirement | status |
|---|---|
| envio pinned at root | ✅ `"envio": "3.6.1"` (hosted requires ≥ 2.21.5) |
| config file | ✅ `config.yaml` at repo root (generated — never hand-edit) |
| schema + handlers | ✅ `schema.graphql`, `src/` via `src/EventHandlers.ts` |
| no build-time host coupling | ✅ no `postinstall`/`prepare` hooks |
| repo size | ✅ well under the 100 MB limit |

Nothing structural needs to change to deploy. Live chains: Robinhood (4663),
Base (8453), Berachain (80094).

## Step 1 — dashboard (zerker, ~10 minutes)

1. Log in at https://envio.dev/app/login with GitHub (the `0xHoneyJar` org).
2. Install the **Envio Deployments** GitHub App; grant it `0xHoneyJar/sonar-api`.
3. **Add Indexer** →
   - Config file path: `config.yaml`
   - Root directory: `/` (standalone repo)
   - Deployment branch: `main`
4. Plans & Billing tab → pick the **paid production tier**. The free dev plan
   soft-limits at 100k events / 5 GB / 7-day inactivity and hard-deletes at
   20 GB or 30 days of age — unusable for a score-api production dependency.
5. Environment Variables tab → nothing required. HyperSync access is bundled
   with hosting; `ENVIO_API_TOKEN` stays a local-dev/CI concern only.
6. Push (or re-deliver) `main` and watch the sync in the dashboard.
7. Report back the deployment's GraphQL endpoint URL.

If the build fails on toolchain versions: hosted recommends Node 24 and pnpm
10.32.x; the repo pins Node 22 / `pnpm@10.11.0`. Bumping `.nvmrc`,
`engines.node`, and `packageManager` is the fix — don't pre-empt it.

## Step 2 — parity (before anything points at it)

```bash
# both endpoints, same query — they should converge per chain
curl -s -X POST <ENDPOINT>/v1/graphql -H 'content-type: application/json' \
  -d '{"query":"{ chain_metadata { chain_id latest_processed_block } }"}'

# contract guard against the new endpoint — must exit 0
BELT_GATEWAY_ENDPOINT=<new>/v1/graphql node scripts/verify-belt-contract.mjs

# score-api's silent-failure hazard: the Hasura input type name must survive
curl -s -X POST <new>/v1/graphql -H 'content-type: application/json' \
  -d '{"query":"{ __type(name: \"Action_bool_exp\") { name } }"}'
```

## Step 3 — repoint consumers

- `scripts/belt-contract.json` `endpoint` → the new URL (the daily
  `belt-contract-guard.yml` cron reads this default).
- score-api: `src/bronze/source.ts` `DEFAULT_INDEXER_URL` → the new URL, and
  set `INDEXER_GRAPHQL_URL` in the Trigger.dev **production** env. The env var
  falls back to the hardcoded default silently — change both.
- Smoke: one bronze pull returns rows from the new endpoint.

## Step 4 — strip the Railway era (one commit)

`git revert 357cdcaa` re-applies the prepared strip commit (`c540d2d8`):
deletes `Dockerfile.belt`, `Dockerfile.gateway`, `Caddyfile`,
`.railwayignore`, `.dockerignore`; fixes README / ARCHITECTURE / SECURITY /
`.env.example` / `belt-contract.json`. Then hand-fix what drifted since it was
written (chain count, contract counts, envio version). Delete this file.

## Step 5 — tear down Railway (zerker, destructive)

`belt-indexer-selfhost`, `belt-hasura-selfhost`, `belt-gateway`,
`Postgres-6J4w` — plus the four already dead or out of scope: `kitchen-api`,
`svm-webhook`, `svm-backfill-worker`, `belt-indexer-robinhood` (PARKED.md).
Recommended: scale to zero for a few days first, then delete.
