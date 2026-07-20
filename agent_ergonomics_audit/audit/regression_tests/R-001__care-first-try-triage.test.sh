#!/usr/bin/env bash
# R-001 — bare care / triage --json is first-try inevitable
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

# bare invocation exits 0
bash scripts/sonar-care.sh >/dev/null

# --json is pure parseable schema
json="$(bash scripts/sonar-care.sh triage --json)"
echo "$json" | jq -e '.schema == "sonar.care.v1"' >/dev/null
echo "$json" | jq -e '(.slos | length) == 5' >/dev/null
echo "$json" | jq -e '(.floors | length) >= 4' >/dev/null
echo "$json" | jq -e '.exit_codes["0"] == "success"' >/dev/null
# additive live S1 probe (fail-soft: always present on triage; status is closed set)
echo "$json" | jq -e '.live.status | IN("ok", "offline", "error")' >/dev/null
echo "$json" | jq -e '.live.fail_soft == true' >/dev/null

# offline override must still exit 0 and report status offline/error (never block care)
set +e
offline_json="$(SONAR_GRAPHQL_URL='http://127.0.0.1:9' SONAR_CARE_PROBE_TIMEOUT=1 bash scripts/sonar-care.sh triage --json 2>/dev/null)"
offline_code=$?
set -e
[ "$offline_code" -eq 0 ]
echo "$offline_json" | jq -e '.live.status | IN("offline", "error")' >/dev/null
echo "$offline_json" | jq -e '.live.fail_soft == true' >/dev/null

# typo teaches exact command and exits 1
set +e
err="$(bash scripts/sonar-care.sh traige 2>&1)"
code=$?
set -e
[ "$code" -eq 1 ]
echo "$err" | grep -q "did you mean 'triage'"
echo "$err" | grep -q "exact: bash scripts/sonar-care.sh triage"

# capabilities
bash scripts/sonar-care.sh capabilities --json | jq -e '.features.robot_triage == true' >/dev/null
bash scripts/sonar-care.sh capabilities --json | jq -e '.features.live_s1_probe == true' >/dev/null

# --robot-triage alias
bash scripts/sonar-care.sh --robot-triage --json | jq -e '.command == "triage"' >/dev/null

echo "R-001 PASS"
