import { indexer } from "envio";
import type {
  EvmOnEventContext,
  MiberaStakedToken as MiberaStakedTokenEntity,
  MiberaStaker as MiberaStakerEntity,
} from "envio";

import { ZERO_ADDRESS } from "./constants";
import { STAKING_CONTRACT_KEYS } from "./mibera-staking/constants";

const ZERO = ZERO_ADDRESS.toLowerCase();

/**
 * Handles Mibera NFT transfers to/from PaddleFi and Jiko staking contracts
 * Deposits: Transfer(user, stakingContract, tokenId)
 * Withdrawals: Transfer(stakingContract, user, tokenId)
 */
indexer.onEvent({ contract: "MiberaStaking", event: "Transfer" },
  async ({ event, context }) => {
    const from = event.params.from.toLowerCase();
    const to = event.params.to.toLowerCase();
    const tokenId = event.params.tokenId;
    const chainId = event.chainId;
    const txHash = event.transaction.hash;
    const blockNumber = BigInt(event.block.number);
    const timestamp = BigInt(event.block.timestamp);

    // Check if this is a deposit (transfer TO a staking contract)
    const depositContractKey = STAKING_CONTRACT_KEYS[to];
    if (depositContractKey && from !== ZERO) {
      await handleDeposit({
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
      return;
    }

    // Check if this is a withdrawal (transfer FROM a staking contract)
    const withdrawContractKey = STAKING_CONTRACT_KEYS[from];
    if (withdrawContractKey && to !== ZERO) {
      await handleWithdrawal({
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
      return;
    }

    // Not a staking-related transfer, ignore
  }
);

interface DepositArgs {
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

async function handleDeposit({
  context,
  stakingContract,
  stakingContractAddress,
  userAddress,
  tokenId,
  chainId,
  txHash,
  blockNumber,
  timestamp,
}: DepositArgs) {
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

interface WithdrawalArgs {
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

async function handleWithdrawal({
  context,
  stakingContract,
  stakingContractAddress,
  userAddress,
  tokenId,
  chainId,
  txHash,
  blockNumber,
  timestamp,
}: WithdrawalArgs) {
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
