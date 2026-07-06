-- 004_sync_status_sqd_cursor.sql — durable SQD resume cursor (sprint-bug-173, dissent DISS-001).
-- MAX(slot) of ingested rows is NOT a sound resume cursor: a capped run upserts chunk-0
-- events at high slots while later chunks never ran, so resuming from MAX permanently
-- skips their range. The loader now persists its coverage-safe cursor here; MAX(slot)
-- remains only as a legacy fallback for rows written before this column existed.
ALTER TABLE svm.sync_status ADD COLUMN IF NOT EXISTS sqd_cursor_slot BIGINT;
