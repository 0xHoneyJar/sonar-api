-- 001_raw_evm_log.sql — append-only raw EVM log store: one row per on-chain log emission,
-- written by the SQD EVM ingest lane before any decode step. The raw store is write-once
-- (the loader uses ifAbsentOnly semantics); decode workers read it and write classified rows
-- to domain tables without mutating this source. Idempotent (re-runnable). (PRD FR-A1; SDD §2.4).
--
-- Column shape note: SDD §4 specifies topics[] (array). This migration commits to four discrete
-- columns (topic0..topic3) instead, matching the row shape that T2 (sqd-evm-loader) writes and
-- that the decode step reads by column name. Discrete columns avoid array-element index gymnastics
-- in SQL and are trivially queryable for the most common filter (topic0 = event signature hash).
--
-- Primary key: (chain_id, block_number, log_index) per SDD §4. A log is uniquely identified by
-- its chain, the block it appeared in, and its position within that block's log sequence.
-- tx_hash is included for join convenience but is not part of the PK: two logs in the same block
-- at the same log_index (impossible on-chain) would violate the PK regardless of tx_hash.

CREATE SCHEMA IF NOT EXISTS raw;

CREATE TABLE IF NOT EXISTS raw.evm_log (
  chain_id      text        NOT NULL,
  block_number  bigint      NOT NULL,
  block_time    timestamptz NOT NULL,
  tx_hash       text        NOT NULL,
  log_index     int         NOT NULL,
  address       text        NOT NULL,
  topic0        text,
  topic1        text,
  topic2        text,
  topic3        text,
  data          text        NOT NULL,
  PRIMARY KEY (chain_id, block_number, log_index)
);

-- Per-chain range re-decode: covers the primary read pattern for the decode worker —
-- SELECT … WHERE chain_id = $1 AND block_number BETWEEN $2 AND $3 — AND chain_id-only
-- lookups ("how far have we ingested for chain N?") since chain_id is its left prefix.
-- (verify:s3 LOW: dropped the standalone idx_evm_log_chain (chain_id) — redundant with this
--  composite's left prefix; it only added write amplification.)
CREATE INDEX IF NOT EXISTS idx_evm_log_chain_block
  ON raw.evm_log (chain_id, block_number);
