/*
 * PaddleFi Lending Protocol Handler
 *
 * Tracks:
 * - Mint (Supply BERA): Lenders deposit BERA into the lending pool
 * - Pawn: Borrowers deposit Mibera NFTs as collateral
 * - LiquidateBorrow: Liquidations (borrower liquidated, liquidator seizes NFTs)
 *
 * Contract: 0x242b7126F3c4E4F8CbD7f62571293e63E9b0a4E1 (Berachain)
 */

import {
  indexer,
  type EvmOnEventContext,
  type PaddleSupply as PaddleSupplyEntity,
  type PaddlePawn as PaddlePawnEntity,
  type PaddleSupplier as PaddleSupplierEntity,
  type PaddleBorrower as PaddleBorrowerEntity,
  type PaddleLiquidation as PaddleLiquidationEntity,
} from "envio";

import { recordAction } from "../lib/actions";

/**
 * Handle Mint events (Supply BERA)
 * Emitted when a lender deposits BERA into the lending pool
 */
indexer.onEvent(
  { contract: "PaddleFi", event: "Mint" },
  async ({ event, context }) => {
    const minter = event.params.minter.toLowerCase();
    const mintAmount = event.params.mintAmount;
    const mintTokens = event.params.mintTokens;
    const chainId = event.chainId;
    const txHash = event.transaction.hash;
    const logIndex = event.logIndex;
    const timestamp = BigInt(event.block.timestamp);
    const blockNumber = BigInt(event.block.number);

    const eventId = `${txHash}_${logIndex}`;

    // Create supply event record
    const supplyEvent: PaddleSupplyEntity = {
      id: eventId,
      minter,
      mintAmount,
      mintTokens,
      timestamp,
      blockNumber,
      transactionHash: txHash,
      chainId,
    };
    context.PaddleSupply.set(supplyEvent);

    // Update supplier aggregate stats
    await updateSupplierStats({
      context,
      address: minter,
      mintAmount,
      mintTokens,
      timestamp,
      chainId,
    });

    // Record action for activity feed
    recordAction(context, {
      id: eventId,
      actionType: "paddle_supply",
      actor: minter,
      primaryCollection: "paddlefi",
      timestamp,
      chainId,
      txHash,
      logIndex: Number(logIndex),
      numeric1: mintAmount,
      numeric2: mintTokens,
      context: {
        type: "supply_bera",
        mintAmount: mintAmount.toString(),
        pTokensReceived: mintTokens.toString(),
      },
    });
  }
);

/**
 * Handle Pawn events (Deposit NFT as collateral)
 * Emitted when a borrower deposits Mibera NFTs to take a loan
 */
indexer.onEvent(
  { contract: "PaddleFi", event: "Pawn" },
  async ({ event, context }) => {
    const borrower = event.params.borrower.toLowerCase();
    const nftIds = event.params.nftIds.map((id) => BigInt(id.toString()));
    const chainId = event.chainId;
    const txHash = event.transaction.hash;
    const logIndex = event.logIndex;
    const timestamp = BigInt(event.block.timestamp);
    const blockNumber = BigInt(event.block.number);

    const eventId = `${txHash}_${logIndex}`;

    // Create pawn event record
    const pawnEvent: PaddlePawnEntity = {
      id: eventId,
      borrower,
      nftIds,
      timestamp,
      blockNumber,
      transactionHash: txHash,
      chainId,
    };
    context.PaddlePawn.set(pawnEvent);

    // Update borrower aggregate stats
    await updateBorrowerStats({
      context,
      address: borrower,
      nftCount: nftIds.length,
      timestamp,
      chainId,
    });

    // Record action for activity feed
    recordAction(context, {
      id: eventId,
      actionType: "paddle_pawn",
      actor: borrower,
      primaryCollection: "paddlefi",
      timestamp,
      chainId,
      txHash,
      logIndex: Number(logIndex),
      numeric1: BigInt(nftIds.length),
      context: {
        type: "pawn_nft",
        nftIds: nftIds.map((id) => id.toString()),
        nftCount: nftIds.length,
      },
    });
  }
);

// Helper functions

interface UpdateSupplierArgs {
  context: EvmOnEventContext;
  address: string;
  mintAmount: bigint;
  mintTokens: bigint;
  timestamp: bigint;
  chainId: number;
}

async function updateSupplierStats({
  context,
  address,
  mintAmount,
  mintTokens,
  timestamp,
  chainId,
}: UpdateSupplierArgs) {
  const supplierId = address;
  const existing = await context.PaddleSupplier.get(supplierId);

  const supplier: PaddleSupplierEntity = existing
    ? {
        ...existing,
        totalSupplied: existing.totalSupplied + mintAmount,
        totalPTokens: existing.totalPTokens + mintTokens,
        supplyCount: existing.supplyCount + 1,
        lastActivityTime: timestamp,
      }
    : {
        id: supplierId,
        address,
        totalSupplied: mintAmount,
        totalPTokens: mintTokens,
        supplyCount: 1,
        firstSupplyTime: timestamp,
        lastActivityTime: timestamp,
        chainId,
      };

  context.PaddleSupplier.set(supplier);
}

interface UpdateBorrowerArgs {
  context: EvmOnEventContext;
  address: string;
  nftCount: number;
  timestamp: bigint;
  chainId: number;
}

async function updateBorrowerStats({
  context,
  address,
  nftCount,
  timestamp,
  chainId,
}: UpdateBorrowerArgs) {
  const borrowerId = address;
  const existing = await context.PaddleBorrower.get(borrowerId);

  const borrower: PaddleBorrowerEntity = existing
    ? {
        ...existing,
        totalNftsPawned: existing.totalNftsPawned + nftCount,
        currentNftsPawned: existing.currentNftsPawned + nftCount,
        pawnCount: existing.pawnCount + 1,
        lastActivityTime: timestamp,
      }
    : {
        id: borrowerId,
        address,
        totalNftsPawned: nftCount,
        currentNftsPawned: nftCount,
        pawnCount: 1,
        firstPawnTime: timestamp,
        lastActivityTime: timestamp,
        chainId,
      };

  context.PaddleBorrower.set(borrower);
}

/**
 * Handle LiquidateBorrow events (Liquidation)
 * Emitted when a liquidator repays a borrower's debt and seizes their NFT collateral
 *
 * Records two actions:
 * - paddle_liquidated: for the borrower who was liquidated
 * - paddle_liquidator: for the user who performed the liquidation
 *
 * App layer computes aggregates (was_first, was_first_ten, count_tier) from Actions table
 */
indexer.onEvent(
  { contract: "PaddleFi", event: "LiquidateBorrow" },
  async ({ event, context }) => {
    const liquidator = event.params.liquidator.toLowerCase();
    const borrower = event.params.borrower.toLowerCase();
    const repayAmount = event.params.repayAmount;
    const nftIds = event.params.nftIds.map((id) => BigInt(id.toString()));
    const chainId = event.chainId;
    const txHash = event.transaction.hash;
    const logIndex = event.logIndex;
    const timestamp = BigInt(event.block.timestamp);
    const blockNumber = BigInt(event.block.number);

    const eventId = `${txHash}_${logIndex}`;

    // Create liquidation event record
    const liquidationEvent: PaddleLiquidationEntity = {
      id: eventId,
      liquidator,
      borrower,
      repayAmount,
      nftIds,
      timestamp,
      blockNumber,
      transactionHash: txHash,
      chainId,
    };
    context.PaddleLiquidation.set(liquidationEvent);

    // Record action for liquidated user (was liquidated)
    recordAction(context, {
      id: `${eventId}_liquidated`,
      actionType: "paddle_liquidated",
      actor: borrower,
      primaryCollection: "paddlefi",
      timestamp,
      chainId,
      txHash,
      logIndex: Number(logIndex),
      numeric1: repayAmount,
      numeric2: BigInt(nftIds.length),
      context: {
        type: "was_liquidated",
        liquidator,
        repayAmount: repayAmount.toString(),
        nftIds: nftIds.map((id) => id.toString()),
        nftCount: nftIds.length,
      },
    });

    // Record action for liquidator (performed liquidation)
    recordAction(context, {
      id: `${eventId}_liquidator`,
      actionType: "paddle_liquidator",
      actor: liquidator,
      primaryCollection: "paddlefi",
      timestamp,
      chainId,
      txHash,
      logIndex: Number(logIndex),
      numeric1: repayAmount,
      numeric2: BigInt(nftIds.length),
      context: {
        type: "performed_liquidation",
        borrower,
        repayAmount: repayAmount.toString(),
        nftIds: nftIds.map((id) => id.toString()),
        nftCount: nftIds.length,
      },
    });
  }
);
