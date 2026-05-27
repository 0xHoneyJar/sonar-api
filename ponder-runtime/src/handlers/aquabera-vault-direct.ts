// ponder-runtime/src/handlers/aquabera-vault-direct.ts
//
// PORTED FROM: src/handlers/aquabera-vault-direct.ts (envio, source-of-truth)
// Contract: AquaberaVaultDirect (Berachain 80094, single deploy at 0x04fD…34f8)
//
// F-6 re-dispatch: ACTIVE.
//
// The vault is a Uniswap V3-style WBERA/HENLO LP pool. Direct Deposit/Withdraw
// events (NOT forwarder-routed) are captured here. Forwarder-routed deposits
// emit a separate DepositForwarded event that envio tracks via aquabera-wall.ts
// (NOT ported in this sprint — different contract).
//
// Key semantics:
//   - amount0 = WBERA (token0); amount1 = HENLO (token1, often 0 single-sided)
//   - shares = LP tokens minted/burned
//   - We persist WBERA amount (NOT LP tokens) into AquaberaDeposit.amount, per
//     envio comment: "Store WBERA amount, not LP tokens".
//   - We SKIP events where sender == the forwarder address (handled separately).
//   - Wall-contribution detection checks sender / recipient / txFrom against
//     the wall contract address.
//
// Subject: none — aquabera doesn't publish NATS envelopes.

import { ponder } from "ponder:registry";
import {
  aquaberaDeposit,
  aquaberaWithdrawal,
  aquaberaBuilder,
  aquaberaStats,
} from "../../ponder.schema";
import { recordAction } from "../lib/record-action";

const WALL_CONTRACT_ADDRESS = "0x05c98986fc75d63ef973c648f22687d1a8056cd6";
const FORWARDER_ADDRESS = "0xc0c6d4178410849ec9765b4267a73f4f64241832";
const BERACHAIN_ID = 80094;
const STATS_ID = "global";

// ────────────────────────────────────────────────────────────────────────────
// Deposit
//   event Deposit(address indexed sender, address indexed to,
//                 uint256 shares, uint256 amount0, uint256 amount1)
// ────────────────────────────────────────────────────────────────────────────
ponder.on("AquaberaVaultDirect:Deposit", async ({ event, context }) => {
  const timestamp = event.block.timestamp;
  const sender = event.args.sender.toLowerCase();
  const recipient = event.args.to.toLowerCase();
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  // Skip forwarder-routed events — those are tracked separately by aquabera-wall.
  if (sender === FORWARDER_ADDRESS) return;

  const lpTokensReceived = event.args.shares;
  const wberaAmount = event.args.amount0;
  const henloAmount = event.args.amount1;

  const txFromRaw = event.transaction.from ?? null;
  const txFrom = txFromRaw ? txFromRaw.toLowerCase() : null;
  const isWallContribution =
    sender === WALL_CONTRACT_ADDRESS ||
    recipient === WALL_CONTRACT_ADDRESS ||
    (txFrom !== null && txFrom === WALL_CONTRACT_ADDRESS);

  const depositId = `${txHash}_${logIndex}`;

  await context.db
    .insert(aquaberaDeposit)
    .values({
      id: depositId,
      amount: wberaAmount,
      shares: lpTokensReceived,
      timestamp,
      blockNumber: event.block.number,
      transactionHash: txHash as `0x${string}`,
      from: (txFrom ?? sender) as `0x${string}`,
      isWallContribution,
      chainId: BERACHAIN_ID,
    })
    .onConflictDoNothing();

  // Builder upsert
  const builderId = sender;
  const existingBuilder = await context.db.find(aquaberaBuilder, { id: builderId });

  if (existingBuilder) {
    await context.db
      .update(aquaberaBuilder, { id: builderId })
      .set({
        totalDeposited: existingBuilder.totalDeposited + wberaAmount,
        netDeposited: existingBuilder.netDeposited + wberaAmount,
        currentShares: existingBuilder.currentShares + lpTokensReceived,
        depositCount: existingBuilder.depositCount + 1,
        lastActivityTime: timestamp,
        isWallContract:
          existingBuilder.isWallContract || builderId === WALL_CONTRACT_ADDRESS,
      });
  } else {
    await context.db
      .insert(aquaberaBuilder)
      .values({
        id: builderId,
        address: builderId as `0x${string}`,
        totalDeposited: wberaAmount,
        totalWithdrawn: 0n,
        netDeposited: wberaAmount,
        currentShares: lpTokensReceived,
        depositCount: 1,
        withdrawalCount: 0,
        firstDepositTime: timestamp,
        lastActivityTime: timestamp,
        isWallContract: builderId === WALL_CONTRACT_ADDRESS,
        chainId: BERACHAIN_ID,
      })
      .onConflictDoNothing();
  }

  // Stats upsert — uniqueBuilders increments only if this is a new builder
  const uniqueBuildersIncrement = !existingBuilder || existingBuilder.depositCount === 0 ? 1 : 0;
  const existingStats = await context.db.find(aquaberaStats, { id: STATS_ID });
  if (existingStats) {
    await context.db
      .update(aquaberaStats, { id: STATS_ID })
      .set({
        totalBera: existingStats.totalBera + wberaAmount,
        totalShares: existingStats.totalShares + lpTokensReceived,
        totalDeposited: existingStats.totalDeposited + wberaAmount,
        uniqueBuilders: existingStats.uniqueBuilders + uniqueBuildersIncrement,
        depositCount: existingStats.depositCount + 1,
        wallContributions: isWallContribution
          ? existingStats.wallContributions + wberaAmount
          : existingStats.wallContributions,
        wallDepositCount: isWallContribution
          ? existingStats.wallDepositCount + 1
          : existingStats.wallDepositCount,
        lastUpdateTime: timestamp,
      });
  } else {
    await context.db
      .insert(aquaberaStats)
      .values({
        id: STATS_ID,
        totalBera: wberaAmount,
        totalShares: lpTokensReceived,
        totalDeposited: wberaAmount,
        totalWithdrawn: 0n,
        uniqueBuilders: 1,
        depositCount: 1,
        withdrawalCount: 0,
        wallContributions: isWallContribution ? wberaAmount : 0n,
        wallDepositCount: isWallContribution ? 1 : 0,
        lastUpdateTime: timestamp,
        chainId: BERACHAIN_ID,
      })
      .onConflictDoNothing();
  }

  await recordAction(context, {
    id: depositId,
    actionType: "deposit",
    actor: sender,
    primaryCollection: "henlo_build",
    timestamp,
    chainId: BERACHAIN_ID,
    txHash,
    logIndex,
    numeric1: wberaAmount,
    numeric2: lpTokensReceived,
    context: {
      vault: event.log.address.toLowerCase(),
      recipient,
      henloAmount: henloAmount.toString(),
      isWallContribution,
      txFrom,
      forwarder: false,
    },
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Withdraw
//   event Withdraw(address indexed sender, address indexed to,
//                  uint256 shares, uint256 amount0, uint256 amount1)
// ────────────────────────────────────────────────────────────────────────────
ponder.on("AquaberaVaultDirect:Withdraw", async ({ event, context }) => {
  const timestamp = event.block.timestamp;
  const sender = event.args.sender.toLowerCase();
  const recipient = event.args.to.toLowerCase();
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  if (sender === FORWARDER_ADDRESS) return;

  const lpTokensBurned = event.args.shares;
  const wberaReceived = event.args.amount0;
  const henloReceived = event.args.amount1;

  const withdrawalId = `${txHash}_${logIndex}`;

  await context.db
    .insert(aquaberaWithdrawal)
    .values({
      id: withdrawalId,
      amount: wberaReceived,
      shares: lpTokensBurned,
      timestamp,
      blockNumber: event.block.number,
      transactionHash: txHash as `0x${string}`,
      from: sender as `0x${string}`,
      chainId: BERACHAIN_ID,
    })
    .onConflictDoNothing();

  // Builder — only update if existing (envio doesn't auto-create on withdraw).
  const existingBuilder = await context.db.find(aquaberaBuilder, { id: sender });
  if (existingBuilder) {
    const newNetDeposited =
      existingBuilder.netDeposited > wberaReceived
        ? existingBuilder.netDeposited - wberaReceived
        : 0n;
    const newCurrentShares =
      existingBuilder.currentShares > lpTokensBurned
        ? existingBuilder.currentShares - lpTokensBurned
        : 0n;
    await context.db
      .update(aquaberaBuilder, { id: sender })
      .set({
        totalWithdrawn: existingBuilder.totalWithdrawn + wberaReceived,
        netDeposited: newNetDeposited,
        currentShares: newCurrentShares,
        withdrawalCount: existingBuilder.withdrawalCount + 1,
        lastActivityTime: timestamp,
      });
  }

  // Stats — only update if existing.
  const existingStats = await context.db.find(aquaberaStats, { id: STATS_ID });
  if (existingStats) {
    const newTotalBera =
      existingStats.totalBera > wberaReceived
        ? existingStats.totalBera - wberaReceived
        : 0n;
    const newTotalShares =
      existingStats.totalShares > lpTokensBurned
        ? existingStats.totalShares - lpTokensBurned
        : 0n;
    await context.db
      .update(aquaberaStats, { id: STATS_ID })
      .set({
        totalBera: newTotalBera,
        totalShares: newTotalShares,
        totalWithdrawn: existingStats.totalWithdrawn + wberaReceived,
        withdrawalCount: existingStats.withdrawalCount + 1,
        lastUpdateTime: timestamp,
      });
  }

  await recordAction(context, {
    id: withdrawalId,
    actionType: "withdraw",
    actor: sender,
    primaryCollection: "henlo_build",
    timestamp,
    chainId: BERACHAIN_ID,
    txHash,
    logIndex,
    numeric1: wberaReceived,
    numeric2: lpTokensBurned,
    context: {
      vault: event.log.address.toLowerCase(),
      recipient,
      henloReceived: henloReceived.toString(),
    },
  });
});
