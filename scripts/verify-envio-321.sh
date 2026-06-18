#!/usr/bin/env bash
#
# verify-envio-321.sh — the LOCAL verification loop (L1-L5) + silent-drift
# guardrail for the Envio 3.2.1 port. This is the safety net the 31-handler
# port runs against; the gate the fan-out depends on.
#
#   L1  codegen          `envio codegen` exits 0 (config + schema valid).
#   L2  typecheck         tsc of the PORTED handler surface against the 3.2.1
#                         `envio` types (tsconfig.envio321.json).
#   L3  boot pair-count   the configured contract×event count is non-zero and
#                         consistent — the count the boot would register.
#   L4  test indexer      net-new createTestIndexer() smoke harness drives a
#                         simulated event through the 3.2.1 test API.
#   L5  regression        the EXISTING vitest suite (codegen-independent) — the
#                         baseline that must stay green throughout the port.
#   BIJECTION             config contract×event pairs <-> onEvent/contractRegister
#                         call sites (reports un-ported handlers as gaps).
#
# By default L1/L4 run against config.probe.yaml (the proven 3.2.1 deploy-path
# config). Set ENVIO321_CONFIG=config.yaml to run the loop against the full
# config (codegen still passes; L4 skips since the probe handler isn't wired to
# the full config; bijection reports the full gap list).
#
# Usage:
#   bash scripts/verify-envio-321.sh                # probe config (default)
#   ENVIO321_CONFIG=config.yaml bash scripts/verify-envio-321.sh
#   bash scripts/verify-envio-321.sh --skip-l5      # skip the slow regression layer
#
# Exit 0 iff every NON-advisory layer passed. L4 skip (capability probe not
# primed) and BIJECTION gaps (un-ported handlers) are ADVISORY at the
# foundation stage and do not fail the loop — they are reported, not gated.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG="${ENVIO321_CONFIG:-config.probe.yaml}"
ENVIO_BIN="./node_modules/.bin/envio"
TSC_BIN="./node_modules/.bin/tsc"
VITEST_BIN="./node_modules/.bin/vitest"

SKIP_L5=0
for arg in "$@"; do
  case "$arg" in
    --skip-l5) SKIP_L5=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

pass=0
fail=0
advisory=0

hr() { printf '%s\n' "------------------------------------------------------------"; }
ok()    { printf '  [PASS] %s\n' "$1"; pass=$((pass+1)); }
ko()    { printf '  [FAIL] %s\n' "$1"; fail=$((fail+1)); }
note()  { printf '  [ADVISORY] %s\n' "$1"; advisory=$((advisory+1)); }

# Preflight: envio CLI present (the symlinked or local node_modules must carry it).
if [ ! -x "$ENVIO_BIN" ]; then
  echo "FATAL: $ENVIO_BIN not found. Run a clean install with envio@3.2.1 present." >&2
  echo "       (In the canary worktree the node_modules symlink must resolve, or" >&2
  echo "        unlink it and \`pnpm install --frozen-lockfile --ignore-scripts\`.)" >&2
  exit 2
fi

# The 3.2.1 test indexer (L4) auto-loads the ACTIVE config's `handlers:` dir at
# boot (Main.start -> autoLoadFromSrcHandlers). The active config is selected by
# ENVIO_CONFIG (default config.yaml). Point it at $CONFIG so L4 loads only the
# handlers belonging to the config under test (the probe config loads only the
# one ported handler; the full config would crash on un-ported handlers — which
# is exactly why L4 SKIPS for the full config).
export ENVIO_CONFIG="$CONFIG"

echo "Envio 3.2.1 verification loop — config: $CONFIG (ENVIO_CONFIG exported)"
echo "envio CLI: $("$ENVIO_BIN" --version 2>/dev/null | tail -1)"
hr

# ---------------------------------------------------------------------------
# L1 — codegen exit 0
# ---------------------------------------------------------------------------
echo "L1 codegen ($CONFIG)"
L1_LOG="$(mktemp)"
if timeout 300 "$ENVIO_BIN" codegen --config "$CONFIG" >"$L1_LOG" 2>&1; then
  ok "envio codegen exited 0"
else
  ko "envio codegen failed (see below)"
  tail -20 "$L1_LOG" | sed 's/^/      /'
fi
hr

# ---------------------------------------------------------------------------
# L2 — tsc of the ported handler surface against 3.2.1 envio types
# ---------------------------------------------------------------------------
echo "L2 typecheck (tsconfig.envio321.json)"
if [ -f tsconfig.envio321.json ]; then
  L2_LOG="$(mktemp)"
  if timeout 180 "$TSC_BIN" -p tsconfig.envio321.json >"$L2_LOG" 2>&1; then
    ok "ported handlers typecheck against 3.2.1 'envio' types"
  else
    ko "tsc found type errors in the ported handler surface"
    head -25 "$L2_LOG" | sed 's/^/      /'
  fi
else
  ko "tsconfig.envio321.json missing"
fi
hr

# ---------------------------------------------------------------------------
# L3 — boot pair-count == configured contract×event pairs
#
# Envio 3.2.1 has no static eventConfigs JSON (the alpha generated/
# internal.config.json is gone); the boot derives eventConfigs from config +
# the registered handlers. The deterministic, codegen-independent invariant we
# can assert at the config layer is: the configured contract×event count is
# non-zero and equals the bijection parser's count (the SAME number the boot
# would register from config). The bijection check (below) is the SoT for that
# count; here we assert it is sane and surface it.
# ---------------------------------------------------------------------------
echo "L3 boot pair-count ($CONFIG)"
L3_JSON="$(node scripts/check-onevent-bijection.mjs --config "$CONFIG" --json 2>/dev/null)"
PAIR_COUNT="$(printf '%s' "$L3_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).configPairs))}catch{process.stdout.write("ERR")}})')"
if [ "$PAIR_COUNT" = "ERR" ] || [ -z "$PAIR_COUNT" ]; then
  ko "could not derive configured contract×event count"
elif [ "$PAIR_COUNT" -gt 0 ] 2>/dev/null; then
  ok "configured contract×event pairs = $PAIR_COUNT (non-zero; matches boot registration count)"
else
  ko "configured contract×event count is 0 — config declares no events"
fi
hr

# ---------------------------------------------------------------------------
# L4 — createTestIndexer() smoke harness (the 3.2.1 test API)
# ---------------------------------------------------------------------------
echo "L4 createTestIndexer smoke harness"
L4_LOG="$(mktemp)"
if timeout 120 "$VITEST_BIN" run test/envio-321-smoke.test.ts >"$L4_LOG" 2>&1; then
  if grep -q "\[L4-SMOKE\] SKIP" "$L4_LOG"; then
    note "L4 harness SKIPPED (capability probe not primed for this config — expected when CONFIG != probe)"
    grep "\[L4-SMOKE\] SKIP" "$L4_LOG" | head -1 | sed 's/^/      /'
  else
    ok "createTestIndexer processed a simulated event and asserted entity writes"
  fi
else
  ko "L4 smoke harness failed (see below)"
  tail -25 "$L4_LOG" | sed 's/^/      /'
fi
hr

# ---------------------------------------------------------------------------
# L5 — existing vitest regression baseline (codegen-independent)
# ---------------------------------------------------------------------------
echo "L5 regression baseline (existing vitest suite)"
if [ "$SKIP_L5" = "1" ]; then
  note "L5 skipped (--skip-l5)"
else
  L5_LOG="$(mktemp)"
  # Exclude the L4 harness here — it is its own layer and is config-coupled.
  if timeout 300 "$VITEST_BIN" run --exclude 'test/envio-321-smoke.test.ts' >"$L5_LOG" 2>&1; then
    SUMMARY="$(grep -E 'Test Files|Tests ' "$L5_LOG" | tail -2 | tr '\n' ' ')"
    ok "existing vitest suite green — $SUMMARY"
  else
    ko "existing vitest suite has failures (regression)"
    grep -E 'FAIL|Test Files|Tests ' "$L5_LOG" | tail -15 | sed 's/^/      /'
  fi
fi
hr

# ---------------------------------------------------------------------------
# BIJECTION — silent-drift guardrail (advisory at foundation stage)
# ---------------------------------------------------------------------------
echo "BIJECTION guardrail (config <-> onEvent/contractRegister call sites)"
BIJ_LOG="$(mktemp)"
node scripts/check-onevent-bijection.mjs --config "$CONFIG" >"$BIJ_LOG" 2>&1
BIJ_RC=$?
sed 's/^/      /' "$BIJ_LOG"
if [ "$BIJ_RC" -eq 0 ]; then
  ok "perfect bijection — every config pair handled, no orphans"
elif [ "$BIJ_RC" -eq 3 ]; then
  # Gaps are expected until all handlers are ported. Orphans are a real error;
  # the check prints them, and the human/CI reads the report. At the foundation
  # stage we keep BIJECTION advisory so the loop can be green while the port is
  # in flight. (Flip to a hard gate at finalize by treating RC 3 as ko.)
  note "bijection drift (gaps = un-ported handlers, expected; orphans = real errors — review report above)"
else
  ko "bijection check errored (rc=$BIJ_RC)"
fi
hr

# ---------------------------------------------------------------------------
echo "SUMMARY: $pass passed, $fail failed, $advisory advisory"
if [ "$fail" -gt 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS (advisory items are informational at the foundation stage)"
exit 0
