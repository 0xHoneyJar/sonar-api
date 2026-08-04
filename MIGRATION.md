# Railway → Envio Cloud

Status: **repo side done, deployment not yet created.**

The five Railway files are deleted, so this repo can no longer build the
self-hosted stack. The Railway services are still *running* — deleting source
files does not stop a container that is already up — and score-api still reads
them. So there is a live belt, and no way to rebuild it from this tree.

That is deliberate. There are no users, the deployment is the point of the
migration, and `git revert <the deletion commit>` brings every file back if
Envio Cloud does not work out.

## Why

`KF-020` set the provider order: (1) self-hosted indexer against a free data
lake, (2) metered reads only as a fallback, (3) **managed hosting once
self-host ops cost more than the fee**. Rung 3 fired. From 2026-07-31 alone: a
`ca-certificates` line removed from `Dockerfile.belt` took all six chains down
with TLS failures; Hasura metadata desynced and did not self-heal on resume; the
re-index needed the KF-013 `ENVIO_RESTART` dance; a sidecar service was still
pointing at a config deleted three days earlier; ten Railway services to reason
about. None of that is indexing work.

## What the repo satisfies

| requirement | status |
|---|---|
| `package.json` at root with envio pinned | ✅ `"envio": "3.2.1"` |
| config file | ✅ `config.yaml` (generated — never hand-edit) |
| schema | ✅ `schema.graphql` |
| handlers | ✅ `src/`, registered via `src/EventHandlers.ts` |
| no build-time host coupling | ✅ no `postinstall`/`prepare`, no Dockerfile |

Nothing structural needs to change to deploy.

## Steps

**1. Connect (dashboard — needs you).** Log into the Envio app with GitHub,
install the *Envio Deployments* GitHub App, grant it this repo. There is no CLI
deploy in envio 3.2.1 — `envio` has `dev`/`start`/`codegen`/`local`, not
`deploy`.

**2. Configure.** Root directory `/`, config file `config.yaml`, and pick a
deployment branch. `main` means every merge redeploys; a dedicated `deploy`
branch gives a manual gate. Recommend the latter while migrating.

**3. Push the deployment branch.** Envio builds and starts a full sync from each
chain's `start_block`. Hours — Ethereum (12,287,507) and Arbitrum (102,894,033)
are the long poles.

**4. Verify before pointing anything at it.**

```bash
curl -s -X POST <NEW_ENDPOINT>/v1/graphql -H 'content-type: application/json' \
  -d '{"query":"{ chain_metadata { chain_id latest_processed_block } }"}'

BELT_GATEWAY_ENDPOINT=<NEW_ENDPOINT>/v1/graphql node scripts/verify-belt-contract.mjs
```

Railway is still up, so the two are comparable until you tear it down.

**5. Swap the consumer.** score-api reads `INDEXER_GRAPHQL_URL`
(`src/bronze/belt-gateway-source.ts:70`, with a hardcoded default fallback). Set
it in the Trigger.dev production env. Confirm the default fallback is not
silently used anywhere before relying on it.

**6. Repoint the guard.** `scripts/belt-contract.json` still carries the Railway
URL as its default endpoint, and `.github/workflows/belt-contract-guard.yml`
hits it daily. Once Railway is gone that guard exits 2 — a warning, not a
failure, by design — so it goes quiet rather than loud. Update the `endpoint`
field or the drift alarm is dark.

**7. Tear down the services.** `belt-indexer-selfhost`, `belt-hasura-selfhost`,
`belt-gateway`, `Postgres-6J4w` — plus the four already dead or out of scope:
`kitchen-api`, `svm-webhook`, `svm-backfill-worker`, `belt-indexer-robinhood`
(see PARKED.md).

## Decide before step 3

- **Storage tier.** Envio Cloud dev plans auto-delete deployments over **20 GB**.
  Six chains from genesis is not obviously under that — Railway was provisioned
  at 60 G. Confirm the tier, or the deployment can vanish mid-sync.
- **Endpoint stability.** Railway gave you an operator-owned alias
  (`sonar.0xhoneyjar.xyz`). Envio Cloud issues its own URL. Keeping the alias as
  a CNAME preserves the control point KF-020 called out; otherwise every consumer
  hardcodes a vendor URL.
- **Re-index cost per change.** Self-hosted, a schema change cost sync time on
  hardware already paid for. Metered, it may cost more. The one KF-020 tradeoff
  that does not go away.

## Rollback

`git revert` the commit that deleted `Dockerfile.belt`, `Dockerfile.gateway`,
`Caddyfile`, `.railwayignore`, and `.dockerignore`. The Railway services
themselves are untouched until step 7, so until then rollback is also just
leaving `INDEXER_GRAPHQL_URL` where it is.
