#!/usr/bin/env bash
# scripts/ac-validate.sh
#
# T-A4.3 — Per-AC validation harness, runs post-cutover.
#
# Each acceptance criterion gets its own self-contained check. Operator
# invokes per-AC; the script emits a JSON record for the runbook to
# capture. Used as input to the abort/proceed decision at the cutover
# observation milestones (T+0, T+1h, T+6h, T+24h).
#
# Source-of-truth: sonar-ponder-coordinator:grimoires/loa/sprint.md A-4
#                  ADR-010 (operator authorization)
#
# Usage:
#   scripts/ac-validate.sh <AC-NUMBER> [--quiet]
#
#   AC-NUMBER ∈ {2, 3, 4, 5, 6}
#
#   AC-2 — envelope byte-parity LIVE (compare last N envio NATS publishes
#          to last N ponder publishes via captured subscriber log)
#   AC-3 — outbox alive (pending_emits drains within OUTBOX_DRAIN_SECONDS)
#   AC-4 — consumer queries succeed (sample queries.json fixtures; each
#          <2s response time, no errors)
#   AC-5 — Hasura RTO measured during synthetic mini-cutover (<30s)
#   AC-6 — no DLQ build-up (dead_letter_emits count stays 0 over a 60s window)
#
# Env (varies per AC; missing env causes the check to fail cleanly):
#
#   AC-2: NATS_CAPTURE_DIR — directory containing captured envio + ponder
#         envelope JSON files (one file per envelope, named by deterministic_id)
#         AC_SAMPLE_N (default 10)
#
#   AC-3: DATABASE_URL (ponder schema), OUTBOX_DRAIN_SECONDS (default 30)
#
#   AC-4: HASURA_URL, HASURA_ADMIN_SECRET,
#         QUERIES_FIXTURE (default test/hasura-contract/fixtures/queries.json),
#         AC4_SAMPLE_N (default 5), AC4_MAX_MS (default 2000)
#
#   AC-5: HASURA_URL, HASURA_ADMIN_SECRET, RTO_BUDGET_SECONDS (default 30).
#         Runs a one-table synthetic untrack/track via metadata API.
#
#   AC-6: DATABASE_URL, AC6_WINDOW_SECONDS (default 60)
#
# Output: JSON record on stdout.
# Exit codes:
#   0 — AC passed
#   1 — AC failed (substantive)
#   2 — script error (missing env / dep / bad AC number)

set -euo pipefail

QUIET=false
AC_NUMBER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet) QUIET=true; shift ;;
    --dry-run) shift ;;
    -h|--help) sed -n '1,42p' "$0"; exit 0 ;;
    [0-9]*) AC_NUMBER="$1"; shift ;;
    *) echo "{\"exit_reason\":\"bad-arg\",\"detail\":\"$1\"}" >&2; exit 2 ;;
  esac
done

if [[ -z "$AC_NUMBER" ]]; then
  echo '{"exit_reason":"missing-arg","detail":"AC-NUMBER required (e.g. ac-validate.sh 2)"}' >&2
  exit 2
fi

log() { [[ "$QUIET" == "true" ]] || echo "$@" >&2; }

command -v jq >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"jq"}' >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"curl"}' >&2; exit 2; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"

START_EPOCH_MS=$(($(date +%s%N) / 1000000))

# ────────────────────────────────────────────────────────────────────────────
# AC dispatchers
# ────────────────────────────────────────────────────────────────────────────

ac_2_envelope_parity_live() {
  local capture_dir="${NATS_CAPTURE_DIR:-}"
  local sample_n="${AC_SAMPLE_N:-10}"

  if [[ -z "$capture_dir" ]] || [[ ! -d "$capture_dir" ]]; then
    jq -nc --arg ac "AC-2" --arg detail "NATS_CAPTURE_DIR unset or not a directory" \
      '{ac:$ac, passed:false, detail:$detail, exit_reason:"missing-env"}'
    return 1
  fi

  # Expected layout: $capture_dir/envio/<id>.json and $capture_dir/ponder/<id>.json
  local envio_dir="$capture_dir/envio"
  local ponder_dir="$capture_dir/ponder"

  if [[ ! -d "$envio_dir" ]] || [[ ! -d "$ponder_dir" ]]; then
    jq -nc --arg ac "AC-2" --arg detail "expected $capture_dir/{envio,ponder}/ subdirs" \
      '{ac:$ac, passed:false, detail:$detail, exit_reason:"bad-capture-layout"}'
    return 1
  fi

  # Intersection of envelope IDs present on BOTH sides — this is the set
  # we can compare byte-for-byte. AC passes if the intersection has at
  # least AC_SAMPLE_N entries and every comparison is byte-identical.
  local intersection_file
  intersection_file=$(mktemp)
  comm -12 \
    <(find "$envio_dir" -maxdepth 1 -type f -name '*.json' -printf '%f\n' | sort) \
    <(find "$ponder_dir" -maxdepth 1 -type f -name '*.json' -printf '%f\n' | sort) \
    > "$intersection_file"

  local intersection_count
  intersection_count=$(wc -l < "$intersection_file" | tr -d '[:space:]')

  if [[ "$intersection_count" -lt "$sample_n" ]]; then
    jq -nc --arg ac "AC-2" \
      --argjson have "$intersection_count" --argjson want "$sample_n" \
      '{ac:$ac, passed:false, detail:"insufficient envelope intersection",
        intersection_count:$have, sample_n:$want, exit_reason:"insufficient-samples"}'
    rm -f "$intersection_file"
    return 1
  fi

  # Compare the first N envelopes byte-for-byte (canonical JSON).
  local checked=0 mismatches=0
  local mismatch_ids='[]'
  while IFS= read -r fname; do
    [[ "$checked" -ge "$sample_n" ]] && break
    local envio_canon ponder_canon
    envio_canon=$(jq -cS . "$envio_dir/$fname" 2>/dev/null || echo "INVALID-ENVIO")
    ponder_canon=$(jq -cS . "$ponder_dir/$fname" 2>/dev/null || echo "INVALID-PONDER")
    if [[ "$envio_canon" != "$ponder_canon" ]]; then
      mismatches=$((mismatches + 1))
      mismatch_ids=$(echo "$mismatch_ids" | jq -c --arg id "$fname" '. + [$id]')
    fi
    checked=$((checked + 1))
  done < "$intersection_file"
  rm -f "$intersection_file"

  local passed="true"; local exit_reason="ok"
  if [[ "$mismatches" -gt 0 ]]; then
    passed="false"; exit_reason="parity-mismatch"
  fi

  jq -nc --arg ac "AC-2" \
    --argjson passed "$passed" \
    --argjson checked "$checked" \
    --argjson mismatches "$mismatches" \
    --argjson mismatch_ids "$mismatch_ids" \
    --argjson intersection_count "$intersection_count" \
    --arg exit_reason "$exit_reason" \
    '{ac:$ac, passed:$passed, samples_compared:$checked, mismatches:$mismatches,
      mismatch_envelope_ids:$mismatch_ids, intersection_count:$intersection_count,
      exit_reason:$exit_reason}'

  [[ "$passed" == "true" ]]
}

ac_3_outbox_alive() {
  local db="${DATABASE_URL:-}"
  local drain_s="${OUTBOX_DRAIN_SECONDS:-30}"

  if [[ -z "$db" ]]; then
    jq -nc --arg ac "AC-3" --arg detail "DATABASE_URL unset" \
      '{ac:$ac, passed:false, detail:$detail, exit_reason:"missing-env"}'
    return 1
  fi
  command -v psql >/dev/null 2>&1 || {
    jq -nc --arg ac "AC-3" --arg detail "psql required" \
      '{ac:$ac, passed:false, detail:$detail, exit_reason:"missing-dep"}'
    return 1
  }

  # Sample the pending count twice, $drain_s apart. A live outbox should
  # see new emits between samples (count fluctuates) AND not see a
  # monotonically rising backlog.
  local t0_count t1_count
  t0_count=$(psql -tA "$db" -c "SELECT COUNT(*) FROM ponder.pending_emits WHERE published_at IS NULL;" 2>/dev/null | tr -d '[:space:]' || echo "error")
  if [[ "$t0_count" == "error" ]] || [[ -z "$t0_count" ]]; then
    jq -nc --arg ac "AC-3" --arg detail "could not query pending_emits" \
      '{ac:$ac, passed:false, detail:$detail, exit_reason:"db-query-failed"}'
    return 1
  fi

  log "[ac-3] t0 pending=${t0_count}; sleeping ${drain_s}s"
  sleep "$drain_s"

  t1_count=$(psql -tA "$db" -c "SELECT COUNT(*) FROM ponder.pending_emits WHERE published_at IS NULL;" 2>/dev/null | tr -d '[:space:]' || echo "error")

  # Also check that recent publishes have happened (any row with
  # published_at within the window).
  local recent_published
  recent_published=$(psql -tA "$db" -c \
    "SELECT COUNT(*) FROM ponder.pending_emits WHERE published_at IS NOT NULL AND published_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '${drain_s} seconds') * 1000)::bigint;" \
    2>/dev/null | tr -d '[:space:]' || echo "0")

  local passed="true" exit_reason="ok" detail=""
  if [[ "$t1_count" -gt "$t0_count" ]] && [[ "$recent_published" == "0" ]]; then
    passed="false"; exit_reason="backlog-growing-no-publishes"
    detail="pending grew from ${t0_count} to ${t1_count} with zero publishes in window"
  fi

  jq -nc --arg ac "AC-3" \
    --argjson passed "$passed" \
    --argjson t0 "$t0_count" \
    --argjson t1 "$t1_count" \
    --argjson recent_published "$recent_published" \
    --argjson window "$drain_s" \
    --arg detail "$detail" \
    --arg exit_reason "$exit_reason" \
    '{ac:$ac, passed:$passed, t0_pending:$t0, t1_pending:$t1, recent_published_in_window:$recent_published,
      window_seconds:$window, detail:$detail, exit_reason:$exit_reason}'

  [[ "$passed" == "true" ]]
}

ac_4_consumer_queries() {
  local hasura="${HASURA_URL:-}"
  local secret="${HASURA_ADMIN_SECRET:-}"
  local fixture="${QUERIES_FIXTURE:-$REPO_ROOT/test/hasura-contract/fixtures/queries.json}"
  local sample_n="${AC4_SAMPLE_N:-5}"
  local max_ms="${AC4_MAX_MS:-2000}"

  if [[ -z "$hasura" ]] || [[ -z "$secret" ]]; then
    jq -nc --arg ac "AC-4" --arg detail "HASURA_URL / HASURA_ADMIN_SECRET unset" \
      '{ac:$ac, passed:false, detail:$detail, exit_reason:"missing-env"}'
    return 1
  fi
  if [[ ! -f "$fixture" ]]; then
    jq -nc --arg ac "AC-4" --arg detail "fixture not found: $fixture" \
      '{ac:$ac, passed:false, detail:$detail, exit_reason:"missing-fixture"}'
    return 1
  fi

  local total_fixtures
  total_fixtures=$(jq -r '.fixtures | length' "$fixture")
  if [[ "$total_fixtures" -lt "$sample_n" ]]; then
    sample_n="$total_fixtures"
  fi

  local results='[]' failures=0
  for i in $(seq 0 $((sample_n - 1))); do
    local q vars id
    q=$(jq -r ".fixtures[$i].query" "$fixture")
    vars=$(jq -c ".fixtures[$i].variables // {}" "$fixture")
    id=$(jq -r ".fixtures[$i].id" "$fixture")

    local t0_ms t1_ms response status_code
    t0_ms=$(($(date +%s%N) / 1000000))
    response=$(curl -sS --max-time 15 -w '\n%{http_code}' \
      -X POST "$hasura/v1/graphql" \
      -H "x-hasura-admin-secret: $secret" \
      -H "Content-Type: application/json" \
      -d "$(jq -nc --arg q "$q" --argjson v "$vars" '{query:$q, variables:$v}')" 2>/dev/null || echo $'\n000')
    t1_ms=$(($(date +%s%N) / 1000000))

    status_code=$(echo "$response" | tail -1)
    local body
    body=$(echo "$response" | sed '$d')
    local elapsed_ms=$((t1_ms - t0_ms))

    local has_errors="false"
    if echo "$body" | jq -e '.errors' >/dev/null 2>&1; then
      has_errors="true"
    fi

    local ok="true"
    if [[ "$status_code" != "200" ]]; then ok="false"; fi
    if [[ "$has_errors" == "true" ]]; then ok="false"; fi
    if [[ "$elapsed_ms" -gt "$max_ms" ]]; then ok="false"; fi

    if [[ "$ok" != "true" ]]; then failures=$((failures + 1)); fi

    results=$(echo "$results" | jq -c \
      --arg id "$id" --arg status "$status_code" --argjson elapsed "$elapsed_ms" \
      --argjson errors "$has_errors" --argjson ok "$ok" \
      '. + [{id:$id, http_status:$status, elapsed_ms:$elapsed, has_errors:$errors, ok:$ok}]')
  done

  local passed="true" exit_reason="ok"
  if [[ "$failures" -gt 0 ]]; then
    passed="false"; exit_reason="consumer-query-failure"
  fi

  jq -nc --arg ac "AC-4" \
    --argjson passed "$passed" \
    --argjson results "$results" \
    --argjson sampled "$sample_n" \
    --argjson failures "$failures" \
    --argjson max_ms "$max_ms" \
    --arg exit_reason "$exit_reason" \
    '{ac:$ac, passed:$passed, queries_sampled:$sampled, failures:$failures,
      max_ms_budget:$max_ms, per_query:$results, exit_reason:$exit_reason}'

  [[ "$passed" == "true" ]]
}

ac_5_hasura_rto() {
  local hasura="${HASURA_URL:-}"
  local secret="${HASURA_ADMIN_SECRET:-}"
  local budget="${RTO_BUDGET_SECONDS:-30}"

  if [[ -z "$hasura" ]] || [[ -z "$secret" ]]; then
    jq -nc --arg ac "AC-5" --arg detail "HASURA_URL / HASURA_ADMIN_SECRET unset" \
      '{ac:$ac, passed:false, detail:$detail, exit_reason:"missing-env"}'
    return 1
  fi

  # Synthetic mini-cutover: export → re-apply (no-op) → measure wall-clock.
  # This is the WORK PORTION of the Hasura cutover envelope without the
  # schema transform — it isolates the API/network latency component
  # which is what RTO measures.
  local t0_ms t1_ms
  t0_ms=$(($(date +%s%N) / 1000000))

  local meta
  meta=$(curl -fSs --max-time 30 -X POST "$hasura/v1/metadata" \
    -H "x-hasura-admin-secret: $secret" \
    -H "Content-Type: application/json" \
    -d '{"type":"export_metadata","args":{}}' 2>/dev/null || echo "")

  if [[ -z "$meta" ]]; then
    jq -nc --arg ac "AC-5" --arg detail "export_metadata failed" \
      '{ac:$ac, passed:false, detail:$detail, exit_reason:"export-failed"}'
    return 1
  fi

  local apply_response
  apply_response=$(curl -fSs --max-time 30 -X POST "$hasura/v1/metadata" \
    -H "x-hasura-admin-secret: $secret" \
    -H "Content-Type: application/json" \
    -d "$(echo "$meta" | jq -c '{type:"replace_metadata", version:2, args:{allow_inconsistent_metadata:false, metadata:.}}')" \
    2>/dev/null || echo "")

  t1_ms=$(($(date +%s%N) / 1000000))
  local elapsed_ms=$((t1_ms - t0_ms))
  local elapsed_s
  elapsed_s=$(awk -v ms="$elapsed_ms" 'BEGIN { printf "%.3f", ms / 1000 }')

  local consistent
  consistent=$(echo "$apply_response" | jq -r '.is_consistent // false' 2>/dev/null || echo "false")

  local passed="true" exit_reason="ok"
  if [[ "$consistent" != "true" ]]; then
    passed="false"; exit_reason="metadata-inconsistent"
  fi
  if awk -v e="$elapsed_s" -v b="$budget" 'BEGIN { exit !(e > b) }'; then
    passed="false"; exit_reason="rto-exceeded"
  fi

  jq -nc --arg ac "AC-5" \
    --argjson passed "$passed" \
    --argjson elapsed_seconds "$elapsed_s" \
    --argjson budget_seconds "$budget" \
    --argjson consistent "$consistent" \
    --arg exit_reason "$exit_reason" \
    '{ac:$ac, passed:$passed, elapsed_seconds:$elapsed_seconds, rto_budget_seconds:$budget_seconds,
      hasura_consistent:$consistent, exit_reason:$exit_reason}'

  [[ "$passed" == "true" ]]
}

ac_6_no_dlq_buildup() {
  local db="${DATABASE_URL:-}"
  local window="${AC6_WINDOW_SECONDS:-60}"

  if [[ -z "$db" ]]; then
    jq -nc --arg ac "AC-6" --arg detail "DATABASE_URL unset" \
      '{ac:$ac, passed:false, detail:$detail, exit_reason:"missing-env"}'
    return 1
  fi
  command -v psql >/dev/null 2>&1 || {
    jq -nc --arg ac "AC-6" --arg detail "psql required" \
      '{ac:$ac, passed:false, detail:$detail, exit_reason:"missing-dep"}'
    return 1
  }

  local t0_dlq t1_dlq
  t0_dlq=$(psql -tA "$db" -c "SELECT COUNT(*) FROM ponder.dead_letter_emits;" 2>/dev/null | tr -d '[:space:]' || echo "error")
  if [[ "$t0_dlq" == "error" ]]; then
    jq -nc --arg ac "AC-6" --arg detail "could not query dead_letter_emits" \
      '{ac:$ac, passed:false, detail:$detail, exit_reason:"db-query-failed"}'
    return 1
  fi

  log "[ac-6] t0 dlq=${t0_dlq}; observing for ${window}s"
  sleep "$window"
  t1_dlq=$(psql -tA "$db" -c "SELECT COUNT(*) FROM ponder.dead_letter_emits;" 2>/dev/null | tr -d '[:space:]' || echo "error")

  local delta=$((t1_dlq - t0_dlq))
  local passed="true" exit_reason="ok"
  if [[ "$delta" -gt 0 ]]; then
    passed="false"; exit_reason="dlq-grew"
  fi

  jq -nc --arg ac "AC-6" \
    --argjson passed "$passed" \
    --argjson t0 "$t0_dlq" \
    --argjson t1 "$t1_dlq" \
    --argjson delta "$delta" \
    --argjson window "$window" \
    --arg exit_reason "$exit_reason" \
    '{ac:$ac, passed:$passed, t0_dlq:$t0, t1_dlq:$t1, delta:$delta,
      window_seconds:$window, exit_reason:$exit_reason}'

  [[ "$passed" == "true" ]]
}

# ────────────────────────────────────────────────────────────────────────────
# Dispatch
# ────────────────────────────────────────────────────────────────────────────

case "$AC_NUMBER" in
  2) ac_2_envelope_parity_live ;;
  3) ac_3_outbox_alive ;;
  4) ac_4_consumer_queries ;;
  5) ac_5_hasura_rto ;;
  6) ac_6_no_dlq_buildup ;;
  *)
    jq -nc --arg ac "$AC_NUMBER" \
      '{exit_reason:"unsupported-ac", detail:"valid AC numbers: 2 3 4 5 6", ac:$ac}' >&2
    exit 2
    ;;
esac
RESULT=$?

# Re-emit elapsed_total for observability
END_EPOCH_MS=$(($(date +%s%N) / 1000000))
log "[ac-validate] AC-${AC_NUMBER} elapsed_ms=$((END_EPOCH_MS - START_EPOCH_MS))"

exit "$RESULT"
