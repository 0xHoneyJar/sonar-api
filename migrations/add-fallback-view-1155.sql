-- =============================================================================
-- Migration: Fallback view v_holder_1155 (R-01 fallback)
-- File:      migrations/add-fallback-view-1155.sql
-- Cycle:     spiral-pertoken-projection-1
-- SDD:       grimoires/loa/sdd.md r1 §3.7 (Hasura Tracking Plan, R-01)
-- =============================================================================
--
-- Use this migration ONLY if Hasura cannot track mv_holder_1155 directly.
-- Some Hasura versions require a primary key or explicit primary key hint on
-- materialized views. This regular view wraps the MV and is trackable without
-- that restriction.
--
-- After running this migration:
--   1. Edit scripts/hasura-track-mv-1155.sh to use 'v_holder_1155' in both
--      pg_track_table and pg_create_select_permission calls.
--   2. Run the edited script to track v_holder_1155.
--
-- Conservation invariants (I1, I2, I3) are unaffected — the view wraps the MV
-- and reflects the same data. fn_1155_invariant_check() still operates on
-- mv_holder_1155 directly.
--
-- EXECUTION: operator-led per ADR-010. The agent does not execute this script.
-- =============================================================================

CREATE OR REPLACE VIEW ponder.v_holder_1155 AS
SELECT
  collection_key,
  chain_id,
  token_id,
  address,
  balance
FROM ponder.mv_holder_1155;

COMMENT ON VIEW ponder.v_holder_1155 IS
  'Fallback wrapper view for ponder.mv_holder_1155. '
  'Use when Hasura cannot track the MV directly (R-01). '
  'Tracks the same data as ponder.mv_holder_1155; refreshes automatically '
  'when ponder.mv_holder_1155 is refreshed via REFRESH MATERIALIZED VIEW.';
