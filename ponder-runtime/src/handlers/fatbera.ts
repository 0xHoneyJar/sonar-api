// ponder-runtime/src/handlers/fatbera.ts
//
// PORTED FROM: src/handlers/fatbera.ts (envio, source-of-truth, 754 lines).
// B-1 green-belt (Group A — the LARGEST + most complex group). Contracts (7,
// all Berachain 80094): FatBeraDeposits, FatBeraAccounting, BeaconDeposit,
// BlockRewardController, AutomatedStake, ValidatorWithdrawalModule,
// ValidatorDepositRouter (config.yaml:856-885; event sigs config.yaml:360-422).
//
// Writes (9 entities):
//   - validator_block_rewards    (APPEND-RUNNING; id=`${blockNumber}_${pubkey}`; THE 906k-row table)
//   - validator_deposits         (APPEND-RUNNING; id=`${blockHeight}_${pubkey}[_${suffix}]`)
//   - latest_validator_deposit   (ROLLUP-LWW singleton; id=`${pubkey}`)
//   - latest_validator_reward    (ROLLUP-LWW singleton; id=`${pubkey}`)
//   - validator_withdrawal_totals(ROLLUP additive; id=`${pubkey}`)
//   - withdrawal_batch           (ROLLUP-LWW; id=`${batchId}`)
//   - withdrawal_request         (APPEND; id=`${blockHeight}_${txHash}_${logIndex}`)
//   - withdrawal_fulfillment     (APPEND; id=`${blockHeight}_${txHash}_${logIndex}`)
//   - fatbera_deposit            (APPEND; id=`${txHash}_${logIndex}`)
//   + action                     (via recordAction — handleFatBeraDeposit only)
//
// No NATS publish (the envio fatbera handler emits no events — matches mirror /
// apdao / moneycomb / henlo-vault — local indexing only).
//
// ════════════════════════════════════════════════════════════════════════════
// ORDER-SENSITIVITY + THE isPreload ELIMINATION (the load-bearing port decision)
// ════════════════════════════════════════════════════════════════════════════
// The envio handler uses a TWO-PASS `isPreload` mechanism: on the preload pass
// it primes singleton reads (`context.LatestValidator{Deposit,Reward}.get(...)`)
// then RETURNS before any write (`if ((context as any).isPreload) return;`); on
// the real pass it re-uses the primed values, computes, and writes. That is an
// envio-executor batching OPTIMIZATION (it warms the entity cache so the batch's
// reads don't serialize against DB latency). It is NOT part of the domain logic.
//
// Ponder processes events STRICTLY SEQUENTIALLY in (block, logIndex) order and
// reads are synchronous `await context.db.find(...)`. So this port DROPS the
// isPreload two-pass entirely and reads each singleton INLINE, immediately
// before the compute-and-write — which IS exactly the read-before-write the
// envio domain logic depends on. The find→compute→write sequence is preserved
// verbatim, single-pass; we NEVER parallelize a read that must observe a write
// made earlier in the SAME event (the only intra-event multi-write handlers —
// FatBeraDeposit direct-deposit + ValidatorDepositRouter redistribution — write
// to DISTINCT validator pubkeys, so their per-pubkey reads are independent and
// the envio `Promise.all` batch-read is safe to keep as a parallel read of
// independent keys). Across events, ponder's sequential ordering reproduces the
// envio "latest singleton reflects all prior events" invariant by construction.
//
// API-pivot from envio (verbatim rules — same as apdao-auction.ts /
// moneycomb-vault.ts / henlo-vault.ts / general-mints.ts):
//   - event.params               → event.args
//   - event.chainId              → context.chain.id (FatBera is Berachain-only; 80094)
//   - event.srcAddress           → event.log.address
//   - event.logIndex             → event.log.logIndex
//   - event.block.timestamp/.number → ALREADY bigint (drop envio's BigInt() wrap)
//   - event.transaction.hash/.from/.to → same in ponder
//   - context.<E>.get(id)        → await context.db.find(<table>, { id })
//   - context.<E>.getWhere(...)  → context.db.sql.select() (drizzle escape hatch — withdrawal-batch user accrual)
//   - context.<E>.set (APPEND)   → context.db.insert(<table>).values(obj).onConflictDoNothing()
//   - context.<E>.set (singleton/rollup) → find → update OR insert (read-modify-write)
//   - context.log.*              → console.* / omit (ponder 0.16.6 indexing context
//                                    has NO .log surface — verified LIVE, commit 879221ff;
//                                    bgt.ts / moneycomb-vault.ts flagged the same. This is
//                                    the bug that crashed the live belt — do NOT port context.log)
//
// TIMESTAMP: envio wrapped block.timestamp in toTimestamp() → Date (its schema
// stored the Timestamp scalar). Ponder columns are t.bigint() (epoch seconds)
// and event.block.timestamp is already bigint epoch-seconds → written DIRECTLY,
// no Date round-trip, no conversion. (See fatbera-core.ts header.)
//
// UINT COERCIONS: viem decodes uint256/uint64/uint48 args as JS bigint. The envio
// source defensively wraps some in BigInt(x.toString()); those wraps are dropped
// (the arg is already a bigint). BeaconDeposit.amount is uint64 → bigint; the
// envio `BigInt(amount.toString()) * GWEI_TO_WEI` becomes `amount * GWEI_TO_WEI`.

import { ponder } from "ponder:registry";
import { eq } from "ponder";
import {
  validatorBlockRewards,
  validatorDeposits,
  latestValidatorDeposit,
  latestValidatorReward,
  validatorWithdrawalTotals,
  withdrawalBatch,
  withdrawalRequest,
  withdrawalFulfillment,
  fatberaDeposit,
} from "../../ponder.schema";
import { recordAction } from "../lib/record-action";
import {
  FATBERA_DEPOSIT_TRACKING_START_BLOCK,
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
} from "./fatbera-core";

const COLLECTION_KEY = "fatbera_deposit";
const GWEI_TO_WEI = 1_000_000_000n;

// ─────────────────────────────────────────────────────────────────────────
// Row-shape types (mirror the ponder schema columns; outstandingFatBera is the
// ponder snake_case rename of envio's outstandingFatBERA — the column is
// outstanding_fat_bera per the green-belt map).
// ─────────────────────────────────────────────────────────────────────────
type ValidatorDepositRow = {
  id: string;
  pubkey: string;
  blockHeight: number;
  timestamp: bigint;
  depositAmount: bigint;
  totalDeposited: bigint;
  depositCount: number;
  outstandingFatBera: bigint;
};

type LatestValidatorDepositRow = {
  id: string;
  pubkey: string;
  blockHeight: number;
  timestamp: bigint;
  depositAmount: bigint;
  totalDeposited: bigint;
  depositCount: number;
  outstandingFatBera: bigint;
};

type ValidatorBlockRewardsRow = {
  id: string;
  pubkey: string;
  blockHeight: number;
  totalBlockRewards: bigint;
  timestamp: bigint;
  nextTimestamp: bigint;
  baseRate: bigint;
  rewardRate: bigint;
  rewardCount: number;
  stakerReward: bigint;
  validatorReward: bigint;
  totalStakerRewards: bigint;
  totalValidatorRewards: bigint;
  outstandingStakerRewards: bigint;
};

type LatestValidatorRewardRow = {
  id: string;
  pubkey: string;
  blockHeight: number;
  totalBlockRewards: bigint;
  timestamp: bigint;
  nextTimestamp: bigint;
  baseRate: bigint;
  rewardRate: bigint;
  rewardCount: number;
  stakerReward: bigint;
  validatorReward: bigint;
  totalStakerRewards: bigint;
  totalValidatorRewards: bigint;
  outstandingStakerRewards: bigint;
};

function isTrackedValidatorPubkey(pubkey: string) {
  return VALIDATORS.find((validator) => validator.pubkey === pubkey.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────
// Dual-write helpers — envio's writeValidatorDeposit / writeValidatorReward.
// Envio: context.ValidatorDeposits.set(record) (append history) +
//        context.LatestValidatorDeposit.set({...}) (singleton, derived from record).
// Ponder: insert the history row (onConflictDoNothing → replay-idempotent) +
//        upsert the singleton (find → update OR insert). The singleton's id is
//        the bare pubkey (NOT the blockHeight_pubkey history id) — verbatim.
// ─────────────────────────────────────────────────────────────────────────
async function writeValidatorDeposit(
  context: any,
  record: ValidatorDepositRow
): Promise<void> {
  // history (append) — id = blockHeight_pubkey[_suffix]
  await context.db
    .insert(validatorDeposits)
    .values({
      id: record.id,
      pubkey: record.pubkey,
      blockHeight: record.blockHeight,
      timestamp: record.timestamp,
      depositAmount: record.depositAmount,
      totalDeposited: record.totalDeposited,
      depositCount: record.depositCount,
      outstandingFatBera: record.outstandingFatBera,
    })
    .onConflictDoNothing();

  // singleton (ROLLUP-LWW) — id = pubkey. Latest deposit state.
  const latestId = record.pubkey;
  const latestValues = {
    pubkey: record.pubkey,
    blockHeight: record.blockHeight,
    timestamp: record.timestamp,
    depositAmount: record.depositAmount,
    totalDeposited: record.totalDeposited,
    depositCount: record.depositCount,
    outstandingFatBera: record.outstandingFatBera,
  };
  const existing = await context.db.find(latestValidatorDeposit, { id: latestId });
  if (existing) {
    await context.db
      .update(latestValidatorDeposit, { id: latestId })
      .set(latestValues);
  } else {
    await context.db
      .insert(latestValidatorDeposit)
      .values({ id: latestId, ...latestValues })
      .onConflictDoNothing();
  }
}

async function writeValidatorReward(
  context: any,
  record: ValidatorBlockRewardsRow
): Promise<void> {
  // history (append-running) — id = blockNumber_pubkey
  await context.db
    .insert(validatorBlockRewards)
    .values({
      id: record.id,
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
    })
    .onConflictDoNothing();

  // singleton (ROLLUP-LWW) — id = pubkey. Latest reward state.
  const latestId = record.pubkey;
  const latestValues = {
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
  };
  const existing = await context.db.find(latestValidatorReward, { id: latestId });
  if (existing) {
    await context.db
      .update(latestValidatorReward, { id: latestId })
      .set(latestValues);
  } else {
    await context.db
      .insert(latestValidatorReward)
      .values({ id: latestId, ...latestValues })
      .onConflictDoNothing();
  }
}

// envio: context.WithdrawalRequest.getWhere({ batch_id: { _eq: batchId } }).
// Ponder has no entity-index getWhere; use the drizzle escape hatch
// (context.db.sql.select) over the withdrawal_request table filtered by batch_id.
// Returns the array of { user, amount } rows the batch-accrual needs.
async function getWithdrawalRequestsForBatch(
  context: any,
  batchId: string
): Promise<{ user: string; amount: bigint }[]> {
  const rows = await context.db.sql
    .select({
      user: withdrawalRequest.user,
      amount: withdrawalRequest.amount,
    })
    .from(withdrawalRequest)
    .where(eq(withdrawalRequest.batchId, batchId));
  return rows as { user: string; amount: bigint }[];
}

// envio buildValidatorDepositRecord — id base `${blockHeight}_${pubkey}`, with
// optional suffix (the router redistribution path uses suffix "redistribution").
function buildValidatorDepositRecord(args: {
  pubkey: string;
  blockHeight: number;
  timestamp: bigint;
  depositAmount: bigint;
  totalDeposited: bigint;
  depositCount: number;
  outstandingFatBera: bigint;
  suffix?: string;
}): ValidatorDepositRow {
  const idBase = `${args.blockHeight}_${args.pubkey}`;
  return {
    id: args.suffix ? `${idBase}_${args.suffix}` : idBase,
    pubkey: args.pubkey,
    blockHeight: args.blockHeight,
    timestamp: args.timestamp,
    depositAmount: args.depositAmount,
    totalDeposited: args.totalDeposited,
    depositCount: args.depositCount,
    outstandingFatBera: args.outstandingFatBera,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// handleFatBeraDeposit — FatBeraDeposits:Deposit (envio fatbera.ts:118-239)
//   Writes fatbera_deposit + recordAction; for non-router direct deposits past
//   the tracking start block, distributes the deposit across active validators
//   (capacity-aware) → validator_deposits / latest_validator_deposit.
// ═════════════════════════════════════════════════════════════════════════
ponder.on("FatBeraDeposits:Deposit", async ({ event, context }) => {
  const { sender, owner, assets, shares } = event.args;

  if (assets === 0n && shares === 0n) {
    return;
  }

  const depositor = sender.toLowerCase();
  const recipient = owner.toLowerCase();
  const transactionFrom = event.transaction.from
    ? event.transaction.from.toLowerCase()
    : undefined;
  const transactionTo = event.transaction.to
    ? String(event.transaction.to).toLowerCase()
    : undefined;
  const id = `${event.transaction.hash}_${event.log.logIndex}`;
  const timestamp = event.block.timestamp; // already bigint
  const blockHeight = Number(event.block.number);

  // fatbera_deposit (APPEND) — envio fatbera.ts:151-164.
  await context.db
    .insert(fatberaDeposit)
    .values({
      id,
      collectionKey: COLLECTION_KEY,
      depositor,
      recipient,
      amount: assets,
      shares,
      transactionFrom: transactionFrom ?? null,
      timestamp,
      blockNumber: event.block.number, // already bigint
      transactionHash: event.transaction.hash,
      chainId: context.chain.id,
    })
    .onConflictDoNothing();

  // recordAction("deposit") — envio fatbera.ts:166-182.
  await recordAction(context, {
    id,
    actionType: "deposit",
    actor: depositor,
    primaryCollection: COLLECTION_KEY,
    timestamp,
    chainId: context.chain.id,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    numeric1: assets,
    numeric2: shares,
    context: {
      recipient,
      transactionFrom,
      contract: event.log.address.toLowerCase(),
    },
  });

  if (blockHeight < FATBERA_DEPOSIT_TRACKING_START_BLOCK) {
    return;
  }

  // Router-originated deposits are handled by ValidatorDepositRouter; skip here
  // to avoid double-counting (envio fatbera.ts:188-190).
  if (transactionTo === VALIDATOR_DEPOSIT_ROUTER_ADDRESS) {
    return;
  }

  // Read the latest deposit singleton for each active validator BEFORE
  // computing the distribution (envio primed these in the preload; here we read
  // them inline — independent per-pubkey keys, safe to read in parallel).
  const activeValidators = getActiveValidators(blockHeight);
  const validatorDepositsLatest: (LatestValidatorDepositRow | null)[] =
    await Promise.all(
      activeValidators.map((v) =>
        context.db.find(latestValidatorDeposit, { id: v.pubkey })
      )
    );

  const states = activeValidators
    .map((validatorInfo, i) => {
      const previousDeposit = validatorDepositsLatest[i];
      if (!previousDeposit) return undefined;
      return {
        validatorInfo,
        totalDeposited: previousDeposit.totalDeposited,
        outstandingFatBERA: previousDeposit.outstandingFatBera,
        previousDeposit,
      };
    })
    .filter((state): state is NonNullable<typeof state> => state !== undefined);

  const assignments = calculateDirectDepositAssignments({
    amount: assets,
    blockHeight,
    states,
  });

  // Sequential write loop — each write targets a DISTINCT validator pubkey, so
  // there is no read-after-write hazard within this event (envio fatbera.ts:212-237).
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

    await writeValidatorDeposit(
      context,
      buildValidatorDepositRecord({
        pubkey: assignment.validatorInfo.pubkey,
        blockHeight,
        timestamp,
        depositAmount: 0n,
        totalDeposited: previousDeposit.totalDeposited,
        depositCount: previousDeposit.depositCount,
        outstandingFatBera:
          previousDeposit.outstandingFatBera + assignment.shareToAdd,
      })
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════
// handleBeaconDeposit — BeaconDeposit:Deposit (envio fatbera.ts:241-275)
//   NON-indexed bytes pubkey → raw value. Tracks a validator's beacon deposit
//   (gwei→wei) accumulating totalDeposited + depositCount.
// ═════════════════════════════════════════════════════════════════════════
ponder.on("BeaconDeposit:Deposit", async ({ event, context }) => {
  const validatorInfo = isTrackedValidatorPubkey(event.args.pubkey);
  if (!validatorInfo) {
    return;
  }

  const previousDeposit = await context.db.find(latestValidatorDeposit, {
    id: validatorInfo.pubkey,
  });

  const currentOutstandingFatBERA =
    previousDeposit?.outstandingFatBera ??
    (validatorInfo.pubkey === VALIDATORS[1].pubkey
      ? VALIDATOR_2_GENESIS_BALANCE
      : 0n);

  // amount is uint64 → bigint already (envio: BigInt(amount.toString()) * GWEI_TO_WEI).
  const depositAmountWei = event.args.amount * GWEI_TO_WEI;

  await writeValidatorDeposit(
    context,
    buildValidatorDepositRecord({
      pubkey: validatorInfo.pubkey,
      blockHeight: Number(event.block.number),
      timestamp: event.block.timestamp,
      depositAmount: depositAmountWei,
      totalDeposited: (previousDeposit?.totalDeposited ?? 0n) + depositAmountWei,
      depositCount: (previousDeposit?.depositCount ?? 0) + 1,
      outstandingFatBera: currentOutstandingFatBERA,
    })
  );
});

// ═════════════════════════════════════════════════════════════════════════
// handleBlockRewardProcessed — BlockRewardController:BlockRewardProcessed
//   (envio fatbera.ts:277-340) — THE 906,771-row producer.
//   INDEXED bytes pubkey → keccak-hash topic, matched against VALIDATORS[i].id.
//   Reward-split depends on latest_validator_deposit.totalDeposited (read FIRST)
//   + latest_validator_reward running totals (read FIRST). Order-sensitive.
// ═════════════════════════════════════════════════════════════════════════
ponder.on(
  "BlockRewardController:BlockRewardProcessed",
  async ({ event, context }) => {
    const validatorInfo = VALIDATORS.find(
      (validator) => validator.id === event.args.pubkey.toLowerCase()
    );
    if (!validatorInfo) {
      return;
    }

    const blockNumber = Number(event.block.number);
    const isValidator4 = validatorInfo.pubkey === VALIDATORS[3].pubkey;
    if (isValidator4 && blockNumber < 8103108) {
      return;
    }

    // Read BOTH singletons BEFORE computing — the reward-split needs the latest
    // deposit's totalDeposited and the running reward totals (envio fatbera.ts:292-295).
    const [previousRewards, depositRecord] = await Promise.all([
      context.db.find(latestValidatorReward, { id: validatorInfo.pubkey }),
      context.db.find(latestValidatorDeposit, { id: validatorInfo.pubkey }),
    ]);

    if (!depositRecord || depositRecord.totalDeposited === 0n) {
      return;
    }

    const baseRate = event.args.baseRate; // uint256 → bigint
    const rewardSplit = calculateRewardSplit({
      baseRate,
      totalDeposited: depositRecord.totalDeposited,
      validatorPubkey: validatorInfo.pubkey,
      blockHeight: blockNumber,
    });

    const reward: ValidatorBlockRewardsRow = {
      id: `${blockNumber}_${validatorInfo.pubkey}`,
      pubkey: validatorInfo.pubkey,
      blockHeight: blockNumber,
      totalBlockRewards: (previousRewards?.totalBlockRewards ?? 0n) + baseRate,
      timestamp: event.block.timestamp,
      nextTimestamp: event.args.nextTimestamp, // uint64 → bigint
      baseRate,
      rewardRate: event.args.rewardRate, // uint256 → bigint
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

    await writeValidatorReward(context, reward);
  }
);

// ═════════════════════════════════════════════════════════════════════════
// handleFatBeraRewardAdded — FatBeraAccounting:RewardAdded (envio fatbera.ts:342-382)
//   Distributes a WBERA reward across validators proportional to their
//   outstandingStakerRewards. Reads ALL validators' latest reward singletons
//   FIRST (the denominator = sum of outstandingStakerRewards), then writes each
//   reduced by its proportional share. Order-sensitive (per-pubkey distinct writes).
// ═════════════════════════════════════════════════════════════════════════
ponder.on("FatBeraAccounting:RewardAdded", async ({ event, context }) => {
  if (event.args.token.toLowerCase() !== WBERA_ADDRESS) {
    return;
  }

  // Read every validator's latest reward singleton BEFORE computing the
  // denominator (envio fatbera.ts:349-353 — independent per-pubkey keys).
  const latestRewards = (
    await Promise.all(
      VALIDATORS.map((validator) =>
        context.db.find(latestValidatorReward, { id: validator.pubkey })
      )
    )
  ).filter(
    (reward): reward is LatestValidatorRewardRow => reward !== undefined && reward !== null
  );

  let totalOutstandingRewards = 0n;
  for (const reward of latestRewards) {
    totalOutstandingRewards += reward.outstandingStakerRewards;
  }

  if (totalOutstandingRewards === 0n || latestRewards.length === 0) {
    return;
  }

  const rewardAmount = event.args.rewardAmount; // uint256 → bigint
  const blockNumber = Number(event.block.number);
  for (const currentReward of latestRewards) {
    const validatorShare =
      (currentReward.outstandingStakerRewards * rewardAmount) /
      totalOutstandingRewards;
    await writeValidatorReward(context, {
      ...currentReward,
      id: `${blockNumber}_${currentReward.pubkey}`,
      blockHeight: blockNumber,
      timestamp: event.block.timestamp,
      outstandingStakerRewards:
        currentReward.outstandingStakerRewards - validatorShare,
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// handleAutomatedStakeExecution — AutomatedStake:WithdrawUnwrapAndStakeExecuted
//   (envio fatbera.ts:384-435). INDEXED bytes pubkey → id-hash match, falls back
//   to validatorIndex. Decrements the validator's outstandingFatBERA by the
//   executed amount (floored at 0).
// ═════════════════════════════════════════════════════════════════════════
ponder.on(
  "AutomatedStake:WithdrawUnwrapAndStakeExecuted",
  async ({ event, context }) => {
    const blockNumber = Number(event.block.number);
    if (blockNumber < FATBERA_DEPOSIT_TRACKING_START_BLOCK) {
      return;
    }

    let validatorInfo = VALIDATORS.find(
      (validator) => validator.id === event.args.pubkey.toLowerCase()
    );
    if (!validatorInfo) {
      const validatorIndex = Number(event.args.validatorIndex);
      validatorInfo = VALIDATORS[validatorIndex];
    }
    if (!validatorInfo) {
      return;
    }

    const previousDeposit = await context.db.find(latestValidatorDeposit, {
      id: validatorInfo.pubkey,
    });

    if (!previousDeposit) {
      return;
    }

    const executedAmount = event.args.amount; // uint256 → bigint
    const outstandingFatBERA =
      previousDeposit.outstandingFatBera > executedAmount
        ? previousDeposit.outstandingFatBera - executedAmount
        : 0n;

    await writeValidatorDeposit(
      context,
      buildValidatorDepositRecord({
        pubkey: validatorInfo.pubkey,
        blockHeight: blockNumber,
        timestamp: event.block.timestamp,
        depositAmount: 0n,
        totalDeposited: previousDeposit.totalDeposited,
        depositCount: previousDeposit.depositCount,
        outstandingFatBera: outstandingFatBERA,
      })
    );
  }
);

// ═════════════════════════════════════════════════════════════════════════
// handleFatBeraWithdrawalRequested — FatBeraAccounting:WithdrawalRequested
//   (envio fatbera.ts:437-487). Appends a withdrawal_request + accrues the
//   batch's uniqueUsers/userAddresses/totalAmount (reads existing requests for
//   the batch). status flips open→full at MAX_USERS_PER_BATCH.
// ═════════════════════════════════════════════════════════════════════════
ponder.on("FatBeraAccounting:WithdrawalRequested", async ({ event, context }) => {
  const batchId = event.args.batchId.toString();
  let batch = await context.db.find(withdrawalBatch, { id: batchId });
  let batchRow = batch
    ? {
        id: batch.id,
        batchId: batch.batchId,
        totalAmount: batch.totalAmount,
        startTime: batch.startTime,
        uniqueUsers: batch.uniqueUsers,
        userAddresses: batch.userAddresses,
        blockHeight: batch.blockHeight,
        transactionHash: batch.transactionHash,
        status: batch.status,
        predictedWithdrawalBlock: batch.predictedWithdrawalBlock,
      }
    : {
        id: batchId,
        batchId: Number(event.args.batchId),
        totalAmount: 0n,
        startTime: event.block.timestamp,
        uniqueUsers: 0,
        userAddresses: "[]",
        blockHeight: Number(event.block.number),
        transactionHash: event.transaction.hash,
        status: "open",
        predictedWithdrawalBlock: 0,
      };

  // Read existing requests for the batch BEFORE appending the new one (the
  // accrual must reflect the new request + all prior — envio fatbera.ts:456-475).
  const existingRequests = await getWithdrawalRequestsForBatch(context, batchId);

  const newRequestAmount = event.args.amount; // uint256 → bigint
  const newRequestUser = event.args.user.toLowerCase();
  const newRequestId = `${Number(event.block.number)}_${event.transaction.hash}_${event.log.logIndex}`;

  await context.db
    .insert(withdrawalRequest)
    .values({
      id: newRequestId,
      user: newRequestUser,
      batchId,
      amount: newRequestAmount,
      timestamp: event.block.timestamp,
      blockHeight: Number(event.block.number),
      transactionHash: event.transaction.hash,
    })
    .onConflictDoNothing();

  const requestUsers = new Set(existingRequests.map((request) => request.user));
  requestUsers.add(newRequestUser);

  let totalAmount = newRequestAmount;
  for (const request of existingRequests) {
    totalAmount += request.amount;
  }

  const uniqueUsers = Array.from(requestUsers);
  const status =
    uniqueUsers.length >= MAX_USERS_PER_BATCH && batchRow.status === "open"
      ? "full"
      : batchRow.status;

  const updatedBatch = {
    ...batchRow,
    totalAmount,
    uniqueUsers: uniqueUsers.length,
    userAddresses: JSON.stringify(uniqueUsers), // array_to_json_text
    status,
  };

  if (batch) {
    await context.db
      .update(withdrawalBatch, { id: batchId })
      .set({
        totalAmount: updatedBatch.totalAmount,
        uniqueUsers: updatedBatch.uniqueUsers,
        userAddresses: updatedBatch.userAddresses,
        status: updatedBatch.status,
      });
  } else {
    await context.db
      .insert(withdrawalBatch)
      .values(updatedBatch)
      .onConflictDoNothing();
  }
});

// ═════════════════════════════════════════════════════════════════════════
// handleFatBeraBatchStarted — FatBeraAccounting:BatchStarted (envio fatbera.ts:489-538)
//   Marks the batch pending (predictedWithdrawalBlock) + opens the NEXT batch
//   if absent. Recomputes uniqueUsers/userAddresses from existing requests when
//   creating the row fresh.
// ═════════════════════════════════════════════════════════════════════════
ponder.on("FatBeraAccounting:BatchStarted", async ({ event, context }) => {
  const batchId = event.args.batchId.toString();
  const [existingBatch, batchRequests] = await Promise.all([
    context.db.find(withdrawalBatch, { id: batchId }),
    getWithdrawalRequestsForBatch(context, batchId),
  ]);
  const uniqueUsers = Array.from(
    new Set(batchRequests.map((request) => request.user))
  );

  if (existingBatch) {
    await context.db
      .update(withdrawalBatch, { id: batchId })
      .set({
        status: "pending",
        predictedWithdrawalBlock: predictWithdrawalBlock(Number(event.block.number)),
      });
  } else {
    await context.db
      .insert(withdrawalBatch)
      .values({
        id: batchId,
        batchId: Number(event.args.batchId),
        totalAmount: event.args.totalAmount, // uint256 → bigint
        startTime: event.block.timestamp,
        uniqueUsers: uniqueUsers.length,
        userAddresses: JSON.stringify(uniqueUsers), // array_to_json_text
        blockHeight: Number(event.block.number),
        transactionHash: event.transaction.hash,
        status: "pending",
        predictedWithdrawalBlock: predictWithdrawalBlock(Number(event.block.number)),
      })
      .onConflictDoNothing();
  }

  // Open the NEXT batch if it doesn't exist yet (envio fatbera.ts:521-536).
  const nextBatchId = String(Number(event.args.batchId) + 1);
  const nextBatch = await context.db.find(withdrawalBatch, { id: nextBatchId });
  if (!nextBatch) {
    await context.db
      .insert(withdrawalBatch)
      .values({
        id: nextBatchId,
        batchId: Number(nextBatchId),
        totalAmount: 0n,
        startTime: event.block.timestamp,
        uniqueUsers: 0,
        userAddresses: "[]",
        blockHeight: Number(event.block.number),
        transactionHash: event.transaction.hash,
        status: "open",
        predictedWithdrawalBlock: 0,
      })
      .onConflictDoNothing();
  }
});

// ═════════════════════════════════════════════════════════════════════════
// handleFatBeraWithdrawalFulfilled — FatBeraAccounting:WithdrawalFulfilled
//   (envio fatbera.ts:540-565). Flips a pending batch → fulfilled + appends a
//   withdrawal_fulfillment row.
// ═════════════════════════════════════════════════════════════════════════
ponder.on("FatBeraAccounting:WithdrawalFulfilled", async ({ event, context }) => {
  const batchId = event.args.batchId.toString();
  const batch = await context.db.find(withdrawalBatch, { id: batchId });
  if (!batch) {
    return;
  }

  if (batch.status === "pending") {
    await context.db
      .update(withdrawalBatch, { id: batchId })
      .set({ status: "fulfilled" });
  }

  await context.db
    .insert(withdrawalFulfillment)
    .values({
      id: `${Number(event.block.number)}_${event.transaction.hash}_${event.log.logIndex}`,
      user: event.args.user.toLowerCase(),
      batchId,
      amount: event.args.amount, // uint256 → bigint
      timestamp: event.block.timestamp,
      blockHeight: Number(event.block.number),
      transactionHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});

// ═════════════════════════════════════════════════════════════════════════
// handleValidatorWithdrawalRequested — ValidatorWithdrawalModule:ValidatorWithdrawalRequested
//   (envio fatbera.ts:567-627). INDEXED bytes cometBFTPublicKey → id-hash match.
//   Accrues validator_withdrawal_totals (additive count/withdrawn/fees + LWW
//   last-withdrawal snapshot) AND decrements the deposit totalDeposited by
//   (withdrawAmount + fee). Reads both singletons FIRST.
// ═════════════════════════════════════════════════════════════════════════
ponder.on(
  "ValidatorWithdrawalModule:ValidatorWithdrawalRequested",
  async ({ event, context }) => {
    const validatorId = event.args.cometBFTPublicKey.toLowerCase();
    const validatorInfo = VALIDATORS.find(
      (validator) => validator.id === validatorId
    );
    if (!validatorInfo) {
      return;
    }

    // Read both BEFORE computing (envio fatbera.ts:577-580 — independent keys).
    const [existingTotals, previousDeposit] = await Promise.all([
      context.db.find(validatorWithdrawalTotals, { id: validatorInfo.pubkey }),
      context.db.find(latestValidatorDeposit, { id: validatorInfo.pubkey }),
    ]);

    const withdrawalAmount = event.args.withdrawAmount; // uint256 → bigint
    const feeAmount = event.args.fee; // uint256 → bigint

    const totalsValues = {
      cometBftPublicKey: validatorId,
      totalWithdrawn: (existingTotals?.totalWithdrawn ?? 0n) + withdrawalAmount,
      withdrawalCount: (existingTotals?.withdrawalCount ?? 0) + 1,
      totalFees: (existingTotals?.totalFees ?? 0n) + feeAmount,
      lastWithdrawalAmount: withdrawalAmount,
      lastWithdrawalBlock: Number(event.block.number),
      lastWithdrawalTimestamp: event.block.timestamp,
      lastWithdrawalSafe: event.args.safe.toLowerCase(),
      lastWithdrawalInitiator: event.args.initiator.toLowerCase(),
    };

    if (existingTotals) {
      await context.db
        .update(validatorWithdrawalTotals, { id: validatorInfo.pubkey })
        .set(totalsValues);
    } else {
      await context.db
        .insert(validatorWithdrawalTotals)
        .values({ id: validatorInfo.pubkey, ...totalsValues })
        .onConflictDoNothing();
    }

    if (!previousDeposit) {
      return;
    }

    const totalAmountRemoved = withdrawalAmount + feeAmount;
    await writeValidatorDeposit(
      context,
      buildValidatorDepositRecord({
        pubkey: validatorInfo.pubkey,
        blockHeight: Number(event.block.number),
        timestamp: event.block.timestamp,
        depositAmount: 0n,
        totalDeposited:
          previousDeposit.totalDeposited > totalAmountRemoved
            ? previousDeposit.totalDeposited - totalAmountRemoved
            : 0n,
        depositCount: previousDeposit.depositCount,
        outstandingFatBera: previousDeposit.outstandingFatBera,
      })
    );
  }
);

// ═════════════════════════════════════════════════════════════════════════
// handleValidatorDepositRequested — ValidatorDepositRouter:ValidatorDepositRequested
//   (envio fatbera.ts:629-747). validatorIndex (uint256) → VALIDATORS[index].
//   Adds the deposit to the target validator up to its remaining capacity (10M
//   fatBERA cap), then redistributes the overflow across the other validators
//   proportionally. Reads ALL active validators' latest deposit singletons FIRST.
// ═════════════════════════════════════════════════════════════════════════
ponder.on(
  "ValidatorDepositRouter:ValidatorDepositRequested",
  async ({ event, context }) => {
    const blockNumber = Number(event.block.number);
    if (blockNumber < FATBERA_DEPOSIT_TRACKING_START_BLOCK) {
      return;
    }

    const validatorIndex = Number(event.args.validatorIndex);
    const validatorInfo = VALIDATORS[validatorIndex];
    if (!validatorInfo) {
      return;
    }

    // Read all active validators' latest deposit singletons BEFORE computing
    // (envio fatbera.ts:643-648 — independent per-pubkey keys).
    const activeValidators = getActiveValidators(blockNumber);
    const allDeposits: (LatestValidatorDepositRow | null)[] =
      await Promise.all(
        activeValidators.map((validator) =>
          context.db.find(latestValidatorDeposit, { id: validator.pubkey })
        )
      );

    const targetIdx = activeValidators.findIndex(
      (v) => v.pubkey === validatorInfo.pubkey
    );
    const previousDeposit = targetIdx >= 0 ? allDeposits[targetIdx] : undefined;
    if (!previousDeposit) {
      return;
    }

    const depositAmount = event.args.amount; // uint256 → bigint
    const totalCurrentAmount =
      previousDeposit.totalDeposited + previousDeposit.outstandingFatBera;
    const remainingCapacity =
      10_000_000n * 10n ** 18n > totalCurrentAmount
        ? 10_000_000n * 10n ** 18n - totalCurrentAmount
        : 0n;
    const amountToAdd =
      depositAmount <= remainingCapacity ? depositAmount : remainingCapacity;
    const amountToRedistribute = depositAmount - amountToAdd;

    if (amountToAdd > 0n) {
      await writeValidatorDeposit(
        context,
        buildValidatorDepositRecord({
          pubkey: validatorInfo.pubkey,
          blockHeight: blockNumber,
          timestamp: event.block.timestamp,
          depositAmount: 0n,
          totalDeposited: previousDeposit.totalDeposited,
          depositCount: previousDeposit.depositCount,
          outstandingFatBera: previousDeposit.outstandingFatBera + amountToAdd,
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
          outstandingFatBERA: latestDeposit.outstandingFatBera,
          previousDeposit: latestDeposit,
        };
      })
      .filter((state): state is NonNullable<typeof state> => state !== undefined);

    const assignments = calculateRouterRedistributionAssignments({
      amountToRedistribute,
      blockHeight: blockNumber,
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

      await writeValidatorDeposit(
        context,
        buildValidatorDepositRecord({
          pubkey: assignment.validatorInfo.pubkey,
          blockHeight: blockNumber,
          timestamp: event.block.timestamp,
          depositAmount: 0n,
          totalDeposited: previousState.previousDeposit.totalDeposited,
          depositCount: previousState.previousDeposit.depositCount,
          outstandingFatBera:
            previousState.previousDeposit.outstandingFatBera +
            assignment.shareToAdd,
          suffix: "redistribution",
        })
      );
    }
  }
);
