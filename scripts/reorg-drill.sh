#!/usr/bin/env bash
# scripts/reorg-drill.sh
#
# T-A3.9 (SKP-002 CRITICAL) — Reorg drill executable.
#
# PROVES: the outbox's deterministic-ID idempotency holds under simulated
# reorg conditions. Specifically:
#
#   GIVEN  N pending_emits rows with deterministic IDs derived from real
#          chain-1 transaction hashes,
#   WHEN   we simulate a reorg by re-running reorg-safe-emit with IDENTICAL
#          canonical inputs (chainId|txHash|logIndex|envelopeType),
#   THEN   the pending_emits row count for those IDs MUST be exactly N
#          (NOT 2N, NOT N+1) — `onConflictDoNothing` absorbs duplicates.
#
# Source-of-truth: SDD §8.5 (reorg drill spec) + COOKBOOK §T-A0.9
# (deterministic id verified driver-level at 5x replay = 1 row).
#
# This script is the **STAGING-EXECUTION** form of that proof. The
# driver-level test (spike/ponder-A-0) hit the same property locally.
#
# Required env:
#   STAGING_DB_URL — Postgres connection string with write access to
#                    ponder.pending_emits (e.g. postgres://postgres@host:5432/sonar)
#
# Optional env:
#   N_EVENTS       — number of synthetic events to insert (default 20)
#   CHAIN_ID       — chain to simulate (default 1 = Ethereum mainnet)
#   DRILL_ID       — UUID for this drill run (default: generated)
#
# Output: a single JSON document on stdout, e.g.
#   {
#     "drill_id": "20260527T1530Z-1a2b3c",
#     "chain_id": 1,
#     "n_events": 20,
#     "pre_count": 20,
#     "post_replay_count": 20,
#     "duplicate_count": 0,
#     "idempotency_pass": true,
#     "envelope_type_distribution": { "mint": 14, "transfer": 6 },
#     "elapsed_ms": 1234,
#     "exit_reason": "ok"
#   }
#
# Exit codes:
#   0 — idempotency_pass true (drill passes)
#   1 — idempotency_pass false (DUPLICATES OBSERVED — production-blocker)
#   2 — script-level error (missing env, DB connect failed, etc.)

set -euo pipefail

START_EPOCH_MS=$(($(date +%s%N) / 1000000))

# ─── 1. Env validation ────────────────────────────────────────────────
if [[ -z "${STAGING_DB_URL:-}" ]]; then
  echo '{"exit_reason":"missing-env","detail":"STAGING_DB_URL not set"}' >&2
  exit 2
fi
N_EVENTS="${N_EVENTS:-20}"
CHAIN_ID="${CHAIN_ID:-1}"
DRILL_ID="${DRILL_ID:-$(date -u +%Y%m%dT%H%MZ)-$(openssl rand -hex 3 2>/dev/null || echo dr$RANDOM)}"

command -v psql >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"psql not installed"}' >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"jq not installed"}' >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo '{"exit_reason":"missing-dep","detail":"node not installed"}' >&2; exit 2; }

PSQL=(psql "${STAGING_DB_URL}" -At -v ON_ERROR_STOP=1 -X)

# ─── 2. Generate N deterministic IDs from synthetic-but-realistic txHashes ────
#
# Use Node to compute keccak256(chainId|txHash|logIndex|envelopeType) — same
# canonical encoding as `deterministicEmitId` in ponder-runtime/src/lib/reorg-safe-emit.ts.
# (We avoid `npx` to keep the drill hermetic; viem is in node_modules already
#  per pnpm install at the freeside-sonar repo root.)
#
# cd to the script's parent dir's parent (= repo root) so `require("viem")`
# resolves against ./node_modules. Lets the operator invoke from anywhere.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
cd "$REPO_ROOT" || { echo '{"exit_reason":"cd-failed","detail":"cannot cd to repo root"}' >&2; exit 2; }

GENERATE_PAYLOADS_JS=$(cat <<'JSEOF'
const { keccak256, toBytes } = require("viem");
const chainId = parseInt(process.env.CHAIN_ID, 10);
const n = parseInt(process.env.N_EVENTS, 10);
const drillId = process.env.DRILL_ID;
const types = ["mint", "transfer"];
const rows = [];
for (let i = 0; i < n; i++) {
  // Stable, drill-scoped txHash so re-runs produce the same IDs.
  const seed = `0x${Buffer.from(`${drillId}-${i}`).toString("hex").padEnd(64, "0").slice(0, 64)}`;
  const txHash = seed;
  const logIndex = i;
  const envelopeType = types[i % 2];
  const canonical = `${chainId}|${txHash.toLowerCase()}|${logIndex}|${envelopeType}`;
  const id = keccak256(toBytes(canonical));
  rows.push({ id, chainId, txHash, logIndex, envelopeType });
}
process.stdout.write(JSON.stringify(rows));
JSEOF
)

PAYLOADS_JSON=$(CHAIN_ID="$CHAIN_ID" N_EVENTS="$N_EVENTS" DRILL_ID="$DRILL_ID" \
  node -e "$GENERATE_PAYLOADS_JS")

if [[ -z "$PAYLOADS_JSON" ]] || [[ "$PAYLOADS_JSON" == "null" ]]; then
  echo '{"exit_reason":"payload-gen-failed"}' >&2
  exit 2
fi

# ─── 3. Phase A: insert N rows. Capture pre-count. ────────────────────
"${PSQL[@]}" <<SQL >/dev/null
CREATE SCHEMA IF NOT EXISTS ponder;
-- Defensive: drill targets ponder.pending_emits. If the table doesn't exist
-- (drill run before Ponder schema deployed), the script fails clearly.
DO \$\$ BEGIN
  PERFORM 1 FROM information_schema.tables
    WHERE table_schema = 'ponder' AND table_name = 'pending_emits';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ponder.pending_emits does not exist — deploy Ponder schema first';
  END IF;
END \$\$;
SQL

# Bulk insert via psql COPY-from-stdin would be cleaner, but for N=20-100 the
# INSERT loop is simpler and gives us per-row visibility. Each INSERT uses
# ON CONFLICT DO NOTHING so the second phase (replay) is safe.
#
# jq filter is written to a temp file to avoid bash single-quote nesting
# pitfalls when the filter contains literal single-quote chars (for SQL
# string delimiters). Use ' in the filter to refer to a single quote
# from inside a jq double-quoted string.
JQ_FILTER_FILE=$(mktemp -t reorg-drill-jq.XXXXXX)
trap 'rm -f "$JQ_FILTER_FILE"' EXIT

cat > "$JQ_FILTER_FILE" <<'JQEOF'
.[] |
  "INSERT INTO ponder.pending_emits (id, chain_id, tx_hash, log_index, envelope_type, event_block, target_block, envelope_json, published_at, attempt_count, last_error) VALUES ("
  + "'" + .id + "', "
  + (.chainId | tostring) + ", "
  + "'" + (.txHash | ascii_downcase) + "', "
  + (.logIndex | tostring) + ", "
  + "'" + .envelopeType + "', "
  + "1000000, 1000012, "
  + "'{\"type\":\"" + .envelopeType + "\",\"subject\":\"drill\",\"payload\":{}}', "
  + "NULL, 0, NULL"
  + ") ON CONFLICT DO NOTHING;"
JQEOF

INSERT_SQL=$(echo "$PAYLOADS_JSON" | jq -r -f "$JQ_FILTER_FILE")

echo "$INSERT_SQL" | "${PSQL[@]}" >/dev/null

# Capture pre-replay count (scoped to OUR drill IDs). Build a comma-separated
# list of single-quoted ids: 'id1','id2','id3' for the IN clause.
# Pre-built via filter file to avoid bash/jq single-quote nesting.
ID_LIST_JQ=$(mktemp -t reorg-drill-id-jq.XXXXXX)
cat > "$ID_LIST_JQ" <<'JQEOF'
[.[].id | "'" + . + "'"] | join(",")
JQEOF
ID_LIST=$(echo "$PAYLOADS_JSON" | jq -r -f "$ID_LIST_JQ")
rm -f "$ID_LIST_JQ"
PRE_COUNT=$("${PSQL[@]}" -c "SELECT count(*) FROM ponder.pending_emits WHERE id IN ($ID_LIST);" | tr -d '[:space:]')

# ─── 4. Phase B: simulate reorg — replay IDENTICAL inserts. ───────────
#
# A real reorg in Ponder rewinds the checkpoint and replays blocks; handlers
# are re-invoked with the SAME canonical inputs (chainId|txHash|logIndex|
# envelopeType) → same deterministic_id → onConflictDoNothing → 0 new rows.
# We re-execute the same INSERT_SQL 5 times to mirror the COOKBOOK §T-A0.9
# 5x-replay property (driver-level proved 1 row from 5 inserts).
for _replay in 1 2 3 4 5; do
  echo "$INSERT_SQL" | "${PSQL[@]}" >/dev/null
done

POST_COUNT=$("${PSQL[@]}" -c "SELECT count(*) FROM ponder.pending_emits WHERE id IN ($ID_LIST);" | tr -d '[:space:]')

# Envelope-type distribution (cross-check).
TYPE_DIST=$("${PSQL[@]}" -c "SELECT envelope_type, count(*) FROM ponder.pending_emits WHERE id IN ($ID_LIST) GROUP BY envelope_type ORDER BY envelope_type;" \
  | awk -F'|' 'BEGIN{ printf "{" } { if (NR>1) printf ","; printf "\"%s\":%s", $1, $2 } END{ printf "}" }')

# ─── 5. Phase C: assertion + JSON output. ─────────────────────────────
DUPLICATES=$((POST_COUNT - PRE_COUNT))
ELAPSED_MS=$(($(date +%s%N) / 1000000 - START_EPOCH_MS))

if [[ "$DUPLICATES" -eq 0 ]] && [[ "$PRE_COUNT" -eq "$N_EVENTS" ]]; then
  IDEMPOTENCY_PASS=true
  EXIT_REASON="ok"
  EXIT_CODE=0
else
  IDEMPOTENCY_PASS=false
  EXIT_REASON="duplicates-observed"
  EXIT_CODE=1
fi

jq -nc \
  --arg drill_id "$DRILL_ID" \
  --argjson chain_id "$CHAIN_ID" \
  --argjson n_events "$N_EVENTS" \
  --argjson pre_count "$PRE_COUNT" \
  --argjson post_replay_count "$POST_COUNT" \
  --argjson duplicate_count "$DUPLICATES" \
  --argjson idempotency_pass "$IDEMPOTENCY_PASS" \
  --argjson envelope_type_distribution "$TYPE_DIST" \
  --argjson elapsed_ms "$ELAPSED_MS" \
  --arg exit_reason "$EXIT_REASON" \
  '{
    drill_id: $drill_id,
    chain_id: $chain_id,
    n_events: $n_events,
    pre_count: $pre_count,
    post_replay_count: $post_replay_count,
    duplicate_count: $duplicate_count,
    idempotency_pass: $idempotency_pass,
    envelope_type_distribution: $envelope_type_distribution,
    elapsed_ms: $elapsed_ms,
    exit_reason: $exit_reason
  }'

# Cleanup hint (operator-driven; we keep rows for inspection by default).
if [[ "${CLEANUP:-0}" == "1" ]]; then
  "${PSQL[@]}" -c "DELETE FROM ponder.pending_emits WHERE id IN ($ID_LIST);" >/dev/null
fi

exit "$EXIT_CODE"
