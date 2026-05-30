// ponder-runtime/src/handlers/henlo-vault.ts
//
// PORTED FROM: src/handlers/henlo-vault.ts (envio, source-of-truth).
// Contract: HenloVault (Berachain 80094, 0x42069E3BF367C403b632CF9cD5a8d61e2c0c44fC)
// — the HENLOCKER vault system: HENLOCKED-token mint deposits, per-strike
// rounds, epochs, balances, and rollup stats.
//
// B-1 green-belt (Group E). Writes:
//   - henlo_vault_round    (ROLLUP-LWW; id = `${strike}_${epochId}_${chainId}`)
//   - henlo_vault_deposit  (APPEND;     id = `${txHash}_${logIndex}`)
//   - henlo_vault_balance  (ROLLUP;     id = `${userLower}_${strike}_${chainId}`)
//   - henlo_vault_epoch    (ROLLUP-LWW; id = `${epochId}_${chainId}`)
//   - henlo_vault_stats    (ROLLUP;     id = `${chainId}`)
//   - henlo_vault_user     (ROLLUP-LWW; id = `${userLower}_${chainId}`)
//
// No NATS publish (the envio handler emits no events; matches mirror / apdao /
// moneycomb / paddlefi / candies — local indexing only).
//
// ════════════════════════════════════════════════════════════════════════
// TRACKED-TOKEN SCOPE — NOT PORTED HERE (grounded: b-1-handler-gap.md §"Group E").
// The envio Mint handler ALSO writes `tracked_token_balance` (the Group-D /
// 40-Mibera `TrackedErc20` path). That entity + the TrackedErc20 contract are
// ALREADY ported and LIVE (ponder-runtime/src/handlers/tracked-erc20.ts;
// TrackedErc20 registered in ponder.config.mibera.ts). This handler ports the
// `henlo_vault_*` writes ONLY — it does NOT import, write, or re-handle
// `tracked_token_balance`, and HenloVault is NOT the TrackedErc20 contract.
// ════════════════════════════════════════════════════════════════════════
//
// API-pivot from envio (verbatim rules — same as apdao-auction.ts /
// moneycomb-vault.ts / mirror-observability.ts / general-mints.ts):
//   - event.params               → event.args
//   - event.chainId              → context.chain.id (HenloVault is Berachain-
//                                    only; 80094. The chain_id column + the id
//                                    construction both use this — verbatim with
//                                    the envio `event.chainId`.)
//   - event.logIndex             → event.log.logIndex
//   - event.block.timestamp      → ALREADY bigint (drop envio's BigInt() wrap)
//   - event.transaction.hash     → event.transaction.hash
//   - context.<E>.get(id)        → await context.db.find(<table>, { id })
//   - context.<E>.set (APPEND)   → context.db.insert(<table>).values(obj).onConflictDoNothing()
//   - context.<E>.set (ROLLUP)   → find → update OR insert (read-modify-write)
//   - context.log.warn(...)      → console.warn(...) (ponder 0.16.6's indexing
//                                    context has NO .log surface — verified LIVE,
//                                    commit 879221ff; bgt.ts:96 / moneycomb-vault.ts
//                                    flagged the same; this is the bug that
//                                    crashed the live belt, do NOT port context.log)
//
// uint coercions: viem decodes strike (uint64) / epochId (uint48) / amount,
// depositLimit (uint256) all as JS `bigint`. The envio source wraps some of
// these in BigInt(strike) / BigInt(epochId) defensively (RoundOpened /
// ReservoirSet) — preserved verbatim (BigInt(bigint) is identity, harmless).
//
// ── UNKNOWN-STRIKE GUARD (load-bearing fidelity decision) ───────────────────
// The envio Mint handler returns EARLY when `STRIKE_TO_TOKEN[strike]` is
// undefined (an unknown strike). That early-return is upstream of ALL the
// henlo_vault_* writes (deposit, balance, round-update, stats, user) — so for
// an unknown strike the envio handler writes NOTHING to any henlo_vault_*
// table. Although STRIKE_TO_TOKEN's payload (token address/key) is only used by
// the dropped tracked_token_balance write, the GUARD ITSELF gates the
// henlo_vault_* writes too. To produce byte-identical henlo_vault_* output we
// PRESERVE the guard (skip the whole Mint body for unknown strikes). Dropping
// the guard would make this port write henlo_vault_deposit/balance/round/stats/
// user rows that the live envio handler never wrote — a faithfulness break.
// STRIKE_TO_TOKEN is therefore retained as the strike-allowlist (the address/
// key fields are vestigial here but kept verbatim for grounding traceability).

import { ponder } from "ponder:registry";
import {
  henloVaultRound,
  henloVaultDeposit,
  henloVaultBalance,
  henloVaultEpoch,
  henloVaultStats,
  henloVaultUser,
} from "../../ponder.schema";

// ─────────────────────────────────────────────────────────────────────────
// Strike → HENLOCKED token allowlist (envio src/handlers/henlo-vault.ts:22-47).
// Retained verbatim as the Mint unknown-strike guard (see header). The
// address/key payload drove the dropped tracked_token_balance write; only the
// KEY-PRESENCE check survives in this port.
// ─────────────────────────────────────────────────────────────────────────
const STRIKE_TO_TOKEN: Record<string, { address: string; key: string }> = {
  "20000": { address: "0x4c9c76d10b1fa7d8f93ba54ab48e890ff0a7660d", key: "hlkd20m" },
  "100000": { address: "0x7bdf98ddeed209cfa26bd2352b470ac8b5485ec5", key: "hlkd100m" },
  "330000": { address: "0x37dd8850919ebdca911c383211a70839a94b0539", key: "hlkd330m" },
  "420000": { address: "0xf07fa3ece9741d408d643748ff85710bedef25ba", key: "hlkd420m" },
  "690000": { address: "0x8ab854dc0672d7a13a85399a56cb628fb22102d6", key: "hlkd690m" },
  "1000000": { address: "0xf0edfc3e122db34773293e0e5b2c3a58492e7338", key: "hlkd1b" },
};

// Strike → epochId (envio src/handlers/henlo-vault.ts:54-61, contract deploy order).
const STRIKE_TO_EPOCH: Record<string, number> = {
  "100000": 1,
  "330000": 2,
  "420000": 3,
  "690000": 4,
  "1000000": 5,
  "20000": 6,
};

// ─────────────────────────────────────────────────────────────────────────
// Row types (mirror the henlo_vault_* schema tables).
// ─────────────────────────────────────────────────────────────────────────
type RoundRow = {
  id: string;
  strike: bigint;
  epochId: bigint;
  exists: boolean;
  closed: boolean;
  depositsPaused: boolean;
  timestamp: bigint;
  depositLimit: bigint;
  totalDeposits: bigint;
  whaleDeposits: bigint;
  userDeposits: bigint;
  remainingCapacity: bigint;
  canRedeem: boolean;
  chainId: number;
};

type EpochRow = {
  id: string;
  epochId: bigint;
  strike: bigint;
  closed: boolean;
  depositsPaused: boolean;
  timestamp: bigint;
  depositLimit: bigint;
  totalDeposits: bigint;
  reservoir: string;
  totalWhitelistDeposit: bigint;
  totalMatched: bigint;
  chainId: number;
};

type StatsRow = {
  id: string;
  totalDeposits: bigint;
  totalUsers: number;
  totalRounds: number;
  totalEpochs: number;
  chainId: number;
};

type UserRow = {
  id: string;
  user: string;
  firstDepositTime: bigint | null;
  lastActivityTime: bigint;
  chainId: number;
};

type BalanceRow = {
  id: string;
  user: string;
  strike: bigint;
  balance: bigint;
  lastUpdated: bigint;
  chainId: number;
};

// ─────────────────────────────────────────────────────────────────────────
// Helpers (mirror envio src/handlers/henlo-vault.ts:63-133).
// ─────────────────────────────────────────────────────────────────────────

// findRoundByStrike — envio:67-82. Uses the known strike→epoch mapping (each
// strike has one epoch). Returns undefined for unknown strikes (no lookup).
async function findRoundByStrike(
  context: any,
  strike: bigint,
  chainId: number
): Promise<RoundRow | undefined> {
  const strikeKey = strike.toString();
  const epochId = STRIKE_TO_EPOCH[strikeKey];
  if (epochId === undefined) return undefined;
  const roundId = `${strike}_${epochId}_${chainId}`;
  const round = (await context.db.find(henloVaultRound, { id: roundId })) as
    | RoundRow
    | null;
  return round ?? undefined;
}

// getOrCreateStats — envio:87-107. Returns the singleton stats row for a chain
// (id = chainId.toString()), or a fresh in-memory default (NOT yet persisted).
async function getOrCreateStats(
  context: any,
  chainId: number
): Promise<StatsRow> {
  const statsId = chainId.toString();
  const stats = (await context.db.find(henloVaultStats, {
    id: statsId,
  })) as StatsRow | null;
  if (stats) return stats;
  return {
    id: statsId,
    totalDeposits: 0n,
    totalUsers: 0,
    totalRounds: 0,
    totalEpochs: 0,
    chainId,
  };
}

// upsertStats — persist a StatsRow (find → update OR insert), since ponder has
// no single .set. Envio's getOrCreate→mutate→set collapses to this read-modify.
async function upsertStats(context: any, row: StatsRow): Promise<void> {
  const existing = await context.db.find(henloVaultStats, { id: row.id });
  if (existing) {
    await context.db.update(henloVaultStats, { id: row.id }).set({
      totalDeposits: row.totalDeposits,
      totalUsers: row.totalUsers,
      totalRounds: row.totalRounds,
      totalEpochs: row.totalEpochs,
      chainId: row.chainId,
    });
  } else {
    await context.db.insert(henloVaultStats).values(row).onConflictDoNothing();
  }
}

// getOrCreateUser — envio:112-133. Returns { vaultUser, isNew }; fresh row pins
// firstDepositTime = lastActivityTime = timestamp (NOT yet persisted).
async function getOrCreateUser(
  context: any,
  user: string,
  chainId: number,
  timestamp: bigint
): Promise<{ vaultUser: UserRow; isNew: boolean }> {
  const userId = `${user}_${chainId}`;
  const existing = (await context.db.find(henloVaultUser, {
    id: userId,
  })) as UserRow | null;
  if (existing) return { vaultUser: existing, isNew: false };
  return {
    vaultUser: {
      id: userId,
      user,
      firstDepositTime: timestamp,
      lastActivityTime: timestamp,
      chainId,
    },
    isNew: true,
  };
}

// upsertUser — persist a UserRow (find → update OR insert).
async function upsertUser(context: any, row: UserRow): Promise<void> {
  const existing = await context.db.find(henloVaultUser, { id: row.id });
  if (existing) {
    await context.db.update(henloVaultUser, { id: row.id }).set({
      user: row.user,
      firstDepositTime: row.firstDepositTime,
      lastActivityTime: row.lastActivityTime,
      chainId: row.chainId,
    });
  } else {
    await context.db.insert(henloVaultUser).values(row).onConflictDoNothing();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Mint — HENLOCKED token mint = a Henlocker vault deposit.
//   envio: src/handlers/henlo-vault.ts:144-258 (handleHenloVaultMint)
//   NOTE: step 1 (tracked_token_balance) is INTENTIONALLY DROPPED — that path
//   is the Group-D TrackedErc20 port (already live). Steps 2-5 (deposit /
//   balance / round / stats / user) are ported verbatim. The unknown-strike
//   early-return guard is PRESERVED (see header) so unknown strikes write
//   nothing to any henlo_vault_* table, matching envio.
// ─────────────────────────────────────────────────────────────────────────
ponder.on("HenloVault:Mint", async ({ event, context }) => {
  try {
    const { user, strike, amount } = event.args;
    const timestamp = event.block.timestamp; // already bigint
    const chainId = context.chain.id;
    const userLower = user.toLowerCase();

    const strikeKey = strike.toString();
    const tokenInfo = STRIKE_TO_TOKEN[strikeKey];

    // Unknown-strike guard (envio:155-159). Preserved: envio returns early here,
    // before ANY henlo_vault_* write. (The tracked_token_balance write that
    // followed is dropped; the guard itself gates the vault writes too.)
    if (!tokenInfo) {
      console.warn(`Unknown HenloVault strike value: ${strikeKey}`);
      return;
    }

    // ── 2. HenloVaultDeposit (APPEND; id = txHash_logIndex). ────────────────
    const depositId = `${event.transaction.hash}_${event.log.logIndex}`;
    const round = await findRoundByStrike(context, strike, chainId);
    const epochId = round
      ? round.epochId
      : BigInt(STRIKE_TO_EPOCH[strikeKey] || 0);

    await context.db
      .insert(henloVaultDeposit)
      .values({
        id: depositId,
        user: userLower,
        strike, // already bigint (decoded uint64)
        epochId,
        amount, // already bigint (decoded uint256)
        timestamp,
        transactionHash: event.transaction.hash,
        chainId,
      })
      .onConflictDoNothing();

    // ── 3. HenloVaultBalance (ROLLUP; balance accumulates per strike). ──────
    const vaultBalanceId = `${userLower}_${strike}_${chainId}`;
    const existingVaultBalance = (await context.db.find(henloVaultBalance, {
      id: vaultBalanceId,
    })) as BalanceRow | null;

    if (existingVaultBalance) {
      await context.db.update(henloVaultBalance, { id: vaultBalanceId }).set({
        balance: existingVaultBalance.balance + amount,
        lastUpdated: timestamp,
      });
    } else {
      await context.db
        .insert(henloVaultBalance)
        .values({
          id: vaultBalanceId,
          user: userLower,
          strike,
          balance: amount,
          lastUpdated: timestamp,
          chainId,
        })
        .onConflictDoNothing();
    }

    // ── 4. HenloVaultRound (ROLLUP-LWW; only if the round exists). ──────────
    if (round) {
      await context.db.update(henloVaultRound, { id: round.id }).set({
        totalDeposits: round.totalDeposits + amount,
        userDeposits: round.userDeposits + amount,
        remainingCapacity: round.depositLimit - (round.totalDeposits + amount),
      });
    }

    // ── 5. HenloVaultStats + HenloVaultUser (ROLLUP). ───────────────────────
    const stats = await getOrCreateStats(context, chainId);
    const { vaultUser, isNew } = await getOrCreateUser(
      context,
      userLower,
      chainId,
      timestamp
    );

    await upsertStats(context, {
      ...stats,
      totalDeposits: stats.totalDeposits + amount,
      totalUsers: isNew ? stats.totalUsers + 1 : stats.totalUsers,
    });

    await upsertUser(context, {
      ...vaultUser,
      lastActivityTime: timestamp,
    });
  } catch (error) {
    console.error(
      `[HenloVault] Mint handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// RoundOpened — create a new vault round.
//   envio: src/handlers/henlo-vault.ts:267-302 (handleHenloVaultRoundOpened)
// ─────────────────────────────────────────────────────────────────────────
ponder.on("HenloVault:RoundOpened", async ({ event, context }) => {
  try {
    const { epochId, strike, depositLimit } = event.args;
    const timestamp = event.block.timestamp; // already bigint
    const chainId = context.chain.id;

    const roundId = `${strike}_${epochId}_${chainId}`;

    const round: RoundRow = {
      id: roundId,
      strike: BigInt(strike), // envio BigInt() wrap preserved (identity on bigint)
      epochId: BigInt(epochId),
      exists: true,
      closed: false,
      depositsPaused: false,
      timestamp,
      depositLimit, // already bigint (decoded uint256)
      totalDeposits: 0n,
      whaleDeposits: 0n,
      userDeposits: 0n,
      remainingCapacity: depositLimit,
      canRedeem: false,
      chainId,
    };

    // ROLLUP-LWW create — envio uses .set (last-write-wins). Replicate as
    // find → update OR insert so a RoundOpened replay reasserts the row state.
    const existingRound = await context.db.find(henloVaultRound, {
      id: roundId,
    });
    if (existingRound) {
      await context.db.update(henloVaultRound, { id: roundId }).set({
        strike: round.strike,
        epochId: round.epochId,
        exists: round.exists,
        closed: round.closed,
        depositsPaused: round.depositsPaused,
        timestamp: round.timestamp,
        depositLimit: round.depositLimit,
        totalDeposits: round.totalDeposits,
        whaleDeposits: round.whaleDeposits,
        userDeposits: round.userDeposits,
        remainingCapacity: round.remainingCapacity,
        canRedeem: round.canRedeem,
        chainId: round.chainId,
      });
    } else {
      await context.db.insert(henloVaultRound).values(round).onConflictDoNothing();
    }

    // Stats: totalRounds++.
    const stats = await getOrCreateStats(context, chainId);
    await upsertStats(context, {
      ...stats,
      totalRounds: stats.totalRounds + 1,
    });
  } catch (error) {
    console.error(
      `[HenloVault] RoundOpened handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// RoundClosed — mark round closed + redeemable.
//   envio: src/handlers/henlo-vault.ts:307-324 (handleHenloVaultRoundClosed)
// ─────────────────────────────────────────────────────────────────────────
ponder.on("HenloVault:RoundClosed", async ({ event, context }) => {
  try {
    const { epochId, strike } = event.args;
    const chainId = context.chain.id;

    const roundId = `${strike}_${epochId}_${chainId}`;
    const round = await context.db.find(henloVaultRound, { id: roundId });
    if (round) {
      await context.db.update(henloVaultRound, { id: roundId }).set({
        closed: true,
        canRedeem: true,
      });
    }
  } catch (error) {
    console.error(
      `[HenloVault] RoundClosed handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DepositsPaused — pause deposits on the round + epoch.
//   envio: src/handlers/henlo-vault.ts:329-356 (handleHenloVaultDepositsPaused)
// ─────────────────────────────────────────────────────────────────────────
ponder.on("HenloVault:DepositsPaused", async ({ event, context }) => {
  try {
    const { epochId, strike } = event.args;
    const chainId = context.chain.id;

    const roundId = `${strike}_${epochId}_${chainId}`;
    const round = await context.db.find(henloVaultRound, { id: roundId });
    if (round) {
      await context.db
        .update(henloVaultRound, { id: roundId })
        .set({ depositsPaused: true });
    }

    const epochEntityId = `${epochId}_${chainId}`;
    const epoch = await context.db.find(henloVaultEpoch, { id: epochEntityId });
    if (epoch) {
      await context.db
        .update(henloVaultEpoch, { id: epochEntityId })
        .set({ depositsPaused: true });
    }
  } catch (error) {
    console.error(
      `[HenloVault] DepositsPaused handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DepositsUnpaused — unpause deposits on the round + epoch.
//   envio: src/handlers/henlo-vault.ts:361-388 (handleHenloVaultDepositsUnpaused)
// ─────────────────────────────────────────────────────────────────────────
ponder.on("HenloVault:DepositsUnpaused", async ({ event, context }) => {
  try {
    const { epochId, strike } = event.args;
    const chainId = context.chain.id;

    const roundId = `${strike}_${epochId}_${chainId}`;
    const round = await context.db.find(henloVaultRound, { id: roundId });
    if (round) {
      await context.db
        .update(henloVaultRound, { id: roundId })
        .set({ depositsPaused: false });
    }

    const epochEntityId = `${epochId}_${chainId}`;
    const epoch = await context.db.find(henloVaultEpoch, { id: epochEntityId });
    if (epoch) {
      await context.db
        .update(henloVaultEpoch, { id: epochEntityId })
        .set({ depositsPaused: false });
    }
  } catch (error) {
    console.error(
      `[HenloVault] DepositsUnpaused handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// MintFromReservoir — whale/reservoir deposits (round.whaleDeposits + stats).
//   envio: src/handlers/henlo-vault.ts:393-420 (handleHenloVaultMintFromReservoir)
// ─────────────────────────────────────────────────────────────────────────
ponder.on("HenloVault:MintFromReservoir", async ({ event, context }) => {
  try {
    const { strike, amount } = event.args; // `reservoir` unused (matches envio)
    const timestamp = event.block.timestamp; // already bigint (unused write-side, parity with envio getOrCreateStats sig)
    const chainId = context.chain.id;

    const round = await findRoundByStrike(context, strike, chainId);
    if (round) {
      await context.db.update(henloVaultRound, { id: round.id }).set({
        totalDeposits: round.totalDeposits + amount,
        whaleDeposits: round.whaleDeposits + amount,
        remainingCapacity: round.depositLimit - (round.totalDeposits + amount),
      });
    }

    const stats = await getOrCreateStats(context, chainId);
    await upsertStats(context, {
      ...stats,
      totalDeposits: stats.totalDeposits + amount,
    });
    void timestamp;
  } catch (error) {
    console.error(
      `[HenloVault] MintFromReservoir handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Redeem — user withdrawal (balance decrement floored at 0 + user activity).
//   envio: src/handlers/henlo-vault.ts:425-457 (handleHenloVaultRedeem)
// ─────────────────────────────────────────────────────────────────────────
ponder.on("HenloVault:Redeem", async ({ event, context }) => {
  try {
    const { user, strike, amount } = event.args;
    const timestamp = event.block.timestamp; // already bigint
    const chainId = context.chain.id;
    const userLower = user.toLowerCase();

    const vaultBalanceId = `${userLower}_${strike}_${chainId}`;
    const existingVaultBalance = (await context.db.find(henloVaultBalance, {
      id: vaultBalanceId,
    })) as BalanceRow | null;

    if (existingVaultBalance) {
      const newBalance = existingVaultBalance.balance - amount;
      await context.db.update(henloVaultBalance, { id: vaultBalanceId }).set({
        balance: newBalance > 0n ? newBalance : 0n,
        lastUpdated: timestamp,
      });
    }

    const userId = `${userLower}_${chainId}`;
    const vaultUser = await context.db.find(henloVaultUser, { id: userId });
    if (vaultUser) {
      await context.db
        .update(henloVaultUser, { id: userId })
        .set({ lastActivityTime: timestamp });
    }
  } catch (error) {
    console.error(
      `[HenloVault] Redeem handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// ReservoirSet — create/update an epoch with its reservoir.
//   envio: src/handlers/henlo-vault.ts:462-505 (handleHenloVaultReservoirSet)
//   On CREATE: also stats.totalEpochs++. On UPDATE: only the reservoir changes.
// ─────────────────────────────────────────────────────────────────────────
ponder.on("HenloVault:ReservoirSet", async ({ event, context }) => {
  try {
    const { epochId, strike, reservoir } = event.args;
    const timestamp = event.block.timestamp; // already bigint
    const chainId = context.chain.id;

    const epochEntityId = `${epochId}_${chainId}`;
    const existingEpoch = (await context.db.find(henloVaultEpoch, {
      id: epochEntityId,
    })) as EpochRow | null;

    if (!existingEpoch) {
      // Create new epoch (envio:471-494).
      const epoch: EpochRow = {
        id: epochEntityId,
        epochId: BigInt(epochId), // envio BigInt() wrap preserved (identity)
        strike: BigInt(strike),
        closed: false,
        depositsPaused: false,
        timestamp,
        depositLimit: 0n,
        totalDeposits: 0n,
        reservoir: reservoir.toLowerCase(),
        totalWhitelistDeposit: 0n,
        totalMatched: 0n,
        chainId,
      };
      await context.db.insert(henloVaultEpoch).values(epoch).onConflictDoNothing();

      // Stats: totalEpochs++ (envio:489-494 — only on epoch create).
      const stats = await getOrCreateStats(context, chainId);
      await upsertStats(context, {
        ...stats,
        totalEpochs: stats.totalEpochs + 1,
      });
    } else {
      // Update existing epoch with reservoir (envio:496-501).
      await context.db
        .update(henloVaultEpoch, { id: epochEntityId })
        .set({ reservoir: reservoir.toLowerCase() });
    }
  } catch (error) {
    console.error(
      `[HenloVault] ReservoirSet handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});
