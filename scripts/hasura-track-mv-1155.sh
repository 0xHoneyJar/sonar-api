#!/usr/bin/env bash
# =============================================================================
# hasura-track-mv-1155.sh — Track mv_holder_1155 in Hasura
# =============================================================================
#
# Calls the Hasura metadata API to:
#   1. Track mv_holder_1155 as a queryable table
#   2. Add SELECT permission for the 'public' role (mirrors existing 94-table pattern)
#
# Required environment:
#   HASURA_GRAPHQL_ENDPOINT   Full URL of the Hasura endpoint (no trailing slash)
#                             Example: https://sonar-hasura.up.railway.app
#   HASURA_ADMIN_SECRET       Hasura admin secret (never hardcode)
#
# Optional environment:
#   HASURA_SOURCE             Postgres source name in Hasura (default: "default")
#   HASURA_SCHEMA             Postgres schema name (default: "ponder")
#
# Exit codes:
#   0   both API calls succeeded
#   1   one or more API calls failed
#   2   required env var not set
#
# Usage:
#   HASURA_GRAPHQL_ENDPOINT=https://... HASURA_ADMIN_SECRET=... ./scripts/hasura-track-mv-1155.sh
#
# FALLBACK (R-01): If Hasura cannot track an MV directly, see the fallback
# instructions at the bottom of this script. Run migrations/add-fallback-view-1155.sql
# first, then use the fallback curl commands provided below.
#
# VERIFICATION after running this script (AC-12):
#   curl -X POST "$HASURA_GRAPHQL_ENDPOINT/v1/graphql" \
#     -H "Content-Type: application/json" \
#     -d '{
#       "query": "query { mv_holder_1155(where: { collection_key: { _eq: \"puru_apiculture\" }, chain_id: { _eq: 8453 }, token_id: { _eq: \"4\" } }, order_by: { balance: desc }, limit: 1) { address balance } }"
#     }'
#   Expected: address = 0x099a..., balance = 2575
#
# SDD reference: §3.7 (Hasura Tracking Plan)
# Sprint task: T6
# EXECUTION: operator-led per ADR-010. The agent does not run this script.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if [[ -z "${HASURA_GRAPHQL_ENDPOINT:-}" ]]; then
  echo "[ERROR] HASURA_GRAPHQL_ENDPOINT is not set." >&2
  exit 2
fi

if [[ -z "${HASURA_ADMIN_SECRET:-}" ]]; then
  echo "[ERROR] HASURA_ADMIN_SECRET is not set." >&2
  exit 2
fi

HASURA_SOURCE="${HASURA_SOURCE:-default}"
HASURA_SCHEMA="${HASURA_SCHEMA:-ponder}"

echo "[INFO] Hasura endpoint: $HASURA_GRAPHQL_ENDPOINT"
echo "[INFO] Source: $HASURA_SOURCE  Schema: $HASURA_SCHEMA"

FAILURES=0

metadata_call() {
  local description="$1"
  local payload="$2"
  local RESPONSE_FILE HTTP_STATUS BODY

  RESPONSE_FILE="$(mktemp)"

  echo ""
  echo "[INFO] $description"
  HTTP_STATUS="$(curl -s -o "$RESPONSE_FILE" -w '%{http_code}' \
    -X POST "$HASURA_GRAPHQL_ENDPOINT/v1/metadata" \
    -H "X-Hasura-Admin-Secret: $HASURA_ADMIN_SECRET" \
    -H "Content-Type: application/json" \
    -d "$payload")"

  BODY="$(cat "$RESPONSE_FILE" 2>/dev/null || echo '{}')"
  rm -f "$RESPONSE_FILE"

  if [[ "$HTTP_STATUS" -ge 200 ]] && [[ "$HTTP_STATUS" -lt 300 ]]; then
    # Check for Hasura-level errors in the response body
    if echo "$BODY" | grep -q '"error"' 2>/dev/null; then
      echo "[WARN] HTTP $HTTP_STATUS but response contains error: $BODY"
      # "already exists" is idempotent — not a real failure
      if echo "$BODY" | grep -qi 'already.exist\|already.tracked' 2>/dev/null; then
        echo "[INFO] Already tracked — idempotent; treating as success."
      else
        echo "[FAIL] $description"
        FAILURES=$((FAILURES + 1))
      fi
    else
      echo "[PASS] $description (HTTP $HTTP_STATUS)"
    fi
  else
    echo "[FAIL] $description — HTTP $HTTP_STATUS: $BODY"
    FAILURES=$((FAILURES + 1))
  fi
}

# ---------------------------------------------------------------------------
# Step 1: Track mv_holder_1155
# ---------------------------------------------------------------------------

metadata_call \
  "Step 1: pg_track_table for mv_holder_1155" \
  "$(cat <<EOF
{
  "type": "pg_track_table",
  "args": {
    "source": "$HASURA_SOURCE",
    "schema": "$HASURA_SCHEMA",
    "name": "mv_holder_1155"
  }
}
EOF
)"

# ---------------------------------------------------------------------------
# Step 2: Add SELECT permission for 'public' role
# Matches the existing 94-table permission pattern (sonar-belt-factory):
#   public role, columns: *, allow_aggregations: true, filter: {}
# ---------------------------------------------------------------------------

metadata_call \
  "Step 2: pg_create_select_permission for role 'public'" \
  "$(cat <<EOF
{
  "type": "pg_create_select_permission",
  "args": {
    "source": "$HASURA_SOURCE",
    "table": {
      "schema": "$HASURA_SCHEMA",
      "name": "mv_holder_1155"
    },
    "role": "public",
    "permission": {
      "columns": "*",
      "filter": {},
      "allow_aggregations": true
    }
  }
}
EOF
)"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "=== Summary ==="
if [[ "$FAILURES" -eq 0 ]]; then
  echo "[PASS] mv_holder_1155 tracked in Hasura with public SELECT permission."
  echo ""
  echo "Verify with:"
  echo "  curl -X POST '$HASURA_GRAPHQL_ENDPOINT/v1/graphql' \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{\"query\": \"query { mv_holder_1155(where: { collection_key: { _eq: \\\"puru_apiculture\\\" }, chain_id: { _eq: 8453 }, token_id: { _eq: \\\"4\\\" } }, order_by: { balance: desc }, limit: 1) { address balance } }\"}'"
  echo "  Expected: address = 0x099a..., balance = 2575"
  exit 0
else
  echo "[FAIL] $FAILURES step(s) failed."
  echo ""
  echo "If Hasura cannot track the MV directly (R-01 fallback):"
  echo "  1. Run: psql \"\$DATABASE_URL\" -f migrations/add-fallback-view-1155.sql"
  echo "  2. Edit this script to use 'v_holder_1155' instead of 'mv_holder_1155'"
  echo "     in the pg_track_table and pg_create_select_permission calls."
  exit 1
fi

# =============================================================================
# FALLBACK INSTRUCTIONS (R-01) — if pg_track_table fails for the MV:
#
# 1. Apply the fallback view migration:
#      psql "$DATABASE_URL" -f migrations/add-fallback-view-1155.sql
#
# 2. Track v_holder_1155 instead:
#      curl -X POST "$HASURA_GRAPHQL_ENDPOINT/v1/metadata" \
#        -H "X-Hasura-Admin-Secret: $HASURA_ADMIN_SECRET" \
#        -H "Content-Type: application/json" \
#        -d '{
#          "type": "pg_track_table",
#          "args": {
#            "source": "default",
#            "schema": "ponder",
#            "name": "v_holder_1155"
#          }
#        }'
#
# 3. Add SELECT permission for v_holder_1155:
#      curl -X POST "$HASURA_GRAPHQL_ENDPOINT/v1/metadata" \
#        -H "X-Hasura-Admin-Secret: $HASURA_ADMIN_SECRET" \
#        -H "Content-Type: application/json" \
#        -d '{
#          "type": "pg_create_select_permission",
#          "args": {
#            "source": "default",
#            "table": {"schema": "ponder", "name": "v_holder_1155"},
#            "role": "public",
#            "permission": {
#              "columns": "*",
#              "filter": {},
#              "allow_aggregations": true
#            }
#          }
#        }'
#
# Conservation invariants are unaffected by the fallback — the view wraps the MV.
# =============================================================================
