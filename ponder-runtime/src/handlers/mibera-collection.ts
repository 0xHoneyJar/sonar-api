// ponder-runtime/src/handlers/mibera-collection.ts
//
// PORTED FROM: src/handlers/mibera-collection.ts (envio, source-of-truth)
// Contract: MiberaCollection ERC-721 (Berachain 80094, 0x6666...c420)
// T-A2.3 — CRITICAL handler, drives Mibera holder/transfer/mint/burn/staking
// truth across the entire blue belt.
//
// envio → ponder API translation summary:
//   - envio: MiberaCollection.Transfer.handler(async ({event, context}) => ...)
//     ponder: ponder.on("MiberaCollection:Transfer", async ({event, context}) => ...)
//   - envio's preload-then-write pattern (Promise.all([... TrackedHolder.get]))
//     followed by `if ((context as any).isPreload) return;` — REMOVED.
//     Ponder uses profiling-based prefetch internally (SDD §5.4 — REMOVES ~500 LOC).
//   - envio's event.transaction.value field-selection-trick replaced by
//     `event.transaction.value` (Ponder always exposes tx value, no config opt-in).
//   - envio: context.<Entity>.set(...) / .get(...) / .deleteUnsafe(...)
//     ponder: context.db.insert(table).values(...).onConflict*(...);
//             context.db.find(table, { id }); context.db.update(table, {id}).set(...);
//             context.db.delete(table, {id}).
//   - envio: publishMintEvent({...}) — fail-soft tail-call
//     ponder: reorgSafeEmit(context, buildMintEnvelope("mibera-collection", payload),
//                           event, chainId) — gated by isLiveEvent.
//
// 6 logical sections — identical to envio's structure (verbatim ports of
// each branch). Preserves the order-of-operations exactly so a side-by-side
// review against envio's source is a 1:1 line-by-line check.

import { ponder } from "ponder:registry";
import {
  miberaTransfer,
  mintActivity,
  nftBurn,
  nftBurnStats,
  trackedHolder,
  miberaStakedToken,
  miberaStaker,
  action,
} from "../../ponder.schema";
import { isLiveEvent } from "../lib/sync-status";
import { reorgSafeEmit } from "../lib/reorg-safe-emit";
import { buildMintEnvelope } from "../lib/nats-publisher";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BERACHAIN_ID = 80094;
const MIBERA_COLLECTION_ADDRESS = "0x6666397dfe9a8c469bf65dc744cb1c733416c420";
const MIBERA_COLLECTION_KEY = "mibera";
const ZERO = ZERO_ADDRESS.toLowerCase();

// Staking-contract address → key map. Verbatim port of envio's
// src/handlers/mibera-staking/constants.ts STAKING_CONTRACT_KEYS.
// Both PaddleFi vault AND Jiko are wired; transfers TO either address
// trigger a deposit, transfers FROM either trigger a withdrawal.
const STAKING_CONTRACT_KEYS: Record<string, string> = {
  // PaddleFi vault (Berachain)
  "0x242b7126f3c4e4f8cbd7f62571293e63e9b0a4e1": "paddlefi",
  // Jiko staking (Berachain) — verbatim from envio constants.ts:7
  "0x8778ca41cf0b5cd2f9967ae06b691daff11db246": "jiko",
};

const BURN_ADDRESSES = new Set<string>([
  ZERO_ADDRESS,
  "0x000000000000000000000000000000000000dead",
]);

function isMintFromZero(from: string): boolean {
  return from.toLowerCase() === ZERO;
}

function isBurnAddress(addr: string): boolean {
  return BURN_ADDRESSES.has(addr.toLowerCase());
}

function isBurnTransfer(from: string, to: string): boolean {
  return !isMintFromZero(from) && isBurnAddress(to);
}

ponder.on("MiberaCollection:Transfer", async ({ event, context }) => {
  const timestamp = event.block.timestamp;
  const from = event.args.from.toLowerCase();
  const to = event.args.to.toLowerCase();
  const tokenId = event.args.tokenId;
  const txHash = event.transaction.hash;
  const blockNumber = event.block.number;
  const logIndex = event.log.logIndex;

  const isMint = isMintFromZero(from);
  const isBurn = isBurnTransfer(from, to);

  // Get transaction value (BERA paid) for mints. envio needed a special
  // field_selection.transaction.value opt-in; Ponder exposes this by default.
  const txValue = (event.transaction as any).value;
  const amountPaid = typeof txValue === "bigint" ? txValue : 0n;

  // ──────────────────────────────────────────────────────────────────────
  // 1. Create MiberaTransfer record (activity feed)
  // ──────────────────────────────────────────────────────────────────────
  const transferId = `${txHash}_${logIndex}`;
  await context.db
    .insert(miberaTransfer)
    .values({
      id: transferId,
      from: from as `0x${string}`,
      to: to as `0x${string}`,
      tokenId,
      isMint,
      timestamp,
      blockNumber,
      transactionHash: txHash as `0x${string}`,
      chainId: BERACHAIN_ID,
    })
    .onConflictDoNothing();

  // ──────────────────────────────────────────────────────────────────────
  // 2. Handle mints — MintActivity + mint action + NATS publish
  // ──────────────────────────────────────────────────────────────────────
  if (isMint) {
    const mintActivityId = `${txHash}_${tokenId}_${to}_MINT`;
    await context.db
      .insert(mintActivity)
      .values({
        id: mintActivityId,
        user: to as `0x${string}`,
        contract: MIBERA_COLLECTION_ADDRESS as `0x${string}`,
        tokenStandard: "ERC721",
        tokenId,
        quantity: 1n,
        amountPaid,
        activityType: "MINT",
        timestamp,
        blockNumber,
        transactionHash: txHash as `0x${string}`,
        operator: null,
        chainId: BERACHAIN_ID,
      })
      .onConflictDoNothing();

    await context.db
      .insert(action)
      .values({
        id: `${txHash}_${logIndex}_mint`,
        actionType: "mint",
        actor: to as `0x${string}`,
        primaryCollection: MIBERA_COLLECTION_KEY,
        timestamp,
        chainId: BERACHAIN_ID,
        txHash: txHash as `0x${string}`,
        numeric1: 1n,
        numeric2: null,
        context: JSON.stringify({
          tokenId: tokenId.toString(),
          contract: MIBERA_COLLECTION_ADDRESS,
          amountPaid: amountPaid.toString(),
        }),
      })
      .onConflictDoNothing();

    // SDD §4.2 HISTORICAL SYNC GATE — gate every publish behind isLiveEvent.
    if (await isLiveEvent(event, context as any)) {
      const envelope = buildMintEnvelope("mibera-collection", {
        chain_id: BERACHAIN_ID,
        contract: MIBERA_COLLECTION_ADDRESS,
        token_id: tokenId.toString(),
        minter: to,
        block_number: Number(blockNumber),
        transaction_hash: txHash,
        timestamp: new Date(Number(timestamp) * 1000).toISOString(),
      });
      await reorgSafeEmit(context, envelope, event, BERACHAIN_ID);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // 3. Handle burns — NftBurn + NftBurnStats + burn action
  // ──────────────────────────────────────────────────────────────────────
  if (isBurn) {
    const burnId = `${txHash}_${logIndex}`;
    await context.db
      .insert(nftBurn)
      .values({
        id: burnId,
        collectionKey: MIBERA_COLLECTION_KEY,
        tokenId,
        from: from as `0x${string}`,
        timestamp,
        blockNumber,
        transactionHash: txHash as `0x${string}`,
        chainId: BERACHAIN_ID,
      })
      .onConflictDoNothing();

    const statsId = `${BERACHAIN_ID}_${MIBERA_COLLECTION_KEY}`;
    const existingStats = await context.db.find(nftBurnStats, { id: statsId });

    if (existingStats) {
      await context.db
        .update(nftBurnStats, { id: statsId })
        .set({
          totalBurned: existingStats.totalBurned + 1,
          lastBurnTime: timestamp,
          // firstBurnTime preserved (set on first burn only)
        });
    } else {
      await context.db
        .insert(nftBurnStats)
        .values({
          id: statsId,
          chainId: BERACHAIN_ID,
          collectionKey: MIBERA_COLLECTION_KEY,
          totalBurned: 1,
          uniqueBurners: 1, // PORT NOTE: envio also had TODO comment for unique burner tracking
          lastBurnTime: timestamp,
          firstBurnTime: timestamp,
        })
        .onConflictDoNothing();
    }

    await context.db
      .insert(action)
      .values({
        id: `${txHash}_${logIndex}_burn`,
        actionType: "burn",
        actor: from as `0x${string}`,
        primaryCollection: MIBERA_COLLECTION_KEY,
        timestamp,
        chainId: BERACHAIN_ID,
        txHash: txHash as `0x${string}`,
        numeric1: 1n,
        numeric2: null,
        context: JSON.stringify({
          tokenId: tokenId.toString(),
          contract: MIBERA_COLLECTION_ADDRESS,
          burnAddress: to,
        }),
      })
      .onConflictDoNothing();
  }

  // ──────────────────────────────────────────────────────────────────────
  // 4. Handle regular transfers (non-mint, non-burn) — transfer action
  // ──────────────────────────────────────────────────────────────────────
  if (!isMint && !isBurn) {
    await context.db
      .insert(action)
      .values({
        id: `${txHash}_${logIndex}_transfer`,
        actionType: "transfer",
        actor: to as `0x${string}`,
        primaryCollection: MIBERA_COLLECTION_KEY,
        timestamp,
        chainId: BERACHAIN_ID,
        txHash: txHash as `0x${string}`,
        numeric1: tokenId,
        numeric2: null,
        context: JSON.stringify({
          tokenId: tokenId.toString(),
          contract: MIBERA_COLLECTION_ADDRESS,
          from,
          to,
          isSecondary: true,
        }),
      })
      .onConflictDoNothing();
  }

  // ──────────────────────────────────────────────────────────────────────
  // 5. Handle staking transfers (user <-> staking contract)
  // ──────────────────────────────────────────────────────────────────────
  const depositContractKey = STAKING_CONTRACT_KEYS[to];
  const withdrawContractKey = STAKING_CONTRACT_KEYS[from];

  if (depositContractKey && from !== ZERO) {
    await handleStakeDeposit({
      context,
      stakingContract: depositContractKey,
      stakingContractAddress: to,
      userAddress: from,
      tokenId,
      txHash,
      blockNumber,
      timestamp,
    });
    // user still owns the staked NFT — DO NOT adjust holder count.
    return;
  }

  if (withdrawContractKey && to !== ZERO) {
    await handleStakeWithdrawal({
      context,
      stakingContract: withdrawContractKey,
      stakingContractAddress: from,
      userAddress: to,
      tokenId,
      txHash,
      blockNumber,
      timestamp,
    });
    // counts were never decremented on deposit — DO NOT adjust holder count.
    return;
  }

  // ──────────────────────────────────────────────────────────────────────
  // 6. Update TrackedHolder balances (for hold-verification missions)
  // ──────────────────────────────────────────────────────────────────────
  await adjustHolder({ context, holderAddress: from, delta: -1, txHash, logIndex, timestamp });
  await adjustHolder({ context, holderAddress: to, delta: 1, txHash, logIndex, timestamp });
});

// ──────────────────────────────────────────────────────────────────────────
// TrackedHolder management — mirrors envio's adjustHolder() helper exactly.
// ──────────────────────────────────────────────────────────────────────────

async function adjustHolder({
  context,
  holderAddress,
  delta,
  txHash,
  logIndex,
  timestamp,
}: {
  context: any;
  holderAddress: string;
  delta: number;
  txHash: string;
  logIndex: number;
  timestamp: bigint;
}): Promise<void> {
  if (delta === 0) return;
  const address = holderAddress.toLowerCase();
  if (address === ZERO || isBurnAddress(address)) return;

  const id = `${MIBERA_COLLECTION_ADDRESS}_${BERACHAIN_ID}_${address}`;
  const existing = await context.db.find(trackedHolder, { id });
  const currentCount = existing?.tokenCount ?? 0;
  const nextCount = currentCount + delta;

  const direction = delta > 0 ? "in" : "out";
  const tokenCountForAction = Math.max(0, nextCount);

  await context.db
    .insert(action)
    .values({
      id: `${txHash}_${logIndex}_${direction}`,
      actionType: "hold721",
      actor: address as `0x${string}`,
      primaryCollection: MIBERA_COLLECTION_KEY,
      timestamp,
      chainId: BERACHAIN_ID,
      txHash: txHash as `0x${string}`,
      numeric1: BigInt(tokenCountForAction),
      numeric2: null,
      context: JSON.stringify({
        contract: MIBERA_COLLECTION_ADDRESS,
        collectionKey: MIBERA_COLLECTION_KEY,
        tokenCount: tokenCountForAction,
        direction,
      }),
    })
    .onConflictDoNothing();

  if (nextCount <= 0) {
    // envio used deleteUnsafe; ponder's db.delete is safe-by-PK.
    if (existing) {
      await context.db.delete(trackedHolder, { id });
    }
    return;
  }

  if (existing) {
    await context.db.update(trackedHolder, { id }).set({ tokenCount: nextCount });
  } else {
    await context.db
      .insert(trackedHolder)
      .values({
        id,
        contract: MIBERA_COLLECTION_ADDRESS as `0x${string}`,
        collectionKey: MIBERA_COLLECTION_KEY,
        chainId: BERACHAIN_ID,
        address: address as `0x${string}`,
        tokenCount: nextCount,
      })
      .onConflictDoNothing();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Staking helpers — mirrors envio's handleMiberaStakeDeposit /
// handleMiberaStakeWithdrawal helpers exactly.
// ──────────────────────────────────────────────────────────────────────────

interface StakeArgs {
  context: any;
  stakingContract: string;
  stakingContractAddress: string;
  userAddress: string;
  tokenId: bigint;
  txHash: string;
  blockNumber: bigint;
  timestamp: bigint;
}

async function handleStakeDeposit({
  context,
  stakingContract,
  stakingContractAddress,
  userAddress,
  tokenId,
  txHash,
  blockNumber,
  timestamp,
}: StakeArgs): Promise<void> {
  const stakedTokenId = `${stakingContract}_${tokenId}`;
  await context.db
    .insert(miberaStakedToken)
    .values({
      id: stakedTokenId,
      stakingContract,
      contractAddress: stakingContractAddress as `0x${string}`,
      tokenId,
      owner: userAddress as `0x${string}`,
      isStaked: true,
      depositedAt: timestamp,
      depositTxHash: txHash as `0x${string}`,
      depositBlockNumber: blockNumber,
      withdrawnAt: null,
      withdrawTxHash: null,
      withdrawBlockNumber: null,
      chainId: BERACHAIN_ID,
    })
    .onConflictDoUpdate((_row: any) => ({
      // If a duplicate stake event arrives (reorg replay), preserve the
      // existing record — same id → idempotent.
      isStaked: true,
    }));

  const stakerId = `${stakingContract}_${userAddress}`;
  const existingStaker = await context.db.find(miberaStaker, { id: stakerId });

  if (existingStaker) {
    await context.db.update(miberaStaker, { id: stakerId }).set({
      currentStakedCount: existingStaker.currentStakedCount + 1,
      totalDeposits: existingStaker.totalDeposits + 1,
      lastActivityTime: timestamp,
    });
  } else {
    await context.db
      .insert(miberaStaker)
      .values({
        id: stakerId,
        stakingContract,
        contractAddress: stakingContractAddress as `0x${string}`,
        address: userAddress as `0x${string}`,
        currentStakedCount: 1,
        totalDeposits: 1,
        totalWithdrawals: 0,
        firstDepositTime: timestamp,
        lastActivityTime: timestamp,
        chainId: BERACHAIN_ID,
      })
      .onConflictDoNothing();
  }
}

async function handleStakeWithdrawal({
  context,
  stakingContract,
  userAddress,
  tokenId,
  txHash,
  blockNumber,
  timestamp,
}: StakeArgs): Promise<void> {
  const stakedTokenId = `${stakingContract}_${tokenId}`;
  const existingStakedToken = await context.db.find(miberaStakedToken, { id: stakedTokenId });

  if (existingStakedToken) {
    await context.db.update(miberaStakedToken, { id: stakedTokenId }).set({
      isStaked: false,
      withdrawnAt: timestamp,
      withdrawTxHash: txHash as `0x${string}`,
      withdrawBlockNumber: blockNumber,
    });
  }

  const stakerId = `${stakingContract}_${userAddress}`;
  const existingStaker = await context.db.find(miberaStaker, { id: stakerId });

  if (existingStaker) {
    await context.db.update(miberaStaker, { id: stakerId }).set({
      currentStakedCount: Math.max(0, existingStaker.currentStakedCount - 1),
      totalWithdrawals: existingStaker.totalWithdrawals + 1,
      lastActivityTime: timestamp,
    });
  }
}
