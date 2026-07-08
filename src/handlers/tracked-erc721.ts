import {
  indexer,
  type EvmOnEventContext,
  type TrackedHolder as TrackedHolderEntity,
  type Token as TokenEntity,
  type MiberaStakedToken as MiberaStakedTokenEntity,
  type MiberaStaker as MiberaStakerEntity,
} from "envio";

import { ZERO_ADDRESS } from "./constants";
import {
  TRACKED_ERC721_COLLECTION_KEYS,
  TRANSFER_TRACKED_COLLECTIONS,
} from "./tracked-erc721/constants";
import { STAKING_CONTRACT_KEYS } from "./mibera-staking/constants";
import { isMarketplaceAddress } from "./marketplaces/constants";
import { recordAction } from "../lib/actions";
import { isBurnAddress, isMintFromZero } from "../lib/mint-detection";

const ZERO = ZERO_ADDRESS.toLowerCase();

// Mibera NFT contract address (lowercase)
const MIBERA_CONTRACT = "0x6666397dfe9a8c469bf65dc744cb1c733416c420";

/** Structural shape of the Transfer event shared by TrackedErc721 + EthTrackedErc721 (identical ABI).
 *  Kept structural (not an envio per-contract event type) so ONE handler serves both registrations. */
type TrackedErc721TransferEvent = {
  srcAddress: string;
  chainId: number;
  logIndex: number | bigint;
  params: { from: string; to: string; tokenId: bigint };
  transaction: { hash: string };
  block: { timestamp: number | bigint; number: number | bigint };
};

/**
 * Shared Transfer handler. Registered below for the multi-chain `TrackedErc721` (OP/Base/Berachain)
 * AND the dedicated `EthTrackedErc721` (chain 1, Azuki). The dedicated ETH contract exists because
 * envio 3.2.1 does not fetch a single-address entry in the shared multi-chain contract on chain 1
 * (#120 / sprint-bug-192) — a dedicated contract closes the gap (Milady, a dedicated single-address
 * ETH contract, indexes fine). Exported so the mibera belt entry can mark it imported.
 */
export async function handleTrackedErc721Transfer(
  event: TrackedErc721TransferEvent,
  context: EvmOnEventContext,
): Promise<void> {
  const contractAddress = event.srcAddress.toLowerCase();
  const collectionKey =
    TRACKED_ERC721_COLLECTION_KEYS[contractAddress] ?? contractAddress;
  const from = event.params.from.toLowerCase();
  const to = event.params.to.toLowerCase();
  const tokenId = event.params.tokenId;
  const chainId = event.chainId;
  const txHash = event.transaction.hash;
  const logIndex = Number(event.logIndex);
  const timestamp = BigInt(event.block.timestamp);
  const blockNumber = BigInt(event.block.number);

  // Preload: prime holder reads for from and to
  if (from !== ZERO && to !== ZERO) {
    const fromId = `${contractAddress}_${chainId}_${from}`;
    const toId = `${contractAddress}_${chainId}_${to}`;
    await Promise.all([
      context.TrackedHolder.get(fromId),
      context.TrackedHolder.get(toId),
    ]);
  }

  // Skip writes during preload
  if ((context as any).isPreload) return;

  // Per-token current ownership (Token entity) — FR-2 / #153 (ported from
  // cycle/sonar-belt-factory e58a51c). Mirrors the TrackedHolder count below
  // so Token{owner} reconciles with TrackedHolder.tokenCount. Mibera main
  // (0x6666…) is NOT in this handler's address list, so `to` is always the
  // effective owner here. On burn (to a burn address) owner=ZERO + isBurned=true.
  await updateTokenOwnership({
    context,
    contractAddress,
    chainId,
    tokenId,
    from,
    to,
    timestamp,
  });

  // If this is a mint (from zero address), also create a mint action
  if (from === ZERO) {
    const mintActionId = `${txHash}_${logIndex}`;
    recordAction(context, {
      id: mintActionId,
      actionType: "mint",
      actor: to,
      primaryCollection: collectionKey.toLowerCase(),
      timestamp,
      chainId,
      txHash,
      logIndex,
      numeric1: 1n,
      context: {
        tokenId: tokenId.toString(),
        contract: contractAddress,
      },
    });
  }

  // If this is a burn (to zero or dead address), create a burn action
  if (isBurnAddress(to) && from !== ZERO) {
    const burnActionId = `${txHash}_${logIndex}_burn`;
    recordAction(context, {
      id: burnActionId,
      actionType: "burn",
      actor: from,
      primaryCollection: collectionKey.toLowerCase(),
      timestamp,
      chainId,
      txHash,
      logIndex,
      numeric1: 1n,
      context: {
        tokenId: tokenId.toString(),
        contract: contractAddress,
        burnAddress: to,
      },
    });
  }

  // Track transfers for specific collections (non-mint, non-burn transfers)
  if (
    TRANSFER_TRACKED_COLLECTIONS.has(collectionKey) &&
    from !== ZERO &&
    !isBurnAddress(to)
  ) {
    const transferActionId = `${txHash}_${logIndex}_transfer`;
    recordAction(context, {
      id: transferActionId,
      actionType: "transfer",
      actor: to, // Recipient is the actor (they received the NFT)
      primaryCollection: collectionKey.toLowerCase(),
      timestamp,
      chainId,
      txHash,
      logIndex,
      numeric1: BigInt(tokenId.toString()),
      context: {
        tokenId: tokenId.toString(),
        contract: contractAddress,
        from,
        to,
        isSecondary: true,
        viaMarketplace: isMarketplaceAddress(from) || isMarketplaceAddress(to),
      },
    });
  }

  // Check for Mibera staking transfers
  const isMibera = contractAddress === MIBERA_CONTRACT;
  const depositContractKey = STAKING_CONTRACT_KEYS[to];
  const withdrawContractKey = STAKING_CONTRACT_KEYS[from];

  // Handle Mibera staking deposit (user → staking contract)
  if (isMibera && depositContractKey && from !== ZERO) {
    await handleMiberaStakeDeposit({
      context,
      stakingContract: depositContractKey,
      stakingContractAddress: to,
      userAddress: from,
      tokenId,
      chainId,
      txHash,
      blockNumber,
      timestamp,
    });
    // Don't adjust holder counts - user still owns the NFT (it's staked)
    return;
  }

  // Handle Mibera staking withdrawal (staking contract → user)
  if (isMibera && withdrawContractKey && to !== ZERO) {
    await handleMiberaStakeWithdrawal({
      context,
      stakingContract: withdrawContractKey,
      stakingContractAddress: from,
      userAddress: to,
      tokenId,
      chainId,
      txHash,
      blockNumber,
      timestamp,
    });
    // Don't adjust holder counts - they were never decremented on deposit
    return;
  }

  // Normal transfer handling
  await adjustHolder({
    context,
    contractAddress,
    collectionKey,
    chainId,
    holderAddress: from,
    delta: -1,
    txHash,
    logIndex,
    timestamp,
    direction: "out",
  });

  await adjustHolder({
    context,
    contractAddress,
    collectionKey,
    chainId,
    holderAddress: to,
    delta: 1,
    txHash,
    logIndex,
    timestamp,
    direction: "in",
  });
}

// Register the shared handler for the multi-chain contract + the dedicated ETH contract (#120 fix).
indexer.onEvent(
  { contract: "TrackedErc721", event: "Transfer" },
  ({ event, context }) => handleTrackedErc721Transfer(event, context),
);
indexer.onEvent(
  { contract: "EthTrackedErc721", event: "Transfer" },
  ({ event, context }) => handleTrackedErc721Transfer(event, context),
);

interface AdjustHolderArgs {
  context: EvmOnEventContext;
  contractAddress: string;
  collectionKey: string;
  chainId: number;
  holderAddress: string;
  delta: number;
  txHash: string;
  logIndex: number;
  timestamp: bigint;
  direction: "in" | "out";
}

async function adjustHolder({
  context,
  contractAddress,
  collectionKey,
  chainId,
  holderAddress,
  delta,
  txHash,
  logIndex,
  timestamp,
  direction,
}: AdjustHolderArgs) {
  if (delta === 0) {
    return;
  }

  const address = holderAddress.toLowerCase();
  if (address === ZERO) {
    return;
  }

  const id = `${contractAddress}_${chainId}_${address}`;
  const existing = await context.TrackedHolder.get(id);
  const currentCount = existing?.tokenCount ?? 0;
  const nextCount = currentCount + delta;

  const actionId = `${txHash}_${logIndex}_${direction}`;
  const normalizedCollection = collectionKey.toLowerCase();
  const tokenCount = Math.max(0, nextCount);

  recordAction(context, {
    id: actionId,
    actionType: "hold721",
    actor: address,
    primaryCollection: normalizedCollection,
    timestamp,
    chainId,
    txHash,
    logIndex,
    numeric1: BigInt(tokenCount),
    context: {
      contract: contractAddress,
      collectionKey: normalizedCollection,
      tokenCount,
      direction,
    },
  });

  if (nextCount <= 0) {
    if (existing) {
      context.TrackedHolder.deleteUnsafe(id);
    }
    return;
  }

  const holder: TrackedHolderEntity = {
    id,
    contract: contractAddress,
    collectionKey,
    chainId,
    address,
    tokenCount: nextCount,
  };

  context.TrackedHolder.set(holder);
}

// =============================================================================
// Per-token current ownership (Token entity) — FR-2 / #153
// Ported from cycle/sonar-belt-factory e58a51c (population-only; no reconcile
// baggage). Exported for direct unit testing of the reconciliation invariant.
// =============================================================================

interface UpdateTokenOwnershipArgs {
  context: EvmOnEventContext;
  contractAddress: string;
  chainId: number;
  tokenId: bigint;
  from: string;
  to: string;
  timestamp: bigint;
}

/**
 * Maintain the per-token current-owner record (Token entity) for tracked
 * ERC-721 collections (Tarot + Fractures + lore + apdao_seat). Keyed
 * `${collection}_${chainId}_${tokenId}` to match the canonical Token shape
 * (src/lib/erc721-holders.ts). `collection` is the on-chain contract address
 * (lowercase), matching the TrackedHolder.contract field used downstream.
 * Burns (to a burn address) mark isBurned=true and set owner=ZERO.
 */
export async function updateTokenOwnership({
  context,
  contractAddress,
  chainId,
  tokenId,
  from,
  to,
  timestamp,
}: UpdateTokenOwnershipArgs) {
  const burned = isBurnAddress(to);
  const owner = burned ? ZERO : to;

  const tokenKey = `${contractAddress}_${chainId}_${tokenId}`;
  const existing = await context.Token.get(tokenKey);

  const token: TokenEntity = existing
    ? {
        ...existing,
        owner,
        isBurned: burned,
        lastTransferTime: timestamp,
      }
    : {
        id: tokenKey,
        collection: contractAddress,
        chainId,
        tokenId,
        owner,
        isBurned: burned,
        mintedAt: from === ZERO ? timestamp : BigInt(0),
        lastTransferTime: timestamp,
      };

  context.Token.set(token);
}

// Mibera staking helper types and functions

interface MiberaStakeArgs {
  context: EvmOnEventContext;
  stakingContract: string;
  stakingContractAddress: string;
  userAddress: string;
  tokenId: bigint;
  chainId: number;
  txHash: string;
  blockNumber: bigint;
  timestamp: bigint;
}

async function handleMiberaStakeDeposit({
  context,
  stakingContract,
  stakingContractAddress,
  userAddress,
  tokenId,
  chainId,
  txHash,
  blockNumber,
  timestamp,
}: MiberaStakeArgs) {
  // Create staked token record
  const stakedTokenId = `${stakingContract}_${tokenId}`;
  const stakedToken: MiberaStakedTokenEntity = {
    id: stakedTokenId,
    stakingContract,
    contractAddress: stakingContractAddress,
    tokenId,
    owner: userAddress,
    isStaked: true,
    depositedAt: timestamp,
    depositTxHash: txHash,
    depositBlockNumber: blockNumber,
    withdrawnAt: undefined,
    withdrawTxHash: undefined,
    withdrawBlockNumber: undefined,
    chainId,
  };
  context.MiberaStakedToken.set(stakedToken);

  // Update staker stats
  const stakerId = `${stakingContract}_${userAddress}`;
  const existingStaker = await context.MiberaStaker.get(stakerId);

  const staker: MiberaStakerEntity = existingStaker
    ? {
        ...existingStaker,
        currentStakedCount: existingStaker.currentStakedCount + 1,
        totalDeposits: existingStaker.totalDeposits + 1,
        lastActivityTime: timestamp,
      }
    : {
        id: stakerId,
        stakingContract,
        contractAddress: stakingContractAddress,
        address: userAddress,
        currentStakedCount: 1,
        totalDeposits: 1,
        totalWithdrawals: 0,
        firstDepositTime: timestamp,
        lastActivityTime: timestamp,
        chainId,
      };

  context.MiberaStaker.set(staker);
}

async function handleMiberaStakeWithdrawal({
  context,
  stakingContract,
  stakingContractAddress,
  userAddress,
  tokenId,
  chainId,
  txHash,
  blockNumber,
  timestamp,
}: MiberaStakeArgs) {
  // Update staked token record
  const stakedTokenId = `${stakingContract}_${tokenId}`;
  const existingStakedToken =
    await context.MiberaStakedToken.get(stakedTokenId);

  if (existingStakedToken) {
    const updatedStakedToken: MiberaStakedTokenEntity = {
      ...existingStakedToken,
      isStaked: false,
      withdrawnAt: timestamp,
      withdrawTxHash: txHash,
      withdrawBlockNumber: blockNumber,
    };
    context.MiberaStakedToken.set(updatedStakedToken);
  }

  // Update staker stats
  const stakerId = `${stakingContract}_${userAddress}`;
  const existingStaker = await context.MiberaStaker.get(stakerId);

  if (existingStaker) {
    const updatedStaker: MiberaStakerEntity = {
      ...existingStaker,
      currentStakedCount: Math.max(0, existingStaker.currentStakedCount - 1),
      totalWithdrawals: existingStaker.totalWithdrawals + 1,
      lastActivityTime: timestamp,
    };
    context.MiberaStaker.set(updatedStaker);
  }
}
