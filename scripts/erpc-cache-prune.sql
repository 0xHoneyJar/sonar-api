-- eRPC cache maintenance — decommissioned-chain prune only (#73).
-- Run against the eRPC cache Postgres (ERPC_DATABASE_URL / Postgres service).
-- NEVER delete active-chain finalized rows — ttl:0 is intentional for re-sync speedup.

-- 1) Inspect volume pressure
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;
SELECT COUNT(*) AS row_count FROM erpc_json_rpc_cache;

-- 2) Example: prune rows for a retired chain (adjust network key to match eRPC cache schema)
-- DELETE FROM erpc_json_rpc_cache
-- WHERE network = 'DEcommissionedChainId'
--   AND finality = 'finalized';

-- 3) Reclaim disk after bulk delete
-- VACUUM (VERBOSE, ANALYZE) erpc_json_rpc_cache;

-- Operator alarm: configure Railway disk alert at ~75% on the Postgres (cache) service volume.
