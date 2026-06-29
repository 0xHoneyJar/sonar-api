/*
 * ERC1155 mint tracking for Candies Market collections.
 * Also tracks orders (non-mint transfers) for SilkRoad marketplace.
 */

import {
  indexer,
  type Erc1155MintEvent,
  type CandiesInventory,
  type CandiesBacking,
  type MiberaOrder,
} from "envio";

import { ZERO_ADDRESS, BERACHAIN_ID } from "./constants";
import { MINT_COLLECTION_KEYS } from "./mints/constants";
import { recordAction } from "../lib/actions";

const ZERO = ZERO_ADDRESS.toLowerCase();

// SilkRoad marketplace address - only create orders for this contract
const SILKROAD_ADDRESS = "0x80283fbf2b8e50f6ddf9bfc4a90a8336bc90e38f";

const getCollectionKey = (address: string): string => {
  const key = MINT_COLLECTION_KEYS[address.toLowerCase()];
  return key ?? address.toLowerCase();
};

indexer.onEvent({ contract: "CandiesMarket1155", event: "TransferSingle" },
  async ({ event, context }) => {
    const { operator, from, to, id, value } = event.params;
    const fromLower = from.toLowerCase();
    const contractAddress = event.srcAddress.toLowerCase();
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;
    const tokenId = BigInt(id.toString());
    const quantity = BigInt(value.toString());

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

indexer.onEvent({ contract: "CandiesMarket1155", event: "TransferBatch" },
  async ({ event, context }) => {
    const { operator, from, to, ids, values } = event.params;

    if (from.toLowerCase() !== ZERO) {
      return;
    }

    const contractAddress = event.srcAddress.toLowerCase();
    const collectionKey = getCollectionKey(contractAddress);
    const operatorLower = operator.toLowerCase();
    const minterLower = to.toLowerCase();
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;
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
