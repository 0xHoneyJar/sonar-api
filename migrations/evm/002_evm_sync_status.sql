-- 002_evm_sync_status.sql — durable coverage-safe resume cursor for the EVM raw-ingest loader
-- (Track A, SDD §2.4 FR-A2). EVM analog of svm.sync_status (migrations/svm/002+004).
--
-- verify:s3 HIGH: src/evm/sqd-evm-loader.ts persists its COVERAGE-SAFE cursor here (DISS-001 —
-- MAX(block) is NOT a sound resume cursor: a capped run writes chunk-0 rows at high blocks while
-- later chunks never ran, so resuming from MAX permanently skips their range). The loader writes
-- the min-across-yielded-chunks cursor and enforces it (2-attempt strict write, throws on failure),
-- so this table is REQUIRED for the loader to run at all. It was missing from the S3 output; the
-- loader queries evm_sync_status / insert_evm_sync_status_one / constraint evm_sync_status_pkey.
--
-- Hasura: track evm.sync_status so the GraphQL root resolves to `evm_sync_status`
-- (schema-prefixed, like svm.sync_status → svm_sync_status).

CREATE SCHEMA IF NOT EXISTS evm;

CREATE TABLE IF NOT EXISTS evm.sync_status (
  chain_id      text        NOT NULL,
  -- coverage-safe resume cursor: highest block below which EVERY chunk has been scanned
  cursor_block  bigint,
  -- freshness telemetry (block_time of the last decoded/ingested event); nullable until first row
  last_event_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evm_sync_status_pkey PRIMARY KEY (chain_id)
);
