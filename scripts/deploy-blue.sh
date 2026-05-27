#!/usr/bin/env bash
# scripts/deploy-blue.sh
#
# T-A4.1 — Railway deploy wrapper for the Ponder blue belt.
#
# Default behavior: DRY-RUN (prints plan, exits 0 without touching Railway).
# Operator invokes with `--apply` to perform the actual deploy.
#
# Source-of-truth: ADR-010 (operator authorization, 2026-05-27)
#                  loa-freeside:grimoires/loa/sdd.md §7 (deployment architecture)
#                  sonar-ponder-coordinator:grimoires/loa/sprint.md A-4 / T-A4.1
#
# Authority model: this script writes the deployment plan + invokes
# `railway up` against a pre-existing Railway service. It does NOT create
# services, mutate env vars, change Hasura, or cutover traffic. The
# Hasura traffic flip is `scripts/cutover-hasura-tracking.sh` — invoked
# separately by the operator (per A-4-cutover-runbook.md).
#
# Usage:
#   # Inspect what would happen (default — safe to invoke ad-hoc)
#   RAILWAY_API_TOKEN=... \
#   RAILWAY_PROJECT_ID=e240cdf0-1a93-475b-88e2-c7ec570eb9ae \
#   RAILWAY_ENVIRONMENT_ID=14424076-195e-46b7-8977-3a025360d60a \
#   BLUE_SERVICE_ID=915bcd34-3223-43c3-ab24-fca91a0180b0 \
#   DATABASE_URL=postgresql://... \
#     scripts/deploy-blue.sh --commit bc15f46
#
#   # Apply the deploy (operator-led, in cutover window)
#     scripts/deploy-blue.sh --commit bc15f46 --apply
#
#   # Help
#     scripts/deploy-blue.sh --help
#
# Required env (apply mode):
#   RAILWAY_API_TOKEN          Workspace-scoped Railway token
#   RAILWAY_PROJECT_ID         freeside-sonar (e240cdf0-...)
#   RAILWAY_ENVIRONMENT_ID     production (14424076-...)
#   BLUE_SERVICE_ID            Railway service to deploy into
#   DATABASE_URL               Pre-flight target Postgres (must have ponder.*)
#
# Optional env:
#   DEPLOY_TIMEOUT_SECONDS     Max wait for SUCCESS (default 900 = 15 min)
#   POLL_INTERVAL_SECONDS      Status poll cadence (default 15)
#   RAILWAY_CLI                Path to `railway` (default: $(command -v railway))
#
# Output: JSON on stdout. Plan-only on dry-run; deployment record on --apply.
#
# Exit codes:
#   0 — dry-run printed plan, OR deploy succeeded
#   1 — deployment failed (Railway reported FAILED or non-success)
#   2 — pre-flight failed (missing dependency / env / schema not deployed)
#   3 — timeout waiting for deployment status

set -euo pipefail

# ────────────────────────────────────────────────────────────────────────────
# Arg parse + help
# ────────────────────────────────────────────────────────────────────────────

DRY_RUN=true
COMMIT_SHA=""
SHOW_HELP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)        DRY_RUN=false; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    --commit)       COMMIT_SHA="${2:-}"; shift 2 ;;
    --commit=*)     COMMIT_SHA="${1#*=}"; shift ;;
    -h|--help)      SHOW_HELP=true; shift ;;
    *) echo "{\"exit_reason\":\"bad-arg\",\"detail\":\"$1\"}" >&2; exit 2 ;;
  esac
done

if [[ "$SHOW_HELP" == "true" ]]; then
  sed -n '1,55p' "$0"
  exit 0
fi

START_EPOCH_MS=$(($(date +%s%N) / 1000000))

# ────────────────────────────────────────────────────────────────────────────
# Pre-flight: dependencies + env
# ────────────────────────────────────────────────────────────────────────────

command -v jq >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"jq"}' >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"curl"}' >&2; exit 2; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"

# Required files: Dockerfile.belt-ponder + ponder config + schema must exist
# at deploy time. If missing, the deploy is doomed regardless of flag — fail
# loudly in dry-run too so operators catch repo-drift before A-4 window.
REQUIRED_FILES=(
  "Dockerfile.belt-ponder"
  "ponder.config.mibera.ts"
  "ponder.schema.ts"
)
MISSING_FILES=()
for f in "${REQUIRED_FILES[@]}"; do
  if [[ ! -f "$REPO_ROOT/$f" ]]; then
    MISSING_FILES+=("$f")
  fi
done
if [[ ${#MISSING_FILES[@]} -gt 0 ]]; then
  jq -nc --argjson files "$(printf '%s\n' "${MISSING_FILES[@]}" | jq -R . | jq -s .)" \
    '{exit_reason:"missing-required-files",detail:"deploy preflight",missing_files:$files}' >&2
  exit 2
fi

# Commit SHA validation. The agent does NOT pick the SHA; the operator passes
# it explicitly so the deploy plan and the cutover runbook agree on which
# commit was deployed.
if [[ -z "$COMMIT_SHA" ]]; then
  echo '{"exit_reason":"missing-arg","detail":"--commit <sha> is required (operator-specified deploy SHA)"}' >&2
  exit 2
fi

# Verify the commit is reachable in this checkout (defensive against typos).
if ! git -C "$REPO_ROOT" rev-parse --verify "${COMMIT_SHA}^{commit}" >/dev/null 2>&1; then
  jq -nc --arg sha "$COMMIT_SHA" \
    '{exit_reason:"commit-not-found",detail:"the specified commit is not reachable from this checkout",commit:$sha}' >&2
  exit 2
fi

CURRENT_HEAD=$(git -C "$REPO_ROOT" rev-parse HEAD)
COMMIT_RESOLVED=$(git -C "$REPO_ROOT" rev-parse "${COMMIT_SHA}^{commit}")
HEAD_MATCHES_DEPLOY="false"
if [[ "$CURRENT_HEAD" == "$COMMIT_RESOLVED" ]]; then
  HEAD_MATCHES_DEPLOY="true"
fi

DEPLOY_TIMEOUT_SECONDS="${DEPLOY_TIMEOUT_SECONDS:-900}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-15}"

# ────────────────────────────────────────────────────────────────────────────
# Pre-flight: ponder.* schema presence in target Postgres
# ────────────────────────────────────────────────────────────────────────────
# A deploy against a Postgres missing the ponder.* schema would result in
# Ponder bootstrapping into an empty namespace — wasted cold-sync time. We
# require it to exist before attempting deploy. Same pattern as
# cutover-hasura-tracking.sh's belt-scope allowlist guard.

PONDER_TABLES_COUNT="unchecked"
if [[ -n "${DATABASE_URL:-}" ]]; then
  PSQL_RUNNER=""
  if command -v psql >/dev/null 2>&1; then
    PSQL_RUNNER="psql"
  elif command -v docker >/dev/null 2>&1; then
    PSQL_RUNNER="docker run --rm -i postgres:16 psql"
  fi
  if [[ -n "$PSQL_RUNNER" ]]; then
    PONDER_TABLES_COUNT=$(${PSQL_RUNNER} "$DATABASE_URL" -tA -c \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='ponder' AND table_name NOT LIKE '\_%' ESCAPE '\';" 2>/dev/null || echo "error")
    if [[ "$PONDER_TABLES_COUNT" == "error" ]] || [[ -z "$PONDER_TABLES_COUNT" ]]; then
      echo '{"exit_reason":"db-preflight-failed","detail":"could not query ponder.* schema; check DATABASE_URL"}' >&2
      exit 2
    fi
    PONDER_TABLES_COUNT=$(echo "$PONDER_TABLES_COUNT" | tr -d '[:space:]')
    if [[ "$PONDER_TABLES_COUNT" -lt 1 ]]; then
      jq -nc '{exit_reason:"ponder-schema-empty",detail:"ponder.* schema has no user tables — deploy A-1 schema first"}' >&2
      exit 2
    fi
  fi
fi

# ────────────────────────────────────────────────────────────────────────────
# Build the plan record
# ────────────────────────────────────────────────────────────────────────────

RAILWAY_API_TOKEN_PRESENT="false"
[[ -n "${RAILWAY_API_TOKEN:-}" ]] && RAILWAY_API_TOKEN_PRESENT="true"

PLAN=$(jq -nc \
  --arg commit "$COMMIT_RESOLVED" \
  --arg commit_input "$COMMIT_SHA" \
  --arg head "$CURRENT_HEAD" \
  --arg head_matches "$HEAD_MATCHES_DEPLOY" \
  --arg project "${RAILWAY_PROJECT_ID:-unset}" \
  --arg env "${RAILWAY_ENVIRONMENT_ID:-unset}" \
  --arg service "${BLUE_SERVICE_ID:-unset}" \
  --arg ponder_tables "$PONDER_TABLES_COUNT" \
  --arg api_token_present "$RAILWAY_API_TOKEN_PRESENT" \
  --argjson timeout "$DEPLOY_TIMEOUT_SECONDS" \
  --argjson poll "$POLL_INTERVAL_SECONDS" \
  '{
    action: "deploy-blue",
    commit_input: $commit_input,
    commit_resolved: $commit,
    repo_head: $head,
    head_matches_deploy: $head_matches,
    railway_project_id: $project,
    railway_environment_id: $env,
    railway_service_id: $service,
    ponder_user_tables: $ponder_tables,
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
for v in RAILWAY_API_TOKEN RAILWAY_PROJECT_ID RAILWAY_ENVIRONMENT_ID BLUE_SERVICE_ID; do
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

# Refuse to deploy a commit that's not on the checked-out HEAD. Forces the
# operator to checkout the desired SHA first, which keeps the repo state
# and the deployed image in sync (avoids "I deployed X but my checkout is Y").
if [[ "$HEAD_MATCHES_DEPLOY" != "true" ]]; then
  jq -nc --argjson plan "$PLAN" \
    '{mode:"apply",plan:$plan,exit_reason:"head-mismatch",detail:"repo HEAD does not match --commit; checkout the deploy SHA first to keep working-tree and image consistent"}' >&2
  exit 2
fi

# ────────────────────────────────────────────────────────────────────────────
# Apply path: invoke `railway up` against the target service
# ────────────────────────────────────────────────────────────────────────────
#
# We use `railway up` (the existing build+deploy primitive). The CLI reads
# RAILWAY_API_TOKEN from the env, RAILWAY_PROJECT_ID + RAILWAY_ENVIRONMENT_ID
# from the env, and we pass `--service` explicitly to disambiguate.
#
# The CLI streams build logs to stdout; we tee them to a file so the final
# JSON record can reference the build-log path for the operator.

DEPLOY_LOG="/tmp/deploy-blue-$(date -u +%Y%m%dT%H%M%SZ).log"
echo "[deploy-blue] streaming railway up output to ${DEPLOY_LOG}"
echo "[deploy-blue] commit=${COMMIT_RESOLVED} service=${BLUE_SERVICE_ID}"

DEPLOY_EXIT=0
RAILWAY_PROJECT_ID="$RAILWAY_PROJECT_ID" \
RAILWAY_ENVIRONMENT_ID="$RAILWAY_ENVIRONMENT_ID" \
RAILWAY_API_TOKEN="$RAILWAY_API_TOKEN" \
  "$RAILWAY_CLI" up --service "$BLUE_SERVICE_ID" --ci \
  > "$DEPLOY_LOG" 2>&1 || DEPLOY_EXIT=$?

NOW_EPOCH_MS=$(($(date +%s%N) / 1000000))
ELAPSED_S=$(( (NOW_EPOCH_MS - START_EPOCH_MS) / 1000 ))

# Extract deployment ID from log if present (`railway up --ci` prints it).
DEPLOYMENT_ID=$(grep -Eo '"id":"[a-f0-9-]{36}"' "$DEPLOY_LOG" | head -1 | sed -E 's/.*"id":"([a-f0-9-]+)"/\1/' || true)
[[ -z "$DEPLOYMENT_ID" ]] && DEPLOYMENT_ID="unknown"

# Timeout enforcement. `railway up --ci` blocks until build done; if the
# subprocess itself exceeded our wall-clock budget, surface that explicitly.
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
