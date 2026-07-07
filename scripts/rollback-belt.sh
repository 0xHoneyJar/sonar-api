#!/usr/bin/env bash
#
# rollback-belt.sh — full belt rollback (S1-T2, SDD §7.4 step 6, SKP-001).
#
# The referenced-but-missing consumer of scripts/snapshot-pre-cutover.sh (which produces the
# rollback artifact pair: Postgres pgdump + Hasura metadata json). This script is the ONE
# operator entrypoint to revert a bad cutover.
#
# ORDERING (DISS-002): the sequence depends on whether a DATA restore is requested.
#   • WITH --snapshot-dir: RESTORE + verify the blue database FIRST, THEN flip the alias to it.
#     Flipping first would point live traffic at a database mid-`pg_restore --clean` — if the
#     restore failed partway, prod would serve a half-restored/corrupted DB. So the destructive
#     restore happens with NO traffic on blue; the alias moves only after restore+verify succeed.
#   • WITHOUT --snapshot-dir (alias-only): just flip the alias (blue is already intact), then verify.
#
# In all cases: GREEN is never touched — preserved for postmortem (no fix-in-place, SDD §8).
# Fail-closed: any step's non-zero exit aborts with a non-zero code. --dry-run makes NO writes.
#
# Usage:
#   scripts/rollback-belt.sh                          # alias revert + consumer verify
#   scripts/rollback-belt.sh --dry-run                # print the plan; no writes
#   scripts/rollback-belt.sh --snapshot-dir DIR       # restore blue (pgdump/hasura) THEN flip alias
#   scripts/rollback-belt.sh --alias-url URL          # override the alias to verify (default: $BELT_ALIAS_URL)
#
# Env (data restore, only when --snapshot-dir given):
#   PG_HOST PG_USER PGPASSWORD PG_DB   — target (blue) Postgres for pg_restore
#   HASURA_GRAPHQL_ENDPOINT HASURA_GRAPHQL_ADMIN_SECRET — target Hasura for metadata apply
#   BLUE_GRAPHQL_URL                   — optional: blue GraphQL to verify serving before the flip
#
# Related: scripts/promote.sh (--rollback), scripts/snapshot-pre-cutover.sh (produces the pair),
#          scripts/consumer-reconnect-drill.sh (deeper consumer drill).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMOTE="${PROMOTE_SH:-$SCRIPT_DIR/promote.sh}"

DRY_RUN=0
SNAPSHOT_DIR=""
ALIAS_URL="${BELT_ALIAS_URL:-https://sonar.0xhoneyjar.xyz/v1/graphql}"

log() { printf '[rollback-belt] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run)      DRY_RUN=1 ;;
		--snapshot-dir) SNAPSHOT_DIR="${2:?--snapshot-dir needs a path}"; shift ;;
		--alias-url)    ALIAS_URL="${2:?--alias-url needs a value}"; shift ;;
		-h|--help)      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) die "unknown argument '$1'" ;;
	esac
	shift
done

[ -x "$PROMOTE" ] || die "promote.sh not found/executable at $PROMOTE"

# ── restore + verify the BLUE database (runs BEFORE any alias flip; DISS-002) ────────────────
restore_blue_data() {
	local pgdump hmeta
	pgdump=$(ls "$SNAPSHOT_DIR"/*.pgdump "$SNAPSHOT_DIR"/*.dump 2>/dev/null | head -1 || true)
	hmeta=$(ls "$SNAPSHOT_DIR"/*hasura*metadata*.json "$SNAPSHOT_DIR"/metadata.json 2>/dev/null | head -1 || true)
	[ -n "$pgdump" ] || die "no Postgres dump (*.pgdump|*.dump) in $SNAPSHOT_DIR"
	log "DATA restore (pre-flip): pgdump=$pgdump hasura_metadata=${hmeta:-<none>}"
	if [ "$DRY_RUN" = "1" ]; then
		log "DRY-RUN: would pg_restore $pgdump into ${PG_DB:-\$PG_DB}@${PG_HOST:-\$PG_HOST} BEFORE any alias flip"
		[ -n "$hmeta" ] && log "DRY-RUN: would apply Hasura metadata $hmeta, then verify blue serves"
		return 0
	fi
	: "${PG_HOST:?data restore needs PG_HOST}"; : "${PG_USER:?PG_USER}"; : "${PG_DB:?PG_DB}"
	PGPASSWORD="${PGPASSWORD:?PGPASSWORD}" pg_restore --clean --if-exists --no-owner \
		-h "$PG_HOST" -U "$PG_USER" -d "$PG_DB" "$pgdump" \
		|| die "pg_restore failed — alias NOT flipped (no traffic pointed at a half-restored blue DB)"
	if [ -n "$hmeta" ]; then
		: "${HASURA_GRAPHQL_ENDPOINT:?HASURA_GRAPHQL_ENDPOINT}"
		# M2: secret is MANDATORY (never authenticate with an empty admin secret) and kept OFF the
		# process args (CWE-214) — passed via a --config FD (process substitution), not `-H` on argv.
		: "${HASURA_GRAPHQL_ADMIN_SECRET:?Hasura admin secret required for metadata apply}"
		curl -fsS -X POST "$HASURA_GRAPHQL_ENDPOINT/v1/metadata" \
			--config <(printf 'header = "x-hasura-admin-secret: %s"\n' "$HASURA_GRAPHQL_ADMIN_SECRET") \
			-H 'Content-Type: application/json' \
			--data "$(printf '{"type":"replace_metadata","args":%s}' "$(cat "$hmeta")")" >/dev/null \
			|| die "Hasura metadata apply failed — alias NOT flipped"
	fi
	# Verify the restored blue serves BEFORE any traffic is pointed at it.
	if [ -n "${BLUE_GRAPHQL_URL:-}" ]; then
		curl -fsS -X POST "$BLUE_GRAPHQL_URL" -H 'Content-Type: application/json' \
			--data '{"query":"query{ __typename }"}' >/dev/null \
			|| die "restored blue did not serve at $BLUE_GRAPHQL_URL — alias NOT flipped"
		log "restored blue verified serving — safe to flip"
	else
		log "WARN: BLUE_GRAPHQL_URL unset — cannot verify restored blue before flip"
	fi
}

# ── alias revert (green → blue) via the sole writer ─────────────────────────────────────────
revert_alias() {
	log "ALIAS revert via promote.sh --rollback (sole BELT_UPSTREAM writer)"
	if [ "$DRY_RUN" = "1" ]; then "$PROMOTE" --rollback --dry-run; else "$PROMOTE" --rollback; fi
}

# ── verify consumers see blue serving via the stable alias ──────────────────────────────────
verify_consumers() {
	log "consumer verify against alias: $ALIAS_URL"
	if [ "$DRY_RUN" = "1" ]; then
		log "DRY-RUN: would POST a probe query to $ALIAS_URL and assert HTTP 200 + non-error body"
		return 0
	fi
	local body safe
	body=$(curl -fsS -X POST "$ALIAS_URL" -H 'Content-Type: application/json' \
		--data '{"query":"query{ __typename }"}' 2>/dev/null) \
		|| die "alias $ALIAS_URL did not serve after rollback — consumers may be dark, escalate"
	# L1/CWE-117: log a truncated, control-char-stripped summary, not the raw upstream body.
	safe=$(printf '%s' "$body" | tr -d '\000-\037' | cut -c1-200)
	case "$body" in
		*'"errors"'*) die "alias returned GraphQL errors post-rollback: $safe" ;;
		*'__typename'*|*'data'*) log "alias serving OK: $safe" ;;
		*) die "unexpected alias response: $safe" ;;
	esac
}

# ── orchestrate in the safe order ───────────────────────────────────────────────────────────
if [ -n "$SNAPSHOT_DIR" ]; then
	log "DATA rollback — restore+verify blue, THEN flip alias (DISS-002 safe order)"
	restore_blue_data   # 1. destructive restore happens with NO traffic on blue
	revert_alias        # 2. only now move the alias to the restored+verified blue
	verify_consumers    # 3. confirm consumers see blue
else
	log "ALIAS-only rollback — no --snapshot-dir (blue already intact)"
	revert_alias        # 1. flip alias
	verify_consumers    # 2. confirm consumers
fi

log "ROLLBACK COMPLETE — blue live, green PRESERVED for postmortem (do NOT fix-in-place)."
printf '{"rollback":"complete","alias":"%s","data_restored":%s,"dry_run":%s}\n' \
	"$ALIAS_URL" "$([ -n "$SNAPSHOT_DIR" ] && echo true || echo false)" \
	"$([ "$DRY_RUN" = "1" ] && echo true || echo false)"
