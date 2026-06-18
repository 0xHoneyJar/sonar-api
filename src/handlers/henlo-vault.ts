/*
 * HenloVault Event Handlers
 *
 * Handles two systems:
 * 1. HENLOCKED token mints - Tracks initial token distribution via TrackedTokenBalance
 * 2. Henlocker vault system - Tracks rounds, deposits, balances, epochs, and stats
 */

import {
  indexer,
  type TrackedTokenBalance,
  type HenloVaultRound,
  type HenloVaultDeposit,
  type HenloVaultBalance,
  type HenloVaultEpoch,
  type HenloVaultStats,
  type HenloVaultUser,
} from "envio";

// Map strike values to HENLOCKED token addresses and keys
// Strike represents FDV target in thousands (e.g., 100000 = $100M FDV)
const STRIKE_TO_TOKEN: Record<string, { address: string; key: string }> = {
  "20000": {
    address: "0x4c9c76d10b1fa7d8f93ba54ab48e890ff0a7660d",
    key: "hlkd20m",
  },
  "100000": {
    address: "0x7bdf98ddeed209cfa26bd2352b470ac8b5485ec5",
    key: "hlkd100m",
  },
  "330000": {
    address: "0x37dd8850919ebdca911c383211a70839a94b0539",
    key: "hlkd330m",
  },
  "420000": {
    address: "0xf07fa3ece9741d408d643748ff85710bedef25ba",
    key: "hlkd420m",
  },
  "690000": {
    address: "0x8ab854dc0672d7a13a85399a56cb628fb22102d6",
    key: "hlkd690m",
  },
  "1000000": {
    address: "0xf0edfc3e122db34773293e0e5b2c3a58492e7338",
    key: "hlkd1b",
  },
};

// ============================
// Helper Functions
// ============================

// Map strike values to their epochIds (based on contract deployment order)
const STRIKE_TO_EPOCH: Record<string, number> = {
  "100000": 1,
  "330000": 2,
  "420000": 3,
  "690000": 4,
  "1000000": 5,
  "20000": 6,
};

/**
 * Find the active round for a given strike
 * Uses the known strike-to-epoch mapping since each strike has one epoch
 */
async function findRoundByStrike(
  context: any,
  strike: bigint,
  chainId: number
): Promise<HenloVaultRound | undefined> {
  const strikeKey = strike.toString();
  const epochId = STRIKE_TO_EPOCH[strikeKey];

  if (epochId === undefined) {
    // Unknown strike, return undefined
    return undefined;
  }

  const roundId = `${strike}_${epochId}_${chainId}`;
  return await context.HenloVaultRound.get(roundId);
}

/**
 * Get or create HenloVaultStats singleton for a chain
 */
async function getOrCreateStats(
  context: any,
  chainId: number,
  timestamp: bigint
): Promise<HenloVaultStats> {
  const statsId = chainId.toString();
  let stats = await context.HenloVaultStats.get(statsId);

  if (!stats) {
    stats = {
      id: statsId,
      totalDeposits: BigInt(0),
      totalUsers: 0,
      totalRounds: 0,
      totalEpochs: 0,
      chainId,
    };
  }

  return stats;
}

/**
 * Get or create HenloVaultUser for tracking unique depositors
 */
async function getOrCreateUser(
  context: any,
  user: string,
  chainId: number,
  timestamp: bigint
): Promise<{ vaultUser: HenloVaultUser; isNew: boolean }> {
  const userId = `${user}_${chainId}`;
  let vaultUser = await context.HenloVaultUser.get(userId);
  const isNew = !vaultUser;

  if (!vaultUser) {
    vaultUser = {
      id: userId,
      user,
      firstDepositTime: timestamp,
      lastActivityTime: timestamp,
      chainId,
    };
  }

  return { vaultUser, isNew };
}

// ============================
// HENLOCKED Token Mint Handler
// ============================

/**
 * Handles HenloVault Mint events
 * Creates/updates TrackedTokenBalance for the user when they receive HENLOCKED tokens
 * Also creates deposit records for the Henlocker vault system
 */
indexer.onEvent(
  { contract: "HenloVault", event: "Mint" },
  async ({ event, context }) => {
    const { user, strike, amount } = event.params;
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;
    const userLower = user.toLowerCase();

    // Get token info from strike value
    const strikeKey = strike.toString();
    const tokenInfo = STRIKE_TO_TOKEN[strikeKey];

    if (!tokenInfo) {
      // Unknown strike value, skip
      context.log.warn(`Unknown HenloVault strike value: ${strikeKey}`);
      return;
    }

    const { address: tokenAddress, key: tokenKey } = tokenInfo;

    // 1. Update TrackedTokenBalance (HENLOCKED token tracking)
    const balanceId = `${userLower}_${tokenAddress}_${chainId}`;
    const existingBalance = await context.TrackedTokenBalance.get(balanceId);

    if (existingBalance) {
      const updatedBalance: TrackedTokenBalance = {
        ...existingBalance,
        balance: existingBalance.balance + amount,
        lastUpdated: timestamp,
      };
      context.TrackedTokenBalance.set(updatedBalance);
    } else {
      const newBalance: TrackedTokenBalance = {
        id: balanceId,
        address: userLower,
        tokenAddress,
        tokenKey,
        chainId,
        balance: amount,
        lastUpdated: timestamp,
      };
      context.TrackedTokenBalance.set(newBalance);
    }

    // 2. Create HenloVaultDeposit record
    const depositId = `${event.transaction.hash}_${event.logIndex}`;

    // Find the round for this strike using the strike-to-epoch mapping
    const round = await findRoundByStrike(context, strike, chainId);
    const epochId = round ? round.epochId : BigInt(STRIKE_TO_EPOCH[strikeKey] || 0);

    const deposit: HenloVaultDeposit = {
      id: depositId,
      user: userLower,
      strike: strike,
      epochId: epochId,
      amount: amount,
      timestamp: timestamp,
      transactionHash: event.transaction.hash,
      chainId,
    };
    context.HenloVaultDeposit.set(deposit);

    // 3. Update HenloVaultBalance
    const vaultBalanceId = `${userLower}_${strike}_${chainId}`;
    const existingVaultBalance = await context.HenloVaultBalance.get(vaultBalanceId);

    if (existingVaultBalance) {
      const updatedVaultBalance: HenloVaultBalance = {
        ...existingVaultBalance,
        balance: existingVaultBalance.balance + amount,
        lastUpdated: timestamp,
      };
      context.HenloVaultBalance.set(updatedVaultBalance);
    } else {
      const newVaultBalance: HenloVaultBalance = {
        id: vaultBalanceId,
        user: userLower,
        strike: strike,
        balance: amount,
        lastUpdated: timestamp,
        chainId,
      };
      context.HenloVaultBalance.set(newVaultBalance);
    }

    // 4. Update HenloVaultRound (if exists)
    if (round) {
      const updatedRound: HenloVaultRound = {
        ...round,
        totalDeposits: round.totalDeposits + amount,
        userDeposits: round.userDeposits + amount,
        remainingCapacity: round.depositLimit - (round.totalDeposits + amount),
      };
      context.HenloVaultRound.set(updatedRound);
    }

    // 5. Update HenloVaultStats
    const stats = await getOrCreateStats(context, chainId, timestamp);
    const { vaultUser, isNew } = await getOrCreateUser(context, userLower, chainId, timestamp);

    const updatedStats: HenloVaultStats = {
      ...stats,
      totalDeposits: stats.totalDeposits + amount,
      totalUsers: isNew ? stats.totalUsers + 1 : stats.totalUsers,
    };
    context.HenloVaultStats.set(updatedStats);

    // Update user activity
    const updatedUser: HenloVaultUser = {
      ...vaultUser,
      lastActivityTime: timestamp,
    };
    context.HenloVaultUser.set(updatedUser);
  }
);

// ============================
// Henlocker Vault Round Handlers
// ============================

/**
 * Handles RoundOpened events - Creates a new vault round
 */
indexer.onEvent(
  { contract: "HenloVault", event: "RoundOpened" },
  async ({ event, context }) => {
    const { epochId, strike, depositLimit } = event.params;
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;

    const roundId = `${strike}_${epochId}_${chainId}`;

    const round: HenloVaultRound = {
      id: roundId,
      strike: BigInt(strike),
      epochId: BigInt(epochId),
      exists: true,
      closed: false,
      depositsPaused: false,
      timestamp: timestamp,
      depositLimit: depositLimit,
      totalDeposits: BigInt(0),
      whaleDeposits: BigInt(0),
      userDeposits: BigInt(0),
      remainingCapacity: depositLimit,
      canRedeem: false,
      chainId,
    };

    context.HenloVaultRound.set(round);

    // Update stats
    const stats = await getOrCreateStats(context, chainId, timestamp);
    const updatedStats: HenloVaultStats = {
      ...stats,
      totalRounds: stats.totalRounds + 1,
    };
    context.HenloVaultStats.set(updatedStats);
  }
);

/**
 * Handles RoundClosed events - Marks round as closed
 */
indexer.onEvent(
  { contract: "HenloVault", event: "RoundClosed" },
  async ({ event, context }) => {
    const { epochId, strike } = event.params;
    const chainId = event.chainId;

    const roundId = `${strike}_${epochId}_${chainId}`;
    const round = await context.HenloVaultRound.get(roundId);

    if (round) {
      const updatedRound: HenloVaultRound = {
        ...round,
        closed: true,
        canRedeem: true,
      };
      context.HenloVaultRound.set(updatedRound);
    }
  }
);

/**
 * Handles DepositsPaused events
 */
indexer.onEvent(
  { contract: "HenloVault", event: "DepositsPaused" },
  async ({ event, context }) => {
    const { epochId, strike } = event.params;
    const chainId = event.chainId;

    const roundId = `${strike}_${epochId}_${chainId}`;
    const round = await context.HenloVaultRound.get(roundId);

    if (round) {
      const updatedRound: HenloVaultRound = {
        ...round,
        depositsPaused: true,
      };
      context.HenloVaultRound.set(updatedRound);
    }

    // Also update epoch
    const epochEntityId = `${epochId}_${chainId}`;
    const epoch = await context.HenloVaultEpoch.get(epochEntityId);
    if (epoch) {
      const updatedEpoch: HenloVaultEpoch = {
        ...epoch,
        depositsPaused: true,
      };
      context.HenloVaultEpoch.set(updatedEpoch);
    }
  }
);

/**
 * Handles DepositsUnpaused events
 */
indexer.onEvent(
  { contract: "HenloVault", event: "DepositsUnpaused" },
  async ({ event, context }) => {
    const { epochId, strike } = event.params;
    const chainId = event.chainId;

    const roundId = `${strike}_${epochId}_${chainId}`;
    const round = await context.HenloVaultRound.get(roundId);

    if (round) {
      const updatedRound: HenloVaultRound = {
        ...round,
        depositsPaused: false,
      };
      context.HenloVaultRound.set(updatedRound);
    }

    // Also update epoch
    const epochEntityId = `${epochId}_${chainId}`;
    const epoch = await context.HenloVaultEpoch.get(epochEntityId);
    if (epoch) {
      const updatedEpoch: HenloVaultEpoch = {
        ...epoch,
        depositsPaused: false,
      };
      context.HenloVaultEpoch.set(updatedEpoch);
    }
  }
);

/**
 * Handles MintFromReservoir events - Whale/reservoir deposits
 */
indexer.onEvent(
  { contract: "HenloVault", event: "MintFromReservoir" },
  async ({ event, context }) => {
    const { reservoir, strike, amount } = event.params;
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;

    // Find the round for this strike using the strike-to-epoch mapping
    const round = await findRoundByStrike(context, strike, chainId);

    if (round) {
      const updatedRound: HenloVaultRound = {
        ...round,
        totalDeposits: round.totalDeposits + amount,
        whaleDeposits: round.whaleDeposits + amount,
        remainingCapacity: round.depositLimit - (round.totalDeposits + amount),
      };
      context.HenloVaultRound.set(updatedRound);
    }

    // Update stats
    const stats = await getOrCreateStats(context, chainId, timestamp);
    const updatedStats: HenloVaultStats = {
      ...stats,
      totalDeposits: stats.totalDeposits + amount,
    };
    context.HenloVaultStats.set(updatedStats);
  }
);

/**
 * Handles Redeem events - User withdrawals
 */
indexer.onEvent(
  { contract: "HenloVault", event: "Redeem" },
  async ({ event, context }) => {
    const { user, strike, amount } = event.params;
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;
    const userLower = user.toLowerCase();

    // Update HenloVaultBalance
    const vaultBalanceId = `${userLower}_${strike}_${chainId}`;
    const existingVaultBalance = await context.HenloVaultBalance.get(vaultBalanceId);

    if (existingVaultBalance) {
      const newBalance = existingVaultBalance.balance - amount;
      const updatedVaultBalance: HenloVaultBalance = {
        ...existingVaultBalance,
        balance: newBalance > BigInt(0) ? newBalance : BigInt(0),
        lastUpdated: timestamp,
      };
      context.HenloVaultBalance.set(updatedVaultBalance);
    }

    // Update user activity
    const userId = `${userLower}_${chainId}`;
    const vaultUser = await context.HenloVaultUser.get(userId);
    if (vaultUser) {
      const updatedUser: HenloVaultUser = {
        ...vaultUser,
        lastActivityTime: timestamp,
      };
      context.HenloVaultUser.set(updatedUser);
    }
  }
);

/**
 * Handles ReservoirSet events - Creates/updates epoch with reservoir
 */
indexer.onEvent(
  { contract: "HenloVault", event: "ReservoirSet" },
  async ({ event, context }) => {
    const { epochId, strike, reservoir } = event.params;
    const timestamp = BigInt(event.block.timestamp);
    const chainId = event.chainId;

    const epochEntityId = `${epochId}_${chainId}`;
    let epoch = await context.HenloVaultEpoch.get(epochEntityId);

    if (!epoch) {
      // Create new epoch
      epoch = {
        id: epochEntityId,
        epochId: BigInt(epochId),
        strike: BigInt(strike),
        closed: false,
        depositsPaused: false,
        timestamp: timestamp,
        depositLimit: BigInt(0),
        totalDeposits: BigInt(0),
        reservoir: reservoir.toLowerCase(),
        totalWhitelistDeposit: BigInt(0),
        totalMatched: BigInt(0),
        chainId,
      };

      // Update stats
      const stats = await getOrCreateStats(context, chainId, timestamp);
      const updatedStats: HenloVaultStats = {
        ...stats,
        totalEpochs: stats.totalEpochs + 1,
      };
      context.HenloVaultStats.set(updatedStats);
    } else {
      // Update existing epoch with reservoir
      epoch = {
        ...epoch,
        reservoir: reservoir.toLowerCase(),
      };
    }

    context.HenloVaultEpoch.set(epoch);
  }
);
