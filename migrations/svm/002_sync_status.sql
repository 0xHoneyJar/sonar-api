-- 002_sync_status.sql — per-collection freshness row (PRD FR-5; the #121 Q4/Q6 consumer-visible
-- SVM freshness signal, and the KF-018 closure: a lane whose failure mode was 9 days of
-- indistinguishable silence now has a queryable "when did each pipe last move" record).
--
-- One row per collection_key. Writers: warehouse loader, webhook (per upsert batch), reconcile
-- cron. `last_event_source` distinguishes which pipe produced the latest data (dune-warehouse |
-- helius-webhook | helius-backfill); `last_reconcile_result` carries the §4.5 gate outcome —
-- including the explicit 'skipped-no-das' degraded state (declared, never silent — PRD NFR-2).
-- Idempotent (re-runnable).
CREATE TABLE IF NOT EXISTS svm.sync_status (
  collection_key        text PRIMARY KEY,
  last_event_at         timestamptz,
  last_event_source     text,
  last_reconcile_at     timestamptz,
  last_reconcile_result text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
