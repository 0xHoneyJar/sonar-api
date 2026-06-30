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
# DESIGN INVARIANT (the load-bearing one): a check NEVER prints ✓ from an absence.
# Zero handler-paths matched, a missing config, a missing workflow file, a missing
# node_modules — each is reported as its own state (UNKNOWN / DRIFT), never as a
# silent green. A sensor that can glow green on absence is the exact lie this whole
# script exists to catch (BB review #105 F-001/F-002/F-003).
#
# Usage:  bash scripts/sonar-pulse.sh   (or: pnpm pulse)
# Exit:   0 = COHERENT · 1 = DRIFT (gaps surfaced) · 2 = UNVERIFIED (a check could
#         not run — e.g. no node_modules; the runnable checks still ran + reported)
#
# Identity it checks against: SOUL.md. Rules live in CLAUDE.md. This is the sensor.

set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)" || { echo "sonar-pulse: cannot cd to repo root"; exit 2; }

BLUE="config.mibera.yaml"   # the Mibera belt
GREEN="config.yaml"         # the full 6-chain belt (BELT_CONFIG=config.yaml on Railway)
# ENVIO321_CONFIG: the env var test/registration-coverage.test.ts reads to choose
# which belt config to run the registration spy against (defaults to config.probe.yaml).
drift=0            # a check positively FAILED (false ✓ impossible — see invariant)
unverified=0       # a check could not run (absence) — reported, never glossed as ✓

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
  if [ ! -f "$cfg" ]; then say "    ⚠ $cfg — config file ABSENT (cannot check)"; unverified=1; continue; fi
  missing=0; found=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    found=$((found + 1))
    if [ ! -e "$p" ]; then say "    ✗ $cfg → $p (DANGLING)"; missing=1; drift=1; fi
  done < <(grep -oE '^[[:space:]]*handlers?:[[:space:]]*[^#[:space:]]+' "$cfg" \
             | sed -E 's/.*handlers?:[[:space:]]*//; s/["'\'']//g' | sort -u)
  if [ "$found" -eq 0 ]; then
    # F-001: zero matches is NOT a pass — the config declares no handler at all,
    # or the scan broke. Either way the check verified nothing.
    say "    ⚠ $cfg — no handler:/handlers: declarations found (check verified nothing)"; unverified=1
  elif [ "$missing" -eq 0 ]; then
    say "    ✓ $cfg — all $found handler path(s) resolve"
  fi
done

# ── 2. Runtime authority (does CI / deps name the LIVE runtime?) ──────────────
# The drift class that froze in the past lightcone after the Ponder→Envio revert:
# the runtime is Envio, but a sensor or a dep still names the corpse. A green check
# over a dead runtime is the lie this whole sensor exists to catch. (No node_modules
# needed — runs even when deps are absent.)
say ""
say "▸ runtime authority (does CI / deps name the LIVE runtime?)"
if [ ! -f package.json ]; then
  say "    ⚠ package.json ABSENT (cannot check the declared runtime)"; unverified=1
elif grep -q '"name": *"envio-indexer"' package.json 2>/dev/null \
     && grep -qE '"(dev|start)": *"envio ' package.json 2>/dev/null; then
  say "    ✓ package.json declares the Envio runtime (name=envio-indexer, envio dev/start)"
else
  say "    ✗ package.json does not clearly declare the Envio runtime (DRIFT)"; drift=1
fi
# F-002: check the file EXISTS before grepping — absence must not read as "✓ live".
pc=.github/workflows/ponder-ci.yml
if [ ! -f "$pc" ]; then
  say "    ✓ no ponder-ci.yml (the inverted 'production gate' is gone)"
elif grep -qiE 'PRODUCTION|production gate' "$pc" 2>/dev/null; then
  say "    ✗ ponder-ci.yml still claims a 'production gate' over vestigial ponder-runtime/ (INVERTED — bd-c7jv)"; drift=1
else
  say "    ✓ ponder-ci.yml present but no longer claims a production gate"
fi
bb=.github/workflows/belt-build.yml
if [ ! -f "$bb" ]; then
  say "    ⚠ belt-build.yml ABSENT (cannot check the Envio gate framing)"; unverified=1
elif grep -qiE 'RETIRED envio|\[retired envio path\]' "$bb" 2>/dev/null; then
  # precise: the INVERTED phrasing names ENVIO as retired ("RETIRED envio belt",
  # "[retired envio path]"). A bare "retired" also matches the de-inverted file's
  # correct "ponder-ci is retired" / "NOT retired" — so we must not grep it broadly.
  say "    ✗ belt-build.yml marks the LIVE envio gates 'RETIRED' (defanged — bd-c7jv)"; drift=1
else
  say "    ✓ belt-build.yml treats the Envio gates as live"
fi

# ── 3. Runtime registration coverage per belt (envio-free vitest spy) ─────────
# Every configured contract×event must actually self-register at module load.
# gaps = configured but never registered (events silently NOT indexed); orphans =
# registered but not configured. Needs node_modules; if absent, reported UNVERIFIED
# (F-003 — the section is skipped, but the runnable checks above still gave a verdict).
say ""
say "▸ runtime registration coverage (configured ⇔ registered)"
if [ ! -d node_modules ]; then
  say "    ⚠ node_modules absent — registration spy UNVERIFIED (run \`pnpm install\` or use a"
  say "      worktree with symlinked node_modules; the checks above still ran)"; unverified=1
else
  for cfg in "$GREEN" "$BLUE"; do
    # vitest routes test console output to stderr — capture both streams. pnpm exec
    # uses the lockfile-pinned vitest, not whatever npx might resolve.
    line="$(ENVIO321_CONFIG="$cfg" pnpm exec vitest run test/registration-coverage.test.ts 2>&1 \
              | grep -oE '\[L3-REG\] \{[^}]*\}' | tail -1 | sed 's/^\[L3-REG\] //')"
    if [ -z "$line" ]; then say "    ⚠ $cfg — registration spy produced no [L3-REG] tile (UNVERIFIED)"; unverified=1; continue; fi
    pairs=$(printf '%s' "$line" | sed -nE 's/.*"configuredPairs":([0-9]+).*/\1/p')
    cov=$(printf '%s' "$line"   | sed -nE 's/.*"coveredConfiguredPairs":([0-9]+).*/\1/p')
    gaps=$(printf '%s' "$line"  | sed -nE 's/.*"gaps":([0-9]+).*/\1/p')
    orph=$(printf '%s' "$line"  | sed -nE 's/.*"orphans":([0-9]+).*/\1/p')
    if [ -z "$gaps" ] || [ -z "$orph" ]; then
      say "    ⚠ $cfg — could not parse the registration tile (UNVERIFIED)"; unverified=1
    elif [ "$gaps" = "0" ] && [ "$orph" = "0" ]; then
      say "    ✓ $cfg — ${cov:-?}/${pairs:-?} pairs registered · gaps:0 orphans:0 (bijection holds)"
    else
      say "    ✗ $cfg — ${cov:-?}/${pairs:-?} registered · gaps:${gaps} orphans:${orph} (DRIFT)"; drift=1
    fi
  done
fi

# ── 4. Verdict ───────────────────────────────────────────────────────────────
rule
if [ "$drift" -ne 0 ]; then
  say "  DRIFT — gaps surfaced above. main does not (yet) tell the whole truth."
  say "  This is honest green refusing to glow: fix the gaps, then the pulse clears."
  rule; exit 1
elif [ "$unverified" -ne 0 ]; then
  say "  UNVERIFIED — no DRIFT in the checks that ran, but at least one check could"
  say "  not run (see ⚠ above). This is NOT a clean bill of health — resolve the gaps"
  say "  in coverage, then re-run. (Full 'envio codegen --config config.yaml' success"
  say "  remains the manual gate; run it where the envio binary lives.)"
  rule; exit 2
else
  say "  COHERENT — handler paths resolve, CI names the live runtime, and every belt's"
  say "  registrations bijection. (Envio-free coverage; full codegen is the manual gate.)"
  rule; exit 0
fi
