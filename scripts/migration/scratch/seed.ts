// scripts/migration/scratch/seed.ts
//
// Generates SYNTHETIC source rows for the scratch validation subset. Values are
// chosen to exercise the transform's edge surfaces:
//   - uint256-scale ids in the bigint[] columns (> 2^63, to prove no overflow)
//   - a non-trivial jsonb structure in badge_holder.holdings
//   - a "large-ish" `action` table (configurable count) to exercise batching
//   - NULLable columns left NULL on some rows
//
// SCRATCH-ONLY. No production data is touched.

import type { Pool } from "../pg";
import type { EntityMap } from "../entity-map";

const qIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

// A uint256 value comfortably above int64 max (9.22e18) — proves numeric(78,0)
// + JSON.stringify(String) path is precision-safe.
const BIG_TOKEN_ID_A = "115792089237316195423570985008687907853269984665640564039457584007913129639935"; // 2^256-1
const BIG_TOKEN_ID_B = "18446744073709551616"; // 2^64
const BIG_AMOUNT = "1000000000000000000000"; // 1000e18

async function insertRows(
  pool: Pool,
  table: string,
  rows: Record<string, unknown>[],
) {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const colList = cols.map(qIdent).join(", ");
  let p = 1;
  const tuples: string[] = [];
  const params: unknown[] = [];
  for (const row of rows) {
    tuples.push(`(${cols.map(() => `$${p++}`).join(", ")})`);
    for (const c of cols) params.push(row[c]);
  }
  await pool.query(
    `INSERT INTO public.${qIdent(table)} (${colList}) VALUES ${tuples.join(", ")}`,
    params,
  );
}

export interface SeedOptions {
  actionRows: number; // size of the `action` table (batching exercise)
}

export async function seedSource(
  src: Pool,
  entities: EntityMap[],
  opts: SeedOptions,
) {
  const byTable = new Map(entities.map((e) => [e.ponder_table, e]));

  // badge_holder — jsonb holdings
  if (byTable.has("badge_holder")) {
    await insertRows(src, "BadgeHolder", [
      {
        id: "0xaaa-80094",
        address: "0xaaa",
        chainId: 80094,
        totalBadges: "3",
        totalAmount: BIG_AMOUNT,
        holdings: JSON.stringify({ "1": "2", "5": "1", big: BIG_TOKEN_ID_A }),
        updatedAt: "1716800000",
      },
      {
        id: "0xbbb-80094",
        address: "0xbbb",
        chainId: 80094,
        totalBadges: "0",
        totalAmount: "0",
        holdings: JSON.stringify([]), // empty-array edge
        updatedAt: "1716800001",
      },
    ]);
  }

  // mibera_loan — bigint[] token_ids
  if (byTable.has("mibera_loan")) {
    await insertRows(src, "MiberaLoan", [
      {
        id: "loan-1",
        loanId: "1",
        loanType: "STANDARD",
        user: "0xuser1",
        tokenIds: [BIG_TOKEN_ID_A, BIG_TOKEN_ID_B, "1"], // pg numeric[]
        amount: BIG_AMOUNT,
        expiry: "1717000000",
        status: "ACTIVE",
        createdAt: "1716000000",
        repaidAt: null,
        defaultedAt: null,
        transactionHash: "0xhash1",
        chainId: 80094,
      },
      {
        id: "loan-2",
        loanId: "2",
        loanType: "STANDARD",
        user: "0xuser2",
        tokenIds: [], // empty array edge
        amount: "0",
        expiry: "1717000001",
        status: "REPAID",
        createdAt: "1716000001",
        repaidAt: "1716500000",
        defaultedAt: null,
        transactionHash: "0xhash2",
        chainId: 80094,
      },
    ]);
  }

  // paddle_pawn — bigint[] nft_ids
  if (byTable.has("paddle_pawn")) {
    await insertRows(src, "PaddlePawn", [
      {
        id: "pawn-1",
        borrower: "0xborrower1",
        nftIds: ["1", "2", BIG_TOKEN_ID_B],
        timestamp: "1716000000",
        blockNumber: "21424000",
        transactionHash: "0xpawnhash1",
        chainId: 80094,
      },
    ]);
  }

  // paddle_liquidation — bigint[] nft_ids
  if (byTable.has("paddle_liquidation")) {
    await insertRows(src, "PaddleLiquidation", [
      {
        id: "liq-1",
        liquidator: "0xliquidator1",
        borrower: "0xborrower1",
        repayAmount: BIG_AMOUNT,
        nftIds: [BIG_TOKEN_ID_A],
        timestamp: "1716100000",
        blockNumber: "21424100",
        transactionHash: "0xliqhash1",
        chainId: 80094,
      },
    ]);
  }

  // mibera_transfer — append-only event
  if (byTable.has("mibera_transfer")) {
    const rows = [];
    for (let i = 0; i < 50; i++) {
      rows.push({
        id: `xfer-${String(i).padStart(4, "0")}`,
        from: i === 0 ? "0x0000000000000000000000000000000000000000" : `0xfrom${i}`,
        to: `0xto${i}`,
        tokenId: String(i),
        isMint: i === 0,
        timestamp: String(1716000000 + i),
        blockNumber: String(21424000 + i),
        transactionHash: `0xxferhash${i}`,
        chainId: 80094,
      });
    }
    await insertRows(src, "MiberaTransfer", rows);
  }

  // tracked_holder — additive-rollup state (overlap-sensitive)
  if (byTable.has("tracked_holder")) {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      rows.push({
        id: `th-${i}-80094`,
        contract: `0xcontract${i % 3}`,
        collectionKey: `coll${i % 3}`,
        chainId: 80094,
        address: `0xholder${i}`,
        tokenCount: i + 1,
      });
    }
    await insertRows(src, "TrackedHolder", rows);
  }

  // action — large table for batching exercise
  if (byTable.has("action")) {
    const total = opts.actionRows;
    const CHUNK = 2000;
    for (let start = 0; start < total; start += CHUNK) {
      const rows = [];
      for (let i = start; i < Math.min(start + CHUNK, total); i++) {
        rows.push({
          id: `action-${String(i).padStart(8, "0")}`,
          actionType: i % 2 === 0 ? "MINT" : "TRANSFER",
          actor: `0xactor${i % 100}`,
          primaryCollection: i % 5 === 0 ? null : `coll${i % 5}`,
          timestamp: String(1716000000 + i),
          chainId: 80094,
          txHash: `0xactionhash${i}`,
          numeric1: i % 7 === 0 ? null : String(i),
          numeric2: null,
          context: i % 3 === 0 ? null : `ctx${i}`,
        });
      }
      await insertRows(src, "Action", rows);
    }
  }
}
