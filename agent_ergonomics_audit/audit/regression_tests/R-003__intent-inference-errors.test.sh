#!/usr/bin/env bash
# R-003 — intent inference + error pedagogy: wrong verbs/flags teach exact command
# Asserts: exit 1, stderr contains "exact:" or "did you mean"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

fail() { echo "R-003 FAIL: $*" >&2; exit 1; }

# assert_teaches CMD...  — run command; must exit 1; stderr must teach
assert_teaches() {
  local label="$1"; shift
  local err code
  set +e
  err="$("$@" 2>&1 >/dev/null)"
  code=$?
  set -e
  [ "$code" -eq 1 ] || fail "$label: expected exit 1, got $code (stderr: $err)"
  if ! printf '%s' "$err" | grep -Eqi 'exact:|did you mean'; then
    fail "$label: stderr missing 'exact:' or 'did you mean' — got: $err"
  fi
}

# ── care: verb typos ──────────────────────────────────────────────────────────
assert_teaches "care capasities"   bash scripts/sonar-care.sh capasities
assert_teaches "care robto-docs"   bash scripts/sonar-care.sh robto-docs
assert_teaches "care qeue"         bash scripts/sonar-care.sh qeue
assert_teaches "care onboardingg"  bash scripts/sonar-care.sh onboardingg
assert_teaches "care florrs"       bash scripts/sonar-care.sh florrs
assert_teaches "care renvoid"      bash scripts/sonar-care.sh renvoid
assert_teaches "care capa"         bash scripts/sonar-care.sh capa
assert_teaches "care robot_triage" bash scripts/sonar-care.sh robot_triage
assert_teaches "care traige"       bash scripts/sonar-care.sh traige
assert_teaches "care totally-bogus" bash scripts/sonar-care.sh totally-bogus-verb-xyz

# ── care: flag typos ──────────────────────────────────────────────────────────
assert_teaches "care --jsno"       bash scripts/sonar-care.sh --jsno
assert_teaches "care --jason"      bash scripts/sonar-care.sh --jason
assert_teaches "care --not-a-flag" bash scripts/sonar-care.sh --not-a-real-flag

# --jsno must specifically name --json and an exact command with --json
set +e
jsno_err="$(bash scripts/sonar-care.sh --jsno 2>&1 >/dev/null)"
jsno_code=$?
set -e
[ "$jsno_code" -eq 1 ] || fail "--jsno exit"
echo "$jsno_err" | grep -q "did you mean '--json'" || fail "--jsno should suggest --json: $jsno_err"
echo "$jsno_err" | grep -q "exact: bash scripts/sonar-care.sh triage --json" || fail "--jsno exact command: $jsno_err"

# capasities → capabilities exact
set +e
cap_err="$(bash scripts/sonar-care.sh capasities 2>&1 >/dev/null)"
set -e
echo "$cap_err" | grep -q "did you mean 'capabilities'" || fail "capasities hint: $cap_err"
echo "$cap_err" | grep -Eq "exact: bash scripts/sonar-care.sh capabilities" || fail "capasities exact: $cap_err"

# robot_triage → triage
set +e
rt_err="$(bash scripts/sonar-care.sh robot_triage 2>&1 >/dev/null)"
set -e
echo "$rt_err" | grep -q "did you mean 'triage'" || fail "robot_triage hint: $rt_err"
echo "$rt_err" | grep -q "exact:" || fail "robot_triage exact: $rt_err"

# ── promote: unknown / typo flags ─────────────────────────────────────────────
assert_teaches "promote --jsno"    bash scripts/promote.sh --jsno
assert_teaches "promote --nope"    bash scripts/promote.sh --not-a-real-flag
assert_teaches "promote --hepl"    bash scripts/promote.sh --hepl

# ── pulse: unknown / typo flags ───────────────────────────────────────────────
assert_teaches "pulse --jsno"      bash scripts/sonar-pulse.sh --jsno
assert_teaches "pulse --nope"      bash scripts/sonar-pulse.sh --not-a-real-flag
assert_teaches "pulse --hepl"      bash scripts/sonar-pulse.sh --hepl

# promote --dryrun still works (alias accepted; not an error path)
set +e
# dry-run may fail later on missing gate/env; we only care it accepted the flag
# (does not print "unknown argument")
prom_err="$(bash scripts/promote.sh --dryrun 2>&1)"
prom_code=$?
set -e
echo "$prom_err" | grep -qi "unknown argument" && fail "promote --dryrun should be accepted, got: $prom_err"
# either treated-as or proceeded past arg parse
echo "$prom_err" | grep -Eqi "treating.*--dry-run|Gate|dry-run|ROLLBACK|ERROR|ABORT" \
  || fail "promote --dryrun did not get past arg parse: $prom_err"

echo "R-003 PASS"
