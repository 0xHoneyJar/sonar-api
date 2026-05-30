// ponder-runtime/src/handlers/fatbera-core.ts
//
// PORTED FROM: src/handlers/fatbera-core.ts (envio, source-of-truth).
// B-1 green-belt (Group A). Pure validator-state math + constants for the
// FatBera / validator-rewards handler. These functions contain the
// ORDER-SENSITIVE reward-split arithmetic + the capacity-redistribution
// allocation — they are ported BYTE-FOR-BYTE from the envio source so that the
// ponder forward-index produces values arithmetically identical to envio's
// frozen-imported history.
//
// THE ONLY CHANGE vs the envio source: `toTimestamp()` is REMOVED. Envio's
// schema stored validator timestamps as the `Timestamp` scalar (Js.Date.t → pg
// timestamp), so the envio handler wrapped `event.block.timestamp` in
// `toTimestamp(...)` → `new Date(seconds * 1000)`. Ponder's schema columns are
// `t.bigint()` (epoch SECONDS) and `event.block.timestamp` is ALREADY a bigint
// epoch-seconds value, so the ponder handler writes it directly with no Date
// round-trip. (The import-transform does the EXTRACT(EPOCH) conversion for the
// frozen rows — out of handler scope.) Every other export below is verbatim.
//
// Constants (VALIDATORS, the genesis balances, the distribution arrays, the
// block thresholds) are copied verbatim from the envio source — they are the
// load-bearing allowlist + the pre/post-migration deposit split.

export type FatberaValidatorInfo = {
  pubkey: string;
  id: string;
};

export const FATBERA_DEPOSIT_TRACKING_START_BLOCK = 1966971;
export const DISTRIBUTION_CHANGE_BLOCK = 8103108;
export const MAX_VALIDATOR_CAPACITY = 10_000_000n * 10n ** 18n;
export const VALIDATOR_2_GENESIS_BALANCE = 11221920000000000000000n;
export const GENESIS_DEPOSIT = 10000000000000000000000n;
export const MAX_USERS_PER_BATCH = 100;
export const WBERA_ADDRESS = "0x6969696969696969696969696969696969696969";
export const VALIDATOR_DEPOSIT_ROUTER_ADDRESS =
  "0x989212d8227a8957b9247e1966046b47a7a63d64";

// VALIDATORS carries BOTH the raw 48-byte `pubkey` AND the bytes32 keccak `id`.
// - `pubkey` matches the RAW (non-indexed) BeaconDeposit pubkey.
// - `id` matches the keccak-HASH topic that viem decodes for the indexed-bytes
//   pubkey/cometBFTPublicKey events (BlockRewardProcessed / AutomatedStake /
//   ValidatorWithdrawalRequested). See abis/FatBeraAbis.ts + the handler header.
export const VALIDATORS: FatberaValidatorInfo[] = [
  {
    pubkey:
      "0xa0c673180d97213c1c35fe3bf4e684dd3534baab235a106d1f71b9c8a37e4d37a056d47546964fd075501dff7f76aeaf",
    id: "0x68b58f24be0e7c16df3852402e8475e8b3cc53a64cfaf45da3dbc148cdc05d30",
  },
  {
    pubkey:
      "0x89cbd542c737cca4bc33f1ea5084a857a7620042fe37fd326ecf5aeb61f2ce096043cd0ed57ba44693cf606978b566ba",
    id: "0x49b1da598314ec223de86906b92ec9415b834ddbb27828c96997b77b88c21926",
  },
  {
    pubkey:
      "0xb82a791d7c3d72efa6759e0250785346266d6c70ed881424ec63ad4d060904983bc57903fa133a9bc00c2d6f9b12964d",
    id: "0x9afbb0da8047cad5f377c08cd27a312bb8bf6957839c1a15b94d48cd2f26ab48",
  },
  {
    pubkey:
      "0xad821eef22a49c9d9ef7f4eb07e57c166ae80804b6524d42d51f7cd8e7e49fb75ced2d61ec6d0e812324d9001464fa0a",
    id: "0xe232736c07f2f3685a92c9b8fee33fd6c4d1fd6369b2f3c4a3db1ebcc1fdae39",
  },
];

export const PRE_MIGRATION_DEPOSIT_DISTRIBUTION = [0.5, 0.35, 0.15];
export const POST_MIGRATION_DEPOSIT_DISTRIBUTION = [0.25, 0.35, 0.15, 0.25];

export type ValidatorAmountState = {
  validatorInfo: FatberaValidatorInfo;
  totalDeposited: bigint;
  outstandingFatBERA: bigint;
};

export type DistributionAssignment = {
  validatorInfo: FatberaValidatorInfo;
  shareToAdd: bigint;
  initialShare: bigint;
  remainingCapacity: bigint;
  index: number;
};

export function getActiveValidators(blockHeight: number): FatberaValidatorInfo[] {
  return blockHeight < DISTRIBUTION_CHANGE_BLOCK
    ? VALIDATORS.slice(0, 3)
    : VALIDATORS;
}

export function getDepositDistribution(blockHeight: number): number[] {
  return blockHeight < DISTRIBUTION_CHANGE_BLOCK
    ? PRE_MIGRATION_DEPOSIT_DISTRIBUTION
    : POST_MIGRATION_DEPOSIT_DISTRIBUTION;
}

export function predictWithdrawalBlock(blockHeight: number): number {
  const blocksPerEpoch = 192;
  const epochsToWait = 256;
  return Math.ceil(blockHeight / blocksPerEpoch + epochsToWait) * blocksPerEpoch;
}

// Reward-split arithmetic — VERBATIM from envio (src/handlers/fatbera-core.ts:78-114).
// The fee + staker/validator portion math is the order-sensitive correctness
// surface the dispatch brief flags: it depends on the latest deposit's
// totalDeposited (read from latest_validator_deposit BEFORE this is called).
export function calculateRewardSplit(args: {
  baseRate: bigint;
  totalDeposited: bigint;
  validatorPubkey: string;
  blockHeight: number;
}): { stakerReward: bigint; validatorReward: bigint } {
  const feePercentage = 69n;
  const scale = 1000n;
  const validatorPubkey = args.validatorPubkey.toLowerCase();
  const isOriginalValidator = validatorPubkey === VALIDATORS[0].pubkey;
  const isValidator4AfterMigration =
    validatorPubkey === VALIDATORS[3].pubkey &&
    args.blockHeight >= DISTRIBUTION_CHANGE_BLOCK;

  let stakerDeposit = args.totalDeposited;
  if (
    (isOriginalValidator || isValidator4AfterMigration) &&
    args.totalDeposited > GENESIS_DEPOSIT
  ) {
    stakerDeposit = args.totalDeposited - GENESIS_DEPOSIT;
  }

  let stakerPortion = 0n;
  let validatorPortion = args.baseRate;
  let stakerFee = 0n;

  if (args.totalDeposited > 0n) {
    stakerPortion = (args.baseRate * stakerDeposit) / args.totalDeposited;
    validatorPortion = args.baseRate - stakerPortion;
    stakerFee = (stakerPortion * feePercentage) / scale;
  }

  return {
    stakerReward: stakerPortion - stakerFee,
    validatorReward: validatorPortion + stakerFee,
  };
}

// Direct-deposit capacity allocation + redistribution — VERBATIM from envio
// (src/handlers/fatbera-core.ts:116-201).
export function calculateDirectDepositAssignments(args: {
  amount: bigint;
  blockHeight: number;
  states: ValidatorAmountState[];
}): DistributionAssignment[] {
  const activeValidators = getActiveValidators(args.blockHeight);
  const distribution = getDepositDistribution(args.blockHeight);
  const assignments: DistributionAssignment[] = [];
  let amountToRedistribute = 0n;

  for (let i = 0; i < activeValidators.length; i += 1) {
    const validatorInfo = activeValidators[i];
    const state = args.states.find(
      (entry) => entry.validatorInfo.pubkey === validatorInfo.pubkey
    );
    if (!state) {
      continue;
    }

    const initialShare = BigInt(
      Math.floor(Number(args.amount) * distribution[i])
    );
    const totalCurrentAmount = state.totalDeposited + state.outstandingFatBERA;
    const remainingCapacity =
      MAX_VALIDATOR_CAPACITY > totalCurrentAmount
        ? MAX_VALIDATOR_CAPACITY - totalCurrentAmount
        : 0n;
    const canAcceptFull = initialShare <= remainingCapacity;
    const shareToAdd = canAcceptFull ? initialShare : remainingCapacity;

    assignments.push({
      validatorInfo,
      shareToAdd,
      initialShare,
      remainingCapacity,
      index: i,
    });

    if (!canAcceptFull) {
      amountToRedistribute += initialShare - remainingCapacity;
    }
  }

  if (amountToRedistribute <= 0n) {
    return assignments;
  }

  const available = assignments.filter(
    (entry) => entry.initialShare <= entry.remainingCapacity && entry.remainingCapacity > entry.shareToAdd
  );
  if (available.length === 0) {
    return assignments;
  }

  let totalAvailablePercentage = 0;
  for (const assignment of available) {
    totalAvailablePercentage += distribution[assignment.index];
  }

  let remainingToRedistribute = amountToRedistribute;
  for (let i = 0; i < available.length; i += 1) {
    const assignment = available[i];
    if (i === available.length - 1) {
      assignment.shareToAdd += remainingToRedistribute;
      break;
    }

    const normalizedPercentage =
      distribution[assignment.index] / totalAvailablePercentage;
    const additionalShare = BigInt(
      Math.floor(Number(amountToRedistribute) * normalizedPercentage)
    );
    const availableCapacity = assignment.remainingCapacity - assignment.shareToAdd;
    const actualAdditionalShare =
      additionalShare < availableCapacity ? additionalShare : availableCapacity;

    assignment.shareToAdd += actualAdditionalShare;
    remainingToRedistribute -= actualAdditionalShare;

    if (remainingToRedistribute <= 0n) {
      break;
    }
  }

  return assignments;
}

// Router redistribution allocation — VERBATIM from envio
// (src/handlers/fatbera-core.ts:203-306).
export function calculateRouterRedistributionAssignments(args: {
  amountToRedistribute: bigint;
  blockHeight: number;
  targetValidatorIndex: number;
  states: ValidatorAmountState[];
}): DistributionAssignment[] {
  const activeValidators = getActiveValidators(args.blockHeight);
  const distribution = getDepositDistribution(args.blockHeight);
  const otherValidators = activeValidators.filter(
    (_validator, index) => index !== args.targetValidatorIndex
  );
  const otherValidatorIndices = otherValidators.map((validator) =>
    activeValidators.findIndex((entry) => entry.pubkey === validator.pubkey)
  );
  const originalDistribution = otherValidatorIndices.map(
    (index) => distribution[index]
  );
  const totalOtherPercentage = originalDistribution.reduce(
    (sum, value) => sum + value,
    0
  );
  const normalizedDistribution = originalDistribution.map(
    (value) => value / totalOtherPercentage
  );

  const assignments: DistributionAssignment[] = [];

  for (let i = 0; i < otherValidators.length; i += 1) {
    const validatorInfo = otherValidators[i];
    const state = args.states.find(
      (entry) => entry.validatorInfo.pubkey === validatorInfo.pubkey
    );
    if (!state) {
      continue;
    }

    const initialShare = BigInt(
      Math.floor(Number(args.amountToRedistribute) * normalizedDistribution[i])
    );
    const totalCurrentAmount = state.totalDeposited + state.outstandingFatBERA;
    const remainingCapacity =
      MAX_VALIDATOR_CAPACITY > totalCurrentAmount
        ? MAX_VALIDATOR_CAPACITY - totalCurrentAmount
        : 0n;
    const canAcceptFull = initialShare <= remainingCapacity;
    const shareToAdd = canAcceptFull ? initialShare : remainingCapacity;

    assignments.push({
      validatorInfo,
      shareToAdd,
      initialShare,
      remainingCapacity,
      index: otherValidatorIndices[i],
    });
  }

  let totalAssigned = 0n;
  for (const assignment of assignments) {
    totalAssigned += assignment.shareToAdd;
  }
  let remainingToRedistribute = args.amountToRedistribute - totalAssigned;

  if (remainingToRedistribute <= 0n) {
    return assignments;
  }

  const available = assignments.filter(
    (entry) => entry.initialShare <= entry.remainingCapacity && entry.remainingCapacity > entry.shareToAdd
  );
  if (available.length === 0) {
    return assignments;
  }

  let totalAvailablePercentage = 0;
  for (const assignment of available) {
    totalAvailablePercentage += distribution[assignment.index];
  }

  for (let i = 0; i < available.length; i += 1) {
    const assignment = available[i];
    if (i === available.length - 1) {
      assignment.shareToAdd += remainingToRedistribute;
      break;
    }

    const normalizedPercentage =
      distribution[assignment.index] / totalAvailablePercentage;
    const additionalShare = BigInt(
      Math.floor(Number(remainingToRedistribute) * normalizedPercentage)
    );
    const availableCapacity = assignment.remainingCapacity - assignment.shareToAdd;
    const actualAdditionalShare =
      additionalShare < availableCapacity ? additionalShare : availableCapacity;

    assignment.shareToAdd += actualAdditionalShare;
    remainingToRedistribute -= actualAdditionalShare;

    if (remainingToRedistribute <= 0n) {
      break;
    }
  }

  return assignments;
}
