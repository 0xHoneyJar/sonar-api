#!/usr/bin/env bash
#
# gate-a-proof.sh — GATE-A: prove a blue/green cutover serves continuously (S1-T4, PRD FR-B4).
#
# GATE-A is the near-term go/no-go that retires the in-place `ENVIO_RESTART=1 --restart` as the
# add procedure: on a STAGING pair, demonstrate that flipping the alias from blue→green (via the
# gated promote.sh) drops ZERO consumer queries and produces NO split-brain. PASS => blue/green is
# the standing add procedure.
#
# Method:
#   1. GATE — run `promote.sh --dry-run` (which runs the non-skippable promotion-gate.js against
#      BLUE_GRAPHQL_URL / GREEN_GRAPHQL_URL). Abort if the gate fails (green not at-head/parity).
#   2. PROBE — spawn a background prober hammering the stable ALIAS_URL every PROBE_INTERVAL_MS,
#      counting every non-200 / GraphQL-error / connection drop, AND recording each chain's
#      latest_processed_block PER chain_id.
#   3. FLIP — run the real `promote.sh` (Option B graceful caddy reload) to move the alias blue→green.
#   4. SETTLE — keep probing for SETTLE_SECONDS after the flip (catch a post-swap 5xx blip).
#   5. ASSERT — drops MUST be 0. Split-brain check (DISS-001): PER-CHAIN monotonicity — if ANY
#      single chain_id's latest_processed_block ever decreases across samples, that chain served an
#      older deployment mid-swap → FAIL (a global max would hide a regression on a non-max chain).
#   6. EMIT — a JSON proof record to $OUT (default grimoires/loa/a2a/sprint-1/gate-a-proof.json).
#
# Fail-closed: any gate failure or drop>0 or per-chain height-regression => non-zero exit.
# --dry-run prints the plan and makes NO writes / NO flip.
#
# ⚠ STAGING ONLY by default (refuses unless GATE_A_ALLOW_PROD=1) — a real flip mutates the alias.
# ⚠ Requires bash 4+ (associative arrays) at run time — fine on the Linux deploy target.
#
# Usage:
#   BLUE_GRAPHQL_URL=... GREEN_GRAPHQL_URL=... ALIAS_URL=... EXPECTED_CHAINS=1,10,8453 \
#     scripts/gate-a-proof.sh --dry-run
#   ... scripts/gate-a-proof.sh --apply           # perform the real staging flip + proof
#
# Env:
#   BLUE_GRAPHQL_URL GREEN_GRAPHQL_URL   — the pair the gate compares (passed to promote.sh gate)
#   ALIAS_URL                            — the stable consumer alias to probe (default sonar prod URL)
#   EXPECTED_CHAINS GOLDEN_SAMPLES       — forwarded to promotion-gate.js via promote.sh
#   PROBE_INTERVAL_MS (default 100)  SETTLE_SECONDS (default 30)  OUT (proof path)
#   GATE_A_ALLOW_PROD=1                  — required to target a non-staging ALIAS_URL

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMOTE="${PROMOTE_SH:-$SCRIPT_DIR/promote.sh}"

DRY_RUN=1   # default SAFE: dry-run unless --apply
ALIAS_URL="${ALIAS_URL:-https://sonar.0xhoneyjar.xyz/v1/graphql}"
PROBE_INTERVAL_MS="${PROBE_INTERVAL_MS:-100}"
SETTLE_SECONDS="${SETTLE_SECONDS:-30}"
OUT="${OUT:-grimoires/loa/a2a/sprint-1/gate-a-proof.json}"

log() { printf '[gate-a] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

while [ $# -gt 0 ]; do
	case "$1" in
		--apply)   DRY_RUN=0 ;;
		--dry-run) DRY_RUN=1 ;;
		-h|--help) sed -n '2,46p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) die "unknown argument '$1'" ;;
	esac
	shift
done

[ -x "$PROMOTE" ] || die "promote.sh not found/executable at $PROMOTE"
if [ "$DRY_RUN" = "0" ] && [ "${GATE_A_ALLOW_PROD:-0}" != "1" ]; then
	# M1/CWE-697: anchor on the HOST, not a substring anywhere in the URL. A prod URL that merely
	# CONTAINS "staging"/"internal" in its path or query (e.g. ...prod.../graphql?env=staging) must
	# NOT bypass the prod-flip guard. Strip scheme, path, query, and port down to the bare host.
	_host="${ALIAS_URL#*://}"; _host="${_host%%/*}"; _host="${_host%%\?*}"; _host="${_host%%:*}"
	case "$_host" in
		localhost|127.0.0.1) : ;;
		*.internal|*.staging|*.staging.*) : ;;
		*) die "ALIAS_URL host '$_host' is not loopback/staging; refusing real flip without GATE_A_ALLOW_PROD=1" ;;
	esac
fi

# ── Step 1: GATE ────────────────────────────────────────────────────────────────────────────
log "STEP 1 — promotion gate (promote.sh --dry-run runs the non-skippable promotion-gate.js)"
if "$PROMOTE" --dry-run; then
	GATE_STATUS="PASS"
elif [ "$DRY_RUN" = "1" ]; then
	# Planning dry-run without a live staging pair: the gate can't be evaluated, but that must
	# NOT block printing the plan. --apply still hard-fails on a real gate failure (below).
	GATE_STATUS="NOT_EVALUATED(dry-run)"
	log "dry-run: promotion gate not evaluated (no live pair / URLs) — plan only"
else
	die "promotion gate FAILED — green not at-head/parity; do not flip"
fi

# probe helper: one query → prints "ok <cid>:<height> <cid>:<height> ..." | "drop <reason>"
probe_once() {
	local url="$1" body pairs
	body=$(curl -fsS --max-time 5 -X POST "$url" -H 'Content-Type: application/json' \
		--data '{"query":"query{ chain_metadata { chain_id latest_processed_block } }"}' 2>/dev/null) || { echo "drop conndrop"; return; }
	case "$body" in
		*'"errors"'*) echo "drop graphql_error"; return ;;
	esac
	# structured per-chain extraction (avoids the DISS-001 global-max collapse)
	pairs=$(printf '%s' "$body" | jq -r '.data.chain_metadata[]? | "\(.chain_id):\(.latest_processed_block)"' 2>/dev/null | tr '\n' ' ')
	if [ -n "$pairs" ]; then echo "ok $pairs"; else echo "drop noparse"; fi
}

if [ "$DRY_RUN" = "1" ]; then
	log "DRY-RUN: gate=$GATE_STATUS. Would spawn prober on $ALIAS_URL @${PROBE_INTERVAL_MS}ms, run promote.sh, settle ${SETTLE_SECONDS}s, assert drops==0 + PER-CHAIN monotonic heights."
	mkdir -p "$(dirname "$OUT")"
	printf '{"gate_a":"DRY_RUN","gate":"%s","alias":"%s","drops":null,"split_brain":null}\n' "$GATE_STATUS" "$ALIAS_URL" | tee "$OUT"
	exit 0
fi

# ── Step 2–4: PROBE across the FLIP ─────────────────────────────────────────────────────────
sleep_s=$(awk "BEGIN{print $PROBE_INTERVAL_MS/1000}")
probe_loop() {   # runs until sentinel file appears; tracks PER-CHAIN monotonicity
	local drops=0 samples=0 maxh=0 regressions=0 r pair cid h prev
	declare -A chainmax
	while [ ! -f "$1" ]; do
		r=$(probe_once "$ALIAS_URL")
		case "$r" in
			ok\ *)
				samples=$((samples+1))
				for pair in ${r#ok }; do
					cid=${pair%%:*}; h=${pair##*:}
					[ -z "$h" ] && continue
					case "$h" in ''|*[!0-9]*) continue ;; esac   # numeric guard
					prev=${chainmax[$cid]:-0}
					if [ "$h" -lt "$prev" ]; then
						regressions=$((regressions+1))
						log "SPLIT-BRAIN: chain $cid regressed $prev -> $h"
					fi
					[ "$h" -gt "$prev" ] && chainmax[$cid]=$h
					[ "$h" -gt "$maxh" ] && maxh=$h
				done ;;
			drop\ *) drops=$((drops+1)); samples=$((samples+1)); log "DROP: ${r#drop }" ;;
		esac
		sleep "$sleep_s"
	done
	printf '%d %d %d %d\n' "$drops" "$samples" "$maxh" "$regressions" > "$1.result"
}
# L2/CWE-377: keep the sentinel + result inside a private temp dir, cleaned up on exit.
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
SENT="$WORK/sentinel"
( probe_loop "$SENT" ) & PROBER=$!
log "STEP 2 — prober PID $PROBER hammering $ALIAS_URL (per-chain height tracking)"
log "STEP 3 — FLIP: promote.sh (gated, graceful reload)"
"$PROMOTE" || { touch "$SENT"; wait "$PROBER" 2>/dev/null || true; die "promote.sh flip failed"; }
log "STEP 4 — settle ${SETTLE_SECONDS}s"
sleep "$SETTLE_SECONDS"
touch "$SENT"; wait "$PROBER" 2>/dev/null || true
read -r DROPS SAMPLES MAXH REGRESSIONS < "$SENT.result"   # $WORK cleaned up by the EXIT trap

# ── Step 5–6: ASSERT + EMIT ─────────────────────────────────────────────────────────────────
VERDICT="PASS"
[ "${DROPS:-1}" -eq 0 ] || VERDICT="FAIL"
[ "${REGRESSIONS:-1}" -eq 0 ] || VERDICT="FAIL"
mkdir -p "$(dirname "$OUT")"
printf '{"gate_a":"%s","gate":"%s","alias":"%s","samples":%d,"drops":%d,"per_chain_height_regressions":%d,"max_height":%d}\n' \
	"$VERDICT" "$GATE_STATUS" "$ALIAS_URL" "${SAMPLES:-0}" "${DROPS:-0}" "${REGRESSIONS:-0}" "${MAXH:-0}" | tee "$OUT"
log "GATE-A $VERDICT — drops=${DROPS:-?}/${SAMPLES:-?}, per-chain split-brain regressions=${REGRESSIONS:-?}"
[ "$VERDICT" = "PASS" ] || exit 1
