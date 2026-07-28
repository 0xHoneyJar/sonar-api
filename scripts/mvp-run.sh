#!/usr/bin/env bash
#
# mvp-run.sh — run the next unblocked MVP step(s) as bounded /goal runs.
#
#   ./scripts/mvp-run.sh        # run 1 step (default)
#   ./scripts/mvp-run.sh 3      # run up to 3 steps in sequence
#
# Each step is its own `claude -p "/goal ..."` invocation: its own evaluator,
# its own turn limit, its own stopping condition. This is a chain of bounded
# runs, NOT one long unsupervised run — that distinction is the whole point.
#
# The chain stops immediately if a step fails to close its bead. A step that did
# not finish must never be built on.
#
# It also refuses to run bd-dwq5.7 (ship card + the door). That is zerker's
# decision and an autonomous runner must not reach it.
#
set -euo pipefail

TEAM="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SONAR="$TEAM/sonar-api"
STEPS="${1:-1}"
LOG="$SONAR/.run/mvp-run.log"
mkdir -p "$(dirname "$LOG")"

# Which repo each step's work lives in.
repo_for() {
  case "$1" in
    *.1 | *.2 | *.3 | *.7) echo "$TEAM/sonar-api" ;;
    *.4 | *.5 | *.6)       echo "$TEAM/score-api" ;;
    *)                     echo "" ;;
  esac
}

field() { python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))"; }

next_step() {
  (cd "$SONAR" && br ready -l mvp --limit 0 --json 2>/dev/null) | python3 -c '
import json, sys
d = json.load(sys.stdin)
rows = d if isinstance(d, list) else d.get("issues", d)
tasks = [r for r in rows if r.get("issue_type") != "epic"]
print(json.dumps(tasks[0]) if tasks else "")'
}

status_of() {
  # --status is repeatable and defaults to open-only; a successfully CLOSED bead
  # would otherwise read as "not found" and halt the chain on success.
  (cd "$SONAR" && br list --id "$1" \
      --status open --status in_progress --status closed --json 2>/dev/null) | python3 -c '
import json, sys
d = json.load(sys.stdin)
rows = d if isinstance(d, list) else d.get("issues", d)
print(rows[0].get("status", "") if rows else "")'
}

for ((n = 1; n <= STEPS; n++)); do
  step="$(next_step)"
  [ -z "$step" ] && { echo "✓ No ready MVP steps — burndown complete."; exit 0; }

  id="$(printf '%s' "$step" | field id)"
  title="$(printf '%s' "$step" | field title)"
  desc="$(printf '%s' "$step" | field description)"

  if [[ "$id" == *.7 ]]; then
    echo "⛔ Next is $id — run the check, ship card, the door."
    echo "   That is zerker's SHIP/KILL decision. Run it interactively, not here."
    exit 0
  fi

  repo="$(repo_for "$id")"
  echo "▶ [$n/$STEPS] $id — $title   (in $(basename "$repo"))" | tee -a "$LOG"

  (
    cd "$repo"
    claude -p "/goal Read the MVP objective at $SONAR/grimoires/loa/OBJECTIVE.md first, then achieve this: $desc

PROVE every claim with real command output pasted into the transcript — never 'should work'. Findings off this path go to PARKED.md in this repo, one line each: never a PR, a bead, or a sprint. Do not start any other MVP step. When the work is done and proven, run: br close $id. Stop after 20 turns and report status." \
      --output-format stream-json --verbose
  ) 2>&1 | tee -a "$LOG"

  st="$(status_of "$id")"
  if [ "$st" != "closed" ]; then
    echo "⛔ $id did not close (status: ${st:-unknown}). Stopping the chain." | tee -a "$LOG"
    echo "   A step that did not finish must not be built on. Check $LOG."
    exit 1
  fi
  echo "✓ $id closed" | tee -a "$LOG"
done

echo
echo "Remaining:"
(cd "$SONAR" && br ready -l mvp --limit 0 2>/dev/null | tail -n +2)
