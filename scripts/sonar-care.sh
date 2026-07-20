#!/usr/bin/env bash
# sonar-care — the gaze. Compressed "what we care about" + agent mega-command.
#
# WHY: agents re-derive SLOs, onboarding policy, and promote safety from SCALE.md
# sludge + NOTES. Care is the offline dream made runnable — a thin path with floors
# still lit. See CARE.md (prose twin) and vault doctrine "dreaming-as-consolidation"
# (orientation only).
#
# Axiom: first command an agent guesses must work or redirect with a useful hint.
# Stdout = data when --json. Stderr = diagnostics. Never silent-fail.
#
# Usage (any of these are first-try inevitable):
#   pnpm care
#   pnpm care triage
#   bash scripts/sonar-care.sh --robot-triage
#   bash scripts/sonar-care.sh capabilities --json
#   bash scripts/sonar-care.sh robot-docs guide
#
# Exit dictionary:
#   0  success (including empty recommendation lists)
#   1  user-input error (unknown verb/flag) — stderr teaches the exact command
#   2  safety-block (reserved; care is read-only today)
#   3  tool-environment error (cannot cd to repo root)
#   4  upstream failure (reserved for live probes)
#   5  conflict (reserved)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || {
  printf '%s\n' "sonar-care: cannot resolve repo root" >&2
  exit 3
}
cd "$ROOT" || {
  printf '%s\n' "sonar-care: cannot cd to $ROOT" >&2
  exit 3
}

# ── NO_COLOR / CI / TERM=dumb / non-TTY ───────────────────────────────────────
# no-color.org: NO_COLOR present (even empty) means no color.
# Non-TTY stdout always suppresses color (piped agents never get ANSI).
USE_COLOR=1
if [ -n "${NO_COLOR+x}" ] || [ "${CI:-}" = "true" ] || [ "${TERM:-}" = "dumb" ] || [ ! -t 1 ]; then
  USE_COLOR=0
fi
apply_color_vars() {
  if [ "$USE_COLOR" -eq 1 ]; then
    BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
    GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'
  else
    BOLD=""; DIM=""; RESET=""; GREEN=""; YELLOW=""; RED=""; CYAN=""
  fi
}
apply_color_vars

log() { printf '%s\n' "$*" >&2; }
out() { printf '%s\n' "$*"; }

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
CONTRACT_VERSION="sonar.care.v1"
ALIAS="https://sonar.0xhoneyjar.xyz"
# Live S1 probe: fail-soft, short timeout. Override endpoint for offline tests.
# SONAR_GRAPHQL_URL may be full GraphQL URL or alias origin (we append /v1/graphql).
CARE_PROBE_TIMEOUT_S="${SONAR_CARE_PROBE_TIMEOUT:-2}"

# SOURCE_DATE_EPOCH → ISO-8601 UTC (for any dated field we emit). Portable macOS/Linux.
care_format_epoch_iso() {
  local e="$1"
  # BSD date (macOS): -r SECONDS · GNU date: -d @SECONDS
  date -u -r "$e" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "@$e" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || printf '1970-01-01T00:00:00Z'
}

# Optional generated_at JSON fragment (only when SOURCE_DATE_EPOCH is set — omit wall-clock).
care_generated_at_json_field() {
  if [ -n "${SOURCE_DATE_EPOCH:-}" ]; then
    printf ',\n  "generated_at": %s' "$(json_str "$(care_format_epoch_iso "$SOURCE_DATE_EPOCH")")"
  fi
}

# Stable JSON stdout: sorted object keys (jq -S). Falls back to raw if jq missing/fails.
# Agents re-running the same offline command get byte-identical stdout.
emit_stable_json() {
  local raw
  raw=$(cat)
  if command -v jq >/dev/null 2>&1; then
    if printf '%s\n' "$raw" | jq -S . 2>/dev/null; then
      return 0
    fi
  fi
  printf '%s\n' "$raw"
}

# ── Intent inference (Levenshtein-ish: known verbs + common typos) ────────────
KNOWN_VERBS=(
  triage robot-triage status health care gaze next
  slo slos objectives metrics lag
  queue onboard onboarding batch taste demand ingest
  dream renvoi floors clarify systemize produce
  capabilities caps robot-docs docs guide handbook
  help -h --help
)

# Map a bad verb/token → canonical verb (stdout). Return 0 if known.
did_you_mean() {
  local bad="$1"
  # strip leading dashes so --triage / -triage still resolve
  bad="${bad#--}"
  bad="${bad#-}"
  # underscore ↔ hyphen (robot_triage, robot_docs)
  bad="${bad//_/-}"
  local c
  for c in "${KNOWN_VERBS[@]}"; do
    case "$c" in
      "$bad"*) printf '%s' "$c"; return 0 ;;
    esac
    case "$bad" in
      "$c"*) printf '%s' "$c"; return 0 ;;
    esac
  done
  # common agent typos / aliases (explicit corpus — agents type these)
  case "$bad" in
    triag|traige|triagee|triage-|robot|robot-triag|robottriage|robt-triage)
      printf 'triage'; return 0 ;;
    sl0|sloz|sla|slos-|sloo|slso|metric|metrics|lagg)
      printf 'slo'; return 0 ;;
    que|queu|qeue|qeu|q|queeu|ingest|kitchen|orders)
      printf 'queue'; return 0 ;;
    onbord|onbaord|on-board|onboardingg|onboardin|onbording|collections)
      printf 'onboard'; return 0 ;;
    capa|capas|capabilitie|capabilites|capasities|capabilties|capabilty|capability|capabilitiees)
      printf 'capabilities'; return 0 ;;
    robot-doc|robto-docs|robotdocs|robot-docss|robt-docs|robotdoc)
      printf 'robot-docs'; return 0 ;;
    dreem|dreaming|consolidat*|night)
      printf 'dream'; return 0 ;;
    renvoy|renvoid|renvoii|renvo|forget|erase)
      printf 'renvoi'; return 0 ;;
    flor|floor|florrs|flooor|floorss|flors|safety)
      printf 'floors'; return 0 ;;
    hepl|hlep|halp|hep|--h)
      printf 'help'; return 0 ;;
  esac
  return 1
}

# Map a bad flag (with leading --) → canonical flag. Return 0 if known.
# Always printf '%s' so leading dashes are never parsed as printf options.
did_you_mean_flag() {
  local bad="$1"
  case "$bad" in
    --jsno|--jason|--jsoon|--jon|--jsom|--jonson|--jsson|--josn|--jnson|--JSON|--Json|--jso)
      printf '%s' '--json'; return 0 ;;
    --robot-triag|--robot_triage|--robottriage|--robot-nextt|--robt-triage)
      printf '%s' '--robot-triage'; return 0 ;;
    --capabilitie|--capasities|--capa|--capabilites|--capabilities-)
      printf '%s' '--capabilities'; return 0 ;;
    --robot-doc|--robto-docs|--robot_docs|--robotdocs|--robot-help)
      printf '%s' '--robot-docs'; return 0 ;;
    --hepl|--halp|--hlep|--hep|--helps)
      printf '%s' '--help'; return 0 ;;
    -j|--js)
      printf '%s' '--json'; return 0 ;;
  esac
  return 1
}

# Exact corrected invocation for a canonical flag (copy-paste ready).
exact_for_flag() {
  case "$1" in
    --json)          printf '%s' 'bash scripts/sonar-care.sh triage --json' ;;
    --robot-triage)  printf '%s' 'bash scripts/sonar-care.sh --robot-triage --json' ;;
    --capabilities)  printf '%s' 'bash scripts/sonar-care.sh capabilities --json' ;;
    --robot-docs)    printf '%s' 'bash scripts/sonar-care.sh robot-docs guide' ;;
    --help)          printf '%s' 'bash scripts/sonar-care.sh --help' ;;
    *)               printf '%s' 'bash scripts/sonar-care.sh triage --json' ;;
  esac
}

# ── Care model (the compressed dream — single source for human + --json) ──────
# S1–S5 are the gaze. Floors are non-compensatory (konesans lesson).
# status: proposed | active | aspirational

emit_care_json() {
  local command="$1"
  # Additive live block only on triage/slo — fail-soft S1 lag or offline reason.
  # NEVER exit non-zero solely because the alias is offline.
  local live_json_block=""
  case "$command" in
    triage|slo)
      live_json_block="$(printf ',\n  "live": %s' "$(probe_live_s1_json)")"
      ;;
  esac
  local generated_at_block
  generated_at_block="$(care_generated_at_json_field)"
  # shellcheck disable=SC2016
  # Fixed insertion order in the heredoc; emit_stable_json re-emits with jq -S
  # (deterministic key order across jq versions / re-runs).
  cat <<EOF | emit_stable_json
{
  "schema": "${CONTRACT_VERSION}",
  "command": $(json_str "$command"),
  "git_sha": $(json_str "$GIT_SHA"),
  "alias": $(json_str "$ALIAS")${generated_at_block},
  "runtime": "self-hosted Envio HyperIndex belt on Railway (NOT managed Cloud, NOT Ponder)",
  "philosophy": [
    "Self-host the indexer; do not rent the reads",
    "Single source of truth at one block height for all consumers",
    "I see; I do not judge (Score lives elsewhere)",
    "Truth writes first; telemetry fails soft",
    "Compress the scan-set; never drop floors; renvoi is visible"
  ],
  "exit_codes": {
    "0": "success",
    "1": "user-input-error",
    "2": "safety-block",
    "3": "tool-environment-error",
    "4": "upstream-failure",
    "5": "conflict"
  },
  "slos": [
    {
      "id": "S1",
      "name": "freshness",
      "status": "proposed",
      "sli": "block_height - latest_processed_block per chain",
      "targets": {
        "1": "<50 blocks (~10m)",
        "10": "<600 blocks (~20m)",
        "8453": "<600 blocks (~20m)",
        "42161": "<2400 blocks (~10m)",
        "7777777": "<1800 blocks (~60m)",
        "80094": "<300 blocks (~10m) PRIMARY"
      },
      "probe": "pnpm care triage --json | jq .live  # fail-soft chain_metadata lag; also: pnpm pulse",
      "alert": "managed runner only (not laptop) · 2 consecutive breaches before page · SCALE.md Guardrail 2 · observe-only until baseline"
    },
    {
      "id": "S2",
      "name": "completeness",
      "status": "aspirational",
      "sli": "entity counts vs ground-truth getLogs sample (KF-012 class)",
      "target": "sample ranges match on-chain within operator-set tolerance; never trust green sync alone",
      "probe": "pnpm validate:evm-canonical · hasura counts vs explorer",
      "why": "sync-to-head with empty getLogs upstream is a silent lie"
    },
    {
      "id": "S3",
      "name": "contract_stability",
      "status": "active-discipline",
      "sli": "GraphQL contract + allowlisted consumer queries after promote",
      "target": "promote gate PASS required; schema additive preferred",
      "probe": "pnpm verify:belt-contract · scripts/promote.sh --dry-run"
    },
    {
      "id": "S4",
      "name": "onboarding_latency",
      "status": "proposed",
      "sli": "p50/p95 queued→indexed OR explicit deferred_reason",
      "target": "no black-hole queue: every job is indexed, failed, or renvoied with reason",
      "probe": "kitchen status routes · kitchen_ingest_jobs"
    },
    {
      "id": "S5",
      "name": "promote_safety",
      "status": "active",
      "sli": "BELT_UPSTREAM only via promote.sh after gate PASS; old belt retained ≥7d",
      "target": "zero ungated swaps; dry-run always available",
      "probe": "scripts/promote.sh --dry-run · scripts/promote.sh --help"
    }
  ],
  "floors": [
    {"id": "F1", "rule": "Berachain (80094) primary — strictest freshness; never compensatory-rank below long-tail"},
    {"id": "F2", "rule": "Score/consumer-critical collections cannot be renvoied by taste alone"},
    {"id": "F3", "rule": "promote never skips gate (no BELT_UPSTREAM bare env edit)"},
    {"id": "F4", "rule": "honest-green: absence is UNKNOWN/DRIFT, never silent PASS (pulse invariant)"}
  ],
  "onboarding": {
    "shape": "produce → systemize → clarify → drain under error budget",
    "produce": "Kitchen POST /v1/collections/:chain/:contract/ingest freely (cheap write)",
    "systemize": "batch by chain · start_block depth · shared reindex window · backfill estimate",
    "clarify": {
      "demand_signals": ["order_id with real consumer", "Score/CubQuests/Mibera pull", "repeat requests"],
      "taste_signals": ["Tracked* lane fit (no handler explosion)", "THJ-ecosystem adjacency", "tight start_block", "reuse across products"],
      "renvoi_reasons": ["out_of_scope", "spam_nft", "depth_too_expensive", "awaiting_batch_window", "duplicate"]
    },
    "drain": "only when S1 error budget has room; big batches do not run during lag fire",
    "queue_states": ["queued", "indexing", "completed", "failed", "deferred (aspirational)"]
  },
  "renvoi": [
    {"item": "managed Envio deployment IDs as authoritative", "reason": "superseded by ${ALIAS}"},
    {"item": "Ponder runtime / ponder-ci production gate", "reason": "ghost limb; Envio only"},
    {"item": "FIFO every Kitchen POST into immediate reindex", "reason": "reindex-all coupling; batch by taste×demand"},
    {"item": "laptop-as-alerter for S1", "reason": "sleeps; silent monitoring failure worse than no monitor"}
  ],
  "commands": {
    "triage": "pnpm care triage --json",
    "slo": "pnpm care slo --json",
    "queue": "pnpm care queue --json",
    "dream": "pnpm care dream",
    "pulse": "pnpm pulse",
    "self": "pnpm self:check",
    "promote_dry": "bash scripts/promote.sh --dry-run",
    "verify_config": "pnpm verify:belt-config",
    "arrival": "read grimoires/loa/ARRIVAL.md then CARE.md"
  },
  "recommendations": [
    {"priority": 1, "action": "Wire S1 lag probe to managed runner (GHA cron / Railway); stay observation-only until baseline", "cmd": "see CARE.md · SCALE Guardrail 2"},
    {"priority": 2, "action": "Add deferred_reason + batch_id to kitchen jobs (S4 honesty)", "cmd": "src/kitchen/types.ts + ingest store"},
    {"priority": 3, "action": "Ship per-chain split (D4) so batch onboarding stops reindexing the world", "cmd": "SCALE Decision Log D4"},
    {"priority": 4, "action": "Continuous S2 sample completeness (KF-012 class)", "cmd": "pnpm validate:evm-canonical"}
  ],
  "quick_ref": {
    "what_is_this": "freeside-sonar · self-hosted multi-chain ownership SoT",
    "public_graphql": "${ALIAS}/v1/graphql",
    "door": "grimoires/loa/ARRIVAL.md",
    "care_card": "CARE.md",
    "identity": "SOUL.md"
  }${live_json_block}
}
EOF
}

json_str() {
  # minimal JSON string escape
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '"%s"' "$s"
}

# Resolve GraphQL endpoint for live probes (env override for tests / local).
care_graphql_url() {
  local u="${SONAR_GRAPHQL_URL:-${ALIAS}/v1/graphql}"
  case "$u" in
    */v1/graphql|*/v1/graphql/) printf '%s' "${u%/}" ;;
    */) printf '%s' "${u}v1/graphql" ;;
    *) printf '%s' "${u}/v1/graphql" ;;
  esac
}

# Fail-soft live S1 probe. ALWAYS returns 0. Never writes to stdout diagnostics.
# status: ok | offline | error — offline/error never makes care exit non-zero.
probe_live_s1_json() {
  local url timeout_s resp body http_code curl_ec=0
  local primary=80094
  url="$(care_graphql_url)"
  timeout_s="${CARE_PROBE_TIMEOUT_S}"

  # curl: body + trailing http_code line. Short timeout so triage never hangs.
  resp="$(
    curl -sS \
      --connect-timeout "$timeout_s" \
      --max-time "$timeout_s" \
      -w $'\n%{http_code}' \
      -X POST "$url" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json' \
      --data '{"query":"{ chain_metadata(order_by: {chain_id: asc}) { chain_id latest_processed_block block_height } }"}' \
      2>/dev/null
  )" || curl_ec=$?

  if [ "$curl_ec" -ne 0 ] || [ -z "${resp:-}" ]; then
    local reason="unreachable"
    case "$curl_ec" in
      6) reason="could_not_resolve_host" ;;
      7) reason="connection_refused" ;;
      28) reason="timeout" ;;
      0) reason="empty_response" ;;
      *) reason="curl_exit_${curl_ec}" ;;
    esac
    printf '{"status":"offline","reason":%s,"endpoint":%s,"timeout_s":%s,"fail_soft":true,"s1":"observation_only","primary_chain_id":%s,"chains":[],"breaches":[],"summary":"alias offline — care continues"}' \
      "$(json_str "$reason")" "$(json_str "$url")" "$timeout_s" "$primary"
    return 0
  fi

  http_code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  # strip a single trailing CR if present
  body="${body%$'\r'}"
  http_code="${http_code//$'\r'/}"

  if [ -z "$http_code" ] || [ "$http_code" = "$resp" ]; then
    printf '{"status":"error","reason":%s,"endpoint":%s,"timeout_s":%s,"fail_soft":true,"s1":"observation_only","primary_chain_id":%s,"chains":[],"breaches":[],"summary":"malformed curl response — care continues"}' \
      "$(json_str "malformed_response")" "$(json_str "$url")" "$timeout_s" "$primary"
    return 0
  fi

  if [ "$http_code" != "200" ]; then
    printf '{"status":"error","reason":%s,"endpoint":%s,"timeout_s":%s,"http_status":%s,"fail_soft":true,"s1":"observation_only","primary_chain_id":%s,"chains":[],"breaches":[],"summary":"GraphQL HTTP non-200 — care continues"}' \
      "$(json_str "http_${http_code}")" "$(json_str "$url")" "$timeout_s" "$http_code" "$primary"
    return 0
  fi

  if ! command -v jq >/dev/null 2>&1; then
    printf '{"status":"ok","reason":%s,"endpoint":%s,"timeout_s":%s,"fail_soft":true,"s1":"observation_only","primary_chain_id":%s,"chains":[],"breaches":[],"summary":"reachable (install jq for per-chain lag)"}' \
      "$(json_str "reachable_jq_missing")" "$(json_str "$url")" "$timeout_s" "$primary"
    return 0
  fi

  if ! printf '%s' "$body" | jq -e . >/dev/null 2>&1; then
    printf '{"status":"error","reason":%s,"endpoint":%s,"timeout_s":%s,"fail_soft":true,"s1":"observation_only","primary_chain_id":%s,"chains":[],"breaches":[],"summary":"invalid JSON body — care continues"}' \
      "$(json_str "invalid_json")" "$(json_str "$url")" "$timeout_s" "$primary"
    return 0
  fi

  # GraphQL top-level errors
  if printf '%s' "$body" | jq -e '(.errors | type) == "array" and (.errors | length) > 0' >/dev/null 2>&1; then
    local gq_msg
    gq_msg="$(printf '%s' "$body" | jq -r '.errors[0].message // "graphql_error"' 2>/dev/null || printf 'graphql_error')"
    printf '{"status":"error","reason":%s,"endpoint":%s,"timeout_s":%s,"fail_soft":true,"s1":"observation_only","primary_chain_id":%s,"chains":[],"breaches":[],"summary":"GraphQL error — care continues"}' \
      "$(json_str "$gq_msg")" "$(json_str "$url")" "$timeout_s" "$primary"
    return 0
  fi

  # Map lag against S1 targets; s1_status is observation-only (proposed SLO).
  # chains/breaches always sorted by chain_id for deterministic JSON.
  printf '%s' "$body" | jq -c \
    --arg url "$url" \
    --argjson timeout_s "$timeout_s" \
    --argjson primary "$primary" \
    --argjson targets '{"1":50,"10":600,"8453":600,"42161":2400,"7777777":1800,"80094":300}' \
    '
    ($targets) as $t
    | (.data.chain_metadata // []) as $rows
    | ([
        $rows[]
        | . as $c
        | ($c.block_height - $c.latest_processed_block) as $lag
        | ($t[($c.chain_id|tostring)] // null) as $tgt
        | {
            chain_id: $c.chain_id,
            latest_processed_block: $c.latest_processed_block,
            block_height: $c.block_height,
            lag: $lag,
            s1_target_blocks: $tgt,
            s1_within_target: (if $tgt == null then null else ($lag <= $tgt) end),
            primary: ($c.chain_id == $primary)
          }
      ] | sort_by(.chain_id)) as $chains
    | ([$chains[] | select(.s1_within_target == false)] | sort_by(.chain_id)) as $breaches
    | (
        if ($chains|length) == 0 then "unknown"
        elif ($breaches|length) > 0 then "breach"
        elif ([$chains[] | select(.s1_within_target == true)]|length) > 0 then "within"
        else "unknown"
        end
      ) as $s1_status
    | (
        ($chains | map(select(.primary)) | .[0] // null) as $p
        | if $p == null then "reachable · no primary chain row"
          else "reachable · \($primary) lag=\($p.lag) (target <\($p.s1_target_blocks // "?")) · \($chains|length) chains · s1=\($s1_status) observe-only"
          end
      ) as $summary
    | {
        status: (if ($chains|length) == 0 then "error" else "ok" end),
        reason: (if ($chains|length) == 0 then "empty_chain_metadata" else "reachable" end),
        endpoint: $url,
        timeout_s: $timeout_s,
        fail_soft: true,
        s1: "observation_only",
        s1_status: $s1_status,
        primary_chain_id: $primary,
        chains: $chains,
        breaches: [$breaches[] | {chain_id, lag, s1_target_blocks}],
        summary: $summary
      }
    ' 2>/dev/null || printf '{"status":"error","reason":%s,"endpoint":%s,"timeout_s":%s,"fail_soft":true,"s1":"observation_only","primary_chain_id":%s,"chains":[],"breaches":[],"summary":"jq map failed — care continues"}' \
      "$(json_str "jq_map_failed")" "$(json_str "$url")" "$timeout_s" "$primary"
  return 0
}

# One-line human live status (stdout). Never hangs beyond probe timeout; never fails.
format_live_human_line() {
  local live status summary primary_bit color
  live="$(probe_live_s1_json)"
  if command -v jq >/dev/null 2>&1; then
    status="$(printf '%s' "$live" | jq -r '.status // "unknown"')"
    summary="$(printf '%s' "$live" | jq -r '.summary // .reason // "n/a"')"
    case "$status" in
      ok)
        color="${GREEN}"
        primary_bit="$(printf '%s' "$live" | jq -r '
          (.chains // [] | map(select(.primary)) | .[0]) as $p
          | if $p == null then .s1_status // "ok"
            else "\($p.chain_id) lag=\($p.lag) target<\($p.s1_target_blocks // "?") s1=\(.s1_status // "?")"
            end
        ')"
        printf '%sLIVE%s  %sok%s · %s · %s' "${BOLD}" "${RESET}" "$color" "${RESET}" "$primary_bit" "${DIM}fail-soft observe-only${RESET}"
        ;;
      offline)
        color="${YELLOW}"
        printf '%sLIVE%s  %soffline%s · %s · %s' "${BOLD}" "${RESET}" "$color" "${RESET}" "$summary" "${DIM}care continues${RESET}"
        ;;
      *)
        color="${YELLOW}"
        printf '%sLIVE%s  %s%s%s · %s · %s' "${BOLD}" "${RESET}" "$color" "$status" "${RESET}" "$summary" "${DIM}care continues${RESET}"
        ;;
    esac
  else
    printf '%sLIVE%s  probe ran (install jq for detail)' "${BOLD}" "${RESET}"
  fi
}

# ── Human surfaces ────────────────────────────────────────────────────────────
print_help() {
  cat <<EOF
${BOLD}sonar-care${RESET} · compressed care map + agent mega-command  ${DIM}(${CONTRACT_VERSION} · ${GIT_SHA})${RESET}

${BOLD}USAGE${RESET}
  pnpm care [command] [--json]
  bash scripts/sonar-care.sh [command] [--json]

${BOLD}COMMANDS${RESET}  (aliases work; typos redirect)
  ${CYAN}triage${RESET}          mega-command — SLOs + floors + queue policy + next actions  ${DIM}(default)${RESET}
  ${CYAN}slo${RESET}             S1–S5 only
  ${CYAN}queue${RESET}           onboarding produce/systemize/clarify (taste × demand)
  ${CYAN}dream${RESET}           the consolidation ritual (produce · systemize · clarify)
  ${CYAN}floors${RESET}          non-compensatory rules that never rank below noise
  ${CYAN}renvoi${RESET}          what we deliberately released (and why)
  ${CYAN}capabilities${RESET}    machine contract (--json default)
  ${CYAN}robot-docs${RESET}      paste-ready agent handbook

${BOLD}FLAGS${RESET}
  --json            stdout = pure JSON (schema ${CONTRACT_VERSION}); diagnostics on stderr
  -h, --help        this help

${BOLD}EXIT CODES${RESET}
  0 success · 1 bad input · 3 environment · (2/4/5 reserved)

${BOLD}FIRST-TRY${RESET}
  pnpm care
  pnpm care --json
  pnpm care capabilities --json
  pnpm care robot-docs

${BOLD}RELATED${RESET}
  CARE.md · grimoires/loa/ARRIVAL.md · pnpm pulse · scripts/promote.sh --dry-run
EOF
}

print_robot_docs() {
  cat <<EOF
# sonar-care — agent handbook (paste-ready)

## One Rule
First command you guess should work. Prefer:
  pnpm care --json
  pnpm care triage --json
  pnpm care capabilities --json

## What this system is
Self-hosted Envio HyperIndex belt (6 EVM + Solana) for THJ/Freeside.
Public GraphQL: ${ALIAS}/v1/graphql
You index facts. You do not score/rank people (Score is separate).

## Care model (gaze, not surveillance)
S1 freshness · S2 completeness · S3 contract stability · S4 onboarding latency · S5 promote safety
Floors F1–F4 are non-compensatory — never bury primary-chain / promote-gate / honest-green.

## Onboarding (taste × demand)
produce: accept Kitchen orders freely
systemize: batch by chain + reindex economics
clarify: rank demand×taste; renvoi with explicit reason
drain: only under S1 error budget

## Dangerous ops
promote: ONLY scripts/promote.sh (gate non-skippable). Always try --dry-run first.
Never bare-edit BELT_UPSTREAM.

## Stdout / stderr
--json → stdout is data only. Human chrome → stdout without --json; errors always stderr.

## Exit codes
0 ok · 1 user error (message names exact fix) · 3 env · never exit 1 for "empty but fine"

## Door
grimoires/loa/ARRIVAL.md then CARE.md. Do not start in NOTES.md.

## Coherence check
pnpm pulse  (0=COHERENT · 1=DRIFT · 2=UNVERIFIED)

## Live S1 (fail-soft)
pnpm care triage --json → .live
  status: ok | offline | error  (never fails the care exit code alone)
  chains[].lag = block_height - latest_processed_block
  s1_status: within | breach | unknown  (observation-only; S1 is proposed)
  Override: SONAR_GRAPHQL_URL  Timeout: SONAR_CARE_PROBE_TIMEOUT (default 2s)
EOF
}

human_triage() {
  # Human primary content on stdout (agents piping still prefer --json)
  out "${BOLD}sonar-care triage${RESET} ${DIM}· ${GIT_SHA} · ${ALIAS}${RESET}"
  out "${DIM}the gaze — five cares, floors lit, renvoi visible${RESET}"
  out "$(format_live_human_line)"
  out ""
  out "${BOLD}SLOs${RESET}"
  out "  ${GREEN}S1${RESET} freshness     proposed   lag per chain (80094 strictest)"
  out "  ${YELLOW}S2${RESET} completeness  aspirational  green sync ≠ full data (KF-012)"
  out "  ${GREEN}S3${RESET} contract      active-discipline  promote + verify:belt-contract"
  out "  ${YELLOW}S4${RESET} onboarding    proposed   queue honesty (indexed|failed|renvoied)"
  out "  ${GREEN}S5${RESET} promote       active     gate PASS only · --dry-run always"
  out ""
  out "${BOLD}FLOORS${RESET} ${DIM}(non-compensatory)${RESET}"
  out "  F1 Berachain primary · F2 Score-critical not taste-renvoiable"
  out "  F3 no ungated promote · F4 honest-green (absence ≠ pass)"
  out ""
  out "${BOLD}ONBOARDING${RESET} produce → systemize(batch) → clarify(taste×demand) → drain(under S1 budget)"
  out ""
  out "${BOLD}NEXT${RESET}"
  out "  1. ${CYAN}pnpm care triage --json${RESET}     # + .live S1 lag (fail-soft)"
  out "  2. ${CYAN}pnpm pulse${RESET}                  # live coherence"
  out "  3. ${CYAN}bash scripts/promote.sh --dry-run${RESET}"
  out "  4. ${CYAN}pnpm care queue${RESET}             # batch policy"
  out "  5. read ${CYAN}CARE.md${RESET} + ${CYAN}grimoires/loa/ARRIVAL.md${RESET}"
  out ""
  out "${DIM}renvoi: managed Envio IDs · Ponder · FIFO reindex · laptop alerter — see pnpm care renvoi${RESET}"
}

human_slo() {
  out "${BOLD}S1–S5${RESET} ${DIM}(see CARE.md for full table)${RESET}"
  out "S1 freshness · S2 completeness · S3 contract · S4 onboarding · S5 promote"
  out "$(format_live_human_line)"
  out "Probe: pnpm care slo --json | jq '{slos, live}'"
}

human_queue() {
  cat <<EOF
${BOLD}onboarding queue policy${RESET} ${DIM}(taste × demand · batch · renvoi)${RESET}

  ${CYAN}produce${RESET}    Kitchen ingest freely — status: queued
  ${CYAN}systemize${RESET}  batch by chain · start_block depth · shared window · estimate minutes
  ${CYAN}clarify${RESET}    rank: demand_signals ∧ taste_signals; floors never buried
  ${CYAN}drain${RESET}      reindex/promote only if S1 budget allows
  ${CYAN}renvoi${RESET}     deferred with reason (not silent drop)

Demand: real order_id · multi-product pull · repeats
Taste:  Tracked* lane · ecosystem fit · tight start_block · no handler explosion

Machine: pnpm care queue --json
EOF
}

human_dream() {
  cat <<EOF
${BOLD}dream ritual${RESET} ${DIM}(produce · systemize · clarify — offline collapse)${RESET}

  1. PRODUCE   ≤5 bullets: what changed in the system / queue / lag story
  2. SYSTEMIZE  attach to S1–S5 or F1–F4 OR file a gap; name CHRONOS vs KAIROS
  3. CLARIFY    one of: tense fix · supersession · renvoi-with-reason · floor check
  4. STOP       no silent promote of unread sludge to "truth"

Erasure without governance = amnesia.
Governance without erasure = equal-yellow surveillance.
This command is the gaze. Pulse is the sensor. Promote is the gate.
EOF
}

human_floors() {
  emit_care_json floors | if command -v jq >/dev/null 2>&1; then jq -r '.floors[] | "  \(.id)  \(.rule)"'; else cat; fi
}

human_renvoi() {
  emit_care_json renvoi | if command -v jq >/dev/null 2>&1; then jq -r '.renvoi[] | "  − \(.item)\n    because: \(.reason)"'; else cat; fi
}

capabilities_json() {
  local generated_at_block
  generated_at_block="$(care_generated_at_json_field)"
  cat <<EOF | emit_stable_json
{
  "schema": "${CONTRACT_VERSION}",
  "name": "sonar-care",
  "version": "0.1.0",
  "contract_version": "${CONTRACT_VERSION}",
  "git_sha": $(json_str "$GIT_SHA")${generated_at_block},
  "description": "Compressed care map + robot triage for freeside-sonar",
  "features": {
    "robot_triage": true,
    "json_stdout": true,
    "intent_inference": true,
    "robot_docs": true,
    "read_only": true,
    "live_s1_probe": true,
    "live_s1_fail_soft": true,
    "output_deterministic": true,
    "source_date_epoch": true
  },
  "commands": [
    "triage", "slo", "queue", "dream", "floors", "renvoi",
    "capabilities", "robot-docs", "help"
  ],
  "flags": ["--json", "-h", "--help", "--robot-triage"],
  "exit_codes": {
    "0": "success",
    "1": "user-input-error",
    "2": "safety-block",
    "3": "tool-environment-error",
    "4": "upstream-failure (reserved; live probe is fail-soft and does not use 4)",
    "5": "conflict"
  },
  "env": {
    "NO_COLOR": "suppress ANSI when set (including empty); also non-TTY / CI=true / TERM=dumb",
    "CI": "when true, no color",
    "TERM": "dumb suppresses color",
    "SOURCE_DATE_EPOCH": "when set, dated fields use this epoch (ISO-8601 UTC generated_at); omit wall-clock otherwise",
    "SONAR_GRAPHQL_URL": "override GraphQL endpoint for live S1 probe (default ${ALIAS}/v1/graphql)",
    "SONAR_CARE_PROBE_TIMEOUT": "live probe timeout seconds (default 2)"
  },
  "related": {
    "pulse": "pnpm pulse",
    "self": "pnpm self",
    "promote": "bash scripts/promote.sh",
    "care_md": "CARE.md",
    "arrival": "grimoires/loa/ARRIVAL.md"
  },
  "determinism": {
    "json_key_order": "sorted (jq -S)",
    "live_chains_order": "sort_by(chain_id)",
    "timestamps": "JSON fields only; never free-text wall-clock on stdout",
    "volatile_fields": []
  }
}
EOF
}

# ── Arg parse ─────────────────────────────────────────────────────────────────
JSON=0
ROBOT_TRIAGE=0
VERB=""
POSITIONAL=()

while [ $# -gt 0 ]; do
  case "$1" in
    --json|-j) JSON=1 ;;
    --robot-triage|--robot-next) ROBOT_TRIAGE=1; VERB="triage" ;;
    --robot-help|--robot-docs) VERB="robot-docs" ;;
    --capabilities) VERB="capabilities"; JSON=1 ;;
    -h|--help) VERB="help" ;;
    --*)
      log "sonar-care: unknown flag '$1'"
      flag_hint="$(did_you_mean_flag "$1" || true)"
      if [ -n "${flag_hint:-}" ]; then
        log "  did you mean '${flag_hint}'?"
        log "  exact: $(exact_for_flag "$flag_hint")"
        exit 1
      fi
      # flag may be a verb mis-spelled as a flag (--triage, --slo, --capa, …)
      verb_hint="$(did_you_mean "${1#--}" || true)"
      if [ -n "${verb_hint:-}" ]; then
        case "$verb_hint" in
          help) log "  did you mean '${verb_hint}'?"
                log "  exact: bash scripts/sonar-care.sh --help" ;;
          capabilities|robot-docs)
                log "  did you mean '${verb_hint}'?"
                log "  exact: bash scripts/sonar-care.sh ${verb_hint} --json" ;;
          *)    log "  did you mean '${verb_hint}'?"
                log "  exact: bash scripts/sonar-care.sh ${verb_hint} --json" ;;
        esac
        exit 1
      fi
      log "  did you mean one of: --json · --robot-triage · --capabilities · --help"
      log "  exact: bash scripts/sonar-care.sh triage --json"
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      ;;
  esac
  shift
done

if [ -z "$VERB" ] && [ ${#POSITIONAL[@]} -gt 0 ]; then
  VERB="${POSITIONAL[0]}"
  POSITIONAL=("${POSITIONAL[@]:1}")
fi

# bare invocation = triage (mega-command) — Axiom 15: never TUI
if [ -z "$VERB" ]; then
  VERB="triage"
fi

# normalize aliases + typos — must run in main shell (not $(...)) so exit codes stick
case "$VERB" in
  triage|robot-triage|status|health|care|gaze|next) VERB="triage" ;;
  slo|slos|objectives|metrics|lag) VERB="slo" ;;
  queue|onboard|onboarding|batch|taste|demand|ingest) VERB="queue" ;;
  dream|dreaming|produce|systemize|clarify) VERB="dream" ;;
  floors|floor|safety) VERB="floors" ;;
  renvoi|renvoy|forget|erase) VERB="renvoi" ;;
  capabilities|caps|capability) VERB="capabilities" ;;
  robot-docs|docs|guide|handbook) VERB="robot-docs" ;;
  help) VERB="help" ;;
  *)
    if hint="$(did_you_mean "$VERB")"; then
      # map hint through the same alias table once
      case "$hint" in
        triage|robot-triage|status|health|care|gaze|next) hint="triage" ;;
        slo|slos|objectives|metrics|lag) hint="slo" ;;
        queue|onboard|onboarding|batch|taste|demand|ingest) hint="queue" ;;
        dream|dreaming|produce|systemize|clarify) hint="dream" ;;
        floors|floor|safety) hint="floors" ;;
        renvoi|renvoy|forget|erase) hint="renvoi" ;;
        capabilities|caps|capability) hint="capabilities" ;;
        robot-docs|docs|guide|handbook) hint="robot-docs" ;;
        help|-h|--help) hint="help" ;;
      esac
      log "sonar-care: unknown command '$VERB' — did you mean '${hint}'?"
      if [ "$hint" = "help" ]; then
        log "  exact: bash scripts/sonar-care.sh --help"
      elif [ "$JSON" -eq 1 ] || [ "$hint" = "capabilities" ]; then
        log "  exact: bash scripts/sonar-care.sh ${hint} --json"
      else
        log "  exact: bash scripts/sonar-care.sh ${hint}"
      fi
      exit 1
    fi
    log "sonar-care: unknown command '$VERB'"
    log "  did you mean one of: triage · slo · queue · floors · renvoi · capabilities · robot-docs"
    log "  exact: bash scripts/sonar-care.sh triage --json"
    exit 1
    ;;
esac

# capabilities defaults to JSON
if [ "$VERB" = "capabilities" ]; then
  JSON=1
fi

# --json / capabilities: never emit ANSI on the data path (even on a TTY).
if [ "$JSON" -eq 1 ]; then
  USE_COLOR=0
  apply_color_vars
fi

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "$VERB" in
  help)
    print_help
    exit 0
    ;;
  capabilities)
    capabilities_json
    exit 0
    ;;
  robot-docs)
    if [ "$JSON" -eq 1 ]; then
      # still data: handbook as a field; stabilize key order via emit_stable_json
      {
        printf '{\n  "schema": "%s",\n  "command": "robot-docs",\n  "guide": ' "$CONTRACT_VERSION"
        print_robot_docs | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null \
          || { print_robot_docs | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/' | tr -d '\n' | sed 's/^/"/; s/\\n$/"/'; }
        printf '\n}\n'
      } | emit_stable_json
    else
      print_robot_docs
    fi
    exit 0
    ;;
  triage|slo|queue|dream|floors|renvoi)
    if [ "$JSON" -eq 1 ]; then
      emit_care_json "$VERB"
    else
      case "$VERB" in
        triage) human_triage ;;
        slo) human_slo; emit_care_json slo | if command -v jq >/dev/null 2>&1; then jq -r '.slos[] | "  \(.id)  \(.name)  [\(.status)]\n    SLI: \(.sli)\n    probe: \(.probe // .target)"'; else cat; fi ;;
        queue) human_queue ;;
        dream) human_dream ;;
        floors) human_floors ;;
        renvoi) human_renvoi ;;
      esac
    fi
    exit 0
    ;;
esac

log "sonar-care: internal dispatch fallthrough for verb='$VERB'"
log "  report this; fallback: bash scripts/sonar-care.sh triage --json"
exit 3
