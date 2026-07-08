/**
 * Mibera Collection Transfer Handler
 *
 * Single source of truth for all mibera tracking:
 * - TrackedHolder (for hold verification in missions)
 * - MiberaTransfer (activity feed)
 * - MintActivity (unified activity feed with amountPaid)
 * - NftBurn/NftBurnStats (burn tracking)
 * - MiberaStakedToken/MiberaStaker (staking tracking)
 *
 * This handler was consolidated to avoid conflicts with TrackedErc721 handler
 * which was preventing TrackedHolder entries from being created.
 */

import {
  indexer,
  type EvmOnEventContext,
  type MiberaTransfer,
  type MintActivity,
  type NftBurn,
  type NftBurnStats,
  type TrackedHolder as TrackedHolderEntity,
  type Token as TokenEntity,
  type MiberaStakedToken as MiberaStakedTokenEntity,
  type MiberaStaker as MiberaStakerEntity,
} from "envio";
import { recordAction } from "../lib/actions";
import { publishMintEvent } from "../lib/events-publisher";
import { isMintFromZero, isBurnTransfer, isBurnAddress } from "../lib/mint-detection";
import { BERACHAIN_ID, ZERO_ADDRESS } from "./constants";
import { STAKING_CONTRACT_KEYS } from "./mibera-staking/constants";

const MIBERA_COLLECTION_ADDRESS = "0x6666397dfe9a8c469bf65dc744cb1c733416c420";
const MIBERA_COLLECTION_KEY = "mibera";
const ZERO = ZERO_ADDRESS.toLowerCase();

/**
 * Handle Transfer - Track all NFT transfers including mints, burns, and holder balances
 * Event: Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
 */
indexer.onEvent(
  { contract: "MiberaCollection", event: "Transfer" },
  async ({ event, context }) => {
    const timestamp = BigInt(event.block.timestamp);
    const from = event.params.from.toLowerCase();
    const to = event.params.to.toLowerCase();
    const tokenId = event.params.tokenId;
    const txHash = event.transaction.hash;
    const blockNumber = BigInt(event.block.number);
    const logIndex = Number(event.logIndex);

    const isMint = isMintFromZero(from);
    const isBurn = isBurnTransfer(from, to);

    // Preload: prime holder reads + burn stats
    if (from !== ZERO && !isBurnAddress(to)) {
      const fromHolderId = `${MIBERA_COLLECTION_ADDRESS}_${BERACHAIN_ID}_${from}`;
      const toHolderId = `${MIBERA_COLLECTION_ADDRESS}_${BERACHAIN_ID}_${to}`;
      await Promise.all([
        context.TrackedHolder.get(fromHolderId),
        context.TrackedHolder.get(toHolderId),
      ]);
    }
    if (isBurn) {
      const statsId = `${BERACHAIN_ID}_${MIBERA_COLLECTION_KEY}`;
      await context.NftBurnStats.get(statsId);
    }

    // Skip writes during preload
    if ((context as any).isPreload) return;

    // Get transaction value (BERA paid) for mints
    // Cast to `any` required because Envio's generated Transaction type doesn't
    // include `value` by default. The field is available at runtime when
    // `field_selection.transaction.value = true` is set in config.yaml.
    const txValue = (event.transaction as any).value;
    const amountPaid = txValue ? BigInt(txValue.toString()) : 0n;

    // =========================================================================
    // 0. Per-token current ownership (Token entity) — FR-2 / #153 (ported from
    // cycle/sonar-belt-factory e58a51c). Mirrors the TrackedHolder count below so
    // Token{owner} reconciles with TrackedHolder.tokenCount. For staking deposits
    // the TrackedHolder count is NOT decremented (staked NFTs still count as
    // held), so the effective owner stays the user (`from`), not the staking
    // contract. On burn, owner=ZERO + isBurned=true.
    // =========================================================================
    const depositContractKeyForOwner = STAKING_CONTRACT_KEYS[to];
    const isStakingDeposit = Boolean(depositContractKeyForOwner) && from !== ZERO;
    const effectiveOwner = isStakingDeposit ? from : to;
    await updateTokenOwnership({
      context,
      tokenId,
      from,
      effectiveOwner,
      timestamp,
    });

    // =========================================================================
    // 1. Create MiberaTransfer record (activity feed)
    // =========================================================================
    const transferId = `${txHash}_${logIndex}`;
    const transfer: MiberaTransfer = {
      id: transferId,
      from,
      to,
      tokenId,
      isMint,
      timestamp,
      blockNumber,
      transactionHash: txHash,
      chainId: BERACHAIN_ID,
    };
    context.MiberaTransfer.set(transfer);

    // =========================================================================
    // 2. Handle mints - MintActivity + mint action
    // =========================================================================
    if (isMint) {
      const mintActivityId = `${txHash}_${tokenId}_${to}_MINT`;
      const mintActivity: MintActivity = {
        id: mintActivityId,
        user: to,
        contract: MIBERA_COLLECTION_ADDRESS,
        tokenStandard: "ERC721",
        tokenId,
        quantity: 1n,
        amountPaid,
        activityType: "MINT",
        timestamp,
        blockNumber,
        transactionHash: txHash,
        operator: undefined,
        chainId: BERACHAIN_ID,
      };
      context.MintActivity.set(mintActivity);

      recordAction(context, {
        id: `${txHash}_${logIndex}_mint`,
        actionType: "mint",
        actor: to,
        primaryCollection: MIBERA_COLLECTION_KEY,
        timestamp,
        chainId: BERACHAIN_ID,
        txHash,
        logIndex,
        numeric1: 1n,
        context: {
          tokenId: tokenId.toString(),
          contract: MIBERA_COLLECTION_ADDRESS,
          amountPaid: amountPaid.toString(),
        },
      });

      // Events-pillar v1: publish main Mibera ERC-721 mint envelope on NATS.
      // Subject: nft.mint.detected.mibera-collection.v1. Fail-soft.
      await publishMintEvent({
        log: context.log,
        collectionSlug: "mibera-collection",
        payload: {
          chain_id: BERACHAIN_ID,
          contract: MIBERA_COLLECTION_ADDRESS,
          token_id: tokenId.toString(),
          minter: to,
          block_number: Number(blockNumber),
          transaction_hash: txHash,
          timestamp: new Date(Number(timestamp) * 1000).toISOString(),
        },
      });
    }

    // =========================================================================
    // 3. Handle burns - NftBurn + NftBurnStats + burn action
    // =========================================================================
    if (isBurn) {
      const burnId = `${txHash}_${logIndex}`;
      const burn: NftBurn = {
        id: burnId,
        collectionKey: MIBERA_COLLECTION_KEY,
        tokenId,
        from,
        timestamp,
        blockNumber,
        transactionHash: txHash,
        chainId: BERACHAIN_ID,
      };
      context.NftBurn.set(burn);

      // Update burn stats
      const statsId = `${BERACHAIN_ID}_${MIBERA_COLLECTION_KEY}`;
      const existingStats = await context.NftBurnStats.get(statsId);

      const stats: NftBurnStats = {
        id: statsId,
        chainId: BERACHAIN_ID,
        collectionKey: MIBERA_COLLECTION_KEY,
        totalBurned: (existingStats?.totalBurned ?? 0) + 1,
        uniqueBurners: existingStats?.uniqueBurners ?? 1, // TODO: Track unique burners properly
        lastBurnTime: timestamp,
        firstBurnTime: existingStats?.firstBurnTime ?? timestamp,
      };
      context.NftBurnStats.set(stats);

      recordAction(context, {
        id: `${txHash}_${logIndex}_burn`,
        actionType: "burn",
        actor: from,
        primaryCollection: MIBERA_COLLECTION_KEY,
        timestamp,
        chainId: BERACHAIN_ID,
        txHash,
        logIndex,
        numeric1: 1n,
        context: {
          tokenId: tokenId.toString(),
          contract: MIBERA_COLLECTION_ADDRESS,
          burnAddress: to,
        },
      });
    }

    // =========================================================================
    // 4. Handle regular transfers (non-mint, non-burn) - transfer action
    // =========================================================================
    if (!isMint && !isBurn) {
      recordAction(context, {
        id: `${txHash}_${logIndex}_transfer`,
        actionType: "transfer",
        actor: to, // Recipient is the actor
        primaryCollection: MIBERA_COLLECTION_KEY,
        timestamp,
        chainId: BERACHAIN_ID,
        txHash,
        logIndex,
        numeric1: BigInt(tokenId.toString()),
        context: {
          tokenId: tokenId.toString(),
          contract: MIBERA_COLLECTION_ADDRESS,
          from,
          to,
          isSecondary: true,
        },
      });
    }

    // =========================================================================
    // 5. Handle staking transfers (user <-> staking contract)
    // =========================================================================
    const depositContractKey = STAKING_CONTRACT_KEYS[to];
    const withdrawContractKey = STAKING_CONTRACT_KEYS[from];

    // Handle staking deposit (user -> staking contract)
    if (depositContractKey && from !== ZERO) {
      await handleMiberaStakeDeposit({
        context,
        stakingContract: depositContractKey,
        stakingContractAddress: to,
        userAddress: from,
        tokenId,
        chainId: BERACHAIN_ID,
        txHash,
        blockNumber,
        timestamp,
      });
      // Don't adjust holder counts - user still owns the NFT (it's staked)
      return;
    }

    // Handle staking withdrawal (staking contract -> user)
    if (withdrawContractKey && to !== ZERO) {
      await handleMiberaStakeWithdrawal({
        context,
        stakingContract: withdrawContractKey,
        stakingContractAddress: from,
        userAddress: to,
        tokenId,
        chainId: BERACHAIN_ID,
        txHash,
        blockNumber,
        timestamp,
      });
      // Don't adjust holder counts - they were never decremented on deposit
      return;
    }

    // =========================================================================
    // 6. Update TrackedHolder balances (for hold verification)
    // =========================================================================
    await adjustHolder({
      context,
      holderAddress: from,
      delta: -1,
      txHash,
      logIndex,
      timestamp,
    });

    await adjustHolder({
      context,
      holderAddress: to,
      delta: 1,
      txHash,
      logIndex,
      timestamp,
    });
  }
);

// =============================================================================
// TrackedHolder Management
// =============================================================================

interface AdjustHolderArgs {
  context: EvmOnEventContext;
  holderAddress: string;
  delta: number;
  txHash: string;
  logIndex: number;
  timestamp: bigint;
}

async function adjustHolder({
  context,
  holderAddress,
  delta,
  txHash,
  logIndex,
  timestamp,
}: AdjustHolderArgs) {
  if (delta === 0) return;

  const address = holderAddress.toLowerCase();
  if (address === ZERO || isBurnAddress(address)) return;

  const id = `${MIBERA_COLLECTION_ADDRESS}_${BERACHAIN_ID}_${address}`;
  const existing = await context.TrackedHolder.get(id);
  const currentCount = existing?.tokenCount ?? 0;
  const nextCount = currentCount + delta;

  const direction = delta > 0 ? "in" : "out";
  const tokenCount = Math.max(0, nextCount);

  // Record hold action for activity tracking
  recordAction(context, {
    id: `${txHash}_${logIndex}_${direction}`,
    actionType: "hold721",
    actor: address,
    primaryCollection: MIBERA_COLLECTION_KEY,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash,
    logIndex,
    numeric1: BigInt(tokenCount),
    context: {
      contract: MIBERA_COLLECTION_ADDRESS,
      collectionKey: MIBERA_COLLECTION_KEY,
      tokenCount,
      direction,
    },
  });

  // Delete holder if balance drops to 0
  if (nextCount <= 0) {
    if (existing) {
      context.TrackedHolder.deleteUnsafe(id);
    }
    return;
  }

  // Create or update holder
  const holder: TrackedHolderEntity = {
    id,
    contract: MIBERA_COLLECTION_ADDRESS,
    collectionKey: MIBERA_COLLECTION_KEY,
    chainId: BERACHAIN_ID,
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
  tokenId: bigint;
  from: string;
  effectiveOwner: string;
  timestamp: bigint;
}

/**
 * Maintain the per-token current-owner record (Token entity) for Mibera.
 * Keyed `${collection}_${chainId}_${tokenId}` to match the canonical Token
 * shape (src/lib/erc721-holders.ts, honey-jar-nfts.ts). Burns (owner is a burn
 * address) mark isBurned=true and set owner=ZERO.
 */
export async function updateTokenOwnership({
  context,
  tokenId,
  from,
  effectiveOwner,
  timestamp,
}: UpdateTokenOwnershipArgs) {
  const burned = isBurnAddress(effectiveOwner);
  const owner = burned ? ZERO : effectiveOwner;

  const tokenKey = `${MIBERA_COLLECTION_ADDRESS}_${BERACHAIN_ID}_${tokenId}`;
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
        collection: MIBERA_COLLECTION_ADDRESS,
        chainId: BERACHAIN_ID,
        tokenId,
        owner,
        isBurned: burned,
        mintedAt: from === ZERO ? timestamp : BigInt(0),
        lastTransferTime: timestamp,
      };

  context.Token.set(token);
}

// =============================================================================
// Staking Helpers
// =============================================================================

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
  const existingStakedToken = await context.MiberaStakedToken.get(stakedTokenId);

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
