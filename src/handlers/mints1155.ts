/*
 * ERC1155 mint tracking for Candies Market collections.
 * Also tracks orders (non-mint transfers) for SilkRoad marketplace.
 */

import { CandiesMarket1155, Erc1155MintEvent, CandiesInventory, CandiesBacking, MiberaOrder } from "generated";
import type {
  handlerContext,
  CandiesHolder as CandiesHolderEntity,
  CandiesHolderBalance as CandiesHolderBalanceEntity,
} from "generated";

import { ZERO_ADDRESS, BERACHAIN_ID } from "./constants";
import { MINT_COLLECTION_KEYS } from "./mints/constants";
import { recordAction } from "../lib/actions";
import { isBurnAddress } from "../lib/mint-detection";

const ZERO = ZERO_ADDRESS.toLowerCase();

// SilkRoad marketplace address - only create orders for this contract
const SILKROAD_ADDRESS = "0x80283fbf2b8e50f6ddf9bfc4a90a8336bc90e38f";

const getCollectionKey = (address: string): string => {
  const key = MINT_COLLECTION_KEYS[address.toLowerCase()];
  return key ?? address.toLowerCase();
};

export const handleCandiesMintSingle = CandiesMarket1155.TransferSingle.handler(
  async ({ event, context }) => {
    const { operator, from, to, id, value } = event.params;
    const fromLower = from.toLowerCase();
    const contractAddress = event.srcAddress.toLowerCase();
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;
    const tokenId = BigInt(id.toString());
    const quantity = BigInt(value.toString());

    // =========================================================================
    // Per-(holder, contract, tokenId) balances (CandiesHolderBalance) — DEP-1.
    // Mirrors badges1155.adjustBadgeBalances: decrement `from`, increment `to`;
    // zero/burn addresses are skipped so mint/burn/transfer all reconcile.
    // Runs for ALL transfers (the mint-only early-return below is preserved for
    // the existing MintEvent / inventory / backing / order side-effects).
    // =========================================================================
    if (quantity > 0n) {
      await adjustCandiesBalance({
        context,
        holderAddress: fromLower,
        contractAddress,
        tokenId,
        amountDelta: -quantity,
        timestamp,
        chainId,
      });
      await adjustCandiesBalance({
        context,
        holderAddress: to.toLowerCase(),
        contractAddress,
        tokenId,
        amountDelta: quantity,
        timestamp,
        chainId,
      });
    }

    // Track orders for SilkRoad marketplace (non-mint transfers on Berachain)
    if (fromLower !== ZERO && contractAddress === SILKROAD_ADDRESS && chainId === BERACHAIN_ID) {
      const orderId = `${chainId}_${event.transaction.hash}_${event.logIndex}`;
      const order: MiberaOrder = {
        id: orderId,
        user: to.toLowerCase(),
        tokenId,
        amount: quantity,
        timestamp,
        blockNumber: BigInt(event.block.number),
        transactionHash: event.transaction.hash,
        chainId,
      };
      context.MiberaOrder.set(order);
    }

    // Skip mint processing if not a mint
    if (fromLower !== ZERO) {
      return;
    }

    const collectionKey = getCollectionKey(contractAddress);
    const mintId = `${event.transaction.hash}_${event.logIndex}`;
    const minter = to.toLowerCase();
    const operatorLower = operator.toLowerCase();
    const txHash = event.transaction.hash;

    // Track BERA backing for candies only (mibera_drugs)
    // Use CandiesBacking entity to deduplicate by txHash
    if (collectionKey === "mibera_drugs") {
      const txValue = (event.transaction as { value?: bigint }).value;
      if (txValue && txValue > 0n) {
        const existingBacking = await context.CandiesBacking.get(txHash);
        if (!existingBacking) {
          const backing: CandiesBacking = {
            id: txHash,
            user: minter,
            amount: txValue,
            timestamp,
            chainId,
          };
          context.CandiesBacking.set(backing);
        }
      }
    }

    const mintEvent: Erc1155MintEvent = {
      id: mintId,
      collectionKey,
      tokenId,
      value: quantity,
      minter,
      operator: operatorLower,
      timestamp,
      blockNumber: BigInt(event.block.number),
      transactionHash: event.transaction.hash,
      chainId,
    };

    context.Erc1155MintEvent.set(mintEvent);

    // Update CandiesInventory tracking
    const inventoryId = `${contractAddress}_${tokenId}`;
    const existingInventory = await context.CandiesInventory.get(inventoryId);

    const inventoryUpdate: CandiesInventory = {
      id: inventoryId,
      contract: contractAddress,
      tokenId,
      currentSupply: existingInventory
        ? existingInventory.currentSupply + quantity
        : quantity,
      mintCount: existingInventory ? existingInventory.mintCount + 1 : 1,
      lastMintTime: timestamp,
      chainId,
    };

    context.CandiesInventory.set(inventoryUpdate);

    recordAction(context, {
      id: mintId,
      actionType: "mint1155",
      actor: minter,
      primaryCollection: collectionKey,
      timestamp,
      chainId,
      txHash,
      logIndex: event.logIndex,
      numeric1: quantity,
      context: {
        tokenId: tokenId.toString(),
        operator: operatorLower,
        contract: contractAddress,
      },
    });
  }
);

export const handleCandiesMintBatch = CandiesMarket1155.TransferBatch.handler(
  async ({ event, context }) => {
    const { operator, from, to, ids, values } = event.params;

    const fromLower = from.toLowerCase();
    const contractAddress = event.srcAddress.toLowerCase();
    const collectionKey = getCollectionKey(contractAddress);
    const operatorLower = operator.toLowerCase();
    const minterLower = to.toLowerCase();
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;
    const txHash = event.transaction.hash;

    const idsArrayForBalance = Array.from(ids);
    const valuesArrayForBalance = Array.from(values);
    const balanceLength = Math.min(
      idsArrayForBalance.length,
      valuesArrayForBalance.length,
    );

    // =========================================================================
    // Per-(holder, contract, tokenId) balances (CandiesHolderBalance) — DEP-1.
    // Runs for ALL batch transfers (mint/burn/transfer); the mint-only
    // early-return below preserves the existing MintEvent / inventory / backing
    // side-effects without affecting balance reconciliation.
    // =========================================================================
    for (let index = 0; index < balanceLength; index += 1) {
      const rawId = idsArrayForBalance[index];
      const rawValue = valuesArrayForBalance[index];
      if (rawId === undefined || rawValue === undefined || rawValue === null) {
        continue;
      }
      const balanceTokenId = BigInt(rawId.toString());
      const balanceQuantity = BigInt(rawValue.toString());
      if (balanceQuantity === 0n) {
        continue;
      }
      await adjustCandiesBalance({
        context,
        holderAddress: fromLower,
        contractAddress,
        tokenId: balanceTokenId,
        amountDelta: -balanceQuantity,
        timestamp,
        chainId,
      });
      await adjustCandiesBalance({
        context,
        holderAddress: minterLower,
        contractAddress,
        tokenId: balanceTokenId,
        amountDelta: balanceQuantity,
        timestamp,
        chainId,
      });
    }

    // Mint-only side-effects below (MintEvent + inventory + backing + action).
    if (fromLower !== ZERO) {
      return;
    }

    // Track BERA backing for candies only (mibera_drugs)
    // Use CandiesBacking entity to deduplicate by txHash
    if (collectionKey === "mibera_drugs") {
      const txValue = (event.transaction as { value?: bigint }).value;
      if (txValue && txValue > 0n) {
        const existingBacking = await context.CandiesBacking.get(txHash);
        if (!existingBacking) {
          const backing: CandiesBacking = {
            id: txHash,
            user: minterLower,
            amount: txValue,
            timestamp,
            chainId,
          };
          context.CandiesBacking.set(backing);
        }
      }
    }

    const idsArray = Array.from(ids);
    const valuesArray = Array.from(values);

    const length = Math.min(idsArray.length, valuesArray.length);

    for (let index = 0; index < length; index += 1) {
      const rawId = idsArray[index];
      const rawValue = valuesArray[index];

      if (rawId === undefined || rawValue === undefined || rawValue === null) {
        continue;
      }

      const quantity = BigInt(rawValue.toString());
      if (quantity === 0n) {
        continue;
      }

      const tokenId = BigInt(rawId.toString());
      const mintId = `${event.transaction.hash}_${event.logIndex}_${index}`;

      const mintEvent: Erc1155MintEvent = {
        id: mintId,
        collectionKey,
        tokenId,
        value: quantity,
        minter: minterLower,
        operator: operatorLower,
        timestamp,
        blockNumber: BigInt(event.block.number),
        transactionHash: txHash,
        chainId,
      };

      context.Erc1155MintEvent.set(mintEvent);

      // Update CandiesInventory tracking
      const inventoryId = `${contractAddress}_${tokenId}`;
      const existingInventory = await context.CandiesInventory.get(inventoryId);

      const inventoryUpdate: CandiesInventory = {
        id: inventoryId,
        contract: contractAddress,
        tokenId,
        currentSupply: existingInventory
          ? existingInventory.currentSupply + quantity
          : quantity,
        mintCount: existingInventory ? existingInventory.mintCount + 1 : 1,
        lastMintTime: timestamp,
        chainId,
      };

      context.CandiesInventory.set(inventoryUpdate);

      recordAction(context, {
        id: mintId,
        actionType: "mint1155",
        actor: minterLower,
        primaryCollection: collectionKey,
        timestamp,
        chainId,
        txHash,
        logIndex: event.logIndex,
        numeric1: quantity,
        context: {
          tokenId: tokenId.toString(),
          operator: operatorLower,
          contract: contractAddress,
          batchIndex: index,
        },
      });
    }
  }
);

// =============================================================================
// Per-(holder, contract, tokenId) ERC-1155 balances (CandiesHolderBalance) — DEP-1
// =============================================================================

interface AdjustCandiesBalanceArgs {
  context: handlerContext;
  holderAddress: string;
  contractAddress: string;
  tokenId: bigint;
  amountDelta: bigint;
  timestamp: bigint;
  chainId: number;
}

const makeCandiesBalanceId = (
  chainId: number,
  address: string,
  contract: string,
  tokenId: bigint,
): string => `${chainId}-${address}-${contract}-${tokenId.toString()}`;

/**
 * Maintain the per-(holder, contract, tokenId) Candies balance, mirroring
 * src/handlers/badges1155.ts adjustBadgeBalances. Skips the zero / burn
 * addresses (so mints and burns naturally settle to a single live side),
 * clamps decrements to the current balance, and deletes empty records.
 * `CandiesHolder.totalAmount` aggregates all candy balances for a wallet.
 */
async function adjustCandiesBalance({
  context,
  holderAddress,
  contractAddress,
  tokenId,
  amountDelta,
  timestamp,
  chainId,
}: AdjustCandiesBalanceArgs): Promise<void> {
  if (amountDelta === 0n) return;

  const address = holderAddress.toLowerCase();
  if (address === ZERO || isBurnAddress(address)) return;

  const contract = contractAddress.toLowerCase();
  const balanceId = makeCandiesBalanceId(chainId, address, contract, tokenId);

  const existingBalance = await context.CandiesHolderBalance.get(balanceId);
  const currentBalance = existingBalance?.amount ?? 0n;

  // Clamp removals to the available balance (defensive — matches badges1155).
  let appliedDelta = amountDelta;
  if (amountDelta < 0n) {
    const removeAmount =
      currentBalance < -amountDelta ? currentBalance : -amountDelta;
    if (removeAmount === 0n) return;
    appliedDelta = -removeAmount;
  }
  if (appliedDelta === 0n) return;

  const nextBalance = currentBalance + appliedDelta;

  // Update aggregate holder total.
  const existingHolder = await context.CandiesHolder.get(address);
  let nextTotal = (existingHolder?.totalAmount ?? 0n) + appliedDelta;
  if (nextTotal < 0n) nextTotal = 0n;

  const holder: CandiesHolderEntity = {
    id: address,
    address,
    chainId,
    totalAmount: nextTotal,
    updatedAt: timestamp,
  };
  context.CandiesHolder.set(holder);

  if (nextBalance <= 0n) {
    if (existingBalance) {
      context.CandiesHolderBalance.deleteUnsafe(balanceId);
    }
    return;
  }

  const balance: CandiesHolderBalanceEntity = {
    id: balanceId,
    holder_id: address,
    contract,
    tokenId,
    chainId,
    amount: nextBalance,
    updatedAt: timestamp,
  };
  context.CandiesHolderBalance.set(balance);
}
