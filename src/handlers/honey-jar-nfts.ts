/*
 * HoneyJar NFT Event Handlers
 * Handles NFT transfers, mints, burns, and cross-chain tracking
 */

import {
  indexer,
  type CollectionStat,
  type GlobalCollectionStat,
  type Holder,
  type Mint,
  type Token,
  type Transfer,
  type UserBalance,
} from "envio";

import {
  ZERO_ADDRESS,
  BERACHAIN_TESTNET_ID,
  PROXY_CONTRACTS,
  ADDRESS_TO_COLLECTION,
  COLLECTION_TO_GENERATION,
  HOME_CHAIN_IDS,
} from "./constants";

/**
 * Main transfer handler for all HoneyJar NFT contracts
 */
export async function handleTransfer(
  event: any,
  context: any,
  collectionOverride?: string
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
    chainId
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
  if ((context as any).isPreload) return;

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
    chainId
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
    chainId
  );

  // Update global collection statistics
  await updateGlobalCollectionStat(context, collection, timestamp);
}

/**
 * Handles NFT mint events
 */
async function handleMint(
  event: any,
  context: any,
  collection: string,
  to: string,
  tokenId: any,
  timestamp: bigint
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

/**
 * Handles NFT burn events
 */
async function handleBurn(
  context: any,
  collection: string,
  tokenId: any,
  chainId: number
) {
  const tokenIdStr = `${collection}_${chainId}_${tokenId}`;
  const token = await context.Token.get(tokenIdStr);
  if (token) {
    // Create updated token object (immutable update)
    const updatedToken = {
      ...token,
      isBurned: true,
      owner: ZERO_ADDRESS,
    };
    context.Token.set(updatedToken);
  }
}

/**
 * Updates token ownership records
 */
async function updateTokenOwnership(
  context: any,
  collection: string,
  tokenId: any,
  from: string,
  to: string,
  timestamp: bigint,
  chainId: number
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
      mintedAt: from.toLowerCase() === ZERO_ADDRESS.toLowerCase() ? timestamp : BigInt(0),
      lastTransferTime: timestamp,
    };
  } else {
    // Create updated token object (immutable update)
    token = {
      ...token,
      owner: to.toLowerCase(),
      isBurned: to.toLowerCase() === ZERO_ADDRESS.toLowerCase(),
      lastTransferTime: timestamp,
    };
  }

  context.Token.set(token);
}

/**
 * Updates holder balance records
 * Now accepts pre-loaded holders to avoid duplicate queries
 */
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
  chainId: number
): Promise<{ fromHolder: any | null; toHolder: any | null }> {
  const isMint = fromLower === ZERO_ADDRESS.toLowerCase();
  const isBurn = toLower === ZERO_ADDRESS.toLowerCase();

  // Update 'from' holder (if not zero address)
  if (!isMint && fromHolder) {
    if (fromHolder.balance > 0) {
      // Create updated holder object (immutable update)
      const updatedFromHolder = {
        ...fromHolder,
        balance: fromHolder.balance - 1,
        lastActivityTime: timestamp,
      };
      context.Holder.set(updatedFromHolder);
      fromHolder = updatedFromHolder; // Update reference for caller
    }

    // Update user balance
    await updateUserBalance(
      context,
      fromLower,
      generation,
      chainId,
      -1,
      false,
      timestamp
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

    // Create updated holder object (immutable update)
    const updatedToHolder = {
      ...toHolder,
      balance: toHolder.balance + 1,
      lastActivityTime: timestamp,
      totalMinted: isMint ? toHolder.totalMinted + 1 : toHolder.totalMinted,
      firstMintTime: isMint && !toHolder.firstMintTime ? timestamp : toHolder.firstMintTime,
    };

    context.Holder.set(updatedToHolder);
    toHolder = updatedToHolder; // Update reference for caller

    // Update user balance
    await updateUserBalance(
      context,
      toLower,
      generation,
      chainId,
      1,
      isMint,
      timestamp
    );
  }

  return { fromHolder, toHolder };
}

/**
 * Updates user balance across all chains
 */
async function updateUserBalance(
  context: any,
  address: string,
  generation: number,
  chainId: number,
  balanceDelta: number,
  isMint: boolean,
  timestamp: bigint
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

  // Update balances based on chain
  const homeChainId = HOME_CHAIN_IDS[generation];

  // Create updated user balance object (immutable update)
  const updatedUserBalance = {
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

/**
 * Updates collection statistics
 * Now accepts pre-loaded holders to avoid duplicate queries
 */
async function updateCollectionStats(
  context: any,
  collection: string,
  fromLower: string,
  toLower: string,
  fromHolder: any | null,
  toHolder: any | null,
  timestamp: bigint,
  chainId: number
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

  // Update unique holders count based on transfer
  // We track this incrementally using the pre-loaded holders
  let uniqueHoldersAdjustment = 0;

  // If this is a transfer TO a new holder
  // Note: toHolder.balance is BEFORE the transfer, so balance === 0 means new holder
  if (!isBurn && toHolder && toHolder.balance === 0) {
    uniqueHoldersAdjustment += 1;
  }

  // If this is a transfer FROM a holder that will become empty
  // Note: fromHolder.balance is BEFORE the transfer, so balance === 1 means will be empty
  if (!isMint && fromHolder && fromHolder.balance === 1) {
    uniqueHoldersAdjustment -= 1;
  }

  // Create updated stats object (immutable update)
  const updatedStats = {
    ...stats,
    totalSupply: isMint ? stats.totalSupply + 1 : isBurn ? stats.totalSupply - 1 : stats.totalSupply,
    totalMinted: isMint ? stats.totalMinted + 1 : stats.totalMinted,
    totalBurned: isBurn ? stats.totalBurned + 1 : stats.totalBurned,
    lastMintTime: isMint ? timestamp : stats.lastMintTime,
    uniqueHolders: Math.max(0, stats.uniqueHolders + uniqueHoldersAdjustment),
  };

  context.CollectionStat.set(updatedStats);
}

/**
 * Updates global collection statistics across all chains
 */
export async function updateGlobalCollectionStat(
  context: any,
  collection: string,
  timestamp: bigint
) {
  const generation = COLLECTION_TO_GENERATION[collection] ?? -1;
  if (generation < 0) return;

  const homeChainId = HOME_CHAIN_IDS[generation];
  const proxyAddress = PROXY_CONTRACTS[collection]?.toLowerCase();

  // For now, we'll skip aggregating from all chains
  // This would require maintaining running totals in the global stat itself
  // TODO: Implement incremental updates to global stats
  return;

  // Implementation removed due to getMany limitations
  // This functionality would need to be handled differently in Envio
  // Consider using a separate aggregation service or maintaining running totals
}

// Handler registrations for each contract
indexer.onEvent(
  { contract: "HoneyJar", event: "Transfer" },
  async ({ event, context }) => {
    await handleTransfer(event, context);
  }
);

indexer.onEvent(
  { contract: "Honeycomb", event: "Transfer" },
  async ({ event, context }) => {
    await handleTransfer(event, context);
  }
);

indexer.onEvent(
  { contract: "HoneyJar2Eth", event: "Transfer" },
  async ({ event, context }) => {
    await handleTransfer(event, context, "HoneyJar2");
  }
);

indexer.onEvent(
  { contract: "HoneyJar3Eth", event: "Transfer" },
  async ({ event, context }) => {
    await handleTransfer(event, context, "HoneyJar3");
  }
);

indexer.onEvent(
  { contract: "HoneyJar4Eth", event: "Transfer" },
  async ({ event, context }) => {
    await handleTransfer(event, context, "HoneyJar4");
  }
);

indexer.onEvent(
  { contract: "HoneyJar5Eth", event: "Transfer" },
  async ({ event, context }) => {
    await handleTransfer(event, context, "HoneyJar5");
  }
);