# Runbook — Kitchen dedicated Postgres cutover (sonar-api#236 / br-9f6)

**Companion:** `belt-reinit.md` §Kitchen survival · SCALE Guardrail 6  
**Code gate:** `KITCHEN_DATABASE_URL` required in production (`kitchen-database-url.ts`)

## Goal

`kitchen-api` durable tables survive monobelt `ENVIO_RESTART=1` wipes.

## Pre-cutover

1. Provision a **new** Railway Postgres (or wipe-exempt service) — **not** the belt indexer DB.
2. Apply migrations on the new DB:
   ```sh
   # from sonar-api
   psql "$KITCHEN_DATABASE_URL" -f migrations/kitchen/001_expand_physical_job_identity.sql
   psql "$KITCHEN_DATABASE_URL" -f migrations/kitchen/001b_enable_dual_write.sql
   # continue through 002/003 as current authority requires; then:
   psql "$KITCHEN_DATABASE_URL" -f migrations/kitchen/004_kitchen_outbox.sql
   ```
3. Optionally dump/restore `kitchen_ingest_jobs` + correlations + migration_state from the old DB if jobs must survive cutover.

## Cutover

1. Set on `kitchen-api`:
   - `KITCHEN_DATABASE_URL=<dedicated>`
   - Remove any reliance on `ENVIO_PG_*` for Kitchen (do **not** set `KITCHEN_ALLOW_ENVIO_PG_FALLBACK` in prod).
2. Redeploy `kitchen-api`.
3. Survival check (must `ok: true`, not colocated):
   ```sh
   KITCHEN_DATABASE_URL=… \
     ENVIO_PG_HOST=… ENVIO_PG_USER=… ENVIO_PG_DATABASE=… \
     pnpm kitchen:survival -- --json
   # or: node scripts/kitchen-survival-check.mjs --json
   ```
4. Smoke: `POST /v2/collection-preparations` + `GET /v2/ownership-ready` with service token.

## Post-cutover / next wipe

Before and after any KF-013 belt wipe: re-run survival-check. Admit path must work **without** re-applying kitchen migrations by hand.

## Done when

- [ ] `kitchen-api` prod uses dedicated `KITCHEN_DATABASE_URL`
- [ ] Survival-check `colocated_with_belt_wipe_target: false`
- [ ] One belt wipe completed with Kitchen admit healthy
