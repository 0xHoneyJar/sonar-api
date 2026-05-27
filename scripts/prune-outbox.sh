#!/usr/bin/env bash
# prune-outbox.sh — T-A2.10 (SKP-003 HIGH) pending_emits pruning cron entry
#
# Per Sprint A-2 T-A2.10 AC:
#   "cron `DELETE FROM ponder.pending_emits WHERE published_at IS NOT NULL
#    AND published_at < NOW() - INTERVAL '7 days'`. Cron job deployed;
#    verified non-destructive on test data."
#
# DEPLOY: Railway cron service or systemd timer. Cadence: daily at midnight
# UTC. Operator validates non-destructive behavior by running with
# DRY_RUN=1 first.
#
# CONTRACT: `published_at` is BIGINT (unix-ms epoch). The SQL converts NOW()
# to unix-ms for the comparison. Default retention 7 days; tunable via
# OUTBOX_RETENTION_DAYS env var.
#
# NON-DESTRUCTIVE GUARANTEE: only rows with `published_at IS NOT NULL` are
# considered. Pending rows (published_at = NULL) are NEVER touched. The
# operator can run this on a live DB without risk to in-flight envelopes.

set -euo pipefail

DATABASE_URL="${DATABASE_URL:?Set DATABASE_URL}"
OUTBOX_RETENTION_DAYS="${OUTBOX_RETENTION_DAYS:-7}"
DRY_RUN="${DRY_RUN:-0}"

# Validate retention is a positive integer.
if ! [[ "$OUTBOX_RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: OUTBOX_RETENTION_DAYS must be a positive integer, got '$OUTBOX_RETENTION_DAYS'" >&2
  exit 2
fi

SQL_DELETE="DELETE FROM ponder.pending_emits
WHERE published_at IS NOT NULL
  AND published_at < (extract(epoch from (NOW() - INTERVAL '${OUTBOX_RETENTION_DAYS} days')) * 1000)::bigint"

SQL_COUNT="SELECT count(*) FROM ponder.pending_emits
WHERE published_at IS NOT NULL
  AND published_at < (extract(epoch from (NOW() - INTERVAL '${OUTBOX_RETENTION_DAYS} days')) * 1000)::bigint"

echo "[prune-outbox] retention: ${OUTBOX_RETENTION_DAYS} days"

if [[ "$DRY_RUN" == "1" ]]; then
  CANDIDATE_COUNT=$(psql -At "$DATABASE_URL" -c "$SQL_COUNT")
  echo "[prune-outbox] DRY_RUN — would delete $CANDIDATE_COUNT row(s)"
  exit 0
fi

# Use a transaction so the count + delete are atomic (in case of races —
# though pending_emits is append-mostly, this is defensive).
RESULT=$(psql -At "$DATABASE_URL" <<SQL
BEGIN;
  SELECT count(*) AS before_count FROM ponder.pending_emits;
  $SQL_DELETE;
  SELECT count(*) AS after_count FROM ponder.pending_emits;
COMMIT;
SQL
)

echo "[prune-outbox] result:"
echo "$RESULT"
echo "[prune-outbox] DONE"
