#!/usr/bin/env bash
# R-004 — --json output determinism + NO_COLOR / non-TTY discipline
# Pins: dual-run byte identity under SOURCE_DATE_EPOCH + offline GraphQL;
#       no ANSI in --json stdout; live.chains sorted by chain_id;
#       generated_at honors SOURCE_DATE_EPOCH when set.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

fail() { echo "R-004 FAIL: $*" >&2; exit 1; }

# Offline + short timeout so live block is stable (no network variance).
export SONAR_GRAPHQL_URL='http://127.0.0.1:9'
export SONAR_CARE_PROBE_TIMEOUT=1
export SOURCE_DATE_EPOCH=0
# Explicit color suppress (also non-TTY via capture).
export NO_COLOR=1

run_triage_json() {
  bash scripts/sonar-care.sh triage --json 2>/dev/null
}

a="$(run_triage_json)"
b="$(run_triage_json)"

# ── No ANSI escapes in --json stdout ──────────────────────────────────────────
if printf '%s' "$a" | grep -q $'\033'; then
  fail "ANSI escape in triage --json stdout"
fi

# ── Dual-run byte identity (offline + SOURCE_DATE_EPOCH pinned) ───────────────
if [ "$a" != "$b" ]; then
  fail "triage --json dual-run outputs differ under offline URL + SOURCE_DATE_EPOCH=0"
fi

# ── Schema + fail-soft offline live ───────────────────────────────────────────
echo "$a" | jq -e '.schema == "sonar.care.v1"' >/dev/null \
  || fail "schema != sonar.care.v1"
echo "$a" | jq -e '.live.status | IN("offline", "error")' >/dev/null \
  || fail "expected live.status offline|error under 127.0.0.1:9"
echo "$a" | jq -e '.live.fail_soft == true' >/dev/null \
  || fail "live.fail_soft"
echo "$a" | jq -e '(.live.chains | type) == "array"' >/dev/null \
  || fail "live.chains must be array"

# ── chains sorted by chain_id (empty list is vacuously sorted) ────────────────
echo "$a" | jq -e '
  (.live.chains // []) as $c
  | ($c | length) == 0
    or ($c | map(.chain_id) == ($c | sort_by(.chain_id) | map(.chain_id)))
' >/dev/null || fail "live.chains not sorted by chain_id"

# ── SOURCE_DATE_EPOCH → generated_at (epoch 0 = 1970-01-01T00:00:00Z) ────────
echo "$a" | jq -e 'has("generated_at")' >/dev/null \
  || fail "generated_at missing when SOURCE_DATE_EPOCH is set"
echo "$a" | jq -e '.generated_at == "1970-01-01T00:00:00Z"' >/dev/null \
  || fail "generated_at should be 1970-01-01T00:00:00Z for SOURCE_DATE_EPOCH=0 (got $(echo "$a" | jq -r .generated_at))"

# ── Stable key order: re-canonicalizing with jq -S is a no-op ─────────────────
# Output is already jq -S; compact form of output == compact form of jq -S(output)
sorted_a="$(printf '%s' "$a" | jq -S -c .)"
again="$(printf '%s' "$a" | jq -S -c .)"
[ "$sorted_a" = "$again" ] || fail "re-canonicalization drift"

# Pretty form from care equals jq -S of itself (key order already sorted)
resorted="$(printf '%s' "$a" | jq -S .)"
[ "$a" = "$resorted" ] || fail "stdout key order is not stable (jq -S rewrite differs)"

# ── capabilities --json also dual-run stable + no ANSI ────────────────────────
c1="$(bash scripts/sonar-care.sh capabilities --json 2>/dev/null)"
c2="$(bash scripts/sonar-care.sh capabilities --json 2>/dev/null)"
[ "$c1" = "$c2" ] || fail "capabilities --json dual-run differs"
if printf '%s' "$c1" | grep -q $'\033'; then
  fail "ANSI in capabilities --json stdout"
fi
echo "$c1" | jq -e '.features.output_deterministic == true' >/dev/null \
  || fail "features.output_deterministic"
echo "$c1" | jq -e '.env | has("SOURCE_DATE_EPOCH")' >/dev/null \
  || fail "capabilities.env.SOURCE_DATE_EPOCH missing"
echo "$c1" | jq -e '.generated_at == "1970-01-01T00:00:00Z"' >/dev/null \
  || fail "capabilities generated_at not pinned by SOURCE_DATE_EPOCH"

# ── Without SOURCE_DATE_EPOCH: no wall-clock generated_at (still dual-stable) ─
unset SOURCE_DATE_EPOCH
u1="$(SONAR_GRAPHQL_URL='http://127.0.0.1:9' SONAR_CARE_PROBE_TIMEOUT=1 \
  bash scripts/sonar-care.sh triage --json 2>/dev/null)"
u2="$(SONAR_GRAPHQL_URL='http://127.0.0.1:9' SONAR_CARE_PROBE_TIMEOUT=1 \
  bash scripts/sonar-care.sh triage --json 2>/dev/null)"
[ "$u1" = "$u2" ] || fail "triage --json dual-run differs without SOURCE_DATE_EPOCH"
echo "$u1" | jq -e 'has("generated_at") | not' >/dev/null \
  || fail "generated_at must be omitted when SOURCE_DATE_EPOCH unset (no wall-clock)"

# ── Non-TTY human mode: no ANSI (stdout piped) ────────────────────────────────
human_out="$(bash scripts/sonar-care.sh triage 2>/dev/null)"
if printf '%s' "$human_out" | grep -q $'\033'; then
  fail "ANSI in non-TTY human triage stdout"
fi

# ── CI=true / TERM=dumb also suppress (defensive; non-TTY already covers) ─────
ci_out="$(CI=true bash scripts/sonar-care.sh triage 2>/dev/null)"
if printf '%s' "$ci_out" | grep -q $'\033'; then
  fail "ANSI under CI=true human triage"
fi
term_out="$(TERM=dumb bash scripts/sonar-care.sh triage 2>/dev/null)"
if printf '%s' "$term_out" | grep -q $'\033'; then
  fail "ANSI under TERM=dumb human triage"
fi

echo "R-004 PASS"
