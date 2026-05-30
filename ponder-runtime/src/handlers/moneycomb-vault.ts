// ponder-runtime/src/handlers/moneycomb-vault.ts
//
// PORTED FROM: src/handlers/moneycomb-vault.ts (envio, source-of-truth).
// Contract: MoneycombVault (Berachain 80094, 0x9279b2227b57f349a0ce552b25af341e735f6309)
// — per-account HJ-burn vaults: account open/close, HoneyJar burns, share
// mints, and reward claims.
//
// B-1 green-belt (Group C). Writes:
//   - vault               (ROLLUP-LWW; id = `${userLower}_${accountIndex}`)
//   - vault_activity      (APPEND;     id = `${txHash}_${logIndex}`)
//   - user_vault_summary  (ROLLUP;     id = `${userLower}`)
//
// No NATS publish (the envio handler emits no events; matches mirror /
// apdao / paddlefi / candies — local indexing only).
//
// HONEYCOMB DEPENDENCY (grounded — see abis/MoneycombVaultAbi.ts header):
//   `honeycombId` is a uint256 PARAMETER on the AccountOpened / AccountClosed
//   events, NOT a read of the Honeycomb (HoneyComb721) contract. This handler
//   subscribes to MoneycombVault events ONLY. No Honeycomb registration is
//   required for Group C (Honeycomb belongs to Group B, honeyjar-genesis).
//
// API-pivot from envio (verbatim rules — same as apdao-auction.ts /
// mirror-observability.ts / general-mints.ts):
//   - event.params               → event.args
//   - event.logIndex             → event.log.logIndex
//   - event.block.timestamp      → ALREADY bigint (drop envio's BigInt() wrap)
//   - event.block.number         → ALREADY bigint (drop envio's BigInt() wrap)
//   - event.transaction.hash     → event.transaction.hash
//   - context.<E>.get(id)        → await context.db.find(<table>, { id })
//   - context.<E>.set (APPEND)   → context.db.insert(<table>).values(obj).onConflictDoNothing()
//   - context.<E>.set (ROLLUP)   → find → update OR insert (read-modify-write)
//   - context.log.error(...)     → console.error(...) (ponder 0.16.6's indexing
//                                    context has NO .log surface — verified LIVE,
//                                    commit 879221ff; bgt.ts:96 flagged the same)
//
// uint256 coercions: envio wrapped honeycombId/shares/reward in
// BigInt(x.toString()); ponder decodes uint256 args as bigint directly, so
// those coercions are dropped. accountIndex (uint256) → Number(accountIndex) and
// hjGen (uint256) → Number(hjGen) preserve envio's exact Number() coercion (the
// vault.account_index / vault_activity.hj_gen columns are int4 per the map).

import { ponder } from "ponder:registry";
import { vault, vaultActivity, userVaultSummary } from "../../ponder.schema";

// ─────────────────────────────────────────────────────────────────────────
// updateUserVaultSummary — mirrors the envio helper (src/handlers/
// moneycomb-vault.ts:307-365). getOrCreate (default row, firstVaultTime =
// timestamp) → apply activity-typed deltas → upsert. Replicated read-modify-
// write: the envio source builds the full updated object then context.<E>.set;
// ponder uses find → update OR insert.
//
// firstVaultTime fidelity: envio inits the fresh summary with
// firstVaultTime = timestamp (truthy), then the ACCOUNT_OPENED branch only
// overwrites when `!summary.firstVaultTime`. Since the fresh row's
// firstVaultTime is already truthy, the conditional is a no-op on first open —
// so firstVaultTime effectively pins to the FIRST activity's timestamp for any
// activity type that creates the row (not just ACCOUNT_OPENED). This port
// preserves that exact behavior.
// ─────────────────────────────────────────────────────────────────────────
type SummaryRow = {
  id: string;
  user: string;
  totalVaults: number;
  activeVaults: number;
  totalShares: bigint;
  totalRewardsClaimed: bigint;
  totalHJsBurned: number;
  firstVaultTime: bigint | null;
  lastActivityTime: bigint;
};

async function updateUserVaultSummary(
  context: any,
  user: string,
  timestamp: bigint,
  activityType: string,
  shares?: bigint,
  reward?: bigint
): Promise<void> {
  const summaryId = user;
  let summary = (await context.db.find(userVaultSummary, {
    id: summaryId,
  })) as SummaryRow | null;

  if (!summary) {
    // envio default row — firstVaultTime initialized to timestamp (truthy).
    summary = {
      id: summaryId,
      user,
      totalVaults: 0,
      activeVaults: 0,
      totalShares: 0n,
      totalRewardsClaimed: 0n,
      totalHJsBurned: 0,
      firstVaultTime: timestamp,
      lastActivityTime: timestamp,
    };
  }

  // Build the fully-updated row (verbatim from envio's spread + conditionals).
  const updated: SummaryRow = {
    id: summary.id,
    user: summary.user,
    totalVaults:
      activityType === "ACCOUNT_OPENED"
        ? summary.totalVaults + 1
        : summary.totalVaults,
    activeVaults:
      activityType === "ACCOUNT_OPENED"
        ? summary.activeVaults + 1
        : activityType === "ACCOUNT_CLOSED"
        ? Math.max(0, summary.activeVaults - 1)
        : summary.activeVaults,
    totalShares:
      activityType === "SHARES_MINTED" && shares
        ? summary.totalShares + shares
        : summary.totalShares,
    totalRewardsClaimed:
      activityType === "REWARD_CLAIMED" && reward
        ? summary.totalRewardsClaimed + reward
        : summary.totalRewardsClaimed,
    totalHJsBurned:
      activityType === "HJ_BURNED"
        ? summary.totalHJsBurned + 1
        : summary.totalHJsBurned,
    firstVaultTime:
      activityType === "ACCOUNT_OPENED" && !summary.firstVaultTime
        ? timestamp
        : summary.firstVaultTime,
    lastActivityTime: timestamp,
  };

  const existing = await context.db.find(userVaultSummary, { id: summaryId });
  if (existing) {
    await context.db
      .update(userVaultSummary, { id: summaryId })
      .set({
        totalVaults: updated.totalVaults,
        activeVaults: updated.activeVaults,
        totalShares: updated.totalShares,
        totalRewardsClaimed: updated.totalRewardsClaimed,
        totalHJsBurned: updated.totalHJsBurned,
        firstVaultTime: updated.firstVaultTime,
        lastActivityTime: updated.lastActivityTime,
      });
  } else {
    await context.db
      .insert(userVaultSummary)
      .values(updated)
      .onConflictDoNothing();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// AccountOpened — a new vault account is opened for a user.
//   envio: src/handlers/moneycomb-vault.ts:16-77 (handleAccountOpened)
// ─────────────────────────────────────────────────────────────────────────
ponder.on("MoneycombVault:AccountOpened", async ({ event, context }) => {
  try {
    const { user, accountIndex, honeycombId } = event.args;
    const userLower = user.toLowerCase();
    const timestamp = event.block.timestamp; // already bigint

    // ── 1. Vault record (CREATE; onConflictDoNothing keeps re-open idempotent
    //       on replay — never overwrites a row that burns/shares have since
    //       mutated, matching the envio create-on-open semantics). ───────────
    const vaultId = `${userLower}_${accountIndex}`;
    await context.db
      .insert(vault)
      .values({
        id: vaultId,
        user: userLower,
        accountIndex: Number(accountIndex),
        honeycombId, // already bigint (decoded uint256)
        isActive: true,
        shares: 0n,
        totalBurned: 0,
        burnedGen1: false,
        burnedGen2: false,
        burnedGen3: false,
        burnedGen4: false,
        burnedGen5: false,
        burnedGen6: false,
        createdAt: timestamp,
        closedAt: null,
        lastActivityTime: timestamp,
      })
      .onConflictDoNothing();

    // ── 2. Activity record (APPEND; id = txHash_logIndex). ──────────────────
    const activityId = `${event.transaction.hash}_${event.log.logIndex}`;
    await context.db
      .insert(vaultActivity)
      .values({
        id: activityId,
        user: userLower,
        accountIndex: Number(accountIndex),
        activityType: "ACCOUNT_OPENED",
        timestamp,
        blockNumber: event.block.number, // already bigint
        transactionHash: event.transaction.hash,
        honeycombId, // already bigint (decoded uint256)
        hjGen: null,
        shares: null,
        reward: null,
      })
      .onConflictDoNothing();

    // ── 3. User summary (ROLLUP). ───────────────────────────────────────────
    await updateUserVaultSummary(context, userLower, timestamp, "ACCOUNT_OPENED");
  } catch (error) {
    console.error(
      `[MoneycombVault] AccountOpened handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// AccountClosed — a vault account is closed.
//   envio: src/handlers/moneycomb-vault.ts:82-135 (handleAccountClosed)
// ─────────────────────────────────────────────────────────────────────────
ponder.on("MoneycombVault:AccountClosed", async ({ event, context }) => {
  try {
    const { user, accountIndex, honeycombId } = event.args;
    const userLower = user.toLowerCase();
    const timestamp = event.block.timestamp; // already bigint

    // ── 1. Vault finalize (if the vault row exists — envio guards on get). ───
    const vaultId = `${userLower}_${accountIndex}`;
    const existingVault = await context.db.find(vault, { id: vaultId });
    if (existingVault) {
      await context.db
        .update(vault, { id: vaultId })
        .set({
          isActive: false,
          closedAt: timestamp,
          lastActivityTime: timestamp,
        });
    }

    // ── 2. Activity record (APPEND). ────────────────────────────────────────
    const activityId = `${event.transaction.hash}_${event.log.logIndex}`;
    await context.db
      .insert(vaultActivity)
      .values({
        id: activityId,
        user: userLower,
        accountIndex: Number(accountIndex),
        activityType: "ACCOUNT_CLOSED",
        timestamp,
        blockNumber: event.block.number, // already bigint
        transactionHash: event.transaction.hash,
        honeycombId, // already bigint (decoded uint256)
        hjGen: null,
        shares: null,
        reward: null,
      })
      .onConflictDoNothing();

    // ── 3. User summary (ROLLUP). ───────────────────────────────────────────
    await updateUserVaultSummary(context, userLower, timestamp, "ACCOUNT_CLOSED");
  } catch (error) {
    console.error(
      `[MoneycombVault] AccountClosed handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// HJBurned — a HoneyJar NFT is burned into a vault (per-generation flags).
//   envio: src/handlers/moneycomb-vault.ts:140-199 (handleHJBurned)
// ─────────────────────────────────────────────────────────────────────────
ponder.on("MoneycombVault:HJBurned", async ({ event, context }) => {
  try {
    const { user, accountIndex, hjGen } = event.args;
    const userLower = user.toLowerCase();
    const timestamp = event.block.timestamp; // already bigint
    const generation = Number(hjGen);

    // ── 1. Vault burn flags (if the vault row exists). ──────────────────────
    const vaultId = `${userLower}_${accountIndex}`;
    const existingVault = await context.db.find(vault, { id: vaultId });
    if (existingVault) {
      await context.db
        .update(vault, { id: vaultId })
        .set({
          totalBurned: existingVault.totalBurned + 1,
          burnedGen1: generation === 1 ? true : existingVault.burnedGen1,
          burnedGen2: generation === 2 ? true : existingVault.burnedGen2,
          burnedGen3: generation === 3 ? true : existingVault.burnedGen3,
          burnedGen4: generation === 4 ? true : existingVault.burnedGen4,
          burnedGen5: generation === 5 ? true : existingVault.burnedGen5,
          burnedGen6: generation === 6 ? true : existingVault.burnedGen6,
          lastActivityTime: timestamp,
        });
    }

    // ── 2. Activity record (APPEND). ────────────────────────────────────────
    const activityId = `${event.transaction.hash}_${event.log.logIndex}`;
    await context.db
      .insert(vaultActivity)
      .values({
        id: activityId,
        user: userLower,
        accountIndex: Number(accountIndex),
        activityType: "HJ_BURNED",
        timestamp,
        blockNumber: event.block.number, // already bigint
        transactionHash: event.transaction.hash,
        honeycombId: null,
        hjGen: generation,
        shares: null,
        reward: null,
      })
      .onConflictDoNothing();

    // ── 3. User summary (ROLLUP). ───────────────────────────────────────────
    await updateUserVaultSummary(context, userLower, timestamp, "HJ_BURNED");
  } catch (error) {
    console.error(
      `[MoneycombVault] HJBurned handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// SharesMinted — vault shares are minted to a user.
//   envio: src/handlers/moneycomb-vault.ts:204-257 (handleSharesMinted)
// ─────────────────────────────────────────────────────────────────────────
ponder.on("MoneycombVault:SharesMinted", async ({ event, context }) => {
  try {
    const { user, accountIndex, shares } = event.args;
    const userLower = user.toLowerCase();
    const timestamp = event.block.timestamp; // already bigint
    const mintedShares = shares; // already bigint (decoded uint256)

    // ── 1. Vault shares accumulate (if the vault row exists). ───────────────
    const vaultId = `${userLower}_${accountIndex}`;
    const existingVault = await context.db.find(vault, { id: vaultId });
    if (existingVault) {
      await context.db
        .update(vault, { id: vaultId })
        .set({
          shares: existingVault.shares + mintedShares,
          lastActivityTime: timestamp,
        });
    }

    // ── 2. Activity record (APPEND). ────────────────────────────────────────
    const activityId = `${event.transaction.hash}_${event.log.logIndex}`;
    await context.db
      .insert(vaultActivity)
      .values({
        id: activityId,
        user: userLower,
        accountIndex: Number(accountIndex),
        activityType: "SHARES_MINTED",
        timestamp,
        blockNumber: event.block.number, // already bigint
        transactionHash: event.transaction.hash,
        honeycombId: null,
        hjGen: null,
        shares: mintedShares,
        reward: null,
      })
      .onConflictDoNothing();

    // ── 3. User summary (ROLLUP — passes shares for totalShares accumulation).
    await updateUserVaultSummary(
      context,
      userLower,
      timestamp,
      "SHARES_MINTED",
      mintedShares
    );
  } catch (error) {
    console.error(
      `[MoneycombVault] SharesMinted handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// RewardClaimed — a user claims accrued rewards (no per-account index).
//   envio: src/handlers/moneycomb-vault.ts:262-302 (handleRewardClaimed)
// ─────────────────────────────────────────────────────────────────────────
ponder.on("MoneycombVault:RewardClaimed", async ({ event, context }) => {
  try {
    const { user, reward } = event.args;
    const userLower = user.toLowerCase();
    const timestamp = event.block.timestamp; // already bigint
    const claimedReward = reward; // already bigint (decoded uint256)

    // ── 1. Activity record (APPEND; accountIndex = -1 per envio — reward
    //       claims don't carry an account index). No vault mutation. ─────────
    const activityId = `${event.transaction.hash}_${event.log.logIndex}`;
    await context.db
      .insert(vaultActivity)
      .values({
        id: activityId,
        user: userLower,
        accountIndex: -1, // envio: reward claims don't specify account
        activityType: "REWARD_CLAIMED",
        timestamp,
        blockNumber: event.block.number, // already bigint
        transactionHash: event.transaction.hash,
        honeycombId: null,
        hjGen: null,
        shares: null,
        reward: claimedReward,
      })
      .onConflictDoNothing();

    // ── 2. User summary (ROLLUP — passes reward for totalRewardsClaimed). ────
    await updateUserVaultSummary(
      context,
      userLower,
      timestamp,
      "REWARD_CLAIMED",
      undefined,
      claimedReward
    );
  } catch (error) {
    console.error(
      `[MoneycombVault] RewardClaimed handler failed for tx ${event.transaction.hash}: ${error}`
    );
  }
});
