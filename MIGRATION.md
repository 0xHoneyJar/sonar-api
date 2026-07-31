# Railway → Envio Cloud

Status: **prepared, not started.** Railway is still the live belt and nothing
here has been executed. This is the plan and the file list, so the cutover is
mechanical when you decide to do it.

## Why

`KF-020` set the provider order: (1) self-hosted indexer against a free data
lake, (2) metered reads only as a fallback, (3) **managed hosting once
self-host ops cost more than the fee**. Rung 3 is what fired. From 2026-07-31
alone: a `ca-certificates` line removed from `Dockerfile.belt` took all six
chains down with TLS failures; Hasura metadata desynced and does not self-heal
on resume; the re-index needs the KF-013 `ENVIO_RESTART` dance; a sidecar
service was still pointing at a config deleted three days earlier; ten Railway
services to reason about. None of that is indexing work.

## What the repo already satisfies

| requirement | status |
|---|---|
| `package.json` at root with envio pinned | ✅ `"envio": "3.2.1"` |
| config file | ✅ `config.yaml` (generated — never hand-edit) |
| schema | ✅ `schema.graphql` |
| handlers | ✅ `src/`, registered via `src/EventHandlers.ts` |
| no build-time host coupling | ✅ `postinstall`/`prepare` hooks removed |

Nothing structural needs to change to deploy.

## Steps

**1. Connect (dashboard — needs you).** Log into the Envio app with GitHub,
install the *Envio Deployments* GitHub App, grant it this repo. There is no CLI
deploy in envio 3.2.1 — `envio` has `dev`/`start`/`codegen`/`local`, not
`deploy`.

**2. Configure.** Root directory `/`, config file `config.yaml`, and pick a
deployment branch. Using `main` means every merge redeploys; a dedicated
`deploy` branch gives you a manual gate. Recommend the latter while migrating.

**3. Push the deployment branch.** Envio builds and starts a full sync from
each chain's `start_block`. This takes as long as the Railway backfill does —
plan for hours, and expect Ethereum and Arbitrum to be the long poles.

**4. Wait for parity before cutting over.** Compare against Railway:

```bash
# both endpoints, same query — they should converge
curl -s -X POST <ENDPOINT>/v1/graphql -H 'content-type: application/json' \
  -d '{"query":"{ chain_metadata { chain_id latest_processed_block } }"}'
```

Also run the contract guard against the new endpoint before pointing anything
at it:

```bash
BELT_GATEWAY_ENDPOINT=<new>/v1/graphql node scripts/verify-belt-contract.mjs
```

**5. Swap the consumer.** score-api reads `INDEXER_GRAPHQL_URL`
(`src/bronze/belt-gateway-source.ts:70`, with a hardcoded default fallback).
Set it in the Trigger.dev production env to the Envio Cloud endpoint. Confirm
the default fallback is not silently used anywhere before you rely on it.

**6. Then, and only then, strip Railway.** One commit:

```
Dockerfile.belt        Dockerfile.gateway     Caddyfile
.railwayignore         .dockerignore
```

plus the `## Deployment` table in `ARCHITECTURE.md` and the `.env.example`
entries for `BELT_CONFIG` / `ENVIO_RESTART` (both are Dockerfile concepts that
Envio Cloud replaces).

**7. Tear down the services.** `belt-indexer-selfhost`, `belt-hasura-selfhost`,
`belt-gateway`, `Postgres-6J4w` — plus the four already dead or out of scope:
`kitchen-api`, `svm-webhook`, `svm-backfill-worker`, `belt-indexer-robinhood`
(see PARKED.md).

## Decide before step 3

- **Storage tier.** Envio Cloud dev plans auto-delete deployments over **20 GB**.
  Six chains from genesis is not obviously under that — Ethereum from 12,287,507
  and Arbitrum from 102,894,033. Confirm your tier, or the deployment can vanish
  mid-sync.
- **Endpoint stability.** Railway gave you an operator-owned alias
  (`sonar.0xhoneyjar.xyz`). Envio Cloud issues its own static production URL.
  If you want to keep the alias, plan a CNAME or keep a thin proxy — otherwise
  every consumer hardcodes a vendor URL, which is the control point KF-020
  originally called out.
- **Re-index cost per change.** On Railway a schema change costs you sync time
  on hardware you already pay for. On a metered plan it may cost more. This is
  the one KF-020 tradeoff that does *not* go away.

## Rollback

Until step 6, rollback is: leave `INDEXER_GRAPHQL_URL` pointed at Railway. The
Railway stack is untouched by any of the above, so there is no window where both
are broken.
