#!/usr/bin/env bash
# R-002 — --json: stdout is data-only (parseable by jq with no grepping)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

# human chrome must not leak onto stdout when --json
stdout="$(bash scripts/sonar-care.sh slo --json 2>/dev/null)"
echo "$stdout" | jq -e '.command == "slo"' >/dev/null
# slo --json includes additive fail-soft live block
echo "$stdout" | jq -e '.live.status | IN("ok", "offline", "error")' >/dev/null
# no ANSI escapes in JSON stdout
if printf '%s' "$stdout" | grep -q $'\033'; then
  echo "R-002 FAIL: ANSI in JSON stdout" >&2
  exit 1
fi

# triage --json also data-only (probe diagnostics must not contaminate stdout)
triage_out="$(bash scripts/sonar-care.sh triage --json 2>/dev/null)"
echo "$triage_out" | jq -e '.schema == "sonar.care.v1"' >/dev/null
if printf '%s' "$triage_out" | grep -q $'\033'; then
  echo "R-002 FAIL: ANSI in triage JSON stdout" >&2
  exit 1
fi

# diagnostics for unknown flag go to stderr, not stdout
set +e
out="$(bash scripts/sonar-care.sh --not-a-real-flag 2>/dev/null)"
err="$(bash scripts/sonar-care.sh --not-a-real-flag 2>&1 >/dev/null)"
code=$?
set -e
[ "$code" -eq 1 ]
[ -z "$out" ]
echo "$err" | grep -qi "unknown flag"

echo "R-002 PASS"
