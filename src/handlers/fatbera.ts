import {
  AutomatedStake,
  BeaconDeposit,
  BlockRewardController,
  FatBeraDeposits,
  ValidatorDepositRouter,
  ValidatorWithdrawalModule,
  type FatBeraDeposit,
  type LatestValidatorDeposit,
  type LatestValidatorReward,
  type ValidatorBlockRewards,
  type ValidatorDeposits,
  type ValidatorWithdrawalTotals,
  type WithdrawalBatch,
  type WithdrawalFulfillment,
  type WithdrawalRequest,
  type handlerContext,
} from "generated";

import { recordAction } from "../lib/actions";
import {
  FATBERA_DEPOSIT_TRACKING_START_BLOCK,
  GENESIS_DEPOSIT,
  MAX_USERS_PER_BATCH,
  VALIDATOR_2_GENESIS_BALANCE,
  VALIDATOR_DEPOSIT_ROUTER_ADDRESS,
  VALIDATORS,
  WBERA_ADDRESS,
  calculateDirectDepositAssignments,
  calculateRewardSplit,
  calculateRouterRedistributionAssignments,
  getActiveValidators,
  predictWithdrawalBlock,
  toTimestamp,
} from "./fatbera-core";

const COLLECTION_KEY = "fatbera_deposit";
const BERACHAIN_CHAIN_ID = 80094;
const GWEI_TO_WEI = 1_000_000_000n;

function isTrackedValidatorPubkey(pubkey: string) {
  return VALIDATORS.find((validator) => validator.pubkey === pubkey.toLowerCase());
}

// --- Dual-write helpers: write to both history and singleton entities ---

function writeValidatorDeposit(
  context: handlerContext,
  record: ValidatorDeposits
): void {
  context.ValidatorDeposits.set(record);
  context.LatestValidatorDeposit.set({
    id: record.pubkey,
    pubkey: record.pubkey,
    blockHeight: record.blockHeight,
    timestamp: record.timestamp,
    depositAmount: record.depositAmount,
    totalDeposited: record.totalDeposited,
    depositCount: record.depositCount,
    outstandingFatBERA: record.outstandingFatBERA,
  });
}

function writeValidatorReward(
  context: handlerContext,
  record: ValidatorBlockRewards
): void {
  context.ValidatorBlockRewards.set(record);
  context.LatestValidatorReward.set({
    id: record.pubkey,
    pubkey: record.pubkey,
    blockHeight: record.blockHeight,
    totalBlockRewards: record.totalBlockRewards,
    timestamp: record.timestamp,
    nextTimestamp: record.nextTimestamp,
    baseRate: record.baseRate,
    rewardRate: record.rewardRate,
    rewardCount: record.rewardCount,
    stakerReward: record.stakerReward,
    validatorReward: record.validatorReward,
    totalStakerRewards: record.totalStakerRewards,
    totalValidatorRewards: record.totalValidatorRewards,
    outstandingStakerRewards: record.outstandingStakerRewards,
  });
}

async function getWithdrawalRequestsForBatch(
  context: handlerContext,
  batchId: string
): Promise<WithdrawalRequest[]> {
  return context.WithdrawalRequest.getWhere({ batch_id: { _eq: batchId } });
}

function buildValidatorDepositRecord(args: {
  pubkey: string;
  blockHeight: number;
  timestamp: Date;
  depositAmount: bigint;
  totalDeposited: bigint;
  depositCount: number;
  outstandingFatBERA: bigint;
  suffix?: string;
}): ValidatorDeposits {
  const idBase = `${args.blockHeight}_${args.pubkey}`;
  return {
    id: args.suffix ? `${idBase}_${args.suffix}` : idBase,
    pubkey: args.pubkey,
    blockHeight: args.blockHeight,
    timestamp: args.timestamp,
    depositAmount: args.depositAmount,
    totalDeposited: args.totalDeposited,
    depositCount: args.depositCount,
    outstandingFatBERA: args.outstandingFatBERA,
  };
}

export const handleFatBeraDeposit = FatBeraDeposits.Deposit.handler(
  async ({ event, context }) => {
    const { sender, owner, assets, shares } = event.params;

    if (assets === 0n && shares === 0n) {
      return;
    }

    const depositor = sender.toLowerCase();
    const recipient = owner.toLowerCase();
    const transactionFrom = event.transaction.from
      ? event.transaction.from.toLowerCase()
      : undefined;
    const transactionTo = (event.transaction as any).to
      ? String((event.transaction as any).to).toLowerCase()
      : undefined;
    const id = `${event.transaction.hash}_${event.logIndex}`;
    const timestamp = BigInt(event.block.timestamp);
    const blockHeight = event.block.number;

    // Preload: prime reads for validators we'll need
    let validatorDeposits: (LatestValidatorDeposit | undefined)[] = [];
    if (blockHeight >= FATBERA_DEPOSIT_TRACKING_START_BLOCK && transactionTo !== VALIDATOR_DEPOSIT_ROUTER_ADDRESS) {
      validatorDeposits = await Promise.all(
        getActiveValidators(blockHeight).map((v) =>
          context.LatestValidatorDeposit.get(v.pubkey)
        )
      );
    }

    // Skip writes and calculations during preload
    if ((context as any).isPreload) return;

    const deposit: FatBeraDeposit = {
      id,
      collectionKey: COLLECTION_KEY,
      depositor,
      recipient,
      amount: assets,
      shares,
      transactionFrom,
      timestamp,
      blockNumber: BigInt(blockHeight),
      transactionHash: event.transaction.hash,
      chainId: event.chainId,
    };
    context.FatBeraDeposit.set(deposit);

    recordAction(context, {
      id,
      actionType: "deposit",
      actor: depositor,
      primaryCollection: COLLECTION_KEY,
      timestamp,
      chainId: event.chainId,
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
      numeric1: assets,
      numeric2: shares,
      context: {
        recipient,
        transactionFrom,
        contract: event.srcAddress.toLowerCase(),
      },
    });

    if (blockHeight < FATBERA_DEPOSIT_TRACKING_START_BLOCK) {
      return;
    }

    if (transactionTo === VALIDATOR_DEPOSIT_ROUTER_ADDRESS) {
      return;
    }

    const activeValidators = getActiveValidators(blockHeight);
    const states = activeValidators
      .map((validatorInfo, i) => {
        const previousDeposit = validatorDeposits[i];
        if (!previousDeposit) return undefined;
        return {
          validatorInfo,
          totalDeposited: previousDeposit.totalDeposited,
          outstandingFatBERA: previousDeposit.outstandingFatBERA,
          previousDeposit,
        };
      })
      .filter((state): state is NonNullable<typeof state> => state !== undefined);

    const assignments = calculateDirectDepositAssignments({
      amount: assets,
      blockHeight,
      states,
    });

    for (const assignment of assignments) {
      if (assignment.shareToAdd <= 0n) {
        continue;
      }

      const previousDeposit = states.find(
        (state) => state.validatorInfo.pubkey === assignment.validatorInfo.pubkey
      )?.previousDeposit;
      if (!previousDeposit) {
        continue;
      }

      writeValidatorDeposit(
        context,
        buildValidatorDepositRecord({
          pubkey: assignment.validatorInfo.pubkey,
          blockHeight,
          timestamp: toTimestamp(event.block.timestamp),
          depositAmount: 0n,
          totalDeposited: previousDeposit.totalDeposited,
          depositCount: previousDeposit.depositCount,
          outstandingFatBERA:
            previousDeposit.outstandingFatBERA + assignment.shareToAdd,
        })
      );
    }
  }
);

export const handleBeaconDeposit = BeaconDeposit.Deposit.handler(
  async ({ event, context }) => {
    const validatorInfo = isTrackedValidatorPubkey(event.params.pubkey);
    if (!validatorInfo) {
      return;
    }

    // Preload: prime singleton read
    const previousDeposit = await context.LatestValidatorDeposit.get(validatorInfo.pubkey);

    // Skip writes during preload
    if ((context as any).isPreload) return;

    const currentOutstandingFatBERA =
      previousDeposit?.outstandingFatBERA ??
      (validatorInfo.pubkey === VALIDATORS[1].pubkey
        ? VALIDATOR_2_GENESIS_BALANCE
        : 0n);

    const depositAmountWei = BigInt(event.params.amount.toString()) * GWEI_TO_WEI;

    writeValidatorDeposit(
      context,
      buildValidatorDepositRecord({
        pubkey: validatorInfo.pubkey,
        blockHeight: event.block.number,
        timestamp: toTimestamp(event.block.timestamp),
        depositAmount: depositAmountWei,
        totalDeposited: (previousDeposit?.totalDeposited ?? 0n) + depositAmountWei,
        depositCount: (previousDeposit?.depositCount ?? 0) + 1,
        outstandingFatBERA: currentOutstandingFatBERA,
      })
    );
  }
);

export const handleBlockRewardProcessed = BlockRewardController.BlockRewardProcessed.handler(
  async ({ event, context }) => {
    const validatorInfo = VALIDATORS.find(
      (validator) => validator.id === event.params.pubkey.toLowerCase()
    );
    if (!validatorInfo) {
      return;
    }

    const isValidator4 = validatorInfo.pubkey === VALIDATORS[3].pubkey;
    if (isValidator4 && event.block.number < 8103108) {
      return;
    }

    // Preload: prime singleton reads
    const [previousRewards, depositRecord] = await Promise.all([
      context.LatestValidatorReward.get(validatorInfo.pubkey),
      context.LatestValidatorDeposit.get(validatorInfo.pubkey),
    ]);

    // Skip calculations and writes during preload
    if ((context as any).isPreload) return;

    if (!depositRecord || depositRecord.totalDeposited === 0n) {
      return;
    }

    const baseRate = BigInt(event.params.baseRate.toString());
    const rewardSplit = calculateRewardSplit({
      baseRate,
      totalDeposited: depositRecord.totalDeposited,
      validatorPubkey: validatorInfo.pubkey,
      blockHeight: event.block.number,
    });

    const reward: ValidatorBlockRewards = {
      id: `${event.block.number}_${validatorInfo.pubkey}`,
      pubkey: validatorInfo.pubkey,
      blockHeight: event.block.number,
      totalBlockRewards: (previousRewards?.totalBlockRewards ?? 0n) + baseRate,
      timestamp: toTimestamp(event.block.timestamp),
      nextTimestamp: BigInt(event.params.nextTimestamp.toString()),
      baseRate,
      rewardRate: BigInt(event.params.rewardRate.toString()),
      rewardCount: (previousRewards?.rewardCount ?? 0) + 1,
      stakerReward: rewardSplit.stakerReward,
      validatorReward: rewardSplit.validatorReward,
      totalStakerRewards:
        (previousRewards?.totalStakerRewards ?? 0n) + rewardSplit.stakerReward,
      totalValidatorRewards:
        (previousRewards?.totalValidatorRewards ?? 0n) +
        rewardSplit.validatorReward,
      outstandingStakerRewards:
        (previousRewards?.outstandingStakerRewards ?? 0n) +
        rewardSplit.stakerReward,
    };

    writeValidatorReward(context, reward);
  },
  {
    // Use raw pubkey — Envio applies keccak256() internally for bytes indexed topics
    eventFilters: VALIDATORS.map((v) => ({ pubkey: v.pubkey })),
  }
);

export const handleFatBeraRewardAdded = FatBeraDeposits.RewardAdded.handler(
  async ({ event, context }) => {
    if (event.params.token.toLowerCase() !== WBERA_ADDRESS) {
      return;
    }

    // Preload: prime singleton reads for all validators
    const latestRewards = (
      await Promise.all(
        VALIDATORS.map((validator) => context.LatestValidatorReward.get(validator.pubkey))
      )
    ).filter((reward): reward is LatestValidatorReward => reward !== undefined);

    // Skip calculations and writes during preload
    if ((context as any).isPreload) return;

    let totalOutstandingRewards = 0n;
    for (const reward of latestRewards) {
      totalOutstandingRewards += reward.outstandingStakerRewards;
    }

    if (totalOutstandingRewards === 0n || latestRewards.length === 0) {
      return;
    }

    const rewardAmount = BigInt(event.params.rewardAmount.toString());
    for (const currentReward of latestRewards) {
      const validatorShare =
        (currentReward.outstandingStakerRewards * rewardAmount) /
        totalOutstandingRewards;
      writeValidatorReward(context, {
        ...currentReward,
        id: `${event.block.number}_${currentReward.pubkey}`,
        blockHeight: event.block.number,
        timestamp: toTimestamp(event.block.timestamp),
        outstandingStakerRewards:
          currentReward.outstandingStakerRewards - validatorShare,
      });
    }
  }
);

export const handleAutomatedStakeExecution =
  AutomatedStake.WithdrawUnwrapAndStakeExecuted.handler(
    async ({ event, context }) => {
      if (event.block.number < FATBERA_DEPOSIT_TRACKING_START_BLOCK) {
        return;
      }

      let validatorInfo = VALIDATORS.find(
        (validator) => validator.id === event.params.pubkey.toLowerCase()
      );
      if (!validatorInfo) {
        const validatorIndex = Number(event.params.validatorIndex);
        validatorInfo = VALIDATORS[validatorIndex];
      }
      if (!validatorInfo) {
        return;
      }

      // Preload: prime singleton read
      const previousDeposit = await context.LatestValidatorDeposit.get(validatorInfo.pubkey);

      // Skip writes during preload
      if ((context as any).isPreload) return;

      if (!previousDeposit) {
        return;
      }

      const executedAmount = BigInt(event.params.amount.toString());
      const outstandingFatBERA =
        previousDeposit.outstandingFatBERA > executedAmount
          ? previousDeposit.outstandingFatBERA - executedAmount
          : 0n;

      writeValidatorDeposit(
        context,
        buildValidatorDepositRecord({
          pubkey: validatorInfo.pubkey,
          blockHeight: event.block.number,
          timestamp: toTimestamp(event.block.timestamp),
          depositAmount: 0n,
          totalDeposited: previousDeposit.totalDeposited,
          depositCount: previousDeposit.depositCount,
          outstandingFatBERA,
        })
      );
    },
    {
      // Use raw pubkey — Envio applies keccak256() internally for bytes indexed topics
      eventFilters: VALIDATORS.map((v) => ({ pubkey: v.pubkey })),
    }
  );

export const handleFatBeraWithdrawalRequested =
  FatBeraDeposits.WithdrawalRequested.handler(async ({ event, context }) => {
    const batchId = event.params.batchId.toString();
    let withdrawalBatch = await context.WithdrawalBatch.get(batchId);
    if (!withdrawalBatch) {
      withdrawalBatch = {
        id: batchId,
        batchId: Number(event.params.batchId),
        totalAmount: 0n,
        startTime: toTimestamp(event.block.timestamp),
        uniqueUsers: 0,
        userAddresses: [],
        blockHeight: event.block.number,
        transactionHash: event.transaction.hash,
        status: "open",
        predictedWithdrawalBlock: 0,
      };
    }

    const existingRequests = await getWithdrawalRequestsForBatch(context, batchId);
    const newRequest: WithdrawalRequest = {
      id: `${event.block.number}_${event.transaction.hash}_${event.logIndex}`,
      user: event.params.user.toLowerCase(),
      batch_id: batchId,
      amount: BigInt(event.params.amount.toString()),
      timestamp: toTimestamp(event.block.timestamp),
      blockHeight: event.block.number,
      transactionHash: event.transaction.hash,
    };
    context.WithdrawalRequest.set(newRequest);

    const requestUsers = new Set(existingRequests.map((request) => request.user));
    requestUsers.add(newRequest.user);

    let totalAmount = newRequest.amount;
    for (const request of existingRequests) {
      totalAmount += request.amount;
    }

    const uniqueUsers = Array.from(requestUsers);
    context.WithdrawalBatch.set({
      ...withdrawalBatch,
      totalAmount,
      uniqueUsers: uniqueUsers.length,
      userAddresses: uniqueUsers,
      status:
        uniqueUsers.length >= MAX_USERS_PER_BATCH && withdrawalBatch.status === "open"
          ? "full"
          : withdrawalBatch.status,
    });
  });

export const handleFatBeraBatchStarted = FatBeraDeposits.BatchStarted.handler(
  async ({ event, context }) => {
    const batchId = event.params.batchId.toString();
    const [existingBatch, batchRequests] = await Promise.all([
      context.WithdrawalBatch.get(batchId),
      getWithdrawalRequestsForBatch(context, batchId),
    ]);
    const uniqueUsers = Array.from(
      new Set(batchRequests.map((request) => request.user))
    );

    const withdrawalBatch: WithdrawalBatch = existingBatch
      ? {
          ...existingBatch,
          status: "pending",
          predictedWithdrawalBlock: predictWithdrawalBlock(event.block.number),
        }
      : {
          id: batchId,
          batchId: Number(event.params.batchId),
          totalAmount: BigInt(event.params.totalAmount.toString()),
          startTime: toTimestamp(event.block.timestamp),
          uniqueUsers: uniqueUsers.length,
          userAddresses: uniqueUsers,
          blockHeight: event.block.number,
          transactionHash: event.transaction.hash,
          status: "pending",
          predictedWithdrawalBlock: predictWithdrawalBlock(event.block.number),
        };

    context.WithdrawalBatch.set(withdrawalBatch);

    const nextBatchId = String(Number(event.params.batchId) + 1);
    const nextBatch = await context.WithdrawalBatch.get(nextBatchId);
    if (!nextBatch) {
      context.WithdrawalBatch.set({
        id: nextBatchId,
        batchId: Number(nextBatchId),
        totalAmount: 0n,
        startTime: toTimestamp(event.block.timestamp),
        uniqueUsers: 0,
        userAddresses: [],
        blockHeight: event.block.number,
        transactionHash: event.transaction.hash,
        status: "open",
        predictedWithdrawalBlock: 0,
      });
    }
  }
);

export const handleFatBeraWithdrawalFulfilled =
  FatBeraDeposits.WithdrawalFulfilled.handler(async ({ event, context }) => {
    const batchId = event.params.batchId.toString();
    const withdrawalBatch = await context.WithdrawalBatch.get(batchId);
    if (!withdrawalBatch) {
      return;
    }

    if (withdrawalBatch.status === "pending") {
      context.WithdrawalBatch.set({
        ...withdrawalBatch,
        status: "fulfilled",
      });
    }

    const fulfillment: WithdrawalFulfillment = {
      id: `${event.block.number}_${event.transaction.hash}_${event.logIndex}`,
      user: event.params.user.toLowerCase(),
      batch_id: batchId,
      amount: BigInt(event.params.amount.toString()),
      timestamp: toTimestamp(event.block.timestamp),
      blockHeight: event.block.number,
      transactionHash: event.transaction.hash,
    };
    context.WithdrawalFulfillment.set(fulfillment);
  });

export const handleValidatorWithdrawalRequested =
  ValidatorWithdrawalModule.ValidatorWithdrawalRequested.handler(
    async ({ event, context }) => {
      const validatorId = event.params.cometBFTPublicKey.toLowerCase();
      const validatorInfo = VALIDATORS.find((validator) => validator.id === validatorId);
      if (!validatorInfo) {
        return;
      }

      // Preload: prime reads
      const [existingTotals, previousDeposit] = await Promise.all([
        context.ValidatorWithdrawalTotals.get(validatorInfo.pubkey),
        context.LatestValidatorDeposit.get(validatorInfo.pubkey),
      ]);

      // Skip writes during preload
      if ((context as any).isPreload) return;

      const withdrawalAmount = BigInt(event.params.withdrawAmount.toString());
      const feeAmount = BigInt(event.params.fee.toString());

      const totals: ValidatorWithdrawalTotals = {
        id: validatorInfo.pubkey,
        cometBFTPublicKey: validatorId,
        totalWithdrawn: (existingTotals?.totalWithdrawn ?? 0n) + withdrawalAmount,
        withdrawalCount: (existingTotals?.withdrawalCount ?? 0) + 1,
        totalFees: (existingTotals?.totalFees ?? 0n) + feeAmount,
        lastWithdrawalAmount: withdrawalAmount,
        lastWithdrawalBlock: event.block.number,
        lastWithdrawalTimestamp: toTimestamp(event.block.timestamp),
        lastWithdrawalSafe: event.params.safe.toLowerCase(),
        lastWithdrawalInitiator: event.params.initiator.toLowerCase(),
      };
      context.ValidatorWithdrawalTotals.set(totals);

      if (!previousDeposit) {
        return;
      }

      const totalAmountRemoved = withdrawalAmount + feeAmount;
      writeValidatorDeposit(
        context,
        buildValidatorDepositRecord({
          pubkey: validatorInfo.pubkey,
          blockHeight: event.block.number,
          timestamp: toTimestamp(event.block.timestamp),
          depositAmount: 0n,
          totalDeposited:
            previousDeposit.totalDeposited > totalAmountRemoved
              ? previousDeposit.totalDeposited - totalAmountRemoved
              : 0n,
          depositCount: previousDeposit.depositCount,
          outstandingFatBERA: previousDeposit.outstandingFatBERA,
        })
      );
    },
    {
      // Use raw pubkey — Envio applies keccak256() internally for bytes indexed topics
      eventFilters: VALIDATORS.map((v) => ({ cometBFTPublicKey: v.pubkey })),
    }
  );

export const handleValidatorDepositRequested =
  ValidatorDepositRouter.ValidatorDepositRequested.handler(
    async ({ event, context }) => {
      if (event.block.number < FATBERA_DEPOSIT_TRACKING_START_BLOCK) {
        return;
      }

      const validatorIndex = Number(event.params.validatorIndex);
      const validatorInfo = VALIDATORS[validatorIndex];
      if (!validatorInfo) {
        return;
      }

      // Preload: prime singleton reads for target + all active validators
      const activeValidators = getActiveValidators(event.block.number);
      const allDeposits = await Promise.all(
        activeValidators.map((validator) =>
          context.LatestValidatorDeposit.get(validator.pubkey)
        )
      );

      // Skip calculations and writes during preload
      if ((context as any).isPreload) return;

      // Use pre-fetched deposit from allDeposits (avoid redundant DB read)
      const targetIdx = activeValidators.findIndex(v => v.pubkey === validatorInfo.pubkey);
      const previousDeposit = targetIdx >= 0 ? allDeposits[targetIdx] : undefined;
      if (!previousDeposit) {
        return;
      }

      const depositAmount = BigInt(event.params.amount.toString());
      const totalCurrentAmount =
        previousDeposit.totalDeposited + previousDeposit.outstandingFatBERA;
      const remainingCapacity =
        10_000_000n * 10n ** 18n > totalCurrentAmount
          ? 10_000_000n * 10n ** 18n - totalCurrentAmount
          : 0n;
      const amountToAdd =
        depositAmount <= remainingCapacity ? depositAmount : remainingCapacity;
      const amountToRedistribute = depositAmount - amountToAdd;

      if (amountToAdd > 0n) {
        writeValidatorDeposit(
          context,
          buildValidatorDepositRecord({
            pubkey: validatorInfo.pubkey,
            blockHeight: event.block.number,
            timestamp: toTimestamp(event.block.timestamp),
            depositAmount: 0n,
            totalDeposited: previousDeposit.totalDeposited,
            depositCount: previousDeposit.depositCount,
            outstandingFatBERA: previousDeposit.outstandingFatBERA + amountToAdd,
          })
        );
      }

      if (amountToRedistribute <= 0n) {
        return;
      }

      const states = activeValidators
        .map((validator, i) => {
          const latestDeposit = allDeposits[i];
          if (!latestDeposit) return undefined;
          return {
            validatorInfo: validator,
            totalDeposited: latestDeposit.totalDeposited,
            outstandingFatBERA: latestDeposit.outstandingFatBERA,
            previousDeposit: latestDeposit,
          };
        })
        .filter((state): state is NonNullable<typeof state> => state !== undefined);

      const assignments = calculateRouterRedistributionAssignments({
        amountToRedistribute,
        blockHeight: event.block.number,
        targetValidatorIndex: validatorIndex,
        states,
      });

      for (const assignment of assignments) {
        if (assignment.shareToAdd <= 0n) {
          continue;
        }

        const previousState = states.find(
          (state) => state.validatorInfo.pubkey === assignment.validatorInfo.pubkey
        );
        if (!previousState) {
          continue;
        }

        writeValidatorDeposit(
          context,
          buildValidatorDepositRecord({
            pubkey: assignment.validatorInfo.pubkey,
            blockHeight: event.block.number,
            timestamp: toTimestamp(event.block.timestamp),
            depositAmount: 0n,
            totalDeposited: previousState.previousDeposit.totalDeposited,
            depositCount: previousState.previousDeposit.depositCount,
            outstandingFatBERA:
              previousState.previousDeposit.outstandingFatBERA +
              assignment.shareToAdd,
            suffix: "redistribution",
          })
        );
      }
    },
    {
      eventFilters: [
        { validatorIndex: 0n },
        { validatorIndex: 1n },
        { validatorIndex: 2n },
        { validatorIndex: 3n },
      ],
    }
  );

export {
  BERACHAIN_CHAIN_ID,
  GENESIS_DEPOSIT,
  MAX_USERS_PER_BATCH,
  VALIDATOR_2_GENESIS_BALANCE,
};
