// ponder-runtime/src/handlers/mibera-liquid-backing/shared.ts
//
// Shared constants + singleton-row helpers for the 9 MiberaLiquidBacking
// handlers (split across loans.ts, treasury.ts, rfv.ts in this directory).
//
// Verbatim port of envio src/handlers/mibera-liquid-backing.ts lines 12-67:
//   - constants (BERACHAIN_ID, LIQUID_BACKING_ADDRESS, SECONDS_PER_DAY)
//   - getOrCreateStats() / getOrCreateLoanStats() singletons
//   - getDayFromTimestamp()
//
// envio used context.<Singleton>.get() returning the entity or undefined.
// Ponder uses context.db.find(table, {id}) returning the row or null —
// shape-compatible swap.
//
// envio's tokenIds field was bigint[] in the entity (auto-mapped from
// uint256[]). Ponder schema stores it as JSON-encoded TEXT (see
// ponder.schema.ts:191) to preserve uint256 fidelity. The helpers below
// handle the encode/decode boundary.

import { treasuryStats, miberaLoanStats } from "../../../ponder.schema";

export const BERACHAIN_ID = 80094;
export const LIQUID_BACKING_ADDRESS = "0xaa04f13994a7fcd86f3bbbf4054d239b88f2744d";
export const SECONDS_PER_DAY = 86400;

/** Singleton id used for TreasuryStats + MiberaLoanStats. */
export const STATS_ID = `${BERACHAIN_ID}_global`;

export interface TreasuryStatsRow {
  id: string;
  totalItemsOwned: number;
  totalItemsEverOwned: number;
  totalItemsSold: number;
  realFloorValue: bigint;
  lastRfvUpdate: bigint | null;
  lastActivityAt: bigint;
  chainId: number;
}

export interface MiberaLoanStatsRow {
  id: string;
  totalActiveLoans: number;
  totalLoansCreated: number;
  totalLoansRepaid: number;
  totalLoansDefaulted: number;
  totalAmountLoaned: bigint;
  totalNftsWithLoans: number;
  chainId: number;
}

/**
 * Get the TreasuryStats singleton, creating an in-memory default if absent.
 * Caller is responsible for persisting (via context.db.insert(...) onConflictDoUpdate).
 */
export async function getOrCreateStats(context: any): Promise<TreasuryStatsRow> {
  const existing = await context.db.find(treasuryStats, { id: STATS_ID });
  if (existing) return existing as TreasuryStatsRow;
  return {
    id: STATS_ID,
    totalItemsOwned: 0,
    totalItemsEverOwned: 0,
    totalItemsSold: 0,
    realFloorValue: 0n,
    lastRfvUpdate: null,
    lastActivityAt: 0n,
    chainId: BERACHAIN_ID,
  };
}

/**
 * Get the MiberaLoanStats singleton, creating an in-memory default if absent.
 */
export async function getOrCreateLoanStats(context: any): Promise<MiberaLoanStatsRow> {
  const existing = await context.db.find(miberaLoanStats, { id: STATS_ID });
  if (existing) return existing as MiberaLoanStatsRow;
  return {
    id: STATS_ID,
    totalActiveLoans: 0,
    totalLoansCreated: 0,
    totalLoansRepaid: 0,
    totalLoansDefaulted: 0,
    totalAmountLoaned: 0n,
    totalNftsWithLoans: 0,
    chainId: BERACHAIN_ID,
  };
}

/**
 * Upsert TreasuryStats — writes a row, replacing fields if it exists.
 * envio's behavior is "last writer wins" via context.TreasuryStats.set().
 */
export async function setStats(
  context: any,
  row: TreasuryStatsRow
): Promise<void> {
  await context.db
    .insert(treasuryStats)
    .values(row)
    .onConflictDoUpdate(() => ({
      totalItemsOwned: row.totalItemsOwned,
      totalItemsEverOwned: row.totalItemsEverOwned,
      totalItemsSold: row.totalItemsSold,
      realFloorValue: row.realFloorValue,
      lastRfvUpdate: row.lastRfvUpdate,
      lastActivityAt: row.lastActivityAt,
    }));
}

/**
 * Upsert MiberaLoanStats — same semantic as setStats above.
 */
export async function setLoanStats(
  context: any,
  row: MiberaLoanStatsRow
): Promise<void> {
  await context.db
    .insert(miberaLoanStats)
    .values(row)
    .onConflictDoUpdate(() => ({
      totalActiveLoans: row.totalActiveLoans,
      totalLoansCreated: row.totalLoansCreated,
      totalLoansRepaid: row.totalLoansRepaid,
      totalLoansDefaulted: row.totalLoansDefaulted,
      totalAmountLoaned: row.totalAmountLoaned,
      totalNftsWithLoans: row.totalNftsWithLoans,
    }));
}

/** Day number since epoch (UTC), used for DailyRfvSnapshot id. */
export function getDayFromTimestamp(timestamp: bigint): number {
  return Math.floor(Number(timestamp) / SECONDS_PER_DAY);
}

/**
 * JSON-encode a bigint[] for the miberaLoan.tokenIds column.
 * Inverse: JSON.parse(value).map(BigInt).
 */
export function encodeTokenIds(ids: readonly bigint[]): string {
  return JSON.stringify(ids.map((i) => i.toString()));
}

/**
 * Decode the JSON-encoded tokenIds back to bigint[].
 */
export function decodeTokenIds(json: string): bigint[] {
  try {
    const arr = JSON.parse(json) as string[];
    return arr.map((s) => BigInt(s));
  } catch {
    return [];
  }
}
