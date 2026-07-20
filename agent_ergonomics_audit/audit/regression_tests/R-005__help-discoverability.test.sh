#!/usr/bin/env bash
# R-005 — mutual help discoverability + robot-docs / capabilities completeness
# Pins: care --help mentions --json, capabilities, pulse;
#       pulse --help mentions care;
#       promote --help mentions dry-run + care;
#       robot-docs covers live probe, SOURCE_DATE_EPOCH, exit codes,
#       related tools, queue policy verbs;
#       capabilities --json has stable related + related_commands maps.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

fail() { echo "R-005 FAIL: $*" >&2; exit 1; }

# ── care --help discovers structured surfaces + related CLIs ─────────────────
care_help="$(bash scripts/sonar-care.sh --help 2>&1)"
echo "$care_help" | grep -q -- '--json' || fail "care --help missing --json"
echo "$care_help" | grep -qi 'capabilities' || fail "care --help missing capabilities"
echo "$care_help" | grep -qi 'robot-docs' || fail "care --help missing robot-docs"
echo "$care_help" | grep -qi 'pulse' || fail "care --help missing pulse"
echo "$care_help" | grep -qi 'promote' || fail "care --help missing promote"
echo "$care_help" | grep -qi 'self' || fail "care --help missing self"

# ── pulse --help discovers care (+ promote family) ───────────────────────────
pulse_help="$(bash scripts/sonar-pulse.sh --help 2>&1)"
echo "$pulse_help" | grep -qi 'care' || fail "pulse --help missing care"
echo "$pulse_help" | grep -qi 'promote' || fail "pulse --help missing promote"

# ── promote --help discovers dry-run + care/pulse ────────────────────────────
promote_help="$(bash scripts/promote.sh --help 2>&1)"
echo "$promote_help" | grep -qi 'dry-run' || fail "promote --help missing dry-run"
echo "$promote_help" | grep -qi 'care' || fail "promote --help missing care"
echo "$promote_help" | grep -qi 'pulse' || fail "promote --help missing pulse"

# ── robot-docs guide completeness ────────────────────────────────────────────
docs="$(bash scripts/sonar-care.sh robot-docs guide 2>&1)"
echo "$docs" | grep -qi 'live' || fail "robot-docs missing live probe"
echo "$docs" | grep -q 'SOURCE_DATE_EPOCH' || fail "robot-docs missing SOURCE_DATE_EPOCH"
echo "$docs" | grep -qi 'exit code' || fail "robot-docs missing exit codes"
echo "$docs" | grep -qi 'pulse' || fail "robot-docs missing pulse"
echo "$docs" | grep -qi 'promote' || fail "robot-docs missing promote"
echo "$docs" | grep -qi 'self' || fail "robot-docs missing self"
echo "$docs" | grep -qi 'produce' || fail "robot-docs missing queue verb produce"
echo "$docs" | grep -qi 'systemize' || fail "robot-docs missing queue verb systemize"
echo "$docs" | grep -qi 'clarify' || fail "robot-docs missing queue verb clarify"
echo "$docs" | grep -qi 'drain' || fail "robot-docs missing queue verb drain"
echo "$docs" | grep -qi 'renvoi' || fail "robot-docs missing queue verb renvoi"

# ── capabilities --json: related + related_commands complete & stable ────────
caps="$(bash scripts/sonar-care.sh capabilities --json 2>/dev/null)"
echo "$caps" | jq -e '.related.pulse == "pnpm pulse"' >/dev/null \
  || fail "related.pulse"
echo "$caps" | jq -e '.related.self == "pnpm self"' >/dev/null \
  || fail "related.self"
echo "$caps" | jq -e '.related.promote == "bash scripts/promote.sh"' >/dev/null \
  || fail "related.promote"
echo "$caps" | jq -e '.related.care_md == "CARE.md"' >/dev/null \
  || fail "related.care_md"
echo "$caps" | jq -e '.related.arrival == "grimoires/loa/ARRIVAL.md"' >/dev/null \
  || fail "related.arrival"

echo "$caps" | jq -e '.related_commands.care_triage | test("care")' >/dev/null \
  || fail "related_commands.care_triage"
echo "$caps" | jq -e '.related_commands.pulse == "pnpm pulse"' >/dev/null \
  || fail "related_commands.pulse"
echo "$caps" | jq -e '.related_commands.promote_dry_run | test("dry-run")' >/dev/null \
  || fail "related_commands.promote_dry_run"
echo "$caps" | jq -e '.related_commands.self_check | test("self")' >/dev/null \
  || fail "related_commands.self_check"

echo "$caps" | jq -e '
  (.queue_policy_verbs | sort) == (["clarify","drain","produce","renvoi","systemize"] | sort)
' >/dev/null || fail "queue_policy_verbs incomplete/unstable"

# Dual-run stability of related maps (sorted key order already from emit_stable_json)
c1="$(bash scripts/sonar-care.sh capabilities --json 2>/dev/null)"
c2="$(bash scripts/sonar-care.sh capabilities --json 2>/dev/null)"
[ "$c1" = "$c2" ] || fail "capabilities --json dual-run differs (related maps not stable)"

# CARE.md Related CLIs section present
grep -q '## Related CLIs' CARE.md || fail "CARE.md missing ## Related CLIs"
grep -q 'pnpm care triage --json' CARE.md || fail "CARE.md missing care first-try"
grep -q 'pnpm pulse' CARE.md || fail "CARE.md missing pulse first-try"

echo "R-005 PASS"
