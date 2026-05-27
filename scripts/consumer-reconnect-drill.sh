#!/usr/bin/env bash
# scripts/consumer-reconnect-drill.sh
#
# T-A3.11 (SKP-005 HIGH 710) — Consumer reconnect drill.
#
# PROVES: when the cutover script's `replace_metadata` invalidates the
# Hasura GraphQL schema, all 3 mock consumers reconnect within the SLA
# (default 60s) and resume event consumption.
#
# Per COOKBOOK §C-6 "Subscription continuity (DEFERRED to A-3.11)":
#   `replace_metadata` invalidates the GraphQL schema, which Hasura v2.43.0
#   documents as dropping existing WebSocket subscriptions; clients MUST
#   reconnect. This drill is the verification path.
#
# Flow:
#   1. Spawn 3 background Node subscribers (mediums, sietch-discord,
#      freeside-score — using their canonical subscription shapes from
#      test/hasura-contract/fixtures/queries.json).
#   2. Wait for each to receive INITIAL data (connection_ack + first message).
#   3. Trigger the cutover script (cutover OR rollback — operator chooses
#      via DIRECTION env).
#   4. For each subscriber, measure: time-to-reconnect after disconnect,
#      and whether the post-reconnect subscription resumes (next message
#      received within the SLA window).
#   5. Aggregate into JSON.
#
# Required env:
#   HASURA_URL           — staging Hasura base URL
#   HASURA_ADMIN_SECRET  — admin secret
#
# Optional env:
#   DIRECTION            — "cutover" or "rollback" (default: cutover)
#   RECONNECT_SLA_SECONDS — default 60
#   DRILL_ID             — drill identifier
#   CUTOVER_SCRIPT       — path to cutover script (default: ./cutover-hasura-tracking.sh)
#
# Output: JSON to stdout.
#
# Exit:
#   0 — all 3 consumers reconnect within SLA
#   1 — one or more consumers exceed SLA OR fail to resume
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

DRILL_ID="${DRILL_ID:-reconnect-$(date -u +%Y%m%dT%H%MZ)-$(openssl rand -hex 3 2>/dev/null || echo c$RANDOM)}"
DIRECTION="${DIRECTION:-cutover}"
RECONNECT_SLA_SECONDS="${RECONNECT_SLA_SECONDS:-60}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
CUTOVER_SCRIPT="${CUTOVER_SCRIPT:-$SCRIPT_DIR/cutover-hasura-tracking.sh}"

case "$DIRECTION" in
  cutover|rollback) ;;
  *) echo "{\"exit_reason\":\"bad-direction\",\"detail\":\"$DIRECTION\"}" >&2; exit 2 ;;
esac

if [[ ! -x "$CUTOVER_SCRIPT" ]]; then
  echo "{\"exit_reason\":\"cutover-script-not-found\",\"detail\":\"$CUTOVER_SCRIPT\"}" >&2
  exit 2
fi

command -v node >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"node"}' >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"jq"}' >&2; exit 2; }

# ─── Subscriber implementation (Node, native WebSocket) ─────────────────
# Three subscriber configs — one per consumer.

WORK_DIR=$(mktemp -d -t consumer-reconnect-drill.XXXXXX)
trap 'rm -rf "$WORK_DIR"' EXIT

SUBSCRIBER_JS="$WORK_DIR/subscriber.js"
cat > "$SUBSCRIBER_JS" <<'JSEOF'
// Node 22+ native WebSocket — speaks Hasura's graphql-ws protocol.
// Subscriber lifecycle:
//   - Connects, sends connection_init, starts subscription.
//   - Logs events as JSON lines to stdout:
//     {ts, kind: "init"|"connection_ack"|"data"|"error"|"close"|"reopen"|"resumed"}
//   - On close, auto-reconnects with exponential backoff (cap 5s).

const HASURA_URL = process.env.HASURA_URL;
const HASURA_ADMIN_SECRET = process.env.HASURA_ADMIN_SECRET;
const NAME = process.env.CONSUMER_NAME;
const QUERY = process.env.SUBSCRIPTION_QUERY;
const MAX_LIFETIME_MS = parseInt(process.env.MAX_LIFETIME_MS || "180000", 10);

const wsUrl = HASURA_URL.replace(/^http/, "ws") + "/v1/graphql";

let attempt = 0;
let hasReceived = false;
let postSwapReceived = false;
const startedAt = Date.now();

function log(kind, extra = {}) {
  process.stdout.write(JSON.stringify({ ts: Date.now(), consumer: NAME, kind, ...extra }) + "\n");
}

function backoffMs() {
  return Math.min(500 * Math.pow(2, attempt), 5000);
}

function connect() {
  attempt++;
  const ws = new WebSocket(wsUrl, ["graphql-ws"]);
  let acked = false;

  ws.addEventListener("open", () => {
    log("ws_open", { attempt });
    ws.send(JSON.stringify({
      type: "connection_init",
      payload: { headers: { "x-hasura-admin-secret": HASURA_ADMIN_SECRET } },
    }));
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
      if (msg.type === "connection_ack") {
        acked = true;
        log("connection_ack", { attempt });
        ws.send(JSON.stringify({ id: "sub-1", type: "start", payload: { query: QUERY } }));
      } else if (msg.type === "data" || msg.type === "next") {
        if (!hasReceived) {
          hasReceived = true;
          log("first_data", { attempt });
        } else if (attempt > 1) {
          if (!postSwapReceived) {
            postSwapReceived = true;
            log("resumed", { attempt, ms_since_start: Date.now() - startedAt });
          }
        }
      } else if (msg.type === "error" || msg.type === "connection_error") {
        log("error", { attempt, payload: msg.payload });
      }
    } catch (err) {
      log("parse_error", { err: String(err) });
    }
  });

  ws.addEventListener("close", (event) => {
    log("close", { attempt, code: event.code, reason: String(event.reason) });
    if (Date.now() - startedAt > MAX_LIFETIME_MS) {
      log("max_lifetime_reached");
      process.exit(0);
    }
    setTimeout(connect, backoffMs());
  });

  ws.addEventListener("error", (e) => {
    log("ws_error", { attempt, message: String((e && e.message) || e) });
  });
}

connect();
setTimeout(() => {
  log("graceful_exit");
  process.exit(0);
}, MAX_LIFETIME_MS);
JSEOF

# ─── Spawn 3 subscribers in background ─────────────────────────────────
declare -A SUB_LOGS
declare -A SUB_PIDS
declare -A SUB_QUERIES

SUB_QUERIES[mediums]="subscription { BadgeHolder(limit: 1) { id address } }"
SUB_QUERIES[sietch-discord]="subscription { MintEvent(limit: 1, order_by: { timestamp: desc }) { id collectionKey tokenId } }"
SUB_QUERIES[freeside-score]="subscription { MiberaTransfer(limit: 1, order_by: { timestamp: desc }) { id from to } }"

for consumer in mediums sietch-discord freeside-score; do
  log_file="$WORK_DIR/$consumer.log"
  SUB_LOGS[$consumer]="$log_file"

  HASURA_URL="$HASURA_URL" \
  HASURA_ADMIN_SECRET="$HASURA_ADMIN_SECRET" \
  CONSUMER_NAME="$consumer" \
  SUBSCRIPTION_QUERY="${SUB_QUERIES[$consumer]}" \
  MAX_LIFETIME_MS=180000 \
    node "$SUBSCRIBER_JS" > "$log_file" 2>&1 &

  SUB_PIDS[$consumer]=$!
done

# Cleanup background subscribers on exit.
cleanup_subs() {
  for consumer in mediums sietch-discord freeside-score; do
    if [[ -n "${SUB_PIDS[$consumer]:-}" ]]; then
      kill "${SUB_PIDS[$consumer]}" 2>/dev/null || true
    fi
  done
}
trap 'cleanup_subs; rm -rf "$WORK_DIR"' EXIT

# Wait up to 30s for each subscriber to receive first_data.
wait_for_first_data() {
  local consumer="$1"
  local timeout_s=30
  local elapsed=0
  while [[ $elapsed -lt $timeout_s ]]; do
    if grep -q '"kind":"first_data"' "${SUB_LOGS[$consumer]}" 2>/dev/null; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

ALL_FIRST_DATA=true
for consumer in mediums sietch-discord freeside-score; do
  if ! wait_for_first_data "$consumer"; then
    ALL_FIRST_DATA=false
    echo "WARNING: $consumer never received first_data" >&2
  fi
done

if [[ "$ALL_FIRST_DATA" != "true" ]]; then
  # Soft-warning: subscriptions can be slow on empty staging. We still proceed,
  # but flag in output. Use a sentinel.
  PRE_SWAP_HEALTHY=false
else
  PRE_SWAP_HEALTHY=true
fi

# ─── Trigger metadata swap ─────────────────────────────────────────────
SWAP_LOG=$(HASURA_URL="$HASURA_URL" HASURA_ADMIN_SECRET="$HASURA_ADMIN_SECRET" "$CUTOVER_SCRIPT" "$DIRECTION" 2>&1) || {
  cleanup_subs
  jq -nc --arg drill_id "$DRILL_ID" --arg log "$SWAP_LOG" \
    '{drill_id: $drill_id, exit_reason: "swap-failed", swap_log: $log, pass: false}'
  exit 1
}
SWAP_END_MS=$(($(date +%s%N) / 1000000))

# ─── Wait for resume (per subscriber, up to SLA seconds) ─────────────────
declare -A RESUMED

wait_for_resume() {
  local consumer="$1"
  local timeout_s="$2"
  local elapsed=0
  while [[ $elapsed -lt $timeout_s ]]; do
    if grep -q '"kind":"resumed"' "${SUB_LOGS[$consumer]}" 2>/dev/null; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

ALL_RESUMED=true
for consumer in mediums sietch-discord freeside-score; do
  if wait_for_resume "$consumer" "$RECONNECT_SLA_SECONDS"; then
    RESUMED[$consumer]=true
  else
    RESUMED[$consumer]=false
    ALL_RESUMED=false
  fi
done

# Build per-consumer JSON array. Re-derive reconnect seconds from log timing:
#   reconnect_seconds = (timestamp of "resumed" event) - (SWAP_END_MS).
build_consumer_json() {
  local consumer="$1"
  local resumed_flag="${RESUMED[$consumer]}"
  local resumed_ts
  resumed_ts=$(grep '"kind":"resumed"' "${SUB_LOGS[$consumer]}" | head -1 | jq -r '.ts // 0')
  if [[ "$resumed_flag" == "true" && "$resumed_ts" -gt 0 ]]; then
    local delta_ms=$((resumed_ts - SWAP_END_MS))
    if [[ $delta_ms -lt 0 ]]; then delta_ms=0; fi
    awk -v c="$consumer" -v ms="$delta_ms" -v resumed="$resumed_flag" \
      'BEGIN { printf "{\"name\":\"%s\",\"reconnect_seconds\":%.2f,\"resumed\":%s}", c, ms/1000, resumed }'
  else
    awk -v c="$consumer" -v sla="$RECONNECT_SLA_SECONDS" -v resumed="$resumed_flag" \
      'BEGIN { printf "{\"name\":\"%s\",\"reconnect_seconds\":%s,\"resumed\":%s}", c, sla, resumed }'
  fi
}

CONSUMER_JSON_ARR="["
FIRST=true
for consumer in mediums sietch-discord freeside-score; do
  if $FIRST; then FIRST=false; else CONSUMER_JSON_ARR="$CONSUMER_JSON_ARR,"; fi
  CONSUMER_JSON_ARR="$CONSUMER_JSON_ARR$(build_consumer_json "$consumer")"
done
CONSUMER_JSON_ARR="$CONSUMER_JSON_ARR]"

if [[ "$ALL_RESUMED" == "true" && "$PRE_SWAP_HEALTHY" == "true" ]]; then
  PASS=true
  EXIT_CODE=0
  EXIT_REASON="ok"
else
  PASS=false
  EXIT_CODE=1
  if [[ "$PRE_SWAP_HEALTHY" != "true" ]]; then
    EXIT_REASON="pre-swap-subscribers-unhealthy"
  else
    EXIT_REASON="reconnect-sla-exceeded"
  fi
fi

jq -nc \
  --arg drill_id "$DRILL_ID" \
  --arg direction "$DIRECTION" \
  --argjson reconnect_sla_seconds "$RECONNECT_SLA_SECONDS" \
  --argjson consumers "$CONSUMER_JSON_ARR" \
  --argjson all_reconnected "$ALL_RESUMED" \
  --argjson pre_swap_healthy "$PRE_SWAP_HEALTHY" \
  --argjson pass "$PASS" \
  --arg exit_reason "$EXIT_REASON" \
  '{
    drill_id: $drill_id,
    direction: $direction,
    reconnect_sla_seconds: $reconnect_sla_seconds,
    pre_swap_healthy: $pre_swap_healthy,
    consumers: $consumers,
    all_reconnected: $all_reconnected,
    pass: $pass,
    exit_reason: $exit_reason
  }'

exit "$EXIT_CODE"
