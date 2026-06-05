#!/usr/bin/env bash
# =============================================================================
# invariant-check-1155.sh — CI conservation-invariant gate for ponder.mv_holder_1155
# =============================================================================
#
# Purpose: Verify that ponder.mv_holder_1155 satisfies three conservation invariants:
#   I1  mint − burn = net held supply per (collection, chain, token_id)
#   I2  no negative intermediate balances in the raw ponder.action fold
#   I3  seven anchor spot-checks for puru_apiculture token-4 reference values
#
# Exit codes:
#   0   all invariants pass
#   1   one or more invariants fail (details printed to stdout)
#   2   usage error or missing env var
#
# Required environment:
#   DATABASE_URL   Postgres connection string: postgres://user:pass@host:port/db
#
# Optional environment (overrides hardcoded T1-audit defaults):
#   I3_TOKEN4_TOP_HOLDER_ADDRESS   Override token-4 top holder address
#   I3_ROUTER_ADDRESS              Override router address
#
# Usage:
#   DATABASE_URL=postgres://... ./scripts/invariant-check-1155.sh
#
# CI wiring:
#   See .github/workflows/invariant-check-1155.yml
#
# SDD reference: §3.5 (CI conservation-invariant script)
# Sprint task: T4
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# I3 reference constants — locked from T1 audit (2026-06-04)
# Source: grimoires/loa/a2a/sprint-pertoken-1/pre-deploy-audit.md §6
# Override via env vars for flexibility across deployments.
# ---------------------------------------------------------------------------
# Token-4 top holder (expected balance: 2,575)
TOKEN4_TOP_HOLDER="${I3_TOKEN4_TOP_HOLDER_ADDRESS:-0x099a23f8a85aecb3748571155109494f8afea233}"

# Router address (expected: 0 rows in ponder.mv_holder_1155 for token-4)
ROUTER_ADDRESS="${I3_ROUTER_ADDRESS:-0x777777794a6e310f2a55da6f157b16ed28fa5d91}"

# Fixed apiculture reference values (from PRD §4 + SDD §3.5 + T1 audit)
APICULTURE_COLLECTION="puru_apiculture"
APICULTURE_CHAIN_ID="8453"
TOKEN4_ID="4"
TOKEN4_EXPECTED_MINTED="24969"
TOKEN4_EXPECTED_BURNED="2"
TOKEN4_EXPECTED_NET_HELD="24967"
TOKEN4_TOP_HOLDER_EXPECTED_BALANCE="2575"
EXPECTED_DISTINCT_TOKEN_IDS="6"
MIN_EXPECTED_TOTAL_ROWS="89021"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

FAILURES=0

fail() {
  echo "[FAIL] $*" >&2
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "[PASS] $*"
}

check_db() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "[ERROR] DATABASE_URL is not set." >&2
    echo "  Set DATABASE_URL to a Postgres connection string before running this script." >&2
    exit 2
  fi
}

psql_query() {
  local SQL_TEXT="$1"
  psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align <<< "$SQL_TEXT" 2>&1
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

check_db

echo "=== invariant-check-1155.sh ==="
echo "Database: ${DATABASE_URL%%@*}@..."
echo "Collection: $APICULTURE_COLLECTION  Chain: $APICULTURE_CHAIN_ID"
echo ""

# ---------------------------------------------------------------------------
# I1: mint − burn = net held supply per (collection, chain, token_id)
# Source table: ponder.action (lowercase schema-qualified — F-1 from T1 audit)
# Any returned rows indicate a non-zero conservation delta for some token.
# ---------------------------------------------------------------------------

echo "--- I1: mint-burn supply conservation ---"

I1_SQL="
SELECT
  m.ck              AS collection_key,
  m.chain_id,
  m.token_id,
  m.total           AS minted,
  COALESCE(b.total, 0) AS burned,
  COALESCE(h.total, 0) AS held,
  (m.total - COALESCE(b.total, 0)) - COALESCE(h.total, 0) AS delta
FROM (
  SELECT primary_collection AS ck, chain_id,
         CAST(numeric2 AS NUMERIC) AS token_id,
         SUM(CAST(numeric1 AS NUMERIC)) AS total
  FROM ponder.action WHERE action_type = 'mint1155'
  GROUP BY 1, 2, 3
) m
LEFT JOIN (
  SELECT primary_collection AS ck, chain_id,
         CAST(numeric2 AS NUMERIC) AS token_id,
         SUM(CAST(numeric1 AS NUMERIC)) AS total
  FROM ponder.action WHERE action_type = 'burn1155'
  GROUP BY 1, 2, 3
) b USING (ck, chain_id, token_id)
LEFT JOIN (
  SELECT collection_key AS ck, chain_id, token_id,
         SUM(balance) AS total
  FROM ponder.mv_holder_1155
  GROUP BY 1, 2, 3
) h ON h.ck = m.ck AND h.chain_id = m.chain_id AND h.token_id = m.token_id
WHERE ABS((m.total - COALESCE(b.total, 0)) - COALESCE(h.total, 0)) > 0;"

I1_RESULT="$(psql_query "$I1_SQL")"

if [[ -z "$I1_RESULT" || "$I1_RESULT" == "" ]]; then
  pass "I1 — conservation delta = 0 for all (collection, chain, token) tuples"
else
  fail "I1 — non-zero conservation delta detected:"
  echo "$I1_RESULT"
fi

echo ""

# ---------------------------------------------------------------------------
# I2: no negative intermediate balances
# Source table: ponder.action (F-1). context is TEXT — cast to jsonb for JSON access.
# Any returned rows indicate a data-ordering bug in the action ledger.
# ---------------------------------------------------------------------------

echo "--- I2: no negative intermediate balances ---"

I2_SQL="
SELECT
  primary_collection AS collection_key,
  chain_id,
  CAST(numeric2 AS NUMERIC) AS token_id,
  addr.address,
  SUM(CASE
    WHEN action_type = 'mint1155'    THEN CAST(numeric1 AS NUMERIC)
    WHEN action_type = 'transfer1155' AND actor = addr.address
      THEN  CAST(numeric1 AS NUMERIC)
    WHEN action_type = 'transfer1155' AND context::jsonb->>'from' = addr.address
      THEN -CAST(numeric1 AS NUMERIC)
    WHEN action_type = 'burn1155'    THEN -CAST(numeric1 AS NUMERIC)
    ELSE 0
  END) AS balance
FROM ponder.action
CROSS JOIN LATERAL (VALUES
  (CASE action_type
    WHEN 'mint1155'     THEN actor
    WHEN 'burn1155'     THEN actor
    WHEN 'transfer1155' THEN actor
  END),
  (CASE action_type
    WHEN 'transfer1155' THEN context::jsonb->>'from'
    ELSE NULL
  END)
) AS addr(address)
WHERE action_type IN ('mint1155', 'burn1155', 'transfer1155')
  AND addr.address IS NOT NULL
  AND addr.address != '0x0000000000000000000000000000000000000000'
GROUP BY 1, 2, 3, 4
HAVING SUM(CASE
  WHEN action_type = 'mint1155'    THEN CAST(numeric1 AS NUMERIC)
  WHEN action_type = 'transfer1155' AND actor = addr.address
    THEN  CAST(numeric1 AS NUMERIC)
  WHEN action_type = 'transfer1155' AND context::jsonb->>'from' = addr.address
    THEN -CAST(numeric1 AS NUMERIC)
  WHEN action_type = 'burn1155'    THEN -CAST(numeric1 AS NUMERIC)
  ELSE 0
END) < 0;"

I2_RESULT="$(psql_query "$I2_SQL")"

if [[ -z "$I2_RESULT" || "$I2_RESULT" == "" ]]; then
  pass "I2 — no negative intermediate balances detected"
else
  fail "I2 — negative intermediate balances found (data-ordering issue in ponder.action):"
  echo "$I2_RESULT"
fi

echo ""

# ---------------------------------------------------------------------------
# I3: apiculture token-4 anchor spot-checks
# Seven fixed-value assertions against the live MV.
# Addresses locked from T1 audit (grimoires/loa/a2a/sprint-pertoken-1/pre-deploy-audit.md §6).
# ---------------------------------------------------------------------------

echo "--- I3: apiculture token-4 anchor spot-checks ---"

# I3.1 — Token-4 top holder balance
I3_1_SQL="SELECT balance FROM ponder.mv_holder_1155
  WHERE collection_key = '$APICULTURE_COLLECTION'
    AND chain_id = $APICULTURE_CHAIN_ID
    AND token_id = $TOKEN4_ID
    AND LOWER(address) = LOWER('$TOKEN4_TOP_HOLDER');"
I3_1_RESULT="$(psql_query "$I3_1_SQL" | tr -d ' ')"
if [[ "$I3_1_RESULT" == "$TOKEN4_TOP_HOLDER_EXPECTED_BALANCE" ]]; then
  pass "I3.1 — token-4 top holder balance = $TOKEN4_TOP_HOLDER_EXPECTED_BALANCE"
else
  fail "I3.1 — token-4 top holder balance: expected=$TOKEN4_TOP_HOLDER_EXPECTED_BALANCE actual=${I3_1_RESULT:-no row}"
fi

# I3.2 — Router address absent from token-4 holder set
I3_2_SQL="SELECT COUNT(*) FROM ponder.mv_holder_1155
  WHERE collection_key = '$APICULTURE_COLLECTION'
    AND chain_id = $APICULTURE_CHAIN_ID
    AND token_id = $TOKEN4_ID
    AND LOWER(address) = LOWER('$ROUTER_ADDRESS');"
I3_2_RESULT="$(psql_query "$I3_2_SQL" | tr -d ' ')"
if [[ "$I3_2_RESULT" == "0" ]]; then
  pass "I3.2 — router address is absent from token-4 holder set (0 rows)"
else
  fail "I3.2 — router address present in token-4 holder set: found $I3_2_RESULT row(s) (expected 0)"
fi

# I3.3 — Token-4 total minted
I3_3_SQL="SELECT SUM(CAST(numeric1 AS NUMERIC))
  FROM ponder.action
  WHERE action_type = 'mint1155'
    AND primary_collection = '$APICULTURE_COLLECTION'
    AND chain_id = $APICULTURE_CHAIN_ID
    AND CAST(numeric2 AS NUMERIC) = $TOKEN4_ID;"
I3_3_RESULT="$(psql_query "$I3_3_SQL" | tr -d ' ')"
if [[ "$I3_3_RESULT" == "$TOKEN4_EXPECTED_MINTED" ]]; then
  pass "I3.3 — token-4 total minted = $TOKEN4_EXPECTED_MINTED"
else
  fail "I3.3 — token-4 total minted: expected=$TOKEN4_EXPECTED_MINTED actual=${I3_3_RESULT:-no row}"
fi

# I3.4 — Token-4 total burned
I3_4_SQL="SELECT COALESCE(SUM(CAST(numeric1 AS NUMERIC)), 0)
  FROM ponder.action
  WHERE action_type = 'burn1155'
    AND primary_collection = '$APICULTURE_COLLECTION'
    AND chain_id = $APICULTURE_CHAIN_ID
    AND CAST(numeric2 AS NUMERIC) = $TOKEN4_ID;"
I3_4_RESULT="$(psql_query "$I3_4_SQL" | tr -d ' ')"
I3_4_RESULT="${I3_4_RESULT:-0}"
if [[ "$I3_4_RESULT" == "$TOKEN4_EXPECTED_BURNED" ]]; then
  pass "I3.4 — token-4 total burned = $TOKEN4_EXPECTED_BURNED"
else
  fail "I3.4 — token-4 total burned: expected=$TOKEN4_EXPECTED_BURNED actual=${I3_4_RESULT:-0}"
fi

# I3.5 — Token-4 net held (SUM of all holder balances in MV)
I3_5_SQL="SELECT SUM(balance)
  FROM ponder.mv_holder_1155
  WHERE collection_key = '$APICULTURE_COLLECTION'
    AND chain_id = $APICULTURE_CHAIN_ID
    AND token_id = $TOKEN4_ID;"
I3_5_RESULT="$(psql_query "$I3_5_SQL" | tr -d ' ')"
if [[ "$I3_5_RESULT" == "$TOKEN4_EXPECTED_NET_HELD" ]]; then
  pass "I3.5 — token-4 net held = $TOKEN4_EXPECTED_NET_HELD"
else
  fail "I3.5 — token-4 net held: expected=$TOKEN4_EXPECTED_NET_HELD actual=${I3_5_RESULT:-no row}"
fi

# I3.6 — Distinct token IDs for puru_apiculture
I3_6_SQL="SELECT COUNT(DISTINCT token_id)
  FROM ponder.mv_holder_1155
  WHERE collection_key = '$APICULTURE_COLLECTION'
    AND chain_id = $APICULTURE_CHAIN_ID;"
I3_6_RESULT="$(psql_query "$I3_6_SQL" | tr -d ' ')"
if [[ "$I3_6_RESULT" == "$EXPECTED_DISTINCT_TOKEN_IDS" ]]; then
  pass "I3.6 — distinct token IDs for $APICULTURE_COLLECTION = $EXPECTED_DISTINCT_TOKEN_IDS"
else
  fail "I3.6 — distinct token IDs: expected=$EXPECTED_DISTINCT_TOKEN_IDS actual=${I3_6_RESULT:-no row}"
fi

# I3.7 — Total holder rows for puru_apiculture (≥ 89,021)
I3_7_SQL="SELECT COUNT(*)
  FROM ponder.mv_holder_1155
  WHERE collection_key = '$APICULTURE_COLLECTION'
    AND chain_id = $APICULTURE_CHAIN_ID;"
I3_7_RESULT="$(psql_query "$I3_7_SQL" | tr -d ' ')"
if [[ -n "$I3_7_RESULT" ]] && [[ "$I3_7_RESULT" -ge "$MIN_EXPECTED_TOTAL_ROWS" ]]; then
  pass "I3.7 — total holder rows for $APICULTURE_COLLECTION = $I3_7_RESULT (>= $MIN_EXPECTED_TOTAL_ROWS)"
else
  fail "I3.7 — total holder rows: expected>=$MIN_EXPECTED_TOTAL_ROWS actual=${I3_7_RESULT:-no row}"
fi

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo "=== Summary ==="
if [[ "$FAILURES" -eq 0 ]]; then
  echo "[PASS] All invariants passed."
  exit 0
else
  echo "[FAIL] $FAILURES invariant(s) failed. See output above for details."
  exit 1
fi
