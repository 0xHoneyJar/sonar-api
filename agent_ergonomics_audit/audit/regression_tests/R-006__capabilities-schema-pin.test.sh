#!/usr/bin/env bash
# R-006 — capabilities --json schema pin (contract envelope)
# Pins critical keys that agents and other CLIs depend on:
#   schema / name / contract_version
#   features.robot_triage / features.live_s1_probe
#   exit_codes (0–5 dictionary)
#   related_commands (care_triage + family)
# Must PASS while those exist; FAIL if any are removed or reshaped.
# Pattern: 🧪 Pin-The-Contract-Test (Axiom 8/9/17 · Stack E Self-Describing)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

fail() { echo "R-006 FAIL: $*" >&2; exit 1; }

# Bare capabilities forces JSON (no --json required)
caps="$(bash scripts/sonar-care.sh capabilities 2>/dev/null)" \
  || fail "capabilities invocation failed"
# --json path must agree
caps_flag="$(bash scripts/sonar-care.sh capabilities --json 2>/dev/null)" \
  || fail "capabilities --json invocation failed"
[ "$caps" = "$caps_flag" ] || fail "bare capabilities != capabilities --json"

# ── Top-level identity / contract ─────────────────────────────────────────────
echo "$caps" | jq -e '.schema == "sonar.care.v1"' >/dev/null \
  || fail "schema missing or != sonar.care.v1"
echo "$caps" | jq -e '.name == "sonar-care"' >/dev/null \
  || fail "name missing or != sonar-care"
echo "$caps" | jq -e '.contract_version == "sonar.care.v1"' >/dev/null \
  || fail "contract_version missing or != sonar.care.v1"
echo "$caps" | jq -e '(.version | type) == "string" and (.version | length) > 0' >/dev/null \
  || fail "version missing"

# ── Feature flags (mega-command + live probe) ─────────────────────────────────
echo "$caps" | jq -e '.features.robot_triage == true' >/dev/null \
  || fail "features.robot_triage missing or false"
echo "$caps" | jq -e '.features.live_s1_probe == true' >/dev/null \
  || fail "features.live_s1_probe missing or false"
# adjacent feature flags that agents gate on (pin presence, not just the two)
echo "$caps" | jq -e '.features.json_stdout == true' >/dev/null \
  || fail "features.json_stdout"
echo "$caps" | jq -e '.features.robot_docs == true' >/dev/null \
  || fail "features.robot_docs"
echo "$caps" | jq -e '.features.intent_inference == true' >/dev/null \
  || fail "features.intent_inference"
echo "$caps" | jq -e '.features.output_deterministic == true' >/dev/null \
  || fail "features.output_deterministic"
echo "$caps" | jq -e '.features.live_s1_fail_soft == true' >/dev/null \
  || fail "features.live_s1_fail_soft"

# ── Exit-code dictionary (Axiom 5) ────────────────────────────────────────────
echo "$caps" | jq -e '
  .exit_codes["0"] == "success"
  and .exit_codes["1"] == "user-input-error"
  and (.exit_codes["2"] | type) == "string"
  and (.exit_codes["3"] | type) == "string"
  and (.exit_codes["4"] | type) == "string"
  and (.exit_codes["5"] | type) == "string"
' >/dev/null || fail "exit_codes incomplete or wrong shape (need keys 0–5)"

# ── related_commands (copy-paste first-try paths) ─────────────────────────────
echo "$caps" | jq -e '(.related_commands | type) == "object"' >/dev/null \
  || fail "related_commands missing"
echo "$caps" | jq -e '
  (.related_commands.care_triage | type) == "string"
  and (.related_commands.care_triage | test("care"))
  and (.related_commands.care_triage | test("triage"))
' >/dev/null || fail "related_commands.care_triage"
echo "$caps" | jq -e '
  (.related_commands.care_caps | type) == "string"
  and (.related_commands.care_caps | test("capabilities"))
' >/dev/null || fail "related_commands.care_caps"
echo "$caps" | jq -e '
  (.related_commands.care_robot_docs | type) == "string"
  and (.related_commands.care_robot_docs | test("robot-docs"))
' >/dev/null || fail "related_commands.care_robot_docs"
echo "$caps" | jq -e '
  (.related_commands.pulse | type) == "string"
  and (.related_commands.promote_dry_run | type) == "string"
  and (.related_commands.self_check | type) == "string"
' >/dev/null || fail "related_commands family keys (pulse/promote_dry_run/self_check)"

# ── related map (doc + sibling CLIs) ──────────────────────────────────────────
echo "$caps" | jq -e '
  .related.pulse == "pnpm pulse"
  and .related.self == "pnpm self"
  and .related.care_md == "CARE.md"
  and (.related.promote | test("promote"))
  and (.related.arrival | test("ARRIVAL"))
' >/dev/null || fail "related map incomplete"

# ── commands / flags lists present ────────────────────────────────────────────
echo "$caps" | jq -e '
  (.commands | type) == "array"
  and (.commands | index("triage") != null)
  and (.commands | index("capabilities") != null)
  and (.commands | index("robot-docs") != null)
' >/dev/null || fail "commands list incomplete"
echo "$caps" | jq -e '
  (.flags | type) == "array"
  and (.flags | index("--json") != null)
  and (.flags | index("--robot-triage") != null)
' >/dev/null || fail "flags list incomplete"

# ── Dual-run byte identity (schema pin must be stable) ────────────────────────
export SOURCE_DATE_EPOCH=0
c1="$(bash scripts/sonar-care.sh capabilities --json 2>/dev/null)"
c2="$(bash scripts/sonar-care.sh capabilities --json 2>/dev/null)"
[ "$c1" = "$c2" ] || fail "capabilities --json dual-run differs under SOURCE_DATE_EPOCH=0"

# ── No ANSI / pure JSON ───────────────────────────────────────────────────────
if printf '%s' "$caps" | grep -q $'\033'; then
  fail "ANSI in capabilities stdout"
fi
echo "$caps" | jq -e 'type == "object"' >/dev/null || fail "stdout not a JSON object"

# ── robot-docs --json still valid (adjacent contract; no scope creep) ─────────
rd="$(bash scripts/sonar-care.sh robot-docs --json 2>/dev/null)" \
  || fail "robot-docs --json failed"
echo "$rd" | jq -e '
  .schema == "sonar.care.v1"
  and .command == "robot-docs"
  and (.guide | type) == "string"
  and (.guide | length) > 100
' >/dev/null || fail "robot-docs --json schema/command/guide contract broken"

echo "R-006 PASS"
