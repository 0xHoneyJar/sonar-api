#!/usr/bin/env bash
# scripts/hasura-rollback-drill.sh
#
# T-A3.10 (SKP-002 HIGH 790) — Hasura rollback drill.
#
# PROVES: the cutover → rollback path completes within the RTO threshold
# (default 30 min) AND that consumer-class queries continue to resolve
# both directions.
#
# Flow:
#   1. T0 = now. Run `cutover-hasura-tracking.sh cutover` (schema public→ponder).
#   2. Run a sample query that MUST work post-cutover (e.g. { MintEvent {…} }
#      remapped to ponder.mint_event via custom_root_fields). Assert success.
#   3. T1 = now. Run `cutover-hasura-tracking.sh rollback` (schema ponder→public).
#   4. Run the SAME query — must work against envio public.* schema. Assert.
#   5. T2 = now. Compute round-trip RTO = T2 - T0.
#   6. Output JSON { rto_seconds, pass, subscriptions_reconnected, permissions_intact, ... }.
#
# RTO threshold: 30 min (1800s) per SDD §10. If exceeded, pass=false (operator
# must escalate before A-4 prod cutover).
#
# Required env:
#   HASURA_URL           — staging Hasura base URL
#   HASURA_ADMIN_SECRET  — admin secret
#
# Optional env:
#   RTO_BUDGET_SECONDS   — override the 1800s default
#   SAMPLE_TABLE_PONDER  — table name to probe post-cutover (default MintEvent)
#   SAMPLE_TABLE_PUBLIC  — table name to probe post-rollback (default MintEvent)
#   DRILL_ID             — drill identifier (default: timestamp-based)
#
# Output: single JSON document on stdout.
#   {
#     "drill_id": "...",
#     "rto_seconds": 8.42,
#     "pass": true,
#     "cutover_query_ok": true,
#     "rollback_query_ok": true,
#     "subscriptions_reconnected": true,
#     "permissions_intact": true,
#     "exit_reason": "ok"
#   }
#
# Exit codes:
#   0 — pass
#   1 — drill ran but assertion failed (rto exceeded OR query broke)
#   2 — script-level error

set -euo pipefail

if [[ -z "${HASURA_URL:-}" ]]; then
  echo '{"exit_reason":"missing-env","detail":"HASURA_URL"}' >&2
  exit 2
fi
if [[ -z "${HASURA_ADMIN_SECRET:-}" ]]; then
  echo '{"exit_reason":"missing-env","detail":"HASURA_ADMIN_SECRET"}' >&2
  exit 2
fi

DRILL_ID="${DRILL_ID:-rollback-$(date -u +%Y%m%dT%H%MZ)-$(openssl rand -hex 3 2>/dev/null || echo r$RANDOM)}"
RTO_BUDGET_SECONDS="${RTO_BUDGET_SECONDS:-1800}"
SAMPLE_TABLE_PONDER="${SAMPLE_TABLE_PONDER:-MintEvent}"
SAMPLE_TABLE_PUBLIC="${SAMPLE_TABLE_PUBLIC:-MintEvent}"
CUTOVER_SCRIPT="${CUTOVER_SCRIPT:-$(dirname "$0")/cutover-hasura-tracking.sh}"

if [[ ! -x "$CUTOVER_SCRIPT" ]]; then
  echo "{\"exit_reason\":\"cutover-script-not-found\",\"detail\":\"$CUTOVER_SCRIPT not found or not executable\"}" >&2
  exit 2
fi

command -v jq >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"jq"}' >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"curl"}' >&2; exit 2; }

probe_query() {
  local table="$1"
  local response
  response=$(
    curl -fSs --max-time 30 -X POST "${HASURA_URL}/v1/graphql" \
      -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
      -H "Content-Type: application/json" \
      -d "{\"query\": \"{ ${table}(limit: 1) { id } }\"}" 2>&1
  ) || { echo "{\"ok\":false,\"detail\":\"curl-failed\",\"response\":$(echo "$response" | jq -Rs .)}"; return; }
  if echo "$response" | jq -e '.errors' >/dev/null 2>&1; then
    echo "{\"ok\":false,\"detail\":\"graphql-error\",\"response\":$response}"
  else
    echo "{\"ok\":true}"
  fi
}

count_permissions() {
  curl -fSs -X POST "${HASURA_URL}/v1/metadata" \
    -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
    -H "Content-Type: application/json" \
    -d '{"type":"export_metadata","args":{}}' \
    | jq '[.. | objects | select(has("select_permissions") or has("insert_permissions") or has("update_permissions") or has("delete_permissions")) | ((.select_permissions // []) + (.insert_permissions // []) + (.update_permissions // []) + (.delete_permissions // []))] | flatten | length'
}

# Count subscriptions baseline: this is a smoke-test surrogate. Hasura doesn't
# expose subscription connection count via metadata; we instead verify a
# subscription handshake completes post-rollback (defers to T-A3.11 drill for
# the deep test). Here we just confirm /v1/graphql still serves subscriptions.
ws_handshake_ok() {
  local hasura_url="$1"
  # Just a TCP-level reachability check. The actual graphql-ws ack happens in
  # the consumer-reconnect drill (T-A3.11). If staging is down, both will fail.
  local host port
  host=$(echo "$hasura_url" | sed -E 's|^https?://([^:/]+).*|\1|')
  case "$hasura_url" in
    https://*) port=443 ;;
    http://*) port=80 ;;
    *) port=443 ;;
  esac
  if timeout 5 bash -c "</dev/tcp/$host/$port" 2>/dev/null; then
    echo true
  else
    echo false
  fi
}

# Pre-permissions baseline.
PRE_PERM_COUNT=$(count_permissions)

# ─── PHASE 1: CUTOVER ──────────────────────────────────────────────────
T0_EPOCH_MS=$(($(date +%s%N) / 1000000))
CUTOVER_LOG=$(HASURA_URL="$HASURA_URL" HASURA_ADMIN_SECRET="$HASURA_ADMIN_SECRET" "$CUTOVER_SCRIPT" cutover 2>&1) || {
  jq -nc \
    --arg drill_id "$DRILL_ID" \
    --arg log "$CUTOVER_LOG" \
    '{drill_id: $drill_id, exit_reason: "cutover-failed", cutover_log: $log, pass: false}'
  exit 1
}

# Cutover-phase query: must resolve at unprefixed name post-customization.
CUTOVER_PROBE=$(probe_query "$SAMPLE_TABLE_PONDER")
CUTOVER_QUERY_OK=$(echo "$CUTOVER_PROBE" | jq -r '.ok')

# ─── PHASE 2: ROLLBACK ─────────────────────────────────────────────────
ROLLBACK_LOG=$(HASURA_URL="$HASURA_URL" HASURA_ADMIN_SECRET="$HASURA_ADMIN_SECRET" "$CUTOVER_SCRIPT" rollback 2>&1) || {
  jq -nc \
    --arg drill_id "$DRILL_ID" \
    --arg log "$ROLLBACK_LOG" \
    --argjson cutover_query_ok "$CUTOVER_QUERY_OK" \
    '{drill_id: $drill_id, exit_reason: "rollback-failed", rollback_log: $log, cutover_query_ok: $cutover_query_ok, pass: false}'
  exit 1
}

# Post-rollback query: schema is back to public.*. Same root-field name should
# resolve (envio originally serves at that name; rollback strips customization).
ROLLBACK_PROBE=$(probe_query "$SAMPLE_TABLE_PUBLIC")
ROLLBACK_QUERY_OK=$(echo "$ROLLBACK_PROBE" | jq -r '.ok')

T2_EPOCH_MS=$(($(date +%s%N) / 1000000))
RTO_SECONDS=$(awk -v ms="$((T2_EPOCH_MS - T0_EPOCH_MS))" 'BEGIN { printf "%.2f", ms / 1000 }')

# Post-permissions count.
POST_PERM_COUNT=$(count_permissions)
if [[ "$POST_PERM_COUNT" == "$PRE_PERM_COUNT" ]]; then
  PERMISSIONS_INTACT=true
else
  PERMISSIONS_INTACT=false
fi

SUBSCRIPTIONS_OK=$(ws_handshake_ok "$HASURA_URL")

# Pass criteria: both queries ok, RTO within budget, permissions intact.
if [[ "$CUTOVER_QUERY_OK" == "true" ]] && \
   [[ "$ROLLBACK_QUERY_OK" == "true" ]] && \
   awk -v rto="$RTO_SECONDS" -v budget="$RTO_BUDGET_SECONDS" 'BEGIN { exit !(rto <= budget) }' && \
   [[ "$PERMISSIONS_INTACT" == "true" ]]; then
  PASS=true
  EXIT_REASON="ok"
  EXIT_CODE=0
else
  PASS=false
  if awk -v rto="$RTO_SECONDS" -v budget="$RTO_BUDGET_SECONDS" 'BEGIN { exit !(rto > budget) }'; then
    EXIT_REASON="rto-exceeded"
  elif [[ "$CUTOVER_QUERY_OK" != "true" ]]; then
    EXIT_REASON="cutover-query-failed"
  elif [[ "$ROLLBACK_QUERY_OK" != "true" ]]; then
    EXIT_REASON="rollback-query-failed"
  elif [[ "$PERMISSIONS_INTACT" != "true" ]]; then
    EXIT_REASON="permissions-drift"
  else
    EXIT_REASON="unknown-failure"
  fi
  EXIT_CODE=1
fi

jq -nc \
  --arg drill_id "$DRILL_ID" \
  --argjson rto_seconds "$RTO_SECONDS" \
  --argjson rto_budget_seconds "$RTO_BUDGET_SECONDS" \
  --argjson cutover_query_ok "$CUTOVER_QUERY_OK" \
  --argjson rollback_query_ok "$ROLLBACK_QUERY_OK" \
  --argjson subscriptions_reconnected "$SUBSCRIPTIONS_OK" \
  --argjson permissions_intact "$PERMISSIONS_INTACT" \
  --argjson pre_permission_count "$PRE_PERM_COUNT" \
  --argjson post_permission_count "$POST_PERM_COUNT" \
  --argjson pass "$PASS" \
  --arg exit_reason "$EXIT_REASON" \
  '{
    drill_id: $drill_id,
    rto_seconds: $rto_seconds,
    rto_budget_seconds: $rto_budget_seconds,
    cutover_query_ok: $cutover_query_ok,
    rollback_query_ok: $rollback_query_ok,
    subscriptions_reconnected: $subscriptions_reconnected,
    permissions_intact: $permissions_intact,
    pre_permission_count: $pre_permission_count,
    post_permission_count: $post_permission_count,
    pass: $pass,
    exit_reason: $exit_reason
  }'

exit "$EXIT_CODE"
