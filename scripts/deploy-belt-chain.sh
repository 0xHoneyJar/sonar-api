#!/usr/bin/env bash
# scripts/deploy-belt-chain.sh
#
# D4 per-chain belt deploy wrapper for Railway (Envio single-chain service).
#
# Default behavior: DRY-RUN (prints the deploy plan as JSON on stdout and exits 0
# without touching Railway). Operator invokes with --apply to perform the real
# deploy.
#
# Source-of-truth: SDD §2.1 (D4 per-chain split design)
#                  SDD §7 (Railway service topology)
#                  Dockerfile.belt:27-51 (BELT_CONFIG ARG/ENV bake + NODE_OPTIONS note)
#                  KF-015 (NODE_OPTIONS structural root cause + per-chain resolution)
#
# Authority model: this script sets BELT_CONFIG on the target per-chain Railway
# service (the single knob the Dockerfile already threads via ARG/ENV/CMD) and
# invokes `railway up`. It does NOT create services, mutate Hasura, or cutover
# traffic. The gateway alias flip remains scripts/promote.sh (sole writer, R-D).
#
# NODE_OPTIONS — NOT baked per-chain (KF-015 / Dockerfile.belt:49-51):
#   Dockerfile.belt:51 bakes NODE_OPTIONS=--max-old-space-size=12288, sized for
#   the 24GB/6-chain consolidated box. Each single-chain per-chain service runs
#   in a smaller Railway container and MUST override NODE_OPTIONS via a Railway
#   service variable scaled to its chain density. Guidance by chain density:
#     Berachain (28 contracts, dense):   --max-old-space-size=8192
#     Ethereum  (8 contracts):           --max-old-space-size=4096
#     Optimism  (5 contracts):           --max-old-space-size=4096
#     Base      (5 contracts, FT-heavy): --max-old-space-size=4096
#     Arbitrum  (1 contract):            --max-old-space-size=2048
#     Zora      (1 contract):            --max-old-space-size=2048
#   This wrapper reads NODE_OPTIONS_OVERRIDE and includes it in the deploy plan
#   (making the intended value explicit) but does NOT edit the Dockerfile or set
#   the Railway variable. The operator sets NODE_OPTIONS on the service
#   separately — recommended before invoking --apply in the cutover window.
#
# Usage:
#   # Inspect what would happen (default — safe to invoke ad-hoc)
#   BELT_CONFIG=config.80094.yaml \
#   RAILWAY_API_TOKEN=... \
#   RAILWAY_PROJECT_ID=e240cdf0-1a93-475b-88e2-c7ec570eb9ae \
#   RAILWAY_ENVIRONMENT_ID=14424076-195e-46b7-8977-3a025360d60a \
#   BELT_SERVICE_ID=<railway-service-uuid> \
#     scripts/deploy-belt-chain.sh
#
#   # Apply the deploy (operator-led, in cutover window)
#   NODE_OPTIONS_OVERRIDE=--max-old-space-size=4096 \
#     scripts/deploy-belt-chain.sh --apply
#
#   # Help
#     scripts/deploy-belt-chain.sh --help
#
# Required env (all modes):
#   BELT_CONFIG                Config file selecting the per-chain belt
#                              (e.g., config.80094.yaml). Must exist on disk in
#                              the repo root; pre-flight fails (exit 2) if missing.
#                              Passed as both Railway build ARG and runtime ENV so
#                              envio codegen bakes the correct chain bindings
#                              (Dockerfile.belt:30-31,42,61).
#
# Required env (apply mode only):
#   RAILWAY_API_TOKEN          Workspace-scoped Railway token
#   RAILWAY_PROJECT_ID         freeside-sonar (e240cdf0-...)
#   RAILWAY_ENVIRONMENT_ID     production (14424076-...)
#   BELT_SERVICE_ID            Per-chain Railway service to deploy into
#
# Optional env:
#   NODE_OPTIONS_OVERRIDE      Per-chain Node heap ceiling to document in the
#                              plan (e.g., --max-old-space-size=4096). Included
#                              in the JSON plan only — NOT set by this script.
#                              The operator MUST set NODE_OPTIONS on the Railway
#                              service independently (KF-015; Dockerfile.belt:51
#                              bakes 12288 sized for 24GB/6-chain — wrong for
#                              single-chain containers).
#   DEPLOY_TIMEOUT_SECONDS     Max wait for SUCCESS (default 900 = 15 min)
#   POLL_INTERVAL_SECONDS      Status poll cadence (default 15)
#   RAILWAY_CLI                Path to `railway` (default: $(command -v railway))
#
# Output: JSON on stdout. Plan-only on dry-run; deployment record on --apply.
#
# Exit codes:
#   0 — dry-run printed plan, OR deploy succeeded
#   1 — deployment failed (Railway reported FAILED or non-success)
#   2 — pre-flight failed (missing dependency / env / config file not found)
#   3 — timeout waiting for deployment status

set -euo pipefail

# ────────────────────────────────────────────────────────────────────────────
# Arg parse + help
# ────────────────────────────────────────────────────────────────────────────

DRY_RUN=true
SHOW_HELP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)        DRY_RUN=false; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    -h|--help)      SHOW_HELP=true; shift ;;
    *) echo "{\"exit_reason\":\"bad-arg\",\"detail\":\"$1\"}" >&2; exit 2 ;;
  esac
done

if [[ "$SHOW_HELP" == "true" ]]; then
  sed -n '1,87p' "$0"
  exit 0
fi

START_EPOCH_MS=$(($(date +%s%N) / 1000000))

# ────────────────────────────────────────────────────────────────────────────
# Pre-flight: dependencies
# ────────────────────────────────────────────────────────────────────────────

command -v jq >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"jq"}' >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"git"}' >&2; exit 2; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"

# ────────────────────────────────────────────────────────────────────────────
# Pre-flight: BELT_CONFIG validation (exit 2 if unset or file missing)
# ────────────────────────────────────────────────────────────────────────────
#
# BELT_CONFIG is the single per-chain knob threaded through the Dockerfile:
#   - Build ARG  (Dockerfile.belt:30): envio codegen bakes chain bindings
#   - Runtime ENV (Dockerfile.belt:31,61): envio start selects the config
# The file must exist on disk at deploy time — `COPY . .` at Dockerfile.belt:26
# embeds it in the image; a missing file means a broken image guaranteed.

if [[ -z "${BELT_CONFIG:-}" ]]; then
  echo '{"exit_reason":"missing-env","detail":"BELT_CONFIG is required (e.g., BELT_CONFIG=config.80094.yaml)"}' >&2
  exit 2
fi

BELT_CONFIG_PATH="$REPO_ROOT/$BELT_CONFIG"
if [[ ! -f "$BELT_CONFIG_PATH" ]]; then
  jq -nc \
    --arg cfg "$BELT_CONFIG" \
    --arg path "$BELT_CONFIG_PATH" \
    '{exit_reason:"config-not-found",detail:"BELT_CONFIG file does not exist on disk — pre-flight fail",belt_config:$cfg,resolved_path:$path}' >&2
  exit 2
fi

# ────────────────────────────────────────────────────────────────────────────
# NODE_OPTIONS override — documented in plan, NOT applied by this script
# ────────────────────────────────────────────────────────────────────────────
#
# Dockerfile.belt:51 bakes NODE_OPTIONS=--max-old-space-size=12288 (sized for
# the 24GB/6-chain consolidated box). A per-chain belt in a smaller Railway
# container MUST override this. This wrapper surfaces NODE_OPTIONS_OVERRIDE
# in the plan so the operator has an explicit reminder; it does not mutate
# the Railway service variable for NODE_OPTIONS (only BELT_CONFIG is set).

NODE_OPTIONS_OVERRIDE="${NODE_OPTIONS_OVERRIDE:-}"
NODE_OPTIONS_NOTE="NOT set by this wrapper — operator must set NODE_OPTIONS on the Railway service to override Dockerfile.belt:51 default (--max-old-space-size=12288 is sized for 24GB/6-chain; too large for single-chain containers and too small for dense chains in under-provisioned boxes; KF-015)"

DEPLOY_TIMEOUT_SECONDS="${DEPLOY_TIMEOUT_SECONDS:-900}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-15}"

# ────────────────────────────────────────────────────────────────────────────
# Build the plan record
# ────────────────────────────────────────────────────────────────────────────

RAILWAY_API_TOKEN_PRESENT="false"
[[ -n "${RAILWAY_API_TOKEN:-}" ]] && RAILWAY_API_TOKEN_PRESENT="true"

PLAN=$(jq -nc \
  --arg belt_config "$BELT_CONFIG" \
  --arg belt_config_path "$BELT_CONFIG_PATH" \
  --arg project "${RAILWAY_PROJECT_ID:-unset}" \
  --arg env_id "${RAILWAY_ENVIRONMENT_ID:-unset}" \
  --arg service "${BELT_SERVICE_ID:-unset}" \
  --arg node_options_override "${NODE_OPTIONS_OVERRIDE}" \
  --arg node_options_note "$NODE_OPTIONS_NOTE" \
  --arg api_token_present "$RAILWAY_API_TOKEN_PRESENT" \
  --argjson timeout "$DEPLOY_TIMEOUT_SECONDS" \
  --argjson poll "$POLL_INTERVAL_SECONDS" \
  '{
    action: "deploy-belt-chain",
    belt_config: $belt_config,
    belt_config_path: $belt_config_path,
    railway_project_id: $project,
    railway_environment_id: $env_id,
    railway_service_id: $service,
    node_options_override: (if $node_options_override == "" then null else $node_options_override end),
    node_options_note: $node_options_note,
    api_token_present: $api_token_present,
    deploy_timeout_seconds: $timeout,
    poll_interval_seconds: $poll
  }')

# ────────────────────────────────────────────────────────────────────────────
# Dry-run early-exit
# ────────────────────────────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "true" ]]; then
  jq -nc \
    --argjson plan "$PLAN" \
    '{
      mode: "dry-run",
      plan: $plan,
      note: "no Railway mutations performed; pass --apply to deploy",
      exit_reason: "dry-run-ok"
    }'
  exit 0
fi

# ────────────────────────────────────────────────────────────────────────────
# Apply path: validate apply-only env vars
# ────────────────────────────────────────────────────────────────────────────

APPLY_MISSING=()
for v in RAILWAY_API_TOKEN RAILWAY_PROJECT_ID RAILWAY_ENVIRONMENT_ID BELT_SERVICE_ID; do
  if [[ -z "${!v:-}" ]]; then
    APPLY_MISSING+=("$v")
  fi
done
if [[ ${#APPLY_MISSING[@]} -gt 0 ]]; then
  jq -nc \
    --argjson plan "$PLAN" \
    --argjson missing "$(printf '%s\n' "${APPLY_MISSING[@]}" | jq -R . | jq -s .)" \
    '{mode:"apply",plan:$plan,exit_reason:"missing-env",missing:$missing}' >&2
  exit 2
fi

RAILWAY_CLI="${RAILWAY_CLI:-$(command -v railway 2>/dev/null || true)}"
if [[ -z "$RAILWAY_CLI" ]] || [[ ! -x "$RAILWAY_CLI" ]]; then
  jq -nc --argjson plan "$PLAN" \
    '{mode:"apply",plan:$plan,exit_reason:"missing-dep",detail:"railway CLI not in PATH; install or set RAILWAY_CLI"}' >&2
  exit 2
fi

# ────────────────────────────────────────────────────────────────────────────
# Apply path: set BELT_CONFIG on the Railway service before triggering the build
# ────────────────────────────────────────────────────────────────────────────
#
# Railway passes service variables as build ARGs for ARG declarations in
# Dockerfiles. BELT_CONFIG must be set before `railway up` so the build
# picks up the correct per-chain config for `envio codegen` (Dockerfile.belt:42).
# --skip-deploys prevents a premature intermediate redeploy; the subsequent
# `railway up` is the authoritative trigger.
#
# This is the ONLY env mutation performed by this script. It touches BELT_CONFIG
# only — not NODE_OPTIONS, not DATABASE_URL, not any Hasura variable.

echo "[deploy-belt-chain] setting BELT_CONFIG=${BELT_CONFIG} on service ${BELT_SERVICE_ID}"
RAILWAY_API_TOKEN="$RAILWAY_API_TOKEN" \
  "$RAILWAY_CLI" variable set \
    "BELT_CONFIG=${BELT_CONFIG}" \
    --service "$BELT_SERVICE_ID" \
    --environment "$RAILWAY_ENVIRONMENT_ID" \
    --project "$RAILWAY_PROJECT_ID" \
    --skip-deploys \
  || {
    jq -nc --argjson plan "$PLAN" \
      '{mode:"apply",plan:$plan,exit_reason:"variable-set-failed",detail:"railway variable set BELT_CONFIG failed; check RAILWAY_API_TOKEN, BELT_SERVICE_ID, and RAILWAY_ENVIRONMENT_ID"}' >&2
    exit 2
  }

# ────────────────────────────────────────────────────────────────────────────
# Apply path: invoke `railway up` against the target service
# ────────────────────────────────────────────────────────────────────────────
#
# `railway up --ci` blocks until the build finishes. Logs are tee'd to a
# temp file so the final JSON record can reference the build-log path.

DEPLOY_LOG="/tmp/deploy-belt-chain-$(date -u +%Y%m%dT%H%M%SZ).log"
echo "[deploy-belt-chain] streaming railway up output to ${DEPLOY_LOG}"
echo "[deploy-belt-chain] belt_config=${BELT_CONFIG} service=${BELT_SERVICE_ID}"

DEPLOY_EXIT=0
RAILWAY_PROJECT_ID="$RAILWAY_PROJECT_ID" \
RAILWAY_ENVIRONMENT_ID="$RAILWAY_ENVIRONMENT_ID" \
RAILWAY_API_TOKEN="$RAILWAY_API_TOKEN" \
  "$RAILWAY_CLI" up --service "$BELT_SERVICE_ID" --ci \
  > "$DEPLOY_LOG" 2>&1 || DEPLOY_EXIT=$?

NOW_EPOCH_MS=$(($(date +%s%N) / 1000000))
ELAPSED_S=$(( (NOW_EPOCH_MS - START_EPOCH_MS) / 1000 ))

DEPLOYMENT_ID=$(grep -Eo '"id":"[a-f0-9-]{36}"' "$DEPLOY_LOG" | head -1 | sed -E 's/.*"id":"([a-f0-9-]+)"/\1/' || true)
[[ -z "$DEPLOYMENT_ID" ]] && DEPLOYMENT_ID="unknown"

if [[ "$ELAPSED_S" -gt "$DEPLOY_TIMEOUT_SECONDS" ]]; then
  jq -nc \
    --argjson plan "$PLAN" \
    --arg deployment_id "$DEPLOYMENT_ID" \
    --arg log "$DEPLOY_LOG" \
    --argjson elapsed "$ELAPSED_S" \
    --argjson budget "$DEPLOY_TIMEOUT_SECONDS" \
    '{
      mode: "apply",
      plan: $plan,
      deployment_id: $deployment_id,
      status: "TIMEOUT",
      elapsed_seconds: $elapsed,
      timeout_budget_seconds: $budget,
      log_path: $log,
      exit_reason: "deploy-timeout"
    }' >&2
  exit 3
fi

if [[ "$DEPLOY_EXIT" -ne 0 ]]; then
  jq -nc \
    --argjson plan "$PLAN" \
    --arg deployment_id "$DEPLOYMENT_ID" \
    --arg log "$DEPLOY_LOG" \
    --argjson elapsed "$ELAPSED_S" \
    --argjson exit "$DEPLOY_EXIT" \
    '{
      mode: "apply",
      plan: $plan,
      deployment_id: $deployment_id,
      status: "FAILED",
      elapsed_seconds: $elapsed,
      cli_exit_code: $exit,
      log_path: $log,
      exit_reason: "deploy-failed"
    }' >&2
  exit 1
fi

jq -nc \
  --argjson plan "$PLAN" \
  --arg deployment_id "$DEPLOYMENT_ID" \
  --arg log "$DEPLOY_LOG" \
  --argjson elapsed "$ELAPSED_S" \
  '{
    mode: "apply",
    plan: $plan,
    deployment_id: $deployment_id,
    status: "SUCCESS",
    elapsed_seconds: $elapsed,
    log_path: $log,
    exit_reason: "ok"
  }'
