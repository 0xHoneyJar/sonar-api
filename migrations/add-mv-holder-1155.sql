-- =============================================================================
-- Migration: Per-Token ERC-1155 Holder Materialized View
-- File:      migrations/add-mv-holder-1155.sql
-- Cycle:     spiral-pertoken-projection-1
-- PRD:       grimoires/loa/prd.md r1
-- SDD:       grimoires/loa/sdd.md r1 §3.1–§3.3, §3.6
-- =============================================================================
--
-- T1 AUDIT CORRECTIONS (2026-06-04):
--   F-1: The real table is ponder.action (lowercase, schema ponder).
--        "Action" (quoted PascalCase) fails with relation-not-found.
--        Every reference below uses ponder.action (unquoted, lowercase).
--   context type: context column is TEXT (JSON-as-text).
--        All JSON access requires context::jsonb->>'key' cast.
--   numeric1/numeric2: already NUMERIC — CASTs are no-ops but kept for
--        explicitness and forward compatibility.
--
-- OPERATOR PRE-CHECKS (run before executing this migration):
--
--   1. Verify column types for numeric1 and numeric2:
--      SELECT column_name, data_type
--      FROM information_schema.columns
--      WHERE table_schema = 'ponder'
--        AND table_name = 'action'
--        AND column_name IN ('numeric1', 'numeric2');
--      Expected: numeric (confirmed by T1 audit 2026-06-04).
--
--   2. Verify apiculture transfer1155 null-rate (must be zero or documented):
--      SELECT COUNT(*) FROM ponder.action
--      WHERE action_type = 'transfer1155'
--        AND primary_collection = 'puru_apiculture'
--        AND context::jsonb->>'from' IS NULL;
--      Expected: 0 (confirmed zero substrate-wide by T1 audit 2026-06-04).
--
-- ESTIMATED WALL TIME: < 5 minutes on the serving DB.
--   - idx_action_type_collection_numeric2 creation: ~seconds for 2M+ rows
--   - MV creation (WITH DATA): bounded by the index above
--
-- REFRESH NOTE: After this migration, use:
--   REFRESH MATERIALIZED VIEW CONCURRENTLY ponder.mv_holder_1155
-- for non-blocking refreshes (uidx_mv_holder_1155_pk is created here).
-- Never use non-concurrent refresh in production — it acquires ACCESS EXCLUSIVE
-- and blocks all reads.
--
-- EXECUTION: operator-led per ADR-010. The agent does not execute this script.
--
-- REAPPLY NOTE: CREATE MATERIALIZED VIEW IF NOT EXISTS silently retains a stale
--   definition on re-run. To reapply after a definition change, run:
--     DROP MATERIALIZED VIEW IF EXISTS ponder.mv_holder_1155 CASCADE;
--   then re-execute this script from the beginning.
-- =============================================================================

BEGIN;

-- =============================================================================
-- STEP 1: Supporting index on ponder.action
-- Enables efficient MV compute and refresh. Without this, MV creation
-- requires a sequential scan of the full ponder.action table (2M+ rows).
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_action_type_collection_numeric2
  ON ponder.action (action_type, primary_collection, numeric2);

-- =============================================================================
-- STEP 2: Materialized view ponder.mv_holder_1155
-- Folds the ponder.action event-ledger into correct per-token, per-address
-- ERC-1155 holder balances.
--
-- Source field mapping (SDD §3.2.1):
--   mint1155:     actor = recipient (+numeric1 tokens for numeric2 tokenId)
--   burn1155:     actor = burner    (-numeric1 tokens for numeric2 tokenId)
--   transfer1155: actor = recipient (+numeric1)
--                 context::jsonb->>'from' = sender (-numeric1)
--
-- context column is TEXT — all JSON access uses context::jsonb->>'key'.
-- Burn addresses excluded via LOWER(address) NOT IN (...) matching isBurnAddress()
-- at src/lib/mint-detection.ts:38 exactly:
--   0x0000000000000000000000000000000000000000  (zero address)
--   0x000000000000000000000000000000000000dead  (dead address)
-- =============================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS ponder.mv_holder_1155 AS
WITH balance_deltas AS (
  -- Mints: actor (recipient) gains tokens
  -- LOWER(actor): ponder.action stores addresses lowercase, but LOWER() is
  -- defensive normalization so mixed-case overrides never split a wallet's balance.
  SELECT
    primary_collection           AS collection_key,
    chain_id,
    CAST(numeric2 AS NUMERIC)    AS token_id,
    LOWER(actor)                 AS address,
    CAST(numeric1 AS NUMERIC)    AS delta
  FROM ponder.action
  WHERE action_type = 'mint1155'
    AND actor IS NOT NULL

  UNION ALL

  -- Burns: actor (burner) loses tokens
  SELECT
    primary_collection           AS collection_key,
    chain_id,
    CAST(numeric2 AS NUMERIC)    AS token_id,
    LOWER(actor)                 AS address,
    -CAST(numeric1 AS NUMERIC)   AS delta
  FROM ponder.action
  WHERE action_type = 'burn1155'
    AND actor IS NOT NULL

  UNION ALL

  -- Transfer in: actor (recipient) gains tokens
  SELECT
    primary_collection           AS collection_key,
    chain_id,
    CAST(numeric2 AS NUMERIC)    AS token_id,
    LOWER(actor)                 AS address,
    CAST(numeric1 AS NUMERIC)    AS delta
  FROM ponder.action
  WHERE action_type = 'transfer1155'
    AND actor IS NOT NULL

  UNION ALL

  -- Transfer out: context::jsonb->>'from' (sender) loses tokens
  -- context is TEXT column — must cast to jsonb before ->> access
  SELECT
    primary_collection           AS collection_key,
    chain_id,
    CAST(numeric2 AS NUMERIC)    AS token_id,
    LOWER(context::jsonb->>'from') AS address,
    -CAST(numeric1 AS NUMERIC)   AS delta
  FROM ponder.action
  WHERE action_type = 'transfer1155'
    AND context::jsonb->>'from' IS NOT NULL
),
aggregated AS (
  SELECT
    collection_key,
    chain_id,
    token_id,
    address,
    SUM(delta) AS balance
  FROM balance_deltas
  WHERE address IS NOT NULL
    AND LOWER(address) NOT IN (
      '0x0000000000000000000000000000000000000000',
      '0x000000000000000000000000000000000000dead'
    )
  GROUP BY collection_key, chain_id, token_id, address
)
SELECT
  collection_key,
  chain_id,
  token_id,
  address,
  balance
FROM aggregated
WHERE balance > 0
WITH DATA;

-- =============================================================================
-- STEP 3: Unique index on ponder.mv_holder_1155
-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY (FR-06, A-05).
-- Also the primary consumer query path for per-token leaderboards.
-- =============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uidx_mv_holder_1155_pk
  ON ponder.mv_holder_1155 (collection_key, chain_id, token_id, address);

-- =============================================================================
-- STEP 4: Secondary index for collection + chain aggregate queries
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_mv_holder_1155_collection_chain
  ON ponder.mv_holder_1155 (collection_key, chain_id);

-- =============================================================================
-- STEP 5: Runtime health-check SQL function (SDD §3.6)
-- Checks I1 (mint-burn = supply) and I2 (no negative intermediate balances).
-- Called on demand by operators; equivalent to invariant-check-1155.sh for CI.
--
-- Usage:
--   SELECT * FROM ponder.fn_1155_invariant_check();
--   SELECT * FROM ponder.fn_1155_invariant_check('puru_apiculture', 8453);
-- =============================================================================
CREATE OR REPLACE FUNCTION ponder.fn_1155_invariant_check(
  p_collection_key TEXT DEFAULT NULL,
  p_chain_id       INT  DEFAULT NULL
)
RETURNS TABLE (
  check_name         TEXT,
  status             TEXT,
  failing_count      BIGINT,
  worst_delta        NUMERIC,
  detail             TEXT
)
LANGUAGE sql STABLE AS $$
  -- I1: mint − burn = net held supply per (collection, chain, token)
  WITH i1 AS (
    SELECT
      'I1_mint_burn_supply'        AS check_name,
      CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status,
      COUNT(*)                     AS failing_count,
      MAX(ABS(
        (m.total - COALESCE(b.total, 0)) - COALESCE(h.total, 0)
      ))                           AS worst_delta,
      CASE WHEN COUNT(*) = 0
        THEN 'All (collection, chain, token) tuples balance'
        ELSE COUNT(*) || ' tuples with non-zero conservation delta'
      END                          AS detail
    FROM (
      SELECT primary_collection AS ck, chain_id,
             CAST(numeric2 AS NUMERIC) AS token_id,
             SUM(CAST(numeric1 AS NUMERIC)) AS total
      FROM ponder.action WHERE action_type = 'mint1155'
        AND (p_collection_key IS NULL OR primary_collection = p_collection_key)
        AND (p_chain_id IS NULL OR chain_id = p_chain_id)
      GROUP BY 1, 2, 3
    ) m
    LEFT JOIN (
      SELECT primary_collection AS ck, chain_id,
             CAST(numeric2 AS NUMERIC) AS token_id,
             SUM(CAST(numeric1 AS NUMERIC)) AS total
      FROM ponder.action WHERE action_type = 'burn1155'
        AND (p_collection_key IS NULL OR primary_collection = p_collection_key)
        AND (p_chain_id IS NULL OR chain_id = p_chain_id)
      GROUP BY 1, 2, 3
    ) b USING (ck, chain_id, token_id)
    LEFT JOIN (
      SELECT collection_key AS ck, chain_id, token_id,
             SUM(balance) AS total
      FROM ponder.mv_holder_1155
        WHERE (p_collection_key IS NULL OR collection_key = p_collection_key)
          AND (p_chain_id IS NULL OR chain_id = p_chain_id)
      GROUP BY 1, 2, 3
    ) h ON h.ck = m.ck AND h.chain_id = m.chain_id AND h.token_id = m.token_id
    WHERE ABS((m.total - COALESCE(b.total, 0)) - COALESCE(h.total, 0)) > 0
  ),
  -- I2: no negative intermediate balances in the raw action-ledger fold
  -- context is TEXT — all JSON access uses context::jsonb->>'key'
  i2_raw AS (
    SELECT
      primary_collection          AS collection_key,
      chain_id,
      CAST(numeric2 AS NUMERIC)   AS token_id,
      addr.address,
      SUM(CASE
        WHEN action_type = 'mint1155' THEN CAST(numeric1 AS NUMERIC)
        WHEN action_type = 'transfer1155' AND actor = addr.address
          THEN CAST(numeric1 AS NUMERIC)
        WHEN action_type = 'transfer1155' AND context::jsonb->>'from' = addr.address
          THEN -CAST(numeric1 AS NUMERIC)
        WHEN action_type = 'burn1155' THEN -CAST(numeric1 AS NUMERIC)
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
      AND (p_collection_key IS NULL OR primary_collection = p_collection_key)
      AND (p_chain_id IS NULL OR chain_id = p_chain_id)
    GROUP BY 1, 2, 3, 4
  ),
  i2 AS (
    SELECT
      'I2_no_negative_balances'    AS check_name,
      CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status,
      COUNT(*)                     AS failing_count,
      MIN(balance)                 AS worst_delta,
      CASE WHEN COUNT(*) = 0
        THEN 'No negative intermediate balances detected'
        ELSE COUNT(*) || ' addresses with negative intermediate balance'
      END                          AS detail
    FROM i2_raw WHERE balance < 0
  )
  SELECT * FROM i1
  UNION ALL
  SELECT * FROM i2;
$$;

COMMENT ON FUNCTION ponder.fn_1155_invariant_check(TEXT, INT) IS
  'Runtime health check for ponder.mv_holder_1155 conservation invariants. '
  'I1: mint-burn = net held supply per token. '
  'I2: no negative intermediate balances in the raw ponder.action fold. '
  'Returns PASS/FAIL rows with failing_count and worst_delta. '
  'Equivalent to scripts/invariant-check-1155.sh but callable on demand.';

COMMIT;

-- =============================================================================
-- POST-MIGRATION VERIFICATION (operator runs after COMMIT):
--
--   -- AC-01: Confirm MV schema
--   \d ponder.mv_holder_1155
--   -- Expected: collection_key TEXT, chain_id INT4, token_id NUMERIC, address TEXT, balance NUMERIC
--
--   -- AC-02: Confirm unique index
--   \di uidx_mv_holder_1155_pk
--
--   -- AC-03: Confirm action-table index
--   \di idx_action_type_collection_numeric2
--
--   -- AC-11: Run health check (should return PASS for both rows on valid data)
--   SELECT * FROM ponder.fn_1155_invariant_check('puru_apiculture', 8453);
--
--   -- Quick population checks
--   SELECT COUNT(*) FROM ponder.mv_holder_1155;
--   -- Expected: >= 89,021 rows for puru_apiculture alone
--
--   SELECT COUNT(DISTINCT token_id) FROM ponder.mv_holder_1155 WHERE collection_key = 'puru_apiculture';
--   -- Expected: 6 distinct token IDs
--
--   -- AC-05: token-4 top holder
--   SELECT balance FROM ponder.mv_holder_1155
--   WHERE collection_key = 'puru_apiculture' AND chain_id = 8453 AND token_id = 4
--     AND address = '0x099a23f8a85aecb3748571155109494f8afea233';
--   -- Expected: 2575
--
--   -- AC-06: router absent
--   SELECT COUNT(*) FROM ponder.mv_holder_1155
--   WHERE collection_key = 'puru_apiculture' AND chain_id = 8453 AND token_id = 4
--     AND address = '0x777777794a6e310f2a55da6f157b16ed28fa5d91';
--   -- Expected: 0
-- =============================================================================
