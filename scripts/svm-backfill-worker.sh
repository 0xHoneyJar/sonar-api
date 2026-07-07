#!/usr/bin/env bash
# svm-backfill-worker.sh — full-genesis SVM deep-history backfill worker.
#
# Runs the parallel SQD loader over the TODO collections SEQUENTIALLY (parallel
# ACROSS collections trips SQD's nginx front proxy). No --from-slot: each
# collection resumes from its durable svm.sync_status.sqd_cursor_slot cursor
# (NULL → genesis), so a restart skips already-completed collections instead of
# re-walking days of work. The two-phase loader writes its cursor only on FULL
# completion, so an interrupted collection safely re-runs from its prior cursor
# (idempotent insert-if-absent — no dupes).
#
# Designed for a NO-TIMEOUT box: full genesis is hours-to-days per dense
# collection. Idles with `sleep infinity` at the end so the service does not
# restart-loop once every collection is done.
#
# Env: SVM_HASURA_ENDPOINT, HASURA_GRAPHQL_ADMIN_SECRET, HELIUS_API_KEY (DAS
# member resolution). SVM_BACKFILL_CONCURRENCY overrides the sustainable default.
set -uo pipefail

COLLECTIONS=(claynosaurz smb_gen2 degods daa_higher_self famous_fox y00ts galactic_geckos)
CONCURRENCY="${SVM_BACKFILL_CONCURRENCY:-8}"
MAX_ATTEMPTS="${SVM_BACKFILL_MAX_ATTEMPTS:-3}"

echo "[worker] SVM backfill start — ${#COLLECTIONS[@]} collections, concurrency ${CONCURRENCY}"
for c in "${COLLECTIONS[@]}"; do
  ok=0
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    echo "[worker] === ${c}: attempt ${attempt}/${MAX_ATTEMPTS} (concurrency ${CONCURRENCY}) ==="
    if npx tsx src/svm/sqd-parallel-loader.ts --collection "$c" --concurrency "$CONCURRENCY"; then
      echo "[worker] === ${c}: DONE ==="
      ok=1
      break
    fi
    echo "[worker] === ${c}: attempt ${attempt} FAILED; backing off 30s ==="
    sleep 30
  done
  [ "$ok" -eq 1 ] || echo "[worker] !!! ${c}: gave up after ${MAX_ATTEMPTS} attempts — continuing to next collection"
done

echo "[worker] all collections processed — idling (sleep infinity) to avoid restart-loop"
sleep infinity
