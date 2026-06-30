#!/usr/bin/env bash
# sonar-pulse.sh — sonar's coherence self-check (the immune system as a command).
#
# WHY THIS EXISTS: on 2026-06-29 a session spent a long time re-deriving, by hand,
# whether sonar was telling the truth about itself — which belt is live, whether
# the green belt's handlers resolve, whether every configured contract×event
# actually registers, whether CI points at the live runtime. None of that should
# need re-deriving. This is that check, made runnable. It is honest-green by
# design: it surfaces every gap it finds rather than glossing a confident PASS.
#
# It proves nothing the envio binary would prove (codegen success). It proves the
# envio-FREE invariants that the live indexer's correctness rests on, the same ones
# test/registration-coverage.test.ts + test/green-belt-handler-resolves.test.ts
# encode — run as one tile so a human (or an agent) gets the whole picture at once.
#
# Usage:  bash scripts/sonar-pulse.sh
# Exit:   0 = COHERENT · 1 = DRIFT (gaps surfaced) · 2 = cannot run (no node_modules)
#
# Identity it checks against: SOUL.md. Rules live in CLAUDE.md. This is the sensor.

set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)" || exit 2

BLUE="config.mibera.yaml"   # the Mibera belt
GREEN="config.yaml"         # the full 6-chain belt (BELT_CONFIG=config.yaml on Railway)
drift=0

say()  { printf '%s\n' "$*"; }
rule() { printf '%s\n' "────────────────────────────────────────────────────────────"; }

rule
say "  sonar-pulse · coherence self-check · $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
say "  runtime: Envio HyperIndex, self-hosted on Railway (NOT managed Cloud, NOT Ponder)"
rule

# ── 1. Handler-path resolution per belt ──────────────────────────────────────
# Every `handler:`/`handlers:` path a belt config declares must exist on disk, or
# `envio codegen` (and the live `pnpm start`) fail on a dangling module.
say "▸ handler paths resolve on disk"
for cfg in "$GREEN" "$BLUE"; do
  [ -f "$cfg" ] || { say "    ⚠ $cfg — config missing"; drift=1; continue; }
  missing=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    if [ ! -e "$p" ]; then say "    ✗ $cfg → $p (DANGLING)"; missing=1; drift=1; fi
  done < <(grep -oE '^[[:space:]]*handlers?:[[:space:]]*[^#[:space:]]+' "$cfg" \
             | sed -E 's/.*handlers?:[[:space:]]*//; s/["'\'']//g' | sort -u)
  [ "$missing" -eq 0 ] && say "    ✓ $cfg — all handler paths resolve"
done

# ── 2. Runtime registration coverage per belt (envio-free vitest spy) ─────────
# Every configured contract×event must actually self-register at module load.
# gaps  = configured but never registered (events silently NOT indexed).
# orphans = registered but not configured (a handler firing into the void).
say ""
say "▸ runtime registration coverage (configured ⇔ registered)"
if [ ! -d node_modules ]; then
  say "    ⚠ node_modules absent — cannot run the registration spy (see verify-reality)"
  say "      install deps (or run in a worktree with symlinked node_modules) to complete the pulse"
  rule
  exit 2
fi
for cfg in "$GREEN" "$BLUE"; do
  # vitest routes test console output to stderr — capture both streams.
  line="$(ENVIO321_CONFIG="$cfg" npx vitest run test/registration-coverage.test.ts 2>&1 \
            | grep -oE '\[L3-REG\] \{[^}]*\}' | tail -1 | sed 's/^\[L3-REG\] //')"
  if [ -z "$line" ]; then say "    ⚠ $cfg — registration spy produced no [L3-REG] tile"; drift=1; continue; fi
  pairs=$(printf '%s' "$line"  | sed -nE 's/.*"configuredPairs":([0-9]+).*/\1/p')
  cov=$(printf '%s' "$line"    | sed -nE 's/.*"coveredConfiguredPairs":([0-9]+).*/\1/p')
  gaps=$(printf '%s' "$line"   | sed -nE 's/.*"gaps":([0-9]+).*/\1/p')
  orph=$(printf '%s' "$line"   | sed -nE 's/.*"orphans":([0-9]+).*/\1/p')
  if [ "${gaps:-1}" = "0" ] && [ "${orph:-1}" = "0" ]; then
    say "    ✓ $cfg — ${cov:-?}/${pairs:-?} pairs registered · gaps:0 orphans:0 (bijection holds)"
  else
    say "    ✗ $cfg — ${cov:-?}/${pairs:-?} registered · gaps:${gaps:-?} orphans:${orph:-?} (DRIFT)"
    drift=1
  fi
done

# ── 3. Verdict ───────────────────────────────────────────────────────────────
rule
if [ "$drift" -eq 0 ]; then
  say "  COHERENT — handler paths resolve and every belt's registrations bijection."
  say "  (This is envio-free coverage. Full 'envio codegen --config config.yaml'"
  say "   success is the manual gate; run it where the envio binary lives.)"
  rule; exit 0
else
  say "  DRIFT — gaps surfaced above. main does not (yet) tell the whole truth."
  say "  This is honest green refusing to glow: fix the gaps, then the pulse clears."
  rule; exit 1
fi
