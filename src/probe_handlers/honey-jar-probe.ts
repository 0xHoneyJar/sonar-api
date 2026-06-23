/*
 * Envio 3.2.1 DEPLOY-PATH PROBE — HoneyJar NFT Transfer handler (Optimism only)
 *
 * Purpose: prove that a 3.2.1-ported `indexer.onEvent` handler LOADS + INDEXES on
 * Envio Cloud (envio 3.2.1) without the alpha.17 `from "generated"` crash-loop.
 *
 * This is a faithful port of src/handlers/honey-jar-nfts.ts (the alpha.17 original)
 * to the 3.2.1 runtime API. The entity read/write logic (context.Entity.get/set) is
 * preserved verbatim — only the import surface + handler-registration surface changed:
 *
 *   alpha.17                                  3.2.1
 *   --------                                  -----
 *   import { Transfer, ... } from "generated" import { type Transfer, ... } from "envio"
 *   import { HoneyJar } from "generated"      (gone — contract is named in onEvent)
 *   HoneyJar.Transfer.handler(cb)             indexer.onEvent({contract,event}, cb)
 *   context.Entity.get/set                    context.Entity.get/set  (UNCHANGED)
 *
 * Constants are inlined here (rather than imported from src/handlers/constants.ts) so
 * this probe directory is fully self-contained and the 3.2.1 handler auto-glob
 * (config `handlers: src/probe_handlers`) only ever touches THIS file.
 */

import {
  indexer,
  type CollectionStat,
  type Holder,
  type Mint,
  type Token,
  type Transfer,
  type UserBalance,
} from "envio";

// ---------------------------------------------------------------------------
// Constants (inlined subset of src/handlers/constants.ts — Optimism / HoneyJar4)
// ---------------------------------------------------------------------------
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BERACHAIN_TESTNET_ID = 80094;

// Only the Optimism HoneyJar4 entry is needed for this probe.
const ADDRESS_TO_COLLECTION: Record<string, string> = {
  "0xe1d16cc75c9f39a2e0f5131eb39d4b634b23f301": "HoneyJar4", // Optimism HoneyJar4
};

const COLLECTION_TO_GENERATION: Record<string, number> = {
  HoneyJar4: 4,
};

const HOME_CHAIN_IDS: Record<number, number> = {
  4: 10, // Gen 4 — Optimism
};

// ---------------------------------------------------------------------------
// Core transfer logic (ported verbatim from honey-jar-nfts.ts handleTransfer)
// ---------------------------------------------------------------------------
async function handleTransfer(
  event: any,
  context: any,
  collectionOverride?: string,
) {
  const { from, to, tokenId } = event.params;
  const contractAddress = event.srcAddress.toLowerCase();
  const collection =
    collectionOverride || ADDRESS_TO_COLLECTION[contractAddress] || "Unknown";
  const generation = COLLECTION_TO_GENERATION[collection] ?? -1;
  const timestamp = BigInt(event.block.timestamp);
  const chainId = event.chainId;

  // Skip unknown collections
  if (generation < 0) return;

  // Create transfer record
  const transferId = `${event.transaction.hash}_${event.logIndex}`;
  const transfer: Transfer = {
    id: transferId,
    tokenId: BigInt(tokenId.toString()),
    from: from.toLowerCase(),
    to: to.toLowerCase(),
    timestamp,
    blockNumber: BigInt(event.block.number),
    transactionHash: event.transaction.hash,
    collection,
    chainId,
  };

  context.Transfer.set(transfer);

  // Handle mint (from zero address)
  if (from.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    await handleMint(event, context, collection, to, tokenId, timestamp);
  }

  // Handle burn (to zero address)
  if (to.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    await handleBurn(context, collection, tokenId, chainId);
  }

  // Update token ownership
  await updateTokenOwnership(
    context,
    collection,
    tokenId,
    from,
    to,
    timestamp,
    chainId,
  );

  // Load holders once to avoid duplicate queries — batch reads for preload
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const fromHolderId = `${collection}_${chainId}_${fromLower}`;
  const toHolderId = `${collection}_${chainId}_${toLower}`;

  // Batch holder reads with Promise.all for preload cache priming
  const [fromHolder, toHolder] = await Promise.all([
    fromLower !== ZERO_ADDRESS.toLowerCase()
      ? context.Holder.get(fromHolderId)
      : Promise.resolve(null),
    toLower !== ZERO_ADDRESS.toLowerCase()
      ? context.Holder.get(toHolderId)
      : Promise.resolve(null),
  ]);

  // Skip writes during preload — reads above prime the batch cache
  if (context.isPreload) return;

  // Update holder balances (returns updated holders)
  const updatedHolders = await updateHolderBalances(
    context,
    collection,
    fromHolder,
    toHolder,
    fromHolderId,
    toHolderId,
    fromLower,
    toLower,
    generation,
    timestamp,
    chainId,
  );

  // Update collection statistics (uses updated holders)
  await updateCollectionStats(
    context,
    collection,
    fromLower,
    toLower,
    updatedHolders.fromHolder,
    updatedHolders.toHolder,
    timestamp,
    chainId,
  );
}

async function handleMint(
  event: any,
  context: any,
  collection: string,
  to: string,
  tokenId: any,
  timestamp: bigint,
) {
  const mintId = `${event.transaction.hash}_${event.logIndex}_mint`;
  const mint: Mint = {
    id: mintId,
    tokenId: BigInt(tokenId.toString()),
    to: to.toLowerCase(),
    timestamp,
    blockNumber: BigInt(event.block.number),
    transactionHash: event.transaction.hash,
    collection,
    chainId: event.chainId,
  };

  context.Mint.set(mint);
}

async function handleBurn(
  context: any,
  collection: string,
  tokenId: any,
  chainId: number,
) {
  const tokenIdStr = `${collection}_${chainId}_${tokenId}`;
  const token = await context.Token.get(tokenIdStr);
  if (token) {
    const updatedToken = {
      ...token,
      isBurned: true,
      owner: ZERO_ADDRESS,
    };
    context.Token.set(updatedToken);
  }
}

async function updateTokenOwnership(
  context: any,
  collection: string,
  tokenId: any,
  from: string,
  to: string,
  timestamp: bigint,
  chainId: number,
) {
  const tokenIdStr = `${collection}_${chainId}_${tokenId}`;
  let token = await context.Token.get(tokenIdStr);

  if (!token) {
    token = {
      id: tokenIdStr,
      collection,
      chainId,
      tokenId: BigInt(tokenId.toString()),
      owner: to.toLowerCase(),
      isBurned: to.toLowerCase() === ZERO_ADDRESS.toLowerCase(),
      mintedAt:
        from.toLowerCase() === ZERO_ADDRESS.toLowerCase() ? timestamp : BigInt(0),
      lastTransferTime: timestamp,
    };
  } else {
    token = {
      ...token,
      owner: to.toLowerCase(),
      isBurned: to.toLowerCase() === ZERO_ADDRESS.toLowerCase(),
      lastTransferTime: timestamp,
    };
  }

  context.Token.set(token);
}

async function updateHolderBalances(
  context: any,
  collection: string,
  fromHolder: any | null,
  toHolder: any | null,
  fromHolderId: string,
  toHolderId: string,
  fromLower: string,
  toLower: string,
  generation: number,
  timestamp: bigint,
  chainId: number,
): Promise<{ fromHolder: any | null; toHolder: any | null }> {
  const isMint = fromLower === ZERO_ADDRESS.toLowerCase();
  const isBurn = toLower === ZERO_ADDRESS.toLowerCase();

  // Update 'from' holder (if not zero address)
  if (!isMint && fromHolder) {
    if (fromHolder.balance > 0) {
      const updatedFromHolder = {
        ...fromHolder,
        balance: fromHolder.balance - 1,
        lastActivityTime: timestamp,
      };
      context.Holder.set(updatedFromHolder);
      fromHolder = updatedFromHolder;
    }

    await updateUserBalance(
      context,
      fromLower,
      generation,
      chainId,
      -1,
      false,
      timestamp,
    );
  }

  // Update 'to' holder (if not zero address)
  if (!isBurn) {
    if (!toHolder) {
      toHolder = {
        id: toHolderId,
        address: toLower,
        balance: 0,
        totalMinted: 0,
        lastActivityTime: timestamp,
        firstMintTime: isMint ? timestamp : undefined,
        collection,
        chainId,
      };
    }

    const updatedToHolder = {
      ...toHolder,
      balance: toHolder.balance + 1,
      lastActivityTime: timestamp,
      totalMinted: isMint ? toHolder.totalMinted + 1 : toHolder.totalMinted,
      firstMintTime:
        isMint && !toHolder.firstMintTime ? timestamp : toHolder.firstMintTime,
    };

    context.Holder.set(updatedToHolder);
    toHolder = updatedToHolder;

    await updateUserBalance(
      context,
      toLower,
      generation,
      chainId,
      1,
      isMint,
      timestamp,
    );
  }

  return { fromHolder, toHolder };
}

async function updateUserBalance(
  context: any,
  address: string,
  generation: number,
  chainId: number,
  balanceDelta: number,
  isMint: boolean,
  timestamp: bigint,
) {
  const userBalanceId = `${generation}_${address}`;
  let userBalance = await context.UserBalance.get(userBalanceId);

  if (!userBalance) {
    userBalance = {
      id: userBalanceId,
      address,
      generation,
      balanceHomeChain: 0,
      balanceEthereum: 0,
      balanceBerachain: 0,
      balanceTotal: 0,
      mintedHomeChain: 0,
      mintedEthereum: 0,
      mintedBerachain: 0,
      mintedTotal: 0,
      lastActivityTime: timestamp,
      firstMintTime: isMint ? timestamp : undefined,
    };
  }

  const homeChainId = HOME_CHAIN_IDS[generation];

  const updatedUserBalance: UserBalance = {
    ...userBalance,
    balanceHomeChain:
      chainId === homeChainId
        ? Math.max(0, userBalance.balanceHomeChain + balanceDelta)
        : userBalance.balanceHomeChain,
    balanceEthereum:
      chainId === 1
        ? Math.max(0, userBalance.balanceEthereum + balanceDelta)
        : userBalance.balanceEthereum,
    balanceBerachain:
      chainId === BERACHAIN_TESTNET_ID
        ? Math.max(0, userBalance.balanceBerachain + balanceDelta)
        : userBalance.balanceBerachain,
    balanceTotal: Math.max(0, userBalance.balanceTotal + balanceDelta),
    mintedHomeChain:
      chainId === homeChainId && isMint
        ? userBalance.mintedHomeChain + 1
        : userBalance.mintedHomeChain,
    mintedEthereum:
      chainId === 1 && isMint
        ? userBalance.mintedEthereum + 1
        : userBalance.mintedEthereum,
    mintedBerachain:
      chainId === BERACHAIN_TESTNET_ID && isMint
        ? userBalance.mintedBerachain + 1
        : userBalance.mintedBerachain,
    mintedTotal: isMint ? userBalance.mintedTotal + 1 : userBalance.mintedTotal,
    firstMintTime:
      isMint && !userBalance.firstMintTime
        ? timestamp
        : userBalance.firstMintTime,
    lastActivityTime: timestamp,
  };

  context.UserBalance.set(updatedUserBalance);
}

async function updateCollectionStats(
  context: any,
  collection: string,
  fromLower: string,
  toLower: string,
  fromHolder: any | null,
  toHolder: any | null,
  timestamp: bigint,
  chainId: number,
) {
  const statsId = `${collection}_${chainId}`;
  let stats = await context.CollectionStat.get(statsId);

  if (!stats) {
    stats = {
      id: statsId,
      collection,
      totalSupply: 0,
      totalMinted: 0,
      totalBurned: 0,
      uniqueHolders: 0,
      lastMintTime: undefined,
      chainId,
    };
  }

  const isMint = fromLower === ZERO_ADDRESS.toLowerCase();
  const isBurn = toLower === ZERO_ADDRESS.toLowerCase();

  let uniqueHoldersAdjustment = 0;

  // balance is BEFORE the transfer: 0 ⇒ new holder
  if (!isBurn && toHolder && toHolder.balance === 0) {
    uniqueHoldersAdjustment += 1;
  }
  // balance is BEFORE the transfer: 1 ⇒ will be empty
  if (!isMint && fromHolder && fromHolder.balance === 1) {
    uniqueHoldersAdjustment -= 1;
  }

  const updatedStats: CollectionStat = {
    ...stats,
    totalSupply: isMint
      ? stats.totalSupply + 1
      : isBurn
        ? stats.totalSupply - 1
        : stats.totalSupply,
    totalMinted: isMint ? stats.totalMinted + 1 : stats.totalMinted,
    totalBurned: isBurn ? stats.totalBurned + 1 : stats.totalBurned,
    lastMintTime: isMint ? timestamp : stats.lastMintTime,
    uniqueHolders: Math.max(0, stats.uniqueHolders + uniqueHoldersAdjustment),
  };

  context.CollectionStat.set(updatedStats);
}

// ---------------------------------------------------------------------------
// 3.2.1 handler registration — the load-bearing API change being probed.
// alpha.17: `HoneyJar.Transfer.handler(cb)` (HoneyJar from "generated")
// 3.2.1:    `indexer.onEvent({ contract, event }, cb)` (contract named by string)
// ---------------------------------------------------------------------------
indexer.onEvent(
  { contract: "HoneyJar", event: "Transfer" },
  async ({ event, context }) => {
    await handleTransfer(event, context);
  },
);
