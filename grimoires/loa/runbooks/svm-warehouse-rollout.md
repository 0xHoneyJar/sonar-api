# Runbook — SVM warehouse-loader rollout (cycle svm-warehouse-loader)

Operator-facing, copy-pasteable. Prereqs per step are explicit; nothing here requires Helius until step 5.

## 0. One-time setup (Dune side)

1. ✅ DONE 2026-07-05 — **executable events query id: 7887938** (created via REST under the operator's
   API key after the MCP-created copies — 7887895/7887896 — returned 403 "archived or unsaved" to API
   execution; account-context mismatch between the MCP OAuth session and the API key. 7887938 is the one.)
2. ✅ E2E PROVEN 2026-07-05: `--collection pythians --from 2026-06-25T21:24:42Z --dry` via the real Dune
   API → 109 rows → 109 events, 0 rejected. Set for runs: `DUNE_API_KEY` (GH secret, set) and
   `DUNE_EVENTS_QUERY_ID=7887938`. Cost model: medium engine = 10 credits flat per execution.

## 1. Apply migration + Hasura track (same motion as migration 001)

```bash
psql "$BELT_POSTGRES_URL" -f migrations/svm/002_sync_status.sql
# Hasura: pg_track_table svm.sync_status + public select role (mirror svm_collection_event's motion)
```
Then flip `svm_sync_status` from `pending-exposure` → `live` in `scripts/svm-contract.json` and run `node scripts/verify-svm-contract.mjs` (must report 7 live types, 0 pending).

## 2. Prove G1 — heal the pythians gap (the 108-event hole, #122)

```bash
SVM_HASURA_ENDPOINT=... HASURA_GRAPHQL_ADMIN_SECRET=... DUNE_API_KEY=... DUNE_EVENTS_QUERY_ID=... \
  npx tsx src/svm/warehouse-loader.ts --collection pythians --from 2026-06-25T00:00:00Z
```
Expected: ~108 transfer events upserted (idempotent overlap with existing rows is safe — content-addressed PK), Dune cost well under 1 credit, `svm_sync_status.pythians.last_event_at ≈ 2026-07-04T22:22Z`, `last_event_source = dune-warehouse`. Parity check: row count vs the Dune ground truth recorded in #122; then `--from 2020-01-01` full re-walk in `--dry` and compare counts vs the 30,006 fixture (raw-vs-classified delta expected on sale/list escrow legs — documented in `project_svm-warehouse-ingestion-route` memory).

## 3. Batch-1 ingestion (8 classic collections, one at a time, cost logged)

```bash
for k in mad_lads claynosaurz smb_gen2 degods daa_higher_self famous_fox y00ts galactic_geckos; do
  npx tsx src/svm/warehouse-loader.ts --collection $k
done
```
Record per-run `[loader] DONE` lines (events + Dune credits) in the table below. Abort a collection if `rowsRejected` is non-trivial (>0.1%) — inspect before trusting completeness.

| collection | events | Dune credits | date |
|---|---|---|---|
| (fill per run) | | | |

## 4. Webhook multi-collection deploy

1. Deploy `svm-webhook` with `COLLECTION` env REMOVED (registry mode = all 9 collections) — or keep `COLLECTION=pythians` for a single-tenant canary first.
2. Helius dashboard: extend the webhook's address set / create per-collection webhooks pointing at the same receiver (operator-side; the receiver routes by membership).
3. `curl $WEBHOOK_URL/health` → per-collection `{members, loadedAt, source}` blocks; every collection should reach `source: das` within one refresh cycle (requires Helius credits — else `db-fallback` is the declared degraded state).

## 5. Post-topup verification (requires Helius credits — the deferred lane)

1. Manually dispatch `svm-event-backfill.yml` → §4.5 reconcile gate passes; `last_reconcile_result: passed` for pythians.
2. Incremental reconcile check: run `npx tsx src/svm/collection-event-indexer.ts --collection pythians` (default = incremental) and confirm via helius-meter's exit line that Enhanced calls ≈ drifted mints only (expect single digits on a quiet day, NOT ~3.7k). `--full` remains available for a trust-but-verify full pass.
3. T-2 completion: run the kind-mapping precision measurement against the Helius-classified fixture (test/fixtures/svm-warehouse/) with live DB access; if program-ID sale-detection precision ≥99%, enable marketplace kinds via `SVM_EMIT_MARKETPLACE_KINDS` + re-backfill (the #85 pattern). Until then batch-1 kinds are mint/transfer/burn only — coarse, never wrong.
4. Close #122: cron green ≥3 consecutive runs + freshness rows current + KF-018 entry updated with the closure evidence.

## Rollback

Loader writes are insert-only/idempotent — rollback = `DELETE FROM svm.collection_event WHERE collection_key = '<key>' AND source = 'dune-warehouse'` (scoped by provenance column; never touch webhook/backfill rows). `svm.sync_status` rows are advisory — safe to delete per key. Webhook: redeploy with `COLLECTION=pythians` to return to single-tenant.
