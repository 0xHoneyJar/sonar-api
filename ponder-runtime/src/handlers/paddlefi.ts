// ponder-runtime/src/handlers/paddlefi.ts
//
// PORTED FROM: src/handlers/paddlefi.ts (envio, source-of-truth)
// Contract: PaddleFi (Berachain 80094, 0x242b7126...0a4E1)
//
// Tracks:
//   - Mint (Supply BERA): Lenders deposit BERA into the lending pool
//   - Pawn: Borrowers deposit Mibera NFTs as collateral
//   - LiquidateBorrow: liquidations (two action records — borrower side + liquidator side)
//
// No NATS publish — paddlefi is internal protocol activity, not a first-class
// mint event. App-side computes aggregates (was_first, was_first_ten,
// count_tier) from Actions table.

import { ponder } from "ponder:registry";
import {
  paddleSupply,
  paddleSupplier,
  paddlePawn,
  paddleBorrower,
  paddleLiquidation,
  action,
} from "../../ponder.schema";

const BERACHAIN_ID = 80094;
const COLLECTION_KEY = "paddlefi";

ponder.on("PaddleFi:Mint", async ({ event, context }) => {
  const minter = event.args.minter.toLowerCase();
  const mintAmount = event.args.mintAmount;
  const mintTokens = event.args.mintTokens;
  const chainId = context.chain.id;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;
  const timestamp = event.block.timestamp;
  const blockNumber = event.block.number;

  const eventId = `${txHash}_${logIndex}`;

  await context.db
    .insert(paddleSupply)
    .values({
      id: eventId,
      minter: minter as `0x${string}`,
      mintAmount,
      mintTokens,
      timestamp,
      blockNumber,
      transactionHash: txHash as `0x${string}`,
      chainId,
    })
    .onConflictDoNothing();

  // Supplier aggregate stats
  const supplierId = minter;
  const existing = await context.db.find(paddleSupplier, { id: supplierId });
  if (existing) {
    await context.db.update(paddleSupplier, { id: supplierId }).set({
      totalSupplied: existing.totalSupplied + mintAmount,
      totalPTokens: existing.totalPTokens + mintTokens,
      supplyCount: existing.supplyCount + 1,
      lastActivityTime: timestamp,
    });
  } else {
    await context.db
      .insert(paddleSupplier)
      .values({
        id: supplierId,
        address: minter as `0x${string}`,
        totalSupplied: mintAmount,
        totalPTokens: mintTokens,
        supplyCount: 1,
        firstSupplyTime: timestamp,
        lastActivityTime: timestamp,
        chainId,
      })
      .onConflictDoNothing();
  }

  await context.db
    .insert(action)
    .values({
      id: eventId,
      actionType: "paddle_supply",
      actor: minter as `0x${string}`,
      primaryCollection: COLLECTION_KEY,
      timestamp,
      chainId,
      txHash: txHash as `0x${string}`,
      numeric1: mintAmount,
      numeric2: mintTokens,
      context: JSON.stringify({
        type: "supply_bera",
        mintAmount: mintAmount.toString(),
        pTokensReceived: mintTokens.toString(),
      }),
    })
    .onConflictDoNothing();
});

ponder.on("PaddleFi:Pawn", async ({ event, context }) => {
  const borrower = event.args.borrower.toLowerCase();
  const nftIds = (event.args.nftIds as readonly bigint[]).map((id) => BigInt(id.toString()));
  const chainId = context.chain.id;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;
  const timestamp = event.block.timestamp;
  const blockNumber = event.block.number;

  const eventId = `${txHash}_${logIndex}`;

  await context.db
    .insert(paddlePawn)
    .values({
      id: eventId,
      borrower: borrower as `0x${string}`,
      nftIds: JSON.stringify(nftIds.map((id) => id.toString())),  // text-encoded uint256[] (schema convention)
      timestamp,
      blockNumber,
      transactionHash: txHash as `0x${string}`,
      chainId,
    })
    .onConflictDoNothing();

  // Borrower aggregate stats
  const borrowerId = borrower;
  const existing = await context.db.find(paddleBorrower, { id: borrowerId });
  if (existing) {
    await context.db.update(paddleBorrower, { id: borrowerId }).set({
      totalNftsPawned: existing.totalNftsPawned + nftIds.length,
      currentNftsPawned: existing.currentNftsPawned + nftIds.length,
      pawnCount: existing.pawnCount + 1,
      lastActivityTime: timestamp,
    });
  } else {
    await context.db
      .insert(paddleBorrower)
      .values({
        id: borrowerId,
        address: borrower as `0x${string}`,
        totalNftsPawned: nftIds.length,
        currentNftsPawned: nftIds.length,
        pawnCount: 1,
        firstPawnTime: timestamp,
        lastActivityTime: timestamp,
        chainId,
      })
      .onConflictDoNothing();
  }

  await context.db
    .insert(action)
    .values({
      id: eventId,
      actionType: "paddle_pawn",
      actor: borrower as `0x${string}`,
      primaryCollection: COLLECTION_KEY,
      timestamp,
      chainId,
      txHash: txHash as `0x${string}`,
      numeric1: BigInt(nftIds.length),
      numeric2: null,
      context: JSON.stringify({
        type: "pawn_nft",
        nftIds: nftIds.map((id) => id.toString()),
        nftCount: nftIds.length,
      }),
    })
    .onConflictDoNothing();
});

ponder.on("PaddleFi:LiquidateBorrow", async ({ event, context }) => {
  const liquidator = event.args.liquidator.toLowerCase();
  const borrower = event.args.borrower.toLowerCase();
  const repayAmount = event.args.repayAmount;
  const nftIds = (event.args.nftIds as readonly bigint[]).map((id) => BigInt(id.toString()));
  const chainId = context.chain.id;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;
  const timestamp = event.block.timestamp;
  const blockNumber = event.block.number;

  const eventId = `${txHash}_${logIndex}`;

  await context.db
    .insert(paddleLiquidation)
    .values({
      id: eventId,
      liquidator: liquidator as `0x${string}`,
      borrower: borrower as `0x${string}`,
      repayAmount,
      nftIds: JSON.stringify(nftIds.map((id) => id.toString())),
      timestamp,
      blockNumber,
      transactionHash: txHash as `0x${string}`,
      chainId,
    })
    .onConflictDoNothing();

  // Two action records — mirrors envio exactly.
  await context.db
    .insert(action)
    .values({
      id: `${eventId}_liquidated`,
      actionType: "paddle_liquidated",
      actor: borrower as `0x${string}`,
      primaryCollection: COLLECTION_KEY,
      timestamp,
      chainId,
      txHash: txHash as `0x${string}`,
      numeric1: repayAmount,
      numeric2: BigInt(nftIds.length),
      context: JSON.stringify({
        type: "was_liquidated",
        liquidator,
        repayAmount: repayAmount.toString(),
        nftIds: nftIds.map((id) => id.toString()),
        nftCount: nftIds.length,
      }),
    })
    .onConflictDoNothing();

  await context.db
    .insert(action)
    .values({
      id: `${eventId}_liquidator`,
      actionType: "paddle_liquidator",
      actor: liquidator as `0x${string}`,
      primaryCollection: COLLECTION_KEY,
      timestamp,
      chainId,
      txHash: txHash as `0x${string}`,
      numeric1: repayAmount,
      numeric2: BigInt(nftIds.length),
      context: JSON.stringify({
        type: "performed_liquidation",
        borrower,
        repayAmount: repayAmount.toString(),
        nftIds: nftIds.map((id) => id.toString()),
        nftCount: nftIds.length,
      }),
    })
    .onConflictDoNothing();
});
