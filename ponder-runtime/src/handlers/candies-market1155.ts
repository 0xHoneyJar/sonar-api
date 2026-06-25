// ponder-runtime/src/handlers/candies-market1155.ts
//
// PORTED FROM: src/handlers/mints1155.ts (envio, source-of-truth)
// Contract: CandiesMarket1155 (ERC-1155 on Berachain 80094, 2 addresses:
//   SilkRoad marketplace + secondary, both → collectionKey "mibera_drugs").
//
// Mibera-gap handler-only port (registered-but-unsubscribed, RLAI-verified).
// Contract registered in ponder.config.mibera.ts:210 (CANDIES_MARKET_1155 array);
// candies_inventory / candies_backing / mibera_order / erc1155_mint_event tables
// already exist in ponder.schema.ts. There was no handler, so all of these were
// silently never written.
//
// NO NATS path (unlike GeneralMints) — this handler only writes the four tables
// + a parallel recordAction. Mirrors the puru-apiculture1155.ts ERC-1155 shape.
//
// Behaviour ported verbatim from envio mints1155.ts:
//   - non-mint transfers from the SilkRoad marketplace on Berachain → MiberaOrder
//   - mints (from == 0x0):
//       * BERA backing (tx.value > 0, deduped by txHash) for "mibera_drugs" only
//       * Erc1155MintEvent row
//       * CandiesInventory rollup (currentSupply += quantity, mintCount += 1)
//       * recordAction("mint1155")

import { ponder } from "ponder:registry";
import {
  erc1155MintEvent,
  candiesInventory,
  candiesBacking,
  miberaOrder,
} from "../../ponder.schema";
import { recordAction } from "../lib/record-action";
import { applyTransferBalances } from "./candies-balance";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// envio src/handlers/constants.ts:9 — BERACHAIN_ID (80094 is mainnet).
const BERACHAIN_ID = 80094;

// SilkRoad marketplace address — only create orders for this contract.
// Verbatim from envio src/handlers/mints1155.ts:15.
const SILKROAD_ADDRESS = "0x80283fbf2b8e50f6ddf9bfc4a90a8336bc90e38f";

// envio src/handlers/mints/constants.ts — both CandiesMarket1155 addresses
// map to "mibera_drugs"; getCollectionKey falls back to the raw address.
const MINT_COLLECTION_KEYS: Record<string, string> = {
  "0x80283fbf2b8e50f6ddf9bfc4a90a8336bc90e38f": "mibera_drugs",
  "0xeca03517c5195f1edd634da6d690d6c72407c40c": "mibera_drugs",
};

function getCollectionKey(address: string): string {
  return MINT_COLLECTION_KEYS[address.toLowerCase()] ?? address.toLowerCase();
}

// ────────────────────────────────────────────────────────────────────────────
// TransferSingle
// ────────────────────────────────────────────────────────────────────────────
ponder.on("CandiesMarket1155:TransferSingle", async ({ event, context }) => {
  const { operator, from, to, id, value } = event.args;
  const fromLower = from.toLowerCase();
  const contractAddress = event.log.address.toLowerCase();
  const timestamp = event.block.timestamp;
  const chainId = context.chain.id;
  const tokenId = BigInt(id.toString());
  const quantity = BigInt(value.toString());
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  // Track orders for SilkRoad marketplace (non-mint transfers on Berachain).
  if (
    fromLower !== ZERO_ADDRESS &&
    contractAddress === SILKROAD_ADDRESS &&
    chainId === BERACHAIN_ID
  ) {
    const orderId = `${chainId}_${txHash}_${logIndex}`;
    await context.db
      .insert(miberaOrder)
      .values({
        id: orderId,
        user: to.toLowerCase() as `0x${string}`,
        tokenId,
        amount: quantity,
        timestamp,
        blockNumber: event.block.number,
        transactionHash: txHash as `0x${string}`,
        chainId,
      })
      .onConflictDoNothing();
  }

  // Per-holder balance maintenance (mints AND trades AND burns).
  // Runs for EVERY transfer, BEFORE the mint-only early-return below — so a
  // trade debits `from` AND credits `to`, a mint only credits, a burn only
  // debits. GATED to candies (mibera_drugs) market addresses, and the row's
  // `contract` is the canonical value inventory-api filters on. See
  // applyTransferBalances (candies-balance.ts) for both decisions.
  await applyTransferBalances({
    context,
    from,
    to,
    contractAddress,
    tokenId,
    chainId,
    quantity,
    timestamp,
  });

  // Skip mint processing if not a mint. (The candies_inventory / candies_backing
  // / erc1155_mint_event / mibera_order writes below stay mint-only — UNCHANGED.)
  if (fromLower !== ZERO_ADDRESS) {
    return;
  }

  const collectionKey = getCollectionKey(contractAddress);
  const mintId = `${txHash}_${logIndex}`;
  const minter = to.toLowerCase();
  const operatorLower = operator.toLowerCase();

  // Track BERA backing for candies only (mibera_drugs), deduped by txHash.
  if (collectionKey === "mibera_drugs") {
    const txValue = (event.transaction as any).value;
    if (typeof txValue === "bigint" && txValue > 0n) {
      const existingBacking = await context.db.find(candiesBacking, {
        id: txHash,
      });
      if (!existingBacking) {
        await context.db
          .insert(candiesBacking)
          .values({
            id: txHash,
            user: minter as `0x${string}`,
            amount: txValue,
            timestamp,
            chainId,
          })
          .onConflictDoNothing();
      }
    }
  }

  await context.db
    .insert(erc1155MintEvent)
    .values({
      id: mintId,
      collectionKey,
      tokenId,
      value: quantity,
      minter: minter as `0x${string}`,
      operator: operatorLower as `0x${string}`,
      timestamp,
      blockNumber: event.block.number,
      transactionHash: txHash as `0x${string}`,
      chainId,
    })
    .onConflictDoNothing();

  // Update CandiesInventory rollup.
  const inventoryId = `${contractAddress}_${tokenId}`;
  const existingInventory = await context.db.find(candiesInventory, {
    id: inventoryId,
  });

  if (existingInventory) {
    await context.db.update(candiesInventory, { id: inventoryId }).set({
      currentSupply: existingInventory.currentSupply + quantity,
      mintCount: existingInventory.mintCount + 1,
      lastMintTime: timestamp,
    });
  } else {
    await context.db
      .insert(candiesInventory)
      .values({
        id: inventoryId,
        contract: contractAddress as `0x${string}`,
        tokenId,
        currentSupply: quantity,
        mintCount: 1,
        lastMintTime: timestamp,
        chainId,
      })
      .onConflictDoNothing();
  }

  await recordAction(context, {
    id: mintId,
    actionType: "mint1155",
    actor: minter,
    primaryCollection: collectionKey,
    timestamp,
    chainId,
    txHash,
    logIndex,
    numeric1: quantity,
    context: {
      tokenId: tokenId.toString(),
      operator: operatorLower,
      contract: contractAddress,
    },
  });
});

// ────────────────────────────────────────────────────────────────────────────
// TransferBatch
// ────────────────────────────────────────────────────────────────────────────
ponder.on("CandiesMarket1155:TransferBatch", async ({ event, context }) => {
  const { operator, from, to, ids, values } = event.args;

  // Was: early-return when `from != 0x0` (mint-only). We now run the per-id
  // loop for EVERY batch transfer so per-holder balances stay correct for
  // trades + burns too — the mint-specific writes (backing / erc1155MintEvent /
  // inventory / recordAction) stay gated behind `isMint`, UNCHANGED.
  const fromLower = from.toLowerCase();
  const isMint = fromLower === ZERO_ADDRESS;

  const contractAddress = event.log.address.toLowerCase();
  const collectionKey = getCollectionKey(contractAddress);
  const operatorLower = operator.toLowerCase();
  const minterLower = to.toLowerCase();
  const timestamp = event.block.timestamp;
  const chainId = context.chain.id;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  // Track BERA backing for candies only (mibera_drugs), deduped by txHash.
  // Mint-only (matches original behaviour — backing was inside the mint path).
  if (isMint && collectionKey === "mibera_drugs") {
    const txValue = (event.transaction as any).value;
    if (typeof txValue === "bigint" && txValue > 0n) {
      const existingBacking = await context.db.find(candiesBacking, {
        id: txHash,
      });
      if (!existingBacking) {
        await context.db
          .insert(candiesBacking)
          .values({
            id: txHash,
            user: minterLower as `0x${string}`,
            amount: txValue,
            timestamp,
            chainId,
          })
          .onConflictDoNothing();
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

    // Per-holder balance maintenance for EVERY batch leg (mint/trade/burn).
    // DEBIT `from` (skipped for mints), CREDIT `to` (skipped for burns). GATED
    // to candies; row `contract` = canonical candies value. Same decisions as
    // TransferSingle — see applyTransferBalances (candies-balance.ts).
    await applyTransferBalances({
      context,
      from,
      to,
      contractAddress,
      tokenId,
      chainId,
      quantity,
      timestamp,
    });

    // Mint-specific writes (backing already handled above) — gated, UNCHANGED.
    if (!isMint) {
      continue;
    }

    const mintId = `${txHash}_${logIndex}_${index}`;

    await context.db
      .insert(erc1155MintEvent)
      .values({
        id: mintId,
        collectionKey,
        tokenId,
        value: quantity,
        minter: minterLower as `0x${string}`,
        operator: operatorLower as `0x${string}`,
        timestamp,
        blockNumber: event.block.number,
        transactionHash: txHash as `0x${string}`,
        chainId,
      })
      .onConflictDoNothing();

    // Update CandiesInventory rollup.
    const inventoryId = `${contractAddress}_${tokenId}`;
    const existingInventory = await context.db.find(candiesInventory, {
      id: inventoryId,
    });

    if (existingInventory) {
      await context.db.update(candiesInventory, { id: inventoryId }).set({
        currentSupply: existingInventory.currentSupply + quantity,
        mintCount: existingInventory.mintCount + 1,
        lastMintTime: timestamp,
      });
    } else {
      await context.db
        .insert(candiesInventory)
        .values({
          id: inventoryId,
          contract: contractAddress as `0x${string}`,
          tokenId,
          currentSupply: quantity,
          mintCount: 1,
          lastMintTime: timestamp,
          chainId,
        })
        .onConflictDoNothing();
    }

    await recordAction(context, {
      id: mintId,
      actionType: "mint1155",
      actor: minterLower,
      primaryCollection: collectionKey,
      timestamp,
      chainId,
      txHash,
      logIndex,
      numeric1: quantity,
      context: {
        tokenId: tokenId.toString(),
        operator: operatorLower,
        contract: contractAddress,
        batchIndex: index,
      },
    });
  }
});
