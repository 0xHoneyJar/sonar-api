-- 003_sync_status_sqd_source.sql — widen source CHECKs for the SQD block-stream lane
-- (cycle svm-sqd-substrate). Idempotent: drop-if-exists + re-add.
ALTER TABLE svm.sync_status DROP CONSTRAINT IF EXISTS sync_status_source_check;
ALTER TABLE svm.sync_status ADD CONSTRAINT sync_status_source_check
  CHECK (last_event_source IN ('dune-warehouse','helius-webhook','helius-backfill','sqd-stream'));
