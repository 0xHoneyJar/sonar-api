// ponder-runtime/src/lib/checkpoint-block.ts
//
// bd-3nh (S2) — the executable contract for `scripts/chain-metadata-view.sql`.
//
// The freshness view extracts `latest_processed_block` from Ponder's internal
// `_ponder_checkpoint.latest_checkpoint` column with a fixed substring offset.
// That offset is a load-bearing magic number coupled to Ponder's checkpoint
// ENCODING (ponder/dist/esm/utils/checkpoint.js, Ponder 0.16.6). This module
// pins the layout + offset so the colocated test fails the moment the encoding
// drifts — BEFORE the SQL view silently slices the wrong digits.
//
// There is intentionally NO runtime importer: SQL cannot import TS. This module
// IS the spec, and checkpoint-block.test.ts is its proof. Keep the two offset
// constants below byte-identical to the `substring(... FROM 27 FOR 16)` in
// scripts/chain-metadata-view.sql.

// Ponder checkpoint field widths (decimal digits, zero-padded). Mirror of the
// `*_DIGITS` constants in ponder/dist/esm/utils/checkpoint.js. A checkpoint is
// the concatenation, in this order, of:
export const BLOCK_TIMESTAMP_DIGITS = 10;
export const CHAIN_ID_DIGITS = 16;
export const BLOCK_NUMBER_DIGITS = 16;
export const TRANSACTION_INDEX_DIGITS = 16;
export const EVENT_TYPE_DIGITS = 1;
export const EVENT_INDEX_DIGITS = 16;

/** Total fixed width of an encoded checkpoint string (Ponder: 75). */
export const CHECKPOINT_LENGTH =
  BLOCK_TIMESTAMP_DIGITS +
  CHAIN_ID_DIGITS +
  BLOCK_NUMBER_DIGITS +
  TRANSACTION_INDEX_DIGITS +
  EVENT_TYPE_DIGITS +
  EVENT_INDEX_DIGITS;

// SQL `substring(s FROM <FROM> FOR <FOR>)` is 1-indexed. The block number starts
// immediately after blockTimestamp + chainId.
//   FROM = 10 + 16 + 1 = 27 ; FOR = 16
export const BLOCK_NUMBER_SQL_FROM = BLOCK_TIMESTAMP_DIGITS + CHAIN_ID_DIGITS + 1;
export const BLOCK_NUMBER_SQL_FOR = BLOCK_NUMBER_DIGITS;

/**
 * Extract the block number from an encoded Ponder checkpoint string, mirroring
 * the SQL view's `substring(latest_checkpoint FROM 27 FOR 16)::bigint`.
 *
 * Pure + total: throws only on a malformed (wrong-length) checkpoint, which is
 * itself a useful contract assertion. Returns the block number as a JS number
 * (safe: real block numbers are << Number.MAX_SAFE_INTEGER).
 */
export function extractLatestProcessedBlock(checkpoint: string): number {
  if (checkpoint.length !== CHECKPOINT_LENGTH) {
    throw new Error(
      `malformed checkpoint: expected ${CHECKPOINT_LENGTH} chars, got ${checkpoint.length}`,
    );
  }
  // SQL substring is 1-indexed; JS slice is 0-indexed → start = FROM - 1.
  const start = BLOCK_NUMBER_SQL_FROM - 1;
  const slice = checkpoint.slice(start, start + BLOCK_NUMBER_SQL_FOR);
  return Number(slice);
}
