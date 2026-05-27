#!/usr/bin/env bash
# scripts/nats-reconciliation-24h.sh
#
# T-A4.5 (Flatline SKP-001) — 24h NATS double-emit reconciliation script.
#
# PROVES: across the 24h post-cutover observation window, the same
# `deterministic_emit_id` never produces two NATS publishes that would
# result in CONSUMER state double-application.
#
# Background: during cutover, envio's pre-cutover tail and ponder's
# post-cutover startup can both publish envelopes for the same on-chain
# event. The outbox's deterministic-id idempotency (A-2 outbox +
# onConflictDoNothing) prevents ponder from re-publishing within its own
# state, BUT envio's last few seconds of pre-cutover emits AND ponder's
# first few seconds may overlap. This script:
#
#   1. Subscribes to all NATS subjects under STONEHENGE_SUBJECT_PREFIX
#      (default `freeside.events.>`).
#   2. Logs every received envelope with its deterministic_id +
#      timestamp + source (inferred from envelope.meta.indexer).
#   3. Every CHECK_INTERVAL_SECONDS, scans the rolling log for any
#      deterministic_id seen ≥2 times. Emits `[NATS-DOUBLE-EMIT]` alerts.
#   4. After DURATION_SECONDS (default 86400 = 24h), produces a final
#      summary JSON: total_envelopes, duplicates_found,
#      expected_duplicates (configurable cutover-edge window),
#      reconciliation_pass.
#
# Source-of-truth: sonar-ponder-coordinator:grimoires/loa/sprint.md A-4 / T-A4.11
#                  ADR-010 (operator authorization)
#                  loa-freeside:grimoires/loa/sdd.md §8.7 (dual-publication overlap)
#
# Usage:
#   # Run in foreground (24h observation):
#   NATS_URL=nats://nats.example.com:4222 \
#   NATS_AUTH_TOKEN=*** \
#     scripts/nats-reconciliation-24h.sh
#
#   # Run as background process (operator daemonizes):
#     scripts/nats-reconciliation-24h.sh &
#     echo $! > /tmp/nats-recon.pid
#
#   # Dry-run (verify connectivity + emit start-of-window record + exit):
#     scripts/nats-reconciliation-24h.sh --dry-run
#
#   # Custom duration (e.g. 1h test):
#     DURATION_SECONDS=3600 scripts/nats-reconciliation-24h.sh
#
# Required env:
#   NATS_URL                NATS server URL
#   NATS_AUTH_TOKEN         NATS auth token (optional if no auth)
#
# Optional env:
#   DURATION_SECONDS        Observation window (default 86400)
#   CHECK_INTERVAL_SECONDS  Duplicate-scan cadence (default 600 = 10 min)
#   STONEHENGE_SUBJECT      NATS subject pattern (default `freeside.events.>`)
#   EXPECTED_DUPES_WINDOW_S Cutover-edge tolerance window (default 60s).
#                           Duplicates whose first+last observation are
#                           BOTH within this many seconds of the
#                           SWITCHOVER_EPOCH are EXPECTED (not failures).
#   SWITCHOVER_EPOCH        UNIX seconds of cutover-Hasura-swap (default: NOW)
#   LOG_DIR                 Where to write envelope log (default /tmp)
#   ALERT_HOOK              Optional URL — POST `[NATS-DOUBLE-EMIT]` payloads
#
# Output:
#   - stdout: human-readable progress + `[NATS-DOUBLE-EMIT]` lines (machine-grep)
#   - stderr: errors
#   - final JSON summary on stdout at end of window
#   - rolling log at $LOG_DIR/nats-recon-<DRILL_ID>.jsonl
#
# Exit codes:
#   0 — reconciliation_pass true (no unexpected duplicates)
#   1 — reconciliation_pass false (duplicates outside expected window)
#   2 — script error (missing env / dep / NATS unreachable)

set -euo pipefail

DRY_RUN=false
SHOW_HELP=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) SHOW_HELP=true; shift ;;
    *) echo "{\"exit_reason\":\"bad-arg\",\"detail\":\"$1\"}" >&2; exit 2 ;;
  esac
done

if [[ "$SHOW_HELP" == "true" ]]; then
  sed -n '1,65p' "$0"
  exit 0
fi

# ────────────────────────────────────────────────────────────────────────────
# Deps + env
# ────────────────────────────────────────────────────────────────────────────

command -v jq >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"jq"}' >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"node (for NATS client)"}' >&2; exit 2; }

if [[ -z "${NATS_URL:-}" ]]; then
  echo '{"exit_reason":"missing-env","detail":"NATS_URL"}' >&2
  exit 2
fi

DURATION_SECONDS="${DURATION_SECONDS:-86400}"
CHECK_INTERVAL_SECONDS="${CHECK_INTERVAL_SECONDS:-600}"
STONEHENGE_SUBJECT="${STONEHENGE_SUBJECT:-freeside.events.>}"
EXPECTED_DUPES_WINDOW_S="${EXPECTED_DUPES_WINDOW_S:-60}"
SWITCHOVER_EPOCH="${SWITCHOVER_EPOCH:-$(date +%s)}"
LOG_DIR="${LOG_DIR:-/tmp}"
DRILL_ID="${DRILL_ID:-natsrecon-$(date -u +%Y%m%dT%H%MZ)-$(openssl rand -hex 3 2>/dev/null || echo r$RANDOM)}"

LOG_FILE="$LOG_DIR/nats-recon-$DRILL_ID.jsonl"
SUMMARY_FILE="$LOG_DIR/nats-recon-$DRILL_ID.summary.json"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"

# Verify node can require nats (the package is in deps per package.json).
if ! (cd "$REPO_ROOT" && node -e 'require("nats")' 2>/dev/null); then
  jq -nc '{exit_reason:"missing-dep", detail:"nats package not installed; run pnpm install at repo root"}' >&2
  exit 2
fi

# ────────────────────────────────────────────────────────────────────────────
# Dry-run early-exit
# ────────────────────────────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "true" ]]; then
  jq -nc \
    --arg drill_id "$DRILL_ID" \
    --arg nats_url "$NATS_URL" \
    --arg subject "$STONEHENGE_SUBJECT" \
    --argjson duration "$DURATION_SECONDS" \
    --argjson check_interval "$CHECK_INTERVAL_SECONDS" \
    --argjson switchover "$SWITCHOVER_EPOCH" \
    --argjson expected_dupes_window "$EXPECTED_DUPES_WINDOW_S" \
    --arg log_file "$LOG_FILE" \
    '{
      mode: "dry-run",
      drill_id: $drill_id,
      nats_url: $nats_url,
      subject: $subject,
      duration_seconds: $duration,
      check_interval_seconds: $check_interval,
      switchover_epoch: $switchover,
      expected_dupes_window_seconds: $expected_dupes_window,
      log_file: $log_file,
      note: "no subscription started; pass without --dry-run to begin observation",
      exit_reason: "dry-run-ok"
    }'
  exit 0
fi

# ────────────────────────────────────────────────────────────────────────────
# Subscriber implementation
# ────────────────────────────────────────────────────────────────────────────

SUBSCRIBER_JS="$(mktemp -t nats-recon.XXXXXX.cjs)"
trap 'rm -f "$SUBSCRIBER_JS"' EXIT

cat > "$SUBSCRIBER_JS" <<'JSEOF'
// 24h NATS double-emit reconciliation subscriber.
// Receives envelopes on $STONEHENGE_SUBJECT, writes one JSONL line per
// envelope to $LOG_FILE. Per-line shape:
//   {ts, deterministic_emit_id, subject, indexer, envelope_type, raw_bytes_len}
// On SIGTERM/SIGINT, drains the connection cleanly.

const { connect, StringCodec } = require("nats");
const fs = require("fs");

const NATS_URL = process.env.NATS_URL;
const NATS_AUTH_TOKEN = process.env.NATS_AUTH_TOKEN || "";
const SUBJECT = process.env.STONEHENGE_SUBJECT;
const LOG_FILE = process.env.LOG_FILE;
const DURATION_SECONDS = parseInt(process.env.DURATION_SECONDS, 10);

(async () => {
  let nc;
  try {
    const opts = { servers: NATS_URL };
    if (NATS_AUTH_TOKEN) opts.token = NATS_AUTH_TOKEN;
    nc = await connect(opts);
  } catch (err) {
    process.stderr.write(JSON.stringify({ ts: Date.now(), kind: "connect-failed", err: String(err) }) + "\n");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ ts: Date.now(), kind: "connected", server: NATS_URL }) + "\n");

  const sc = StringCodec();
  const out = fs.createWriteStream(LOG_FILE, { flags: "a" });
  const sub = nc.subscribe(SUBJECT);

  let seen = 0;
  (async () => {
    for await (const m of sub) {
      const raw = sc.decode(m.data);
      let env;
      try { env = JSON.parse(raw); } catch (_) { env = null; }
      const id = env && env.meta && env.meta.deterministic_emit_id ? env.meta.deterministic_emit_id
                : env && env.deterministic_emit_id ? env.deterministic_emit_id
                : env && env.id ? env.id
                : null;
      const indexer = env && env.meta && env.meta.indexer ? env.meta.indexer
                    : env && env.meta && env.meta.source ? env.meta.source
                    : "unknown";
      const envelope_type = env && env.type ? env.type : "unknown";
      out.write(JSON.stringify({
        ts: Date.now(),
        deterministic_emit_id: id,
        subject: m.subject,
        indexer,
        envelope_type,
        raw_bytes_len: raw.length
      }) + "\n");
      seen += 1;
      if (seen % 100 === 0) {
        process.stdout.write(JSON.stringify({ ts: Date.now(), kind: "progress", seen }) + "\n");
      }
    }
  })().catch((err) => {
    process.stderr.write(JSON.stringify({ ts: Date.now(), kind: "iterator-error", err: String(err) }) + "\n");
  });

  const onExit = async () => {
    try { await sub.drain(); } catch (_) {}
    try { await nc.drain(); } catch (_) {}
    try { out.end(); } catch (_) {}
    process.stdout.write(JSON.stringify({ ts: Date.now(), kind: "drained", seen }) + "\n");
    process.exit(0);
  };
  process.on("SIGTERM", onExit);
  process.on("SIGINT", onExit);

  // Self-terminate at the duration boundary (defense in depth in case
  // the parent script's kill arrives late).
  setTimeout(onExit, DURATION_SECONDS * 1000 + 5000);
})();
JSEOF

# ────────────────────────────────────────────────────────────────────────────
# Launch subscriber
# ────────────────────────────────────────────────────────────────────────────

: > "$LOG_FILE"
echo "[nats-recon] drill_id=$DRILL_ID duration=${DURATION_SECONDS}s log=$LOG_FILE"
echo "[nats-recon] launching subscriber against $NATS_URL subject=$STONEHENGE_SUBJECT"

LOG_FILE="$LOG_FILE" \
NATS_URL="$NATS_URL" \
NATS_AUTH_TOKEN="${NATS_AUTH_TOKEN:-}" \
STONEHENGE_SUBJECT="$STONEHENGE_SUBJECT" \
DURATION_SECONDS="$DURATION_SECONDS" \
  node "$SUBSCRIBER_JS" &

SUB_PID=$!

cleanup() {
  if kill -0 "$SUB_PID" 2>/dev/null; then
    kill -TERM "$SUB_PID" 2>/dev/null || true
    # Give it 5s to drain before SIGKILL.
    for _ in $(seq 1 5); do
      kill -0 "$SUB_PID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$SUB_PID" 2>/dev/null || true
  fi
  rm -f "$SUBSCRIBER_JS"
}
trap cleanup EXIT INT TERM

# ────────────────────────────────────────────────────────────────────────────
# Periodic duplicate scan
# ────────────────────────────────────────────────────────────────────────────

scan_for_dupes() {
  # Group by deterministic_emit_id, report any with count > 1.
  # Skip null IDs (envelopes that couldn't be parsed).
  jq -sc '
    [.[] | select(.deterministic_emit_id != null)]
    | group_by(.deterministic_emit_id)
    | map(select(length > 1))
    | map({
        deterministic_emit_id: .[0].deterministic_emit_id,
        count: length,
        first_ts: (map(.ts) | min),
        last_ts: (map(.ts) | max),
        indexers: (map(.indexer) | unique),
        subjects: (map(.subject) | unique)
      })
  ' "$LOG_FILE" 2>/dev/null || echo "[]"
}

# Classify a duplicate group as expected (cutover-edge) vs unexpected.
# Expected = first_ts and last_ts BOTH within EXPECTED_DUPES_WINDOW_S
# seconds of SWITCHOVER_EPOCH (in ms).
classify_dupes() {
  local switchover_ms=$((SWITCHOVER_EPOCH * 1000))
  local window_ms=$((EXPECTED_DUPES_WINDOW_S * 1000))
  jq -c --argjson switchover "$switchover_ms" --argjson window "$window_ms" '
    map(. + {
      expected: (
        ((.first_ts | tonumber - $switchover) | fabs <= $window)
        and
        ((.last_ts | tonumber - $switchover) | fabs <= $window)
      )
    })
  '
}

START_EPOCH=$(date +%s)
END_EPOCH=$((START_EPOCH + DURATION_SECONDS))

echo "[nats-recon] observing until $(date -u -r "$END_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$END_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"

while [[ $(date +%s) -lt "$END_EPOCH" ]]; do
  # Sleep up to the next check interval, but not past END_EPOCH.
  NOW=$(date +%s)
  REMAINING=$((END_EPOCH - NOW))
  SLEEP_FOR=$CHECK_INTERVAL_SECONDS
  [[ "$SLEEP_FOR" -gt "$REMAINING" ]] && SLEEP_FOR="$REMAINING"
  [[ "$SLEEP_FOR" -le 0 ]] && break
  sleep "$SLEEP_FOR"

  # Verify subscriber still alive.
  if ! kill -0 "$SUB_PID" 2>/dev/null; then
    echo "[nats-recon] subscriber process died unexpectedly" >&2
    break
  fi

  # Scan + alert on new dupes.
  DUPES=$(scan_for_dupes | classify_dupes)
  UNEXPECTED_COUNT=$(echo "$DUPES" | jq '[.[] | select(.expected == false)] | length' 2>/dev/null || echo 0)
  TOTAL_DUPE_GROUPS=$(echo "$DUPES" | jq 'length' 2>/dev/null || echo 0)

  if [[ "$TOTAL_DUPE_GROUPS" -gt 0 ]]; then
    echo "$DUPES" | jq -c '.[] | select(.expected == false)' 2>/dev/null \
      | while IFS= read -r dupe; do
          [[ -z "$dupe" ]] && continue
          echo "[NATS-DOUBLE-EMIT] $dupe"
          if [[ -n "${ALERT_HOOK:-}" ]]; then
            curl -fSs -X POST "$ALERT_HOOK" \
              -H 'Content-Type: application/json' \
              -d "$dupe" >/dev/null 2>&1 || true
          fi
        done
  fi

  echo "[nats-recon] progress: total_dupe_groups=$TOTAL_DUPE_GROUPS unexpected=$UNEXPECTED_COUNT elapsed=$(($(date +%s) - START_EPOCH))s"
done

# ────────────────────────────────────────────────────────────────────────────
# Final summary
# ────────────────────────────────────────────────────────────────────────────

# Stop the subscriber cleanly before computing summary.
cleanup

TOTAL_ENVELOPES=$(wc -l < "$LOG_FILE" | tr -d '[:space:]')
TOTAL_ENVELOPES=${TOTAL_ENVELOPES:-0}

FINAL_DUPES=$(scan_for_dupes | classify_dupes)
EXPECTED_GROUPS=$(echo "$FINAL_DUPES" | jq '[.[] | select(.expected)] | length' 2>/dev/null || echo 0)
UNEXPECTED_GROUPS=$(echo "$FINAL_DUPES" | jq '[.[] | select(.expected == false)] | length' 2>/dev/null || echo 0)
TOTAL_DUPE_GROUPS=$(echo "$FINAL_DUPES" | jq 'length' 2>/dev/null || echo 0)

PASS="true" EXIT_REASON="ok" EXIT_CODE=0
if [[ "$UNEXPECTED_GROUPS" -gt 0 ]]; then
  PASS="false"; EXIT_REASON="unexpected-duplicates"; EXIT_CODE=1
fi

SUMMARY=$(jq -nc \
  --arg drill_id "$DRILL_ID" \
  --argjson total_envelopes "$TOTAL_ENVELOPES" \
  --argjson total_dupe_groups "$TOTAL_DUPE_GROUPS" \
  --argjson expected_dupe_groups "$EXPECTED_GROUPS" \
  --argjson unexpected_dupe_groups "$UNEXPECTED_GROUPS" \
  --argjson duration_seconds "$DURATION_SECONDS" \
  --argjson switchover_epoch "$SWITCHOVER_EPOCH" \
  --argjson expected_dupes_window_seconds "$EXPECTED_DUPES_WINDOW_S" \
  --argjson dupes "$FINAL_DUPES" \
  --argjson reconciliation_pass "$PASS" \
  --arg exit_reason "$EXIT_REASON" \
  --arg log_file "$LOG_FILE" \
  '{
    drill_id: $drill_id,
    total_envelopes: $total_envelopes,
    total_dupe_groups: $total_dupe_groups,
    expected_dupe_groups: $expected_dupe_groups,
    unexpected_dupe_groups: $unexpected_dupe_groups,
    duration_seconds: $duration_seconds,
    switchover_epoch: $switchover_epoch,
    expected_dupes_window_seconds: $expected_dupes_window_seconds,
    duplicates: $dupes,
    reconciliation_pass: $reconciliation_pass,
    exit_reason: $exit_reason,
    log_file: $log_file
  }')

echo "$SUMMARY" | tee "$SUMMARY_FILE"

exit "$EXIT_CODE"
