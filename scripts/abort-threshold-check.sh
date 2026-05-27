#!/usr/bin/env bash
# scripts/abort-threshold-check.sh
#
# T-A4.2 (AC-1) — Pre-cutover go/no-go check.
#
# Runs BEFORE `cutover-hasura-tracking.sh cutover`. Aggregates several
# health signals into a single go/no-go verdict. Exits 0 if cutover is
# safe to proceed; exits 1 with detailed JSON if ANY check fails.
#
# Checks (per sprint A-4 / SDD §10):
#
#   AC-1 cold-sync caught up:
#     head_block - last_indexed_block < CONFIRMATIONS_BY_CHAIN
#     (default per-chain: 12; override via CONFIRMATIONS_<CHAIN_ID>=N)
#
#   outbox backlog:
#     pending_emits count < OUTBOX_BACKLOG_MAX (default 100)
#
#   DLQ clean:
#     dead_letter_emits count == 0 (any DLQ entries block cutover)
#
#   Hasura expected pre-cutover state:
#     introspection reports `MintEvent` (PascalCase envio shape) AND does
#     NOT report `ponder_mint_event` (cutover-leaked prefix). Confirms we
#     are pre-cutover, not mid-flight.
#
#   envio belt-indexer healthy (sanity — we don't cutover a broken side):
#     ENVIO_HEALTH_URL returns 200 within 5s.
#
# Source-of-truth: sonar-ponder-coordinator:grimoires/loa/sprint.md A-4 §T-A4.3
#                  loa-freeside:grimoires/loa/sdd.md §10 (observability)
#                  ADR-010 (operator authorization, abort criteria)
#
# Usage:
#   DATABASE_URL=postgresql://... \
#   HASURA_URL=https://belt-hasura.up.railway.app \
#   HASURA_ADMIN_SECRET=... \
#   PONDER_HEAD_URL=https://belt-indexer-green.up.railway.app/ready \
#   PONDER_INDEXED_URL=https://belt-indexer-green.up.railway.app/sync-status \
#   ENVIO_HEALTH_URL=https://belt-indexer.up.railway.app/healthz \
#   CHAIN_IDS="1,10,42161" \
#     scripts/abort-threshold-check.sh
#
#   # JSON-only output (suppress stderr progress):
#     scripts/abort-threshold-check.sh --quiet
#
#   # Help
#     scripts/abort-threshold-check.sh --help
#
# Output: single JSON document on stdout.
#   { checks: [{name, passed, detail}], abort: bool, reason }
#
# Exit codes:
#   0 — go (all checks passed)
#   1 — abort (at least one check failed)
#   2 — script error (missing env / dep / unreachable endpoint)

set -euo pipefail

QUIET=false
SHOW_HELP=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet)    QUIET=true; shift ;;
    --dry-run)  shift ;;
    -h|--help)  SHOW_HELP=true; shift ;;
    *) echo "{\"exit_reason\":\"bad-arg\",\"detail\":\"$1\"}" >&2; exit 2 ;;
  esac
done

if [[ "$SHOW_HELP" == "true" ]]; then
  sed -n '1,55p' "$0"
  exit 0
fi

log() { [[ "$QUIET" == "true" ]] || echo "$@" >&2; }

# ────────────────────────────────────────────────────────────────────────────
# Deps + env
# ────────────────────────────────────────────────────────────────────────────

command -v jq >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"jq"}' >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"curl"}' >&2; exit 2; }

PSQL_RUNNER=""
if command -v psql >/dev/null 2>&1; then
  PSQL_RUNNER="psql"
elif command -v docker >/dev/null 2>&1; then
  PSQL_RUNNER="docker run --rm -i postgres:16 psql"
fi

REQ_MISSING=()
for v in DATABASE_URL HASURA_URL HASURA_ADMIN_SECRET; do
  if [[ -z "${!v:-}" ]]; then
    REQ_MISSING+=("$v")
  fi
done
if [[ ${#REQ_MISSING[@]} -gt 0 ]]; then
  jq -nc --argjson missing "$(printf '%s\n' "${REQ_MISSING[@]}" | jq -R . | jq -s .)" \
    '{exit_reason:"missing-env",missing:$missing}' >&2
  exit 2
fi
if [[ -z "$PSQL_RUNNER" ]]; then
  echo '{"exit_reason":"missing-dep","detail":"need psql OR docker (postgres:16)"}' >&2
  exit 2
fi

CHAIN_IDS="${CHAIN_IDS:-1,10,42161,7777777,8453,80094}"
OUTBOX_BACKLOG_MAX="${OUTBOX_BACKLOG_MAX:-100}"
DEFAULT_CONFIRMATIONS="${DEFAULT_CONFIRMATIONS:-12}"
ENVIO_HEALTH_URL="${ENVIO_HEALTH_URL:-}"

# Accumulator for check records.
CHECKS_JSON='[]'
ABORT=false
ABORT_REASON=""

append_check() {
  local name="$1" passed="$2" detail="$3"
  CHECKS_JSON=$(echo "$CHECKS_JSON" | jq -c \
    --arg n "$name" --argjson p "$passed" --arg d "$detail" \
    '. + [{name:$n, passed:$p, detail:$d}]')
  if [[ "$passed" != "true" ]]; then
    ABORT=true
    [[ -z "$ABORT_REASON" ]] && ABORT_REASON="$name"
  fi
}

# ────────────────────────────────────────────────────────────────────────────
# Check 1: AC-1 cold-sync caught up (per chain)
# ────────────────────────────────────────────────────────────────────────────
# We read indexed-head per chain from ponder._meta (Ponder writes the
# latest indexed checkpoint per chain). If `ponder._meta` does not exist
# (pre-A-1 schema), the check FAILS — cutover is unsafe.

log "[abort-check] AC-1 cold-sync per chain"

META_EXISTS=$(${PSQL_RUNNER} "$DATABASE_URL" -tA -c \
  "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='ponder' AND table_name='_meta');" \
  2>/dev/null | tr -d '[:space:]' || echo "f")

if [[ "$META_EXISTS" != "t" ]]; then
  append_check "ac1-cold-sync" false "ponder._meta does not exist — Ponder has never run against this DB. Deploy A-1 schema + run Ponder before cutover."
else
  IFS=',' read -ra CHAIN_ARR <<< "$CHAIN_IDS"
  COLD_SYNC_FAILED=false
  COLD_SYNC_DETAIL=""
  for chain_id in "${CHAIN_ARR[@]}"; do
    chain_id=$(echo "$chain_id" | tr -d '[:space:]')

    # Per-chain confirmation override: CONFIRMATIONS_1=64, etc.
    CONF_VAR="CONFIRMATIONS_${chain_id}"
    CONFIRMATIONS="${!CONF_VAR:-$DEFAULT_CONFIRMATIONS}"

    INDEXED=$(${PSQL_RUNNER} "$DATABASE_URL" -tA -c \
      "SELECT COALESCE(checkpoint, '0') FROM ponder._meta WHERE chain_id = ${chain_id} LIMIT 1;" \
      2>/dev/null | tr -d '[:space:]' || echo "")

    if [[ -z "$INDEXED" ]] || [[ "$INDEXED" == "0" ]]; then
      COLD_SYNC_FAILED=true
      COLD_SYNC_DETAIL="${COLD_SYNC_DETAIL}chain ${chain_id}: no checkpoint recorded; "
      continue
    fi

    # Head-block lookup requires an RPC URL per chain. We support an
    # optional PONDER_HEAD_URL_<CHAIN_ID> env var; if absent, we trust
    # the operator-supplied PONDER_HEAD_URL aggregator (a JSON map).
    HEAD_VAR="PONDER_HEAD_URL_${chain_id}"
    HEAD_URL="${!HEAD_VAR:-}"

    if [[ -z "$HEAD_URL" ]] && [[ -z "${PONDER_HEAD_URL:-}" ]]; then
      # No RPC available — fall back to ponder.* sync status if present.
      # If the operator has not provided either, we record the per-chain
      # check as "unverified" and require explicit override.
      COLD_SYNC_FAILED=true
      COLD_SYNC_DETAIL="${COLD_SYNC_DETAIL}chain ${chain_id}: no head-block RPC URL (set PONDER_HEAD_URL or PONDER_HEAD_URL_${chain_id}); "
      continue
    fi

    if [[ -n "$HEAD_URL" ]]; then
      HEAD_BLOCK=$(curl -fSs --max-time 10 -X POST "$HEAD_URL" \
        -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' 2>/dev/null \
        | jq -r '.result // empty' 2>/dev/null || echo "")
      if [[ -n "$HEAD_BLOCK" ]] && [[ "$HEAD_BLOCK" =~ ^0x ]]; then
        HEAD_BLOCK=$((HEAD_BLOCK))
      else
        HEAD_BLOCK=""
      fi
    else
      # Try the aggregator URL — expected to return {"<chain_id>": <head_block>}
      HEAD_BLOCK=$(curl -fSs --max-time 10 "$PONDER_HEAD_URL" 2>/dev/null \
        | jq -r ".[\"${chain_id}\"] // empty" 2>/dev/null || echo "")
    fi

    if [[ -z "$HEAD_BLOCK" ]]; then
      COLD_SYNC_FAILED=true
      COLD_SYNC_DETAIL="${COLD_SYNC_DETAIL}chain ${chain_id}: head-block fetch failed; "
      continue
    fi

    LAG=$((HEAD_BLOCK - INDEXED))
    if [[ "$LAG" -ge "$CONFIRMATIONS" ]]; then
      COLD_SYNC_FAILED=true
      COLD_SYNC_DETAIL="${COLD_SYNC_DETAIL}chain ${chain_id}: lag=${LAG} ≥ confirmations=${CONFIRMATIONS} (head=${HEAD_BLOCK} indexed=${INDEXED}); "
    fi
  done

  if [[ "$COLD_SYNC_FAILED" == "true" ]]; then
    append_check "ac1-cold-sync" false "${COLD_SYNC_DETAIL%; }"
  else
    append_check "ac1-cold-sync" true "all chains within confirmation window"
  fi
fi

# ────────────────────────────────────────────────────────────────────────────
# Check 2: outbox backlog (pending_emits)
# ────────────────────────────────────────────────────────────────────────────

log "[abort-check] outbox backlog"

PENDING_COUNT=$(${PSQL_RUNNER} "$DATABASE_URL" -tA -c \
  "SELECT COUNT(*) FROM ponder.pending_emits WHERE published_at IS NULL;" \
  2>/dev/null | tr -d '[:space:]' || echo "error")

if [[ "$PENDING_COUNT" == "error" ]] || [[ -z "$PENDING_COUNT" ]]; then
  append_check "outbox-backlog" false "could not query ponder.pending_emits"
elif [[ "$PENDING_COUNT" -ge "$OUTBOX_BACKLOG_MAX" ]]; then
  append_check "outbox-backlog" false "pending_emits=${PENDING_COUNT} ≥ max=${OUTBOX_BACKLOG_MAX} — drain backlog before cutover"
else
  append_check "outbox-backlog" true "pending_emits=${PENDING_COUNT} < max=${OUTBOX_BACKLOG_MAX}"
fi

# ────────────────────────────────────────────────────────────────────────────
# Check 3: DLQ clean
# ────────────────────────────────────────────────────────────────────────────

log "[abort-check] DLQ clean"

DLQ_COUNT=$(${PSQL_RUNNER} "$DATABASE_URL" -tA -c \
  "SELECT COUNT(*) FROM ponder.dead_letter_emits;" \
  2>/dev/null | tr -d '[:space:]' || echo "error")

if [[ "$DLQ_COUNT" == "error" ]] || [[ -z "$DLQ_COUNT" ]]; then
  append_check "dlq-clean" false "could not query ponder.dead_letter_emits"
elif [[ "$DLQ_COUNT" -gt 0 ]]; then
  append_check "dlq-clean" false "dead_letter_emits=${DLQ_COUNT} > 0 — investigate before cutover"
else
  append_check "dlq-clean" true "dead_letter_emits=0"
fi

# ────────────────────────────────────────────────────────────────────────────
# Check 4: Hasura is in expected pre-cutover state
# ────────────────────────────────────────────────────────────────────────────

log "[abort-check] Hasura pre-cutover state"

INTROSPECTION=$(curl -fSs --max-time 15 -X POST "${HASURA_URL}/v1/graphql" \
  -H "x-hasura-admin-secret: ${HASURA_ADMIN_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ __schema { queryType { fields { name } } } }"}' 2>/dev/null || echo "")

if [[ -z "$INTROSPECTION" ]]; then
  append_check "hasura-pre-cutover" false "introspection request failed"
else
  PREFIXED_COUNT=$(echo "$INTROSPECTION" | jq -r '
    [.data.__schema.queryType.fields[]?.name | select(test("^ponder_"; "i"))] | length
  ' 2>/dev/null || echo "error")

  PASCAL_PRESENT=$(echo "$INTROSPECTION" | jq -r '
    [.data.__schema.queryType.fields[]?.name | select(test("^[A-Z]"))] | length > 0
  ' 2>/dev/null || echo "false")

  if [[ "$PREFIXED_COUNT" == "error" ]]; then
    append_check "hasura-pre-cutover" false "introspection parse failed"
  elif [[ "$PREFIXED_COUNT" -gt 0 ]]; then
    append_check "hasura-pre-cutover" false "Hasura already shows ${PREFIXED_COUNT} ponder_* prefixed fields — appears to be MID-CUTOVER. Run rollback first."
  elif [[ "$PASCAL_PRESENT" != "true" ]]; then
    append_check "hasura-pre-cutover" false "Hasura returned no PascalCase root fields — schema may be empty"
  else
    append_check "hasura-pre-cutover" true "envio public.* tracking active; no ponder_* leaks"
  fi
fi

# ────────────────────────────────────────────────────────────────────────────
# Check 5: envio belt-indexer healthy (advisory; only if URL provided)
# ────────────────────────────────────────────────────────────────────────────

if [[ -n "$ENVIO_HEALTH_URL" ]]; then
  log "[abort-check] envio belt-indexer health"
  HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "$ENVIO_HEALTH_URL" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    append_check "envio-healthy" true "envio health 200 at ${ENVIO_HEALTH_URL}"
  else
    append_check "envio-healthy" false "envio health ${HTTP_CODE} at ${ENVIO_HEALTH_URL} — won't cutover a broken side"
  fi
else
  append_check "envio-healthy" true "ENVIO_HEALTH_URL unset — skipped (advisory check)"
fi

# ────────────────────────────────────────────────────────────────────────────
# Final verdict
# ────────────────────────────────────────────────────────────────────────────

if [[ "$ABORT" == "true" ]]; then
  jq -nc \
    --argjson checks "$CHECKS_JSON" \
    --argjson abort true \
    --arg reason "$ABORT_REASON" \
    '{checks:$checks, abort:$abort, reason:$reason, verdict:"NO-GO"}'
  exit 1
fi

jq -nc \
  --argjson checks "$CHECKS_JSON" \
  --argjson abort false \
  '{checks:$checks, abort:$abort, reason:"", verdict:"GO"}'
exit 0
