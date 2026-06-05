#!/usr/bin/env bash
# =============================================================================
# refresh-mv-1155.sh — Refresh driver for mv_holder_1155
# =============================================================================
#
# Refresh sequence:
#   1. Run I2 pre-check (no negative intermediate balances).
#      If any violations: log error, emit audit entry, EXIT 1 — skip REFRESH.
#      NFR-03: never expose a state with negative balances via serving surface.
#   2. Capture pre-refresh row count.
#   3. REFRESH MATERIALIZED VIEW CONCURRENTLY mv_holder_1155.
#      Requires uidx_mv_holder_1155_pk (created in migrations/add-mv-holder-1155.sql).
#   4. Log post-refresh row count and elapsed time.
#   5. Emit structured audit entry to .run/audit.jsonl.
#
# Exit codes:
#   0    refresh completed successfully
#   1    I2 pre-check failed (refresh skipped) OR postgres error
#   2    usage error or DATABASE_URL not set
#   124  timeout (wrapped by caller's `timeout` command)
#
# Required environment:
#   DATABASE_URL   Postgres connection string: postgres://user:pass@host:port/db
#
# Optional environment:
#   REFRESH_TIMEOUT_SECONDS   Seconds before the refresh is killed (default: 360)
#   AUDIT_LOG_PATH            Path for audit JSON lines (default: .run/audit.jsonl)
#
# Usage:
#   DATABASE_URL=postgres://... ./scripts/refresh-mv-1155.sh
#
# Cron configuration: see docs/cron-refresh-config.md
# SDD reference: §3.4 (Refresh Mechanism)
# Sprint task: T5
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
REFRESH_TIMEOUT_SECONDS="${REFRESH_TIMEOUT_SECONDS:-360}"
AUDIT_LOG_PATH="${AUDIT_LOG_PATH:-.run/audit.jsonl}"
SCRIPT_START_TS="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

die() {
  echo "[ERROR] $*" >&2
  exit 1
}

log_info() {
  echo "[INFO] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
}

log_error() {
  echo "[ERROR] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*" >&2
}

psql_query() {
  local SQL_TEXT="$1"
  psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align <<< "$SQL_TEXT"
}

emit_audit() {
  local outcome="$1"
  local row_count="${2:-0}"
  local elapsed_seconds="${3:-0}"
  local detail="${4:-}"

  mkdir -p "$(dirname "$AUDIT_LOG_PATH")" 2>/dev/null || true

  local entry
  entry="$(jq -cn \
    --arg ts "$SCRIPT_START_TS" \
    --arg outcome "$outcome" \
    --argjson row_count "$row_count" \
    --argjson elapsed_seconds "$elapsed_seconds" \
    --arg detail "$detail" \
    '{ts: $ts, primitive: "refresh-mv-1155", outcome: $outcome, row_count: $row_count, elapsed_seconds: $elapsed_seconds, detail: $detail}')"

  echo "$entry" >> "$AUDIT_LOG_PATH" || log_error "Could not write to audit log at $AUDIT_LOG_PATH"
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[ERROR] DATABASE_URL is not set." >&2
  exit 2
fi

log_info "refresh-mv-1155.sh starting"
log_info "Database: ${DATABASE_URL%%@*}@..."

# ---------------------------------------------------------------------------
# Advisory lock: prevent concurrent-refresh accumulation
# pg_try_advisory_lock returns FALSE immediately if another session holds the
# lock, so concurrent cron invocations exit early rather than pile up.
# The lock is session-scoped and auto-released when the psql session ends.
# pg_advisory_unlock in the trap is belt-and-suspenders for explicit release.
# ---------------------------------------------------------------------------
LOCK_KEY="hashtext('mv_holder_1155_refresh')::bigint"
LOCK_ACQUIRED="$(psql_query "SELECT pg_try_advisory_lock($LOCK_KEY);" | tr -d ' ')"

if [[ "$LOCK_ACQUIRED" != "t" ]]; then
    log_info "Advisory lock not acquired — another refresh is in progress. Skipping."
    exit 0
fi

_release_advisory_lock() {
    psql_query "SELECT pg_advisory_unlock($LOCK_KEY);" >/dev/null 2>&1 || true
}
trap _release_advisory_lock EXIT

# ---------------------------------------------------------------------------
# Step 1: I2 pre-check — no negative intermediate balances
# If the action ledger contains a transfer before the corresponding mint,
# a REFRESH would expose a negative-balance state. Skip REFRESH in that case.
# ---------------------------------------------------------------------------

log_info "Step 1: I2 pre-check (no negative intermediate balances)"

I2_SQL="
SELECT primary_collection, chain_id, CAST(numeric2 AS NUMERIC) AS token_id, addr.address,
  SUM(CASE
    WHEN action_type = 'mint1155'    THEN CAST(numeric1 AS NUMERIC)
    WHEN action_type = 'transfer1155' AND actor = addr.address
      THEN  CAST(numeric1 AS NUMERIC)
    WHEN action_type = 'transfer1155' AND context::jsonb->>'from' = addr.address
      THEN -CAST(numeric1 AS NUMERIC)
    WHEN action_type = 'burn1155'    THEN -CAST(numeric1 AS NUMERIC)
    ELSE 0
  END) AS balance
FROM ponder.action
CROSS JOIN LATERAL (VALUES
  (CASE action_type
    WHEN 'mint1155'     THEN actor
    WHEN 'burn1155'     THEN actor
    WHEN 'transfer1155' THEN actor
  END),
  (CASE action_type
    WHEN 'transfer1155' THEN context::jsonb->>'from'
    ELSE NULL
  END)
) AS addr(address)
WHERE action_type IN ('mint1155', 'burn1155', 'transfer1155')
  AND addr.address IS NOT NULL
  AND addr.address != '0x0000000000000000000000000000000000000000'
GROUP BY 1, 2, 3, 4
HAVING SUM(CASE
  WHEN action_type = 'mint1155'    THEN CAST(numeric1 AS NUMERIC)
  WHEN action_type = 'transfer1155' AND actor = addr.address
    THEN  CAST(numeric1 AS NUMERIC)
  WHEN action_type = 'transfer1155' AND context::jsonb->>'from' = addr.address
    THEN -CAST(numeric1 AS NUMERIC)
  WHEN action_type = 'burn1155'    THEN -CAST(numeric1 AS NUMERIC)
  ELSE 0
END) < 0;"

I2_RESULT="$(psql_query "$I2_SQL" 2>&1)" || {
  log_error "I2 pre-check query failed: $I2_RESULT"
  emit_audit "error" 0 0 "I2 pre-check query failed"
  exit 1
}

if [[ -n "$I2_RESULT" ]]; then
  I2_COUNT="$(echo "$I2_RESULT" | grep -c .)" || true
  log_error "I2 pre-check FAILED: $I2_COUNT address(es) with negative intermediate balance."
  log_error "Failing rows:"
  echo "$I2_RESULT" >&2
  log_error "REFRESH skipped. The MV remains at its prior state."
  emit_audit "i2_violation_skipped" 0 0 "I2 pre-check failed: $I2_COUNT negative-balance addresses"
  exit 1
fi

log_info "Step 1: I2 pre-check PASSED — no negative intermediate balances."

# ---------------------------------------------------------------------------
# Step 2: Pre-refresh row count
# ---------------------------------------------------------------------------

log_info "Step 2: Capturing pre-refresh row count"

PRE_COUNT="$(psql_query "SELECT COUNT(*) FROM ponder.mv_holder_1155;" | tr -d ' ')" || {
  log_error "Could not query mv_holder_1155 row count"
  emit_audit "error" 0 0 "pre-refresh row count query failed"
  exit 1
}
log_info "Pre-refresh row count: $PRE_COUNT"

# ---------------------------------------------------------------------------
# Step 3: REFRESH MATERIALIZED VIEW CONCURRENTLY
# The unique index uidx_mv_holder_1155_pk is required. If it is absent, psql
# will return an error and this script exits 1 (Postgres handles the message).
# ---------------------------------------------------------------------------

log_info "Step 3: REFRESH MATERIALIZED VIEW CONCURRENTLY mv_holder_1155"

REFRESH_START="$(date +%s)"

# Apply timeout wrapper around the refresh command
if ! timeout "$REFRESH_TIMEOUT_SECONDS" psql "$DATABASE_URL" --no-psqlrc -c \
    "REFRESH MATERIALIZED VIEW CONCURRENTLY ponder.mv_holder_1155;" 2>&1; then
  REFRESH_EXIT="$?"
  if [[ "$REFRESH_EXIT" -eq 124 ]]; then
    log_error "REFRESH timed out after ${REFRESH_TIMEOUT_SECONDS}s."
    emit_audit "timeout" "$PRE_COUNT" "$REFRESH_TIMEOUT_SECONDS" \
      "REFRESH timed out after ${REFRESH_TIMEOUT_SECONDS}s"
    exit 124
  fi
  log_error "REFRESH failed with exit code $REFRESH_EXIT."
  emit_audit "error" "$PRE_COUNT" 0 "REFRESH failed with exit code $REFRESH_EXIT"
  exit 1
fi

REFRESH_END="$(date +%s)"
ELAPSED="$((REFRESH_END - REFRESH_START))"

# ---------------------------------------------------------------------------
# Step 4: Post-refresh row count and elapsed time
# ---------------------------------------------------------------------------

log_info "Step 4: Post-refresh verification"

POST_COUNT="$(psql_query "SELECT COUNT(*) FROM ponder.mv_holder_1155;" | tr -d ' ')" || {
  log_error "Could not query post-refresh row count"
  emit_audit "warning" "$PRE_COUNT" "$ELAPSED" "post-refresh row count query failed"
  exit 1
}

log_info "Refresh complete: pre=$PRE_COUNT rows → post=$POST_COUNT rows in ${ELAPSED}s"

# ---------------------------------------------------------------------------
# Step 5: Audit emit
# ---------------------------------------------------------------------------

emit_audit "success" "$POST_COUNT" "$ELAPSED" \
  "pre_count=$PRE_COUNT post_count=$POST_COUNT elapsed=${ELAPSED}s"

log_info "refresh-mv-1155.sh complete. Audit entry written to $AUDIT_LOG_PATH"
exit 0
