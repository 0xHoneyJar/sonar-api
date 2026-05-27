#!/usr/bin/env bash
# scripts/railway-alerting-setup.sh
#
# T-A4.6 — Configure Railway log-rule webhooks for the cutover-window alerts.
#
# Wires three alert hooks against the deployed Ponder service:
#
#   [OUTBOX-DLQ-ALERT]   — A-2 T-A2.9 (any envelope drops to dead_letter_emits)
#   [NATS-DOUBLE-EMIT]   — this sprint (T-A4.5; unexpected duplicate envelopes)
#   cold-sync-stall      — last block tick > COLD_SYNC_STALL_SECONDS ago
#
# Each alert posts to a webhook URL supplied by the operator
# (Slack/Discord/PagerDuty). The script defaults to DRY-RUN: it computes
# the GraphQL mutation payloads + prints them, but does NOT call Railway
# unless `--apply` is passed.
#
# Authority model: this script only mutates Railway log-rule webhooks
# (an additive, reversible config). It does NOT touch service env vars,
# Hasura, or Postgres. Operator can revert by deleting the rules in the
# Railway UI.
#
# Source-of-truth: sonar-ponder-coordinator:grimoires/loa/sprint.md A-4 / T-A4.10
#                  ADR-010 (operator authorization)
#                  loa-freeside:grimoires/loa/sdd.md §10 (observability)
#
# Usage:
#   # Dry-run (print the GraphQL plan; default — safe):
#   RAILWAY_API_TOKEN=*** \
#   RAILWAY_PROJECT_ID=e240cdf0-... \
#   RAILWAY_ENVIRONMENT_ID=14424076-... \
#   BLUE_SERVICE_ID=915bcd34-... \
#   OUTBOX_DLQ_WEBHOOK=https://hooks.slack.com/... \
#   NATS_DOUBLE_EMIT_WEBHOOK=https://hooks.slack.com/... \
#   COLD_SYNC_STALL_WEBHOOK=https://hooks.slack.com/... \
#     scripts/railway-alerting-setup.sh
#
#   # Apply (operator-led):
#     scripts/railway-alerting-setup.sh --apply
#
#   # Help:
#     scripts/railway-alerting-setup.sh --help
#
# Required env:
#   RAILWAY_API_TOKEN          Workspace-scoped Railway token
#   RAILWAY_PROJECT_ID
#   RAILWAY_ENVIRONMENT_ID
#   BLUE_SERVICE_ID            Service whose log stream to attach rules to
#
# At least ONE of the webhook env vars must be set; missing webhooks
# cause that specific alert to be skipped (script does NOT fail; the
# operator can re-run to add more later).
#
#   OUTBOX_DLQ_WEBHOOK
#   NATS_DOUBLE_EMIT_WEBHOOK
#   COLD_SYNC_STALL_WEBHOOK
#
# Optional env:
#   COLD_SYNC_STALL_SECONDS    Stall threshold (default 300 = 5 min)
#   RAILWAY_GRAPHQL_URL        API endpoint (default https://backboard.railway.com/graphql/v2)
#
# Output: JSON record of plan / applied rules.
# Exit codes:
#   0 — dry-run printed plan, OR apply succeeded
#   1 — apply failed (at least one rule mutation errored)
#   2 — script error (missing env / dep)

set -euo pipefail

DRY_RUN=true
SHOW_HELP=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)   DRY_RUN=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) SHOW_HELP=true; shift ;;
    *) echo "{\"exit_reason\":\"bad-arg\",\"detail\":\"$1\"}" >&2; exit 2 ;;
  esac
done

if [[ "$SHOW_HELP" == "true" ]]; then
  sed -n '1,60p' "$0"
  exit 0
fi

command -v jq >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"jq"}' >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"curl"}' >&2; exit 2; }

REQ_MISSING=()
for v in RAILWAY_PROJECT_ID RAILWAY_ENVIRONMENT_ID BLUE_SERVICE_ID; do
  [[ -z "${!v:-}" ]] && REQ_MISSING+=("$v")
done
if [[ "$DRY_RUN" == "false" ]] && [[ -z "${RAILWAY_API_TOKEN:-}" ]]; then
  REQ_MISSING+=("RAILWAY_API_TOKEN")
fi
if [[ ${#REQ_MISSING[@]} -gt 0 ]]; then
  jq -nc --argjson missing "$(printf '%s\n' "${REQ_MISSING[@]}" | jq -R . | jq -s .)" \
    '{exit_reason:"missing-env", missing:$missing}' >&2
  exit 2
fi

RAILWAY_GRAPHQL_URL="${RAILWAY_GRAPHQL_URL:-https://backboard.railway.com/graphql/v2}"
COLD_SYNC_STALL_SECONDS="${COLD_SYNC_STALL_SECONDS:-300}"

# ────────────────────────────────────────────────────────────────────────────
# Rule definitions
# ────────────────────────────────────────────────────────────────────────────
# Each rule has: name, log-line pattern, target webhook URL, severity.
# The Railway log-rule GraphQL surface accepts a `pattern` (regex), the
# target service, and a webhook destination. We emit the corresponding
# mutation per rule.

RULES_JSON='[]'

append_rule() {
  local name="$1" pattern="$2" webhook="$3" severity="$4"
  if [[ -z "$webhook" ]]; then
    return 0
  fi
  RULES_JSON=$(echo "$RULES_JSON" | jq -c \
    --arg n "$name" --arg p "$pattern" --arg w "$webhook" --arg s "$severity" \
    '. + [{name:$n, pattern:$p, webhook:$w, severity:$s}]')
}

append_rule "outbox-dlq" "\\[OUTBOX-DLQ-ALERT\\]" "${OUTBOX_DLQ_WEBHOOK:-}" "critical"
append_rule "nats-double-emit" "\\[NATS-DOUBLE-EMIT\\]" "${NATS_DOUBLE_EMIT_WEBHOOK:-}" "critical"
append_rule "cold-sync-stall" "\\[COLD-SYNC-STALL\\]|last block tick >.*${COLD_SYNC_STALL_SECONDS}" "${COLD_SYNC_STALL_WEBHOOK:-}" "high"

RULE_COUNT=$(echo "$RULES_JSON" | jq 'length')

if [[ "$RULE_COUNT" -eq 0 ]]; then
  jq -nc \
    '{exit_reason:"no-webhooks-configured", detail:"set at least one of OUTBOX_DLQ_WEBHOOK / NATS_DOUBLE_EMIT_WEBHOOK / COLD_SYNC_STALL_WEBHOOK"}' >&2
  exit 2
fi

# ────────────────────────────────────────────────────────────────────────────
# Build the GraphQL mutations
# ────────────────────────────────────────────────────────────────────────────
# Railway exposes log-rule webhooks via the public GraphQL schema. The
# exact mutation name has shifted over versions; we use the documented
# `webhookCreate` shape and target the service-scoped log stream. If
# the schema has drifted, the API call will return a GraphQL error and
# the operator can adjust via the dashboard.

build_mutation() {
  local name="$1" pattern="$2" webhook="$3"
  jq -nc \
    --arg n "$name" --arg p "$pattern" --arg w "$webhook" \
    --arg project "$RAILWAY_PROJECT_ID" \
    --arg env "$RAILWAY_ENVIRONMENT_ID" \
    --arg service "$BLUE_SERVICE_ID" \
    '{
      query: "mutation WebhookCreate($input: WebhookCreateInput!) { webhookCreate(input: $input) { id url filters } }",
      variables: {
        input: {
          projectId: $project,
          environmentId: $env,
          serviceId: $service,
          url: $w,
          filters: [$p],
          name: $n
        }
      }
    }'
}

# ────────────────────────────────────────────────────────────────────────────
# Dry-run early-exit
# ────────────────────────────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "true" ]]; then
  PLAN='[]'
  while IFS= read -r rule; do
    [[ -z "$rule" ]] && continue
    name=$(echo "$rule" | jq -r '.name')
    pattern=$(echo "$rule" | jq -r '.pattern')
    webhook=$(echo "$rule" | jq -r '.webhook')
    mutation=$(build_mutation "$name" "$pattern" "$webhook")
    PLAN=$(echo "$PLAN" | jq -c --argjson m "$mutation" --arg n "$name" \
      '. + [{rule_name:$n, graphql_payload:$m}]')
  done < <(echo "$RULES_JSON" | jq -c '.[]')

  jq -nc \
    --argjson plan "$PLAN" \
    --argjson rules "$RULES_JSON" \
    --argjson rule_count "$RULE_COUNT" \
    --arg api "$RAILWAY_GRAPHQL_URL" \
    '{
      mode: "dry-run",
      api_endpoint: $api,
      rule_count: $rule_count,
      rules: $rules,
      mutations: $plan,
      note: "no Railway mutations performed; pass --apply to wire alerts",
      exit_reason: "dry-run-ok"
    }'
  exit 0
fi

# ────────────────────────────────────────────────────────────────────────────
# Apply path
# ────────────────────────────────────────────────────────────────────────────

APPLIED='[]'
FAILED='[]'
while IFS= read -r rule; do
  [[ -z "$rule" ]] && continue
  name=$(echo "$rule" | jq -r '.name')
  pattern=$(echo "$rule" | jq -r '.pattern')
  webhook=$(echo "$rule" | jq -r '.webhook')
  mutation=$(build_mutation "$name" "$pattern" "$webhook")

  echo "[railway-alerting] applying rule=$name" >&2
  RESPONSE=$(curl -sS --max-time 30 -X POST "$RAILWAY_GRAPHQL_URL" \
    -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$mutation" 2>&1 || echo '{"errors":[{"message":"curl-failed"}]}')

  if echo "$RESPONSE" | jq -e '.errors' >/dev/null 2>&1; then
    FAILED=$(echo "$FAILED" | jq -c \
      --arg name "$name" --argjson resp "$RESPONSE" \
      '. + [{rule_name:$name, response:$resp}]')
  else
    WEBHOOK_ID=$(echo "$RESPONSE" | jq -r '.data.webhookCreate.id // "unknown"')
    APPLIED=$(echo "$APPLIED" | jq -c \
      --arg name "$name" --arg id "$WEBHOOK_ID" \
      '. + [{rule_name:$name, webhook_id:$id}]')
  fi
done < <(echo "$RULES_JSON" | jq -c '.[]')

FAILED_COUNT=$(echo "$FAILED" | jq 'length')
APPLIED_COUNT=$(echo "$APPLIED" | jq 'length')

EXIT_REASON="ok"; EXIT_CODE=0
if [[ "$FAILED_COUNT" -gt 0 ]]; then
  EXIT_REASON="partial-failure"; EXIT_CODE=1
fi

jq -nc \
  --argjson applied "$APPLIED" \
  --argjson failed "$FAILED" \
  --argjson applied_count "$APPLIED_COUNT" \
  --argjson failed_count "$FAILED_COUNT" \
  --argjson rules "$RULES_JSON" \
  --arg exit_reason "$EXIT_REASON" \
  '{
    mode: "apply",
    rules_configured: $rules,
    applied_count: $applied_count,
    failed_count: $failed_count,
    applied: $applied,
    failed: $failed,
    exit_reason: $exit_reason
  }'

exit "$EXIT_CODE"
