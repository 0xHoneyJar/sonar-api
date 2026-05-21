# S2-T4 — Deploy the Mibera belt to Railway (operator runbook)

> Goal: stand up the Mibera belt (HyperIndex over eRPC) on Railway in the
> `freeside-sonar` project (`e240cdf0`), syncing `/backing` data to head, then
> re-verify completeness + AC-6 on the Railway IP. The local proof (S2-T3) +
> AC-6 reconciliation already passed; this is the production deploy of that.

## Topology (what gets created)

`freeside-sonar` already has: **eRPC service** + **eRPC cache Postgres** (S1).
This task adds **3 belt services** + redeploys eRPC with the Finding A+B fix:

```
            ┌────────────────────────── Railway project: freeside-sonar ──────────────────────────┐
            │                                                                                       │
  belt ─────┤  belt-indexer (this repo) ──ENVIO_PG_*──▶ belt-postgres ◀──DATABASE_URL── belt-hasura │──▶ public GraphQL
            │       │                                                         (graphql-engine v2.43)  │    (L4 endpoint;
            │       └──rpc: erpc.railway.internal:4000──▶ eRPC service ──▶ eRPC cache Postgres        │     S3 gateway fronts this)
            │                                              (REBUILD w/ fixed erpc.yaml)               │
            └───────────────────────────────────────────────────────────────────────────────────────┘
```

- **belt-postgres** — new Railway Postgres (the belt's OWN DB; separate from the eRPC cache PG per SDD §4.5).
- **belt-hasura** — `hasura/graphql-engine:v2.43.0`; serves the public GraphQL (port 8080). This is the endpoint consumers hit.
- **belt-indexer** — this repo (`0xHoneyJar/sonar-api`, branch `indexer-belt-rebuild`); runs `pnpm envio start --config config.mibera.yaml`; writes to belt-postgres, applies Hasura metadata to belt-hasura, pulls chain data from the eRPC service over Railway private networking.
- **eRPC service** — REBUILD so the Finding A+B fix (ignoreMethods + tenderly/sentio + rate-limit pacing) takes effect. `Dockerfile.erpc` bakes `erpc.yaml` in, so a rebuild from the branch with the fixed `erpc.yaml` is all that's needed.

## Step 0 — Branch / source

The fixed `erpc.yaml` + belt code are on **`indexer-belt-rebuild`** (pushed to `origin`).
Point every Railway service that builds from this repo at **`indexer-belt-rebuild`**
(or merge it to `main` first and build from `main` — operator's call). The eRPC
rebuild MUST come from the branch that has the fixed `erpc.yaml`.

## Step 1 — Redeploy eRPC with the fix (do FIRST — the belt needs it)

1. eRPC service → Settings → confirm Source = `0xHoneyJar/sonar-api` @ `indexer-belt-rebuild`, Dockerfile = `Dockerfile.erpc`.
2. Trigger **Redeploy** (Railway auto-builds on push if connected; else manual).
3. Verify after build: eRPC logs show all 6 upstreams (incl. `berachain-tenderly`, `berachain-sentio`) initialized; `/healthcheck` → `state: OK`.
   - Internal address (unchanged): `http://erpc.railway.internal:4000/main/evm/80094`.

## Step 2 — Create belt-postgres

- `+ New` → **Database → PostgreSQL**. Name it `belt-postgres`. (Default size is fine — "start small"; disk grows with indexed data + can scale later.)

## Step 3 — Create belt-hasura

- `+ New` → **Docker Image** → `hasura/graphql-engine:v2.43.0`. Name `belt-hasura`.
- Variables (see table). Networking → expose a public domain on **target port 8080** (for verification + later the S3 gateway upstream).

## Step 4 — Create belt-indexer

- `+ New` → **GitHub Repo** → `0xHoneyJar/sonar-api`, branch `indexer-belt-rebuild`. Name `belt-indexer`.
- Settings → **Dockerfile path:** `Dockerfile.belt` (controlled build; runs `envio codegen`, skips the repo-wide `tsc` build that DISS-002 breaks). No build/start command needed — the Dockerfile owns both.
  - (No public domain needed — it's an internal worker. It exposes a health/metrics port; an optional Railway healthcheck can target it.)
- Variables (see table).

## Env-var table (the deliverable)

### belt-hasura
| Var | Value |
|---|---|
| `HASURA_GRAPHQL_DATABASE_URL` | `${{belt-postgres.DATABASE_URL}}` (use the **private** URL if offered) |
| `HASURA_GRAPHQL_ADMIN_SECRET` | *(generate a strong secret — NOT "testing")* |
| `HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES` | `true` *(required — BigInt fields)* |
| `HASURA_GRAPHQL_UNAUTHORIZED_ROLE` | `public` *(lets consumers query without auth)* |
| `HASURA_GRAPHQL_ENABLE_CONSOLE` | `false` *(prod; `true` only while debugging)* |
| `PORT` | `8080` |

### belt-indexer
| Var | Value | Note |
|---|---|---|
| `ENVIO_PG_HOST` | `${{belt-postgres.PGHOST}}` | belt DB (private host) |
| `ENVIO_PG_PORT` | `${{belt-postgres.PGPORT}}` | usually 5432 |
| `ENVIO_PG_USER` | `${{belt-postgres.PGUSER}}` | |
| `ENVIO_PG_PASSWORD` | `${{belt-postgres.PGPASSWORD}}` | |
| `ENVIO_PG_DATABASE` | `${{belt-postgres.PGDATABASE}}` | |
| `ENVIO_PG_SSL_MODE` | `require` | ⚠️ watch-point — if the indexer can't connect over `railway.internal`, try `disable` (private net) or `prefer` |
| `TUI_OFF` | `true` | Ink TUI crashes non-TTY |
| `HASURA_GRAPHQL_ENDPOINT` | `http://belt-hasura.railway.internal:8080` | indexer applies metadata here |
| `HASURA_GRAPHQL_ADMIN_SECRET` | *(same secret as belt-hasura)* | |

- **No `ENVIO_API_TOKEN`** — sovereign RPC path; HyperSync is not used. (Ignore `.env.example`'s token line — obsolete for the belt.)
- The eRPC data-source URL is **already baked into `config.mibera.yaml`** (`http://erpc.railway.internal:4000/main/evm/80094`) — no env var needed.

## Step 5 — Cold sync + verify (this is S2-T5 on production)

1. belt-indexer logs: expect `Starting indexing!` then the synced block climbing from 3,837,808 toward head (~21.15M).
   - ⚠️ **Re-validate the rate-limit tuning here.** Local hit head in ~5 min at 25 req/s/upstream from a partly-burned IP; Railway's egress IP + cold cache will differ. Watch eRPC logs for sustained punitive 429s — if the sync stalls, lower the `rateLimiters` budgets in `erpc.yaml` (e.g. 15/s) and redeploy eRPC. The cache makes the *second* sync much faster.
2. Once synced to head, verify against belt-hasura (use its public URL + the admin secret):
   - `MiberaTransfer_aggregate.count` ≈ 39,714 · `MintActivity_aggregate.count` = 10,000 · earliest MiberaTransfer is a mint (`from=0x0`) near block 3,838,974.
   - **AC-6:** `MiberaLoanStats.totalActiveLoans` == on-chain `Treasury.backingLoanDetails` active set (= 19 at the 2026-05-19/20 reference). Re-run the reconciliation against the Railway endpoint (I can do this once the URL exists).

## Verification ABIs (use local — do NOT fetch)
- MiberaLiquidBacking = `Treasury` → `mibera-honeyroad/abis/treasury.ts` (`backingLoanId`, `backingLoanDetails(id)→loanedTo…`, `backingLoanedOut`; `backingLoanExpired` is a mutator, not a read — active = `loanedTo != 0x0`).
- Event ABIs → `thj-sonar/abis/*.json`.

## Watch-points (lead with what to doubt)
1. **ENVIO_PG_SSL_MODE** over `railway.internal` — most likely deploy snag. Try `require` → `disable` → `prefer`.
2. **Startup order** — indexer needs belt-hasura + belt-postgres up; it retries, but if it errors early, redeploy belt-indexer after the other two are healthy.
3. **eRPC rate-limit tuning** — the 25/s is a starting point; tune on the real Railway IP.
4. **Branch** — every service must build from the branch holding the fixed `erpc.yaml` + belt code.

## What actually happened (live S2-T4 run, 2026-05-20 — read before re-running)

Deployed via `railway` CLI with a **project token** (`RAILWAY_TOKEN`); browser-login was read-only.
Outcome: belt synced to head sovereignly, AC-6=19 on Railway, public GraphQL live. Gotchas hit:

1. **`Dockerfile.belt` MUST be `node:22`** (envio alpha.17 autoload uses `fs.promises.glob`; node:20 → runtime
   crash `Promises.glob is not a function`; build still passes on 20). Fixed + committed.
2. **eRPC deploy:** GitHub build failed ("couldn't locate Dockerfile.erpc in code archive"). Deployed with
   `railway up -s erpc -c` (local upload, respects the service's Dockerfile.erpc). Verify 6 upstreams in logs.
3. **`railway add -d postgres -s <name>`** ignores `-s` → DB got auto-named `Postgres-3vIC`. Reference it by
   its actual name (`${{Postgres-3vIC.DATABASE_URL}}` etc.) or rename in dashboard BEFORE wiring references.
4. **Image services (`railway add -i`) don't auto-deploy** — trigger the first deploy with a var-set
   (`railway variables -s belt-hasura --set X=Y`).
5. **`RAILWAY_RUN_COMMAND` is ignored for Dockerfile services** — you cannot inject `--restart` via env.
6. **Hasura table tracking (CRITICAL):** envio runs "Tracking tables in Hasura" ONLY on a FRESH storage init,
   never on resume. If belt-hasura's private DNS is seconds-old at the indexer's first start, tracking fails
   silently and never retries → GraphQL returns `field 'X' not found in type 'query_root'` with 0 tracked
   tables. **Deploy belt-hasura BEFORE belt-indexer and confirm it's healthy.** If tables still aren't tracked,
   run the manual track (idempotent — does exactly what envio does):

   ```bash
   # for each public entity table (exclude raw_events, dynamic_contract_registry, persisted_state,
   # envio_chains, envio_checkpoints, _meta, envio_history_*): pg_track_table + public SELECT
   curl -s "$HASURA_URL/v1/metadata" -H "x-hasura-admin-secret: $SECRET" -H 'content-type: application/json' \
     -d '{"type":"pg_track_table","args":{"source":"default","table":{"schema":"public","name":"<T>"}}}'
   curl -s "$HASURA_URL/v1/metadata" -H "x-hasura-admin-secret: $SECRET" -H 'content-type: application/json' \
     -d '{"type":"pg_create_select_permission","args":{"source":"default","table":{"schema":"public","name":"<T>"},"role":"public","permission":{"columns":"*","filter":{},"allow_aggregations":true}}}'
   ```
7. **belt-indexer stdout barely streams on Railway** (envio non-TUI buffering) — verify sync via the DB
   (`chain_metadata.latest_processed_block`) + Hasura metadata, not `railway logs`. (Observability gap for S3.)

## Verify (live endpoints)
- DB: `chain_metadata.latest_processed_block == block_height` (synced); entity counts match local.
- Public GraphQL (anonymous `public` role): `https://belt-hasura-production.up.railway.app/v1/graphql` —
  `MiberaLoanStats.totalActiveLoans == 19`, MiberaTransfer 39,714, MintActivity 10,000.
