#!/usr/bin/env bash
#
# promote.sh — the ONLY blue↔green alias swap path (bd-c09.4, SDD §7/§8, SR-3 / R-D).
#
# Promotion is gated: this script runs scripts/promotion-gate.js as a NON-SKIPPABLE
# precondition and ABORTS (fail-closed) on any non-zero exit — there is no code path that
# flips BELT_UPSTREAM without a fresh gate PASS. It is the SOLE writer of BELT_UPSTREAM
# (R-D); the gateway Caddyfile comment forbids bare env edits. It also publishes the
# current-belt DATABASE_URL signal so the raw-PG consumer (Score, score-api#163) knows
# which belt is live, alongside the GraphQL (BELT_UPSTREAM) flip.
#
# Usage:
#   scripts/promote.sh                 # promote blue → green (runs the gate first)
#   scripts/promote.sh --dry-run       # run the gate + print the intended flip; NO writes
#   scripts/promote.sh --rollback      # revert green → blue (safety exit; NO gate)
#   scripts/promote.sh --rollback --dry-run
#
# The gate reads its config from the environment (set these before invoking for a promote):
#   PROMOTION_MODE (default: expansion), BLUE_GRAPHQL_URL, GREEN_GRAPHQL_URL,
#   EXPECTED_CHAINS, GOLDEN_SAMPLES  (+ optional RPC_<chainId>)  — see scripts/promotion-gate.js.
# Rollback does NOT run the gate (it is the safety exit; blue is kept hot + at-head, R-A).
#
# Zero-downtime (FR-6 / SDD §7.4): the swap is the gate-gated var flip. The gateway runs
# Caddy with a loopback-only admin (bd-c09.1) so the apply can be a graceful `caddy reload`
# (Option B). If localhost-only reload proves infeasible on Railway, the §7.4 contingency is
# Option C (≥2 gateway replicas → rolling redeploy) — no re-decision needed.
#
# §8 ROLLBACK TRIGGERS (run `promote.sh --rollback` on any of these in the first hour):
#   • a 5xx spike on the alias post-swap
#   • a consumer reports a missing entity / field
#   • a post-swap reconciliation re-run shows green diverged
#   • operator-detected data inconsistency
# On rollback: revert to blue, verify consumers, KEEP the broken green for postmortem
# (do NOT fix-in-place).
#
# Secrets: the Railway token is read inline from a 0600 file and never echoed; the DB-URL
# values written are Railway *references* (`${{Service.DATABASE_URL}}`), not resolved creds.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="${PROMOTION_GATE:-$SCRIPT_DIR/promotion-gate.js}"

# ── config (env-overridable) ───────────────────────────────────────────────────
TOKEN_FILE="${RAILWAY_TOKEN_FILE:-$HOME/.railway-green.tok}"
GATEWAY_SERVICE="${GATEWAY_SERVICE:-belt-gateway}"
GREEN_UPSTREAM="${GREEN_UPSTREAM:-belt-hasura-green.railway.internal:8080}"
BLUE_UPSTREAM="${BLUE_UPSTREAM:-belt-hasura.railway.internal:8080}"
# Score raw-PG signal (score-api#163). The exact consumer location is defined by #163;
# default = a discoverable var on the gateway, both target + name overridable.
SCORE_SIGNAL_SERVICE="${SCORE_SIGNAL_SERVICE:-$GATEWAY_SERVICE}"
SCORE_SIGNAL_VAR="${SCORE_SIGNAL_VAR:-CURRENT_BELT_DATABASE_URL}"
PROMOTION_MODE="${PROMOTION_MODE:-expansion}"; export PROMOTION_MODE

# DB-URL Railway references — single-quoted literals so bash never tries to expand `${{`.
GREEN_DB_REF="${GREEN_DB_REF-}"; [ -n "$GREEN_DB_REF" ] || GREEN_DB_REF='${{Postgres-vRR1.DATABASE_URL}}'
BLUE_DB_REF="${BLUE_DB_REF-}";   [ -n "$BLUE_DB_REF"  ] || BLUE_DB_REF='${{Postgres-3vIC.DATABASE_URL}}'

DRY_RUN=0
ROLLBACK=0

log() { printf '%s\n' "$*" >&2; }

usage() {
	# Header comment is the usage body (lines 2–37); append mutual discovery footer.
	sed -n '2,37p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
	cat <<'EOF'

Related CLIs (mutual discovery):
  pnpm care triage --json              care map + live S1 (structured; not this tool)
  pnpm care capabilities --json        care machine contract
  pnpm pulse                           coherence sensor (0=COHERENT · 1=DRIFT · 2=UNVERIFIED)
  pnpm self / pnpm self:check          territory beacon emit / drift-check
  CARE.md · grimoires/loa/ARRIVAL.md

First-try (safe):
  bash scripts/promote.sh --dry-run
  bash scripts/promote.sh --help
EOF
	exit "${1:-0}"
}

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--rollback) ROLLBACK=1 ;;
		-h|--help|help) usage 0 ;;
		# dry-run aliases / typos (inferred-and-acted with stderr breadcrumb)
		--dryrun|--dry|--dry-runs|--dry_run|--drurun|--dry-ru)
			DRY_RUN=1
			log "promote.sh: treating '$1' as --dry-run"
			;;
		# rollback aliases / typos
		--roll-back|--revert|--rollbak|--rolllback|--roll_back|--undopromote)
			ROLLBACK=1
			log "promote.sh: treating '$1' as --rollback"
			;;
		# help typos → teach exact command (do not silently succeed)
		--hepl|--halp|--hlep|--hep|--helps)
			log "promote.sh: unknown flag '$1' — did you mean '--help'?"
			log "  exact: bash scripts/promote.sh --help"
			exit 1
			;;
		# json-ish typos (promote has no --json; redirect to care)
		--jsno|--jason|--json|-j)
			log "promote.sh: unknown flag '$1' — promote has no --json surface"
			log "  did you mean care triage for structured output?"
			log "  exact: bash scripts/sonar-care.sh triage --json"
			log "  or:    bash scripts/promote.sh --dry-run"
			exit 1
			;;
		*)
			log "promote.sh: unknown argument '$1'"
			log "  did you mean one of: --dry-run · --rollback · --help"
			log "  exact: bash scripts/promote.sh --dry-run"
			log "  or:    bash scripts/promote.sh --help"
			exit 1
			;;
	esac
	shift
done

# rw: run the railway CLI with the project token (token never echoed). Resolved from PATH
# so tests can shim it. Only invoked for real (non-dry-run) writes.
rw() { RAILWAY_TOKEN="$(cat "$TOKEN_FILE")" railway "$@"; }

# set_var SERVICE KEY=VALUE — print intent always; write only when not --dry-run.
set_var() {
	local svc="$1" kv="$2"
	if [ "$DRY_RUN" -eq 1 ]; then
		log "  [dry-run] would set ${kv%%=*} on ${svc}  (→ ${kv#*=})"
	else
		rw variables --service "$svc" --set "$kv" >/dev/null
		log "  set ${kv%%=*} on ${svc}  (→ ${kv#*=})"
	fi
}

# require the token file before any real write (clear, early failure).
require_token() {
	[ "$DRY_RUN" -eq 1 ] && return 0
	if [ ! -r "$TOKEN_FILE" ]; then
		log "ERROR: Railway token file not readable: $TOKEN_FILE (set RAILWAY_TOKEN_FILE)"; exit 3
	fi
}

run_gate() {
	log "── Gate precondition (NON-SKIPPABLE, R-D) ─────────────────────────────"
	log "   mode=${PROMOTION_MODE}  gate=${GATE}"
	local rc=0
	node "$GATE" || rc=$?
	if [ "$rc" -eq 0 ]; then
		log "   ✅ gate PASS (swap allowed)"
		return 0
	fi
	log "   ❌ gate FAILED (exit ${rc}) — ABORTING swap, no flip (fail-closed)"
	return 1
}

if [ "$ROLLBACK" -eq 1 ]; then
	log "════ ROLLBACK: green → blue ════  (safety exit — no gate; blue kept hot + at-head, R-A)"
	require_token
	set_var "$GATEWAY_SERVICE" "BELT_UPSTREAM=${BLUE_UPSTREAM}"
	set_var "$SCORE_SIGNAL_SERVICE" "${SCORE_SIGNAL_VAR}=${BLUE_DB_REF}"
	log "✅ reverted to BLUE. Verify consumers are green, then investigate the bad green"
	log "   for postmortem — do NOT fix-in-place."
	exit 0
fi

log "════ PROMOTE: blue → green ════"
# BB F1 (defense-in-depth; the gate enforces this too): a real promotion MUST validate a
# DISTINCT green. Refuse if GREEN_GRAPHQL_URL is unset or equals BLUE — self-parity is a
# gate test mode, never a live swap.
if [ -z "${GREEN_GRAPHQL_URL:-}" ] || [ "${GREEN_GRAPHQL_URL:-}" = "${BLUE_GRAPHQL_URL:-}" ]; then
	log "ERROR: promote requires GREEN_GRAPHQL_URL set AND ≠ BLUE_GRAPHQL_URL (refusing blue-vs-blue, BB F1)"; exit 3
fi
run_gate || exit 1   # fail-closed: a non-zero gate aborts the swap entirely
require_token
log "── Swap (gate PASSED) ─────────────────────────────────────────────────"
set_var "$GATEWAY_SERVICE" "BELT_UPSTREAM=${GREEN_UPSTREAM}"
set_var "$SCORE_SIGNAL_SERVICE" "${SCORE_SIGNAL_VAR}=${GREEN_DB_REF}"
if [ "$DRY_RUN" -eq 1 ]; then
	log "✅ DRY-RUN complete — gate ran, NO writes made."
else
	log "✅ swapped to GREEN. Now watch the alias through the rollback window:"
fi
log "   §8 triggers → run 'promote.sh --rollback': 5xx spike · missing entity/field ·"
log "   post-swap recon divergence · operator-detected inconsistency (first hour)."
