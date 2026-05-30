// ponder-runtime/src/handlers/sf-vaults.ts
//
// PORTED FROM: src/handlers/sf-vaults.ts (envio, source-of-truth, ~40KB — the
// LARGEST handler in the repo). B-1 green-belt (Group F — rated L: the
// strategy-migration per-MultiRewards position logic is the hardest part to
// port faithfully). Contracts (3, all Berachain 80094): SFVaultERC4626,
// SFMultiRewards, SFVaultStrategyWrapper (config.yaml:891-916; event sigs
// config.yaml:433-475).
//
// Writes (5 entities):
//   - sf_position                (ROLLUP-LWW; id=`${BERACHAIN_ID}_${owner}_${vault}`)
//   - sf_vault_stats             (ROLLUP;     id=`${BERACHAIN_ID}_${vault}`)
//   - sf_multi_rewards_position  (ROLLUP;     id=`${BERACHAIN_ID}_${user}_${multiRewards}`)
//   - sf_vault_strategy          (ROLLUP-LWW; id=`${BERACHAIN_ID}_${vault}_${strategy}`)
//   - latest_vault_strategy      (ROLLUP-LWW singleton; id=`${vault}`)
//   + action                     (via recordAction — deposit/withdraw/stake/unstake/claim/rebate/strategy_updated)
//
// No NATS publish (the envio sf-vaults handler emits no events — matches mirror /
// apdao / moneycomb / henlo-vault / fatbera — local indexing only).
//
// ════════════════════════════════════════════════════════════════════════════
// API-pivot from envio (verbatim rules — same as fatbera.ts / apdao-auction.ts /
// moneycomb-vault.ts / henlo-vault.ts / general-mints.ts):
//   - event.params               → event.args
//   - event.srcAddress           → event.log.address
//   - event.logIndex             → event.log.logIndex
//   - event.block.timestamp/.number → ALREADY bigint (drop envio's BigInt() wrap)
//   - event.transaction.hash     → same in ponder (config field_selection: [hash])
//   - BERACHAIN_ID (envio const = 80094) → KEPT verbatim as the literal 80094.
//        SF is Berachain-only; the envio source hardcodes `const BERACHAIN_ID = 80094`
//        and uses it both in id-construction AND as the chainId column value.
//        Keeping the literal (NOT context.chain.id) preserves the envio id shape
//        BYTE-IDENTICALLY — context.chain.id is the same value (80094) but using
//        the source's own constant is the more faithful port for this group.
//   - context.<E>.get(id)        → await context.db.find(<table>, { id })
//   - context.<E>.getWhere(...)  → context.db.sql.select() (drizzle escape hatch — strategy fallbacks)
//   - context.<E>.set (ROLLUP/singleton) → find → update OR insert (read-modify-write upsert)
//   - context.log.*              → console.* (ponder 0.16.6's indexing context has
//                                    NO .log surface — verified LIVE, commit 879221ff;
//                                    bgt.ts / moneycomb-vault.ts / fatbera.ts flagged the
//                                    same. This is the bug that crash-looped the live
//                                    belt — do NOT port context.log.)
//
// ════════════════════════════════════════════════════════════════════════════
// THE isPreload ELIMINATION (load-bearing — same decision as fatbera.ts)
// ════════════════════════════════════════════════════════════════════════════
// The envio handler reads entities, then RETURNS before writes on the preload
// pass (`if ((context as any).isPreload) return;`) to warm the entity cache. That
// is an envio-executor batching OPTIMIZATION, NOT domain logic. Ponder processes
// events STRICTLY SEQUENTIALLY in (block, logIndex) order with synchronous
// `await context.db.find(...)`. This port DROPS the isPreload guards entirely and
// reads each entity INLINE immediately before the compute-and-write — which IS
// exactly the read-before-write the envio domain logic depends on. The
// find→compute→write sequence is preserved verbatim, single-pass.
//
// ════════════════════════════════════════════════════════════════════════════
// THE RPC EFFECTS (envio createEffect → ponder context.client.readContract)
// ════════════════════════════════════════════════════════════════════════════
// envio used createEffect(...) wrapping a module-level viem rpcClient.readContract
// (with cache:true + rateLimit). Ponder's indexing context provides
// `context.client` — a CACHED ReadonlyClient (viem PublicActions, block-pinned).
// So the two envio effects map directly:
//   getMultiRewardsAddress(strategy, block)        → context.client.readContract(multiRewardsAddress(), { blockNumber })
//   getVaultAddressFromMultiRewards(mr, block)      → context.client.readContract(stakingToken(),       { blockNumber })
// The fallback ordering is preserved VERBATIM:
//   getMultiRewardsAddress: RPC → SFVaultStrategy DB (active record) → STRATEGY_TO_MULTI_REWARDS hardcoded map → throw
//   getVault...: RPC only (no DB/map fallback in the source).
// Ponder caches readContract by default, so the envio effect's cache:true is
// reproduced; the rateLimit is an envio executor concern (dropped — ponder
// serializes the sequential indexing loop).
//
// ════════════════════════════════════════════════════════════════════════════
// THE DROPPED contractRegister DYNAMIC REGISTRATION (RLAI-at-boot parity gap)
// ════════════════════════════════════════════════════════════════════════════
// The envio handler dynamically registers NEW MultiRewards contracts at runtime:
//   SFVaultERC4626.StrategyUpdated.contractRegister  → addSFMultiRewards(newMR)
//   SFVaultStrategyWrapper.MultiRewardsUpdated.contractRegister → addSFMultiRewards(newMR)
// Ponder has NO handler-time addContract API, and the prior green-belt groups all
// use STATIC address registration. The 5 static SFMultiRewards addresses in
// ponder.config.ts ARE the current "new" MultiRewards set (config.yaml marks all
// 5 "(new)"; they equal the 5 values in STRATEGY_TO_MULTI_REWARDS below), so the
// LIVE set is covered. Events from any FUTURE MultiRewards created post-boundary
// that is not one of those 5 would be missed until added to the static config.
// This is a DOCUMENTED parity gap to RLAI-grade at green-v3 boot (see report +
// ponder.config.ts Group-F block). The two state HANDLERS (StrategyUpdated /
// MultiRewardsUpdated) ARE fully ported — only their contractRegister twins are
// dropped (the registration mechanism, not the state-tracking domain logic).
//
// ════════════════════════════════════════════════════════════════════════════
// TIMESTAMP: every SF timestamp column (firstDepositAt/lastActivityAt/activeFrom/
// activeTo/firstStakeAt) is BigInt in the envio schema (the source already wraps
// `BigInt(event.block.timestamp)`), NOT the Timestamp scalar — so they map to
// ponder t.bigint() as PURE renames. event.block.timestamp is already a bigint
// epoch-seconds value in ponder 0.16.6 → written directly, no Date round-trip, no
// timestamp_to_bigint conversion (same as apdao / moneycomb / henlo-vault).

import { ponder } from "ponder:registry";
import { eq } from "ponder";
import { parseAbi } from "viem";
import {
  sfPosition,
  sfVaultStats,
  sfMultiRewardsPosition,
  sfVaultStrategy,
  latestVaultStrategy,
} from "../../ponder.schema";
import { recordAction } from "../lib/record-action";

// SF is Berachain-only. Kept VERBATIM from envio src/handlers/sf-vaults.ts:46
// (`const BERACHAIN_ID = 80094;`). Used for both id-construction and the
// chain_id column — preserving the envio id shape byte-identically.
const BERACHAIN_ID = 80094;

// ─────────────────────────────────────────────────────────────────────────
// Vault Configuration Mapping (envio sf-vaults.ts:60-109) — VERBATIM.
// Maps vault addresses → initial strategy / MultiRewards / kitchen token.
// ─────────────────────────────────────────────────────────────────────────
interface VaultConfig {
  vault: string;
  multiRewards: string;
  kitchenToken: string;
  kitchenTokenSymbol: string;
  strategy: string;
}

const VAULT_CONFIGS: Record<string, VaultConfig> = {
  // HLKD1B
  "0x3bec4140eda07911208d4fc06b2f5adb7b5237fb": {
    vault: "0x3bec4140eda07911208d4fc06b2f5adb7b5237fb",
    multiRewards: "0x34b3668e2ad47ccfe3c53e24a0606b911d1f6a8f",
    kitchenToken: "0xf0edfc3e122db34773293e0e5b2c3a58492e7338",
    kitchenTokenSymbol: "HLKD1B",
    strategy: "0x39748c56511c02eb7be22225c4699f59fbb55b8f",
  },
  // HLKD690M
  "0x335d150495f6c8483773abc0e4fa5780dd270e78": {
    vault: "0x335d150495f6c8483773abc0e4fa5780dd270e78",
    multiRewards: "0xd1cbf8f7f310947a7993abbd7fd6113794e353da",
    kitchenToken: "0x8ab854dc0672d7a13a85399a56cb628fb22102d6",
    kitchenTokenSymbol: "HLKD690M",
    strategy: "0x447d56af16a0cfaff96536c7fd54f46bf56e160e",
  },
  // HLKD420M
  "0x2e2bdfdd4b786703b374aeeaa44195698a699dd1": {
    vault: "0x2e2bdfdd4b786703b374aeeaa44195698a699dd1",
    multiRewards: "0x827b7ea9fdb4322dbc6f9bf72c04871be859f20c",
    kitchenToken: "0xf07fa3ece9741d408d643748ff85710bedef25ba",
    kitchenTokenSymbol: "HLKD420M",
    strategy: "0xffa9dbbff80f736cde9e41427c0335f866854a9a",
  },
  // HLKD330M
  "0x91f321a8791fb899c6b860b9f54940c68cb45aed": {
    vault: "0x91f321a8791fb899c6b860b9f54940c68cb45aed",
    multiRewards: "0xacd0177bfcbc3760b03c87808b5423945f6bfaec",
    kitchenToken: "0x37dd8850919ebdca911c383211a70839a94b0539",
    kitchenTokenSymbol: "HLKD330M",
    strategy: "0x3032a263c651d9237b74cd6d47baf1345bf0930e",
  },
  // HLKD100M
  "0xee1087ec5d6a0a673c046b9acb15c93b7adb95ca": {
    vault: "0xee1087ec5d6a0a673c046b9acb15c93b7adb95ca",
    multiRewards: "0xb5b312fbf7eb145485ece55b862db94d626efa0f",
    kitchenToken: "0x7bdf98ddeed209cfa26bd2352b470ac8b5485ec5",
    kitchenTokenSymbol: "HLKD100M",
    strategy: "0xaee9aea23783057cbc890684464570ad9723be01",
  },
};

// --- Module-level reverse lookup Maps (envio sf-vaults.ts:115-132) — VERBATIM ---
const MULTI_REWARDS_TO_VAULT = new Map<string, { vault: string; config: VaultConfig }>();
for (const [vaultAddr, config] of Object.entries(VAULT_CONFIGS)) {
  MULTI_REWARDS_TO_VAULT.set(config.multiRewards, { vault: vaultAddr, config });
}

const STRATEGY_TO_VAULT_MAP = new Map<string, { vault: string; config: VaultConfig }>();
for (const [vaultAddr, config] of Object.entries(VAULT_CONFIGS)) {
  STRATEGY_TO_VAULT_MAP.set(config.strategy, { vault: vaultAddr, config });
}

const STRATEGY_TO_MULTI_REWARDS: Record<string, string> = {
  "0x39748c56511c02eb7be22225c4699f59fbb55b8f": "0x34b3668e2ad47ccfe3c53e24a0606b911d1f6a8f", // HLKD1B
  "0x447d56af16a0cfaff96536c7fd54f46bf56e160e": "0xd1cbf8f7f310947a7993abbd7fd6113794e353da", // HLKD690M
  "0xffa9dbbff80f736cde9e41427c0335f866854a9a": "0x827b7ea9fdb4322dbc6f9bf72c04871be859f20c", // HLKD420M
  "0x3032a263c651d9237b74cd6d47baf1345bf0930e": "0xacd0177bfcbc3760b03c87808b5423945f6bfaec", // HLKD330M
  "0xaee9aea23783057cbc890684464570ad9723be01": "0xb5b312fbf7eb145485ece55b862db94d626efa0f", // HLKD100M
};

// ABIs for the two RPC view reads (envio parsed these inline in the effect bodies).
const MULTI_REWARDS_ADDRESS_ABI = parseAbi([
  "function multiRewardsAddress() view returns (address)",
]);
const STAKING_TOKEN_ABI = parseAbi([
  "function stakingToken() view returns (address)",
]);

// ─────────────────────────────────────────────────────────────────────────
// Row-shape types (mirror the ponder schema columns 1:1; activeTo / firstDepositAt
// (stats) / firstStakeAt are nullable per the green-belt map).
// ─────────────────────────────────────────────────────────────────────────
type SFPositionRow = {
  id: string;
  user: string;
  vault: string;
  multiRewards: string;
  kitchenToken: string;
  strategy: string;
  kitchenTokenSymbol: string;
  vaultShares: bigint;
  stakedShares: bigint;
  totalShares: bigint;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  totalClaimed: bigint;
  firstDepositAt: bigint;
  lastActivityAt: bigint;
  chainId: number;
};

type SFVaultStatsRow = {
  id: string;
  vault: string;
  kitchenToken: string;
  kitchenTokenSymbol: string;
  strategy: string;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  totalStaked: bigint;
  totalUnstaked: bigint;
  totalClaimed: bigint;
  uniqueDepositors: number;
  activePositions: number;
  depositCount: number;
  withdrawalCount: number;
  claimCount: number;
  firstDepositAt: bigint | null;
  lastActivityAt: bigint;
  chainId: number;
};

type SFMultiRewardsPositionRow = {
  id: string;
  user: string;
  vault: string;
  multiRewards: string;
  stakedShares: bigint;
  totalStaked: bigint;
  totalUnstaked: bigint;
  totalClaimed: bigint;
  firstStakeAt: bigint | null;
  lastActivityAt: bigint;
  chainId: number;
};

type SFVaultStrategyRow = {
  id: string;
  vault: string;
  strategy: string;
  multiRewards: string;
  kitchenToken: string;
  kitchenTokenSymbol: string;
  activeFrom: bigint;
  activeTo: bigint | null;
  isActive: boolean;
  chainId: number;
};

type LatestVaultStrategyRow = {
  id: string;
  vault: string;
  strategy: string;
  multiRewards: string;
  kitchenToken: string;
  kitchenTokenSymbol: string;
  chainId: number;
};

// ─────────────────────────────────────────────────────────────────────────
// Upsert helpers — envio's context.<E>.set() is last-write-wins (insert-or-
// replace). Ponder splits read-modify-write into find → update OR insert. Each
// helper writes the FULL row (the caller always builds the complete object, just
// like the envio source). onConflictDoNothing() guards the insert leg against
// reorg-replay re-execution (same as fatbera.ts). NOTE: the caller decides
// whether the row pre-existed (it read it first); these helpers re-check to be
// robust to the read happening earlier in the handler body.
// ─────────────────────────────────────────────────────────────────────────
async function setSFPosition(context: any, row: SFPositionRow): Promise<void> {
  const existing = await context.db.find(sfPosition, { id: row.id });
  if (existing) {
    await context.db.update(sfPosition, { id: row.id }).set(row);
  } else {
    await context.db.insert(sfPosition).values(row).onConflictDoNothing();
  }
}

async function setSFVaultStats(context: any, row: SFVaultStatsRow): Promise<void> {
  const existing = await context.db.find(sfVaultStats, { id: row.id });
  if (existing) {
    await context.db.update(sfVaultStats, { id: row.id }).set(row);
  } else {
    await context.db.insert(sfVaultStats).values(row).onConflictDoNothing();
  }
}

async function setSFMultiRewardsPosition(
  context: any,
  row: SFMultiRewardsPositionRow
): Promise<void> {
  const existing = await context.db.find(sfMultiRewardsPosition, { id: row.id });
  if (existing) {
    await context.db.update(sfMultiRewardsPosition, { id: row.id }).set(row);
  } else {
    await context.db.insert(sfMultiRewardsPosition).values(row).onConflictDoNothing();
  }
}

async function setSFVaultStrategy(
  context: any,
  row: SFVaultStrategyRow
): Promise<void> {
  const existing = await context.db.find(sfVaultStrategy, { id: row.id });
  if (existing) {
    await context.db.update(sfVaultStrategy, { id: row.id }).set(row);
  } else {
    await context.db.insert(sfVaultStrategy).values(row).onConflictDoNothing();
  }
}

async function setLatestVaultStrategy(
  context: any,
  row: LatestVaultStrategyRow
): Promise<void> {
  const existing = await context.db.find(latestVaultStrategy, { id: row.id });
  if (existing) {
    await context.db.update(latestVaultStrategy, { id: row.id }).set(row);
  } else {
    await context.db.insert(latestVaultStrategy).values(row).onConflictDoNothing();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// RPC effect ports — envio getMultiRewardsAddress / getVaultAddressFromMultiRewards.
// context.client is the cached ReadonlyClient (envio's cache:true). Fallback
// ordering preserved VERBATIM (RPC → SFVaultStrategy DB → hardcoded map → throw).
// ─────────────────────────────────────────────────────────────────────────
async function getMultiRewardsAddress(
  context: any,
  strategyAddress: string,
  blockNumber: bigint
): Promise<string> {
  const strategyLower = strategyAddress.toLowerCase();

  // 1. RPC call (envio sf-vaults.ts:159-167)
  try {
    const multiRewards = await context.client.readContract({
      address: strategyAddress as `0x${string}`,
      abi: MULTI_REWARDS_ADDRESS_ABI,
      functionName: "multiRewardsAddress",
      blockNumber,
    });
    return (multiRewards as string).toLowerCase();
  } catch (error) {
    // 2. Fallback to DB — find active SFVaultStrategy by strategy (envio sf-vaults.ts:170-183).
    try {
      const existingByStrategy = await context.db.sql
        .select()
        .from(sfVaultStrategy)
        .where(eq(sfVaultStrategy.strategy, strategyLower));
      if (existingByStrategy && existingByStrategy.length > 0) {
        const activeRecord =
          existingByStrategy.find((s: any) => s.isActive) ?? existingByStrategy[0];
        if (activeRecord?.multiRewards) {
          console.warn(
            `RPC call failed for strategy ${strategyLower}, using DB multiRewards: ${activeRecord.multiRewards}`
          );
          return activeRecord.multiRewards;
        }
      }
    } catch (dbError) {
      console.warn(
        `Failed to query SFVaultStrategy fallback for ${strategyLower}: ${dbError}`
      );
    }

    // 3. Fallback to hardcoded mapping (envio sf-vaults.ts:185-190).
    const fallback = STRATEGY_TO_MULTI_REWARDS[strategyLower];
    if (fallback) {
      console.warn(
        `RPC call failed for strategy ${strategyLower}, using fallback multiRewards: ${fallback}`
      );
      return fallback;
    }

    console.error(
      `Failed to get multiRewardsAddress for strategy ${strategyAddress} at block ${blockNumber}: ${error}`
    );
    throw error;
  }
}

async function getVaultAddressFromMultiRewards(
  context: any,
  multiRewardsAddress: string,
  blockNumber: bigint
): Promise<string> {
  const stakingToken = await context.client.readContract({
    address: multiRewardsAddress as `0x${string}`,
    abi: STAKING_TOKEN_ABI,
    functionName: "stakingToken",
    blockNumber,
  });
  return (stakingToken as string).toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────
// getVaultFromMultiRewards (envio sf-vaults.ts:233-278) — VERBATIM ordering:
//   1. module-level Map (O(1))
//   2. LatestVaultStrategy by multiRewards (DB)
//   3. RPC stakingToken() → VAULT_CONFIGS
// ─────────────────────────────────────────────────────────────────────────
async function getVaultFromMultiRewards(
  context: any,
  multiRewardsAddress: string,
  blockNumber: bigint
): Promise<{ vault: string; config: VaultConfig } | null> {
  // 1. Module-level Map lookup (covers initial + runtime-updated configs).
  const cached = MULTI_REWARDS_TO_VAULT.get(multiRewardsAddress);
  if (cached) return cached;

  // 2. Search LatestVaultStrategy by multiRewards (envio used getWhere; ponder
  //    uses the drizzle escape hatch over the latest_vault_strategy table).
  const latestStrategies = await context.db.sql
    .select()
    .from(latestVaultStrategy)
    .where(eq(latestVaultStrategy.multiRewards, multiRewardsAddress));
  if (latestStrategies && latestStrategies.length > 0) {
    const record = latestStrategies[0];
    const baseConfig = VAULT_CONFIGS[record.vault];
    if (baseConfig) {
      const result = {
        vault: record.vault,
        config: { ...baseConfig, strategy: record.strategy, multiRewards: record.multiRewards },
      };
      MULTI_REWARDS_TO_VAULT.set(multiRewardsAddress, result);
      return result;
    }
  }

  // 3. Fallback: derive the vault from MultiRewards.stakingToken() via RPC.
  try {
    const vaultAddress = await getVaultAddressFromMultiRewards(
      context,
      multiRewardsAddress,
      blockNumber
    );
    const config = VAULT_CONFIGS[vaultAddress];
    if (config) {
      const result = { vault: vaultAddress, config };
      MULTI_REWARDS_TO_VAULT.set(multiRewardsAddress, result);
      return result;
    }
  } catch (error) {
    console.warn(
      `Failed to read stakingToken() for MultiRewards ${multiRewardsAddress} at block ${blockNumber}: ${error}`
    );
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// getVaultFromStrategy (envio sf-vaults.ts:284-310) — VERBATIM ordering:
//   1. module-level Map (O(1))
//   2. SFVaultStrategy by strategy (DB; active record preferred)
// ─────────────────────────────────────────────────────────────────────────
async function getVaultFromStrategy(
  context: any,
  strategyAddress: string
): Promise<{ vault: string; config: VaultConfig } | null> {
  const cached = STRATEGY_TO_VAULT_MAP.get(strategyAddress);
  if (cached) return cached;

  const strategies = await context.db.sql
    .select()
    .from(sfVaultStrategy)
    .where(eq(sfVaultStrategy.strategy, strategyAddress));
  if (strategies && strategies.length > 0) {
    const activeRecord = strategies.find((s: any) => s.isActive) ?? strategies[0];
    const baseConfig = VAULT_CONFIGS[activeRecord.vault];
    if (baseConfig) {
      return {
        vault: activeRecord.vault,
        config: {
          ...baseConfig,
          strategy: activeRecord.strategy,
          multiRewards: activeRecord.multiRewards,
        },
      };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// ensureInitialStrategy (envio sf-vaults.ts:316-360) — VERBATIM. Bootstraps the
// SFVaultStrategy + LatestVaultStrategy records on first deposit, resolving the
// MultiRewards address at the deposit block via the RPC effect.
// ─────────────────────────────────────────────────────────────────────────
async function ensureInitialStrategy(
  context: any,
  vaultAddress: string,
  blockNumber: bigint
): Promise<void> {
  const config = VAULT_CONFIGS[vaultAddress];
  if (!config) return;

  const strategyId = `${BERACHAIN_ID}_${vaultAddress}_${config.strategy}`;
  const existing = await context.db.find(sfVaultStrategy, { id: strategyId });

  if (!existing) {
    const multiRewardsAtBlock = await getMultiRewardsAddress(
      context,
      config.strategy,
      blockNumber
    );

    await setSFVaultStrategy(context, {
      id: strategyId,
      vault: vaultAddress,
      strategy: config.strategy,
      multiRewards: multiRewardsAtBlock,
      kitchenToken: config.kitchenToken,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
      activeFrom: BigInt(0),
      activeTo: null,
      isActive: true,
      chainId: BERACHAIN_ID,
    });

    // Also write LatestVaultStrategy singleton.
    await setLatestVaultStrategy(context, {
      id: vaultAddress,
      vault: vaultAddress,
      strategy: config.strategy,
      multiRewards: multiRewardsAtBlock,
      kitchenToken: config.kitchenToken,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
      chainId: BERACHAIN_ID,
    });

    // Update runtime Map.
    MULTI_REWARDS_TO_VAULT.set(multiRewardsAtBlock, {
      vault: vaultAddress,
      config: { ...config, multiRewards: multiRewardsAtBlock },
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════
// SFVaultERC4626:StrategyUpdated (envio handleSFVaultStrategyUpdated, sf-vaults.ts:412-506)
//   Marks the old strategy inactive, creates the new strategy record (resolving
//   its MultiRewards at the event block), updates SFVaultStats.strategy +
//   LatestVaultStrategy singleton + the runtime Maps. recordAction("sf_strategy_updated").
// ═════════════════════════════════════════════════════════════════════════
ponder.on("SFVaultERC4626:StrategyUpdated", async ({ event, context }) => {
  const vaultAddress = event.log.address.toLowerCase();
  const oldStrategy = event.args.oldStrategy.toLowerCase();
  const newStrategy = event.args.newStrategy.toLowerCase();
  const timestamp = event.block.timestamp; // already bigint

  const config = VAULT_CONFIGS[vaultAddress];
  if (!config) {
    console.warn(`Unknown vault address: ${vaultAddress}`);
    return;
  }

  // Query the new strategy's multiRewardsAddress at this block.
  const newMultiRewards = await getMultiRewardsAddress(
    context,
    newStrategy,
    event.block.number // already bigint
  );

  // Mark old strategy as inactive.
  const oldStrategyId = `${BERACHAIN_ID}_${vaultAddress}_${oldStrategy}`;
  const oldStrategyRecord = await context.db.find(sfVaultStrategy, { id: oldStrategyId });
  if (oldStrategyRecord) {
    await setSFVaultStrategy(context, {
      ...oldStrategyRecord,
      activeTo: timestamp,
      isActive: false,
    });
  }

  // Create new strategy record.
  const newStrategyId = `${BERACHAIN_ID}_${vaultAddress}_${newStrategy}`;
  await setSFVaultStrategy(context, {
    id: newStrategyId,
    vault: vaultAddress,
    strategy: newStrategy,
    multiRewards: newMultiRewards,
    kitchenToken: config.kitchenToken,
    kitchenTokenSymbol: config.kitchenTokenSymbol,
    activeFrom: timestamp,
    activeTo: null,
    isActive: true,
    chainId: BERACHAIN_ID,
  });

  // Update vault stats with new strategy.
  const statsId = `${BERACHAIN_ID}_${vaultAddress}`;
  const stats = await context.db.find(sfVaultStats, { id: statsId });
  if (stats) {
    await setSFVaultStats(context, {
      ...stats,
      strategy: newStrategy,
      lastActivityAt: timestamp,
    });
  }

  // Update LatestVaultStrategy singleton.
  await setLatestVaultStrategy(context, {
    id: vaultAddress,
    vault: vaultAddress,
    strategy: newStrategy,
    multiRewards: newMultiRewards,
    kitchenToken: config.kitchenToken,
    kitchenTokenSymbol: config.kitchenTokenSymbol,
    chainId: BERACHAIN_ID,
  });

  // Update runtime Maps for subsequent events in same batch.
  MULTI_REWARDS_TO_VAULT.delete(config.multiRewards);
  MULTI_REWARDS_TO_VAULT.set(newMultiRewards, {
    vault: vaultAddress,
    config: { ...config, strategy: newStrategy, multiRewards: newMultiRewards },
  });
  STRATEGY_TO_VAULT_MAP.set(newStrategy, {
    vault: vaultAddress,
    config: { ...config, strategy: newStrategy, multiRewards: newMultiRewards },
  });

  console.log(
    `Strategy updated for vault ${vaultAddress}: ${oldStrategy} -> ${newStrategy} (MultiRewards: ${newMultiRewards})`
  );

  // Record action for activity feed.
  await recordAction(context, {
    actionType: "sf_strategy_updated",
    actor: vaultAddress,
    primaryCollection: vaultAddress,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    context: {
      vault: vaultAddress,
      oldStrategy,
      newStrategy,
      newMultiRewards,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════
// SFVaultStrategyWrapper:MultiRewardsUpdated (envio handleSFStrategyMultiRewardsUpdated,
//   sf-vaults.ts:516-581). When the vault admin updates the MultiRewards address
//   (without changing the strategy), update the strategy→multiRewards mapping so
//   new staking/claim events from the new MultiRewards are attributed correctly.
// ═════════════════════════════════════════════════════════════════════════
ponder.on("SFVaultStrategyWrapper:MultiRewardsUpdated", async ({ event, context }) => {
  const strategyAddress = event.log.address.toLowerCase();
  const oldMultiRewards = event.args.oldMultiRewards.toLowerCase();
  const newMultiRewards = event.args.newMultiRewards.toLowerCase();
  const timestamp = event.block.timestamp; // already bigint

  const vaultInfo = await getVaultFromStrategy(context, strategyAddress);
  if (!vaultInfo) {
    console.warn(
      `Unknown strategy wrapper address for MultiRewardsUpdated: ${strategyAddress} (old=${oldMultiRewards}, new=${newMultiRewards})`
    );
    return;
  }

  const { vault: vaultAddress, config } = vaultInfo;
  const strategyId = `${BERACHAIN_ID}_${vaultAddress}_${strategyAddress}`;
  const existing = await context.db.find(sfVaultStrategy, { id: strategyId });

  if (existing) {
    await setSFVaultStrategy(context, {
      ...existing,
      multiRewards: newMultiRewards,
    });
  } else {
    // First time we've seen this vault (no deposits yet) — bootstrap a minimal
    // strategy record so MultiRewards events can be attributed.
    await setSFVaultStrategy(context, {
      id: strategyId,
      vault: vaultAddress,
      strategy: strategyAddress,
      multiRewards: newMultiRewards,
      kitchenToken: config.kitchenToken,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
      activeFrom: timestamp,
      activeTo: null,
      isActive: true,
      chainId: BERACHAIN_ID,
    });
  }

  // Update LatestVaultStrategy singleton with new multiRewards.
  await setLatestVaultStrategy(context, {
    id: vaultAddress,
    vault: vaultAddress,
    strategy: strategyAddress,
    multiRewards: newMultiRewards,
    kitchenToken: config.kitchenToken,
    kitchenTokenSymbol: config.kitchenTokenSymbol,
    chainId: BERACHAIN_ID,
  });

  // Update runtime Maps.
  MULTI_REWARDS_TO_VAULT.delete(oldMultiRewards);
  MULTI_REWARDS_TO_VAULT.set(newMultiRewards, {
    vault: vaultAddress,
    config: { ...config, multiRewards: newMultiRewards },
  });

  // Keep vault stats pointing at the currently active multiRewards (if stats exists).
  const statsId = `${BERACHAIN_ID}_${vaultAddress}`;
  const stats = await context.db.find(sfVaultStats, { id: statsId });
  if (stats) {
    await setSFVaultStats(context, {
      ...stats,
      lastActivityAt: timestamp,
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// SFVaultERC4626:Deposit (envio handleSFVaultDeposit, sf-vaults.ts:587-721)
//   ERC4626 Deposit(sender, owner, assets, shares). Deposited shares go to the
//   vault (not staked yet); updates sf_position (vaultShares/totalShares/
//   totalDeposited) + sf_vault_stats (totalDeposited/depositCount/uniqueDepositors/
//   activePositions). recordAction("sf_vault_deposit").
// ═════════════════════════════════════════════════════════════════════════
ponder.on("SFVaultERC4626:Deposit", async ({ event, context }) => {
  const vaultAddress = event.log.address.toLowerCase();
  const config = VAULT_CONFIGS[vaultAddress];

  if (!config) {
    console.warn(`Unknown vault address: ${vaultAddress}`);
    return;
  }

  const timestamp = event.block.timestamp; // already bigint
  const owner = event.args.owner.toLowerCase();
  const assets = event.args.assets; // Kitchen tokens deposited
  const shares = event.args.shares; // Vault shares received

  // Ensure initial strategy record exists (resolves the MultiRewards at block).
  await ensureInitialStrategy(context, vaultAddress, event.block.number);

  // Get the current active strategy via the singleton (O(1)).
  const latestStrategy = await context.db.find(latestVaultStrategy, { id: vaultAddress });
  const strategyAddress = latestStrategy?.strategy || config.strategy;
  const multiRewardsAddress = latestStrategy?.multiRewards || config.multiRewards;

  const positionId = `${BERACHAIN_ID}_${owner}_${vaultAddress}`;
  const statsId = `${BERACHAIN_ID}_${vaultAddress}`;

  // Fetch existing position and stats.
  const position = await context.db.find(sfPosition, { id: positionId });
  const stats = await context.db.find(sfVaultStats, { id: statsId });

  // Update or create position.
  const isNewPosition = !position;
  const positionToUpdate: SFPositionRow = position || {
    id: positionId,
    user: owner,
    vault: vaultAddress,
    multiRewards: multiRewardsAddress,
    kitchenToken: config.kitchenToken,
    strategy: strategyAddress,
    kitchenTokenSymbol: config.kitchenTokenSymbol,
    vaultShares: BigInt(0),
    stakedShares: BigInt(0),
    totalShares: BigInt(0),
    totalDeposited: BigInt(0),
    totalWithdrawn: BigInt(0),
    totalClaimed: BigInt(0),
    firstDepositAt: timestamp,
    lastActivityAt: timestamp,
    chainId: BERACHAIN_ID,
  };

  // When depositing, shares go to vault (not staked yet).
  const newVaultShares = positionToUpdate.vaultShares + shares;
  const newTotalShares = newVaultShares + positionToUpdate.stakedShares;

  const updatedPosition: SFPositionRow = {
    ...positionToUpdate,
    vaultShares: newVaultShares,
    totalShares: newTotalShares,
    totalDeposited: positionToUpdate.totalDeposited + assets,
    lastActivityAt: timestamp,
    // Update strategy/multiRewards to current active one.
    strategy: strategyAddress,
    multiRewards: multiRewardsAddress,
    // Set firstDepositAt on first deposit, or backfill if null.
    firstDepositAt: positionToUpdate.firstDepositAt || timestamp,
  };

  await setSFPosition(context, updatedPosition);

  // Update or create vault stats.
  const statsToUpdate: SFVaultStatsRow = stats || {
    id: statsId,
    vault: vaultAddress,
    kitchenToken: config.kitchenToken,
    kitchenTokenSymbol: config.kitchenTokenSymbol,
    strategy: strategyAddress,
    totalDeposited: BigInt(0),
    totalWithdrawn: BigInt(0),
    totalStaked: BigInt(0),
    totalUnstaked: BigInt(0),
    totalClaimed: BigInt(0),
    uniqueDepositors: 0,
    activePositions: 0,
    depositCount: 0,
    withdrawalCount: 0,
    claimCount: 0,
    firstDepositAt: timestamp,
    lastActivityAt: timestamp,
    chainId: BERACHAIN_ID,
  };

  // Check if this deposit creates a new active position.
  const previousTotalShares = position
    ? position.vaultShares + position.stakedShares
    : BigInt(0);
  const isNewActivePosition =
    previousTotalShares === BigInt(0) && newTotalShares > BigInt(0);

  const updatedStats: SFVaultStatsRow = {
    ...statsToUpdate,
    totalDeposited: statsToUpdate.totalDeposited + assets,
    depositCount: statsToUpdate.depositCount + 1,
    lastActivityAt: timestamp,
    // Increment unique depositors if this is a new position.
    uniqueDepositors: statsToUpdate.uniqueDepositors + (isNewPosition ? 1 : 0),
    // Increment active positions if totalShares went from 0 to non-zero.
    activePositions: statsToUpdate.activePositions + (isNewActivePosition ? 1 : 0),
  };

  await setSFVaultStats(context, updatedStats);

  // Record action for activity feed.
  await recordAction(context, {
    actionType: "sf_vault_deposit",
    actor: owner,
    primaryCollection: vaultAddress,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    numeric1: assets, // Kitchen token amount
    numeric2: shares, // Vault shares received
    context: {
      vault: vaultAddress,
      kitchenToken: config.kitchenToken,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
      sender: event.args.sender.toLowerCase(),
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════
// SFVaultERC4626:Withdraw (envio handleSFVaultWithdraw, sf-vaults.ts:727-814)
//   ERC4626 Withdraw(sender, receiver, owner, assets, shares). Burns vault
//   shares; updates sf_position (vaultShares floored at 0) + sf_vault_stats
//   (totalWithdrawn/withdrawalCount/activePositions on close). recordAction("sf_vault_withdraw").
// ═════════════════════════════════════════════════════════════════════════
ponder.on("SFVaultERC4626:Withdraw", async ({ event, context }) => {
  const vaultAddress = event.log.address.toLowerCase();
  const config = VAULT_CONFIGS[vaultAddress];

  if (!config) {
    console.warn(`Unknown vault address: ${vaultAddress}`);
    return;
  }

  const timestamp = event.block.timestamp; // already bigint
  const owner = event.args.owner.toLowerCase();
  const assets = event.args.assets; // Kitchen tokens withdrawn
  const shares = event.args.shares; // Vault shares burned

  const positionId = `${BERACHAIN_ID}_${owner}_${vaultAddress}`;
  const statsId = `${BERACHAIN_ID}_${vaultAddress}`;

  const position = await context.db.find(sfPosition, { id: positionId });
  const stats = await context.db.find(sfVaultStats, { id: statsId });

  // Update position if it exists.
  if (position) {
    // When withdrawing, shares are burned from vault balance.
    let newVaultShares = position.vaultShares - shares;

    // Ensure vaultShares doesn't go negative.
    if (newVaultShares < BigInt(0)) {
      newVaultShares = BigInt(0);
    }

    const newTotalShares = newVaultShares + position.stakedShares;

    const updatedPosition: SFPositionRow = {
      ...position,
      vaultShares: newVaultShares,
      totalShares: newTotalShares,
      totalWithdrawn: position.totalWithdrawn + assets,
      lastActivityAt: timestamp,
    };
    await setSFPosition(context, updatedPosition);
  }

  // Update vault stats.
  if (stats && position) {
    // Check if this withdrawal closes the position (totalShares -> 0).
    const previousTotalShares = position.totalShares;
    const newTotalShares = position.vaultShares - shares + position.stakedShares;
    const closedPosition =
      previousTotalShares > BigInt(0) && newTotalShares === BigInt(0);

    const updatedStats: SFVaultStatsRow = {
      ...stats,
      totalWithdrawn: stats.totalWithdrawn + assets,
      withdrawalCount: stats.withdrawalCount + 1,
      // Decrement active positions if totalShares went to 0.
      activePositions: stats.activePositions - (closedPosition ? 1 : 0),
      lastActivityAt: timestamp,
    };
    await setSFVaultStats(context, updatedStats);
  }

  // Record action for activity feed.
  await recordAction(context, {
    actionType: "sf_vault_withdraw",
    actor: owner,
    primaryCollection: vaultAddress,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    numeric1: assets, // Kitchen token amount
    numeric2: shares, // Vault shares burned
    context: {
      vault: vaultAddress,
      kitchenToken: config.kitchenToken,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
      receiver: event.args.receiver.toLowerCase(),
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════
// SFMultiRewards:Staked (envio handleSFMultiRewardsStaked, sf-vaults.ts:820-932)
//   Staked(user, amount). Resolves the vault from the MultiRewards address, moves
//   shares vault→staked in sf_position, increments sf_vault_stats.totalStaked, and
//   tracks the PER-MULTIREWARDS position (sf_multi_rewards_position) — the
//   strategy-migration tracking key. recordAction("sf_rewards_stake").
// ═════════════════════════════════════════════════════════════════════════
ponder.on("SFMultiRewards:Staked", async ({ event, context }) => {
  const multiRewardsAddress = event.log.address.toLowerCase();

  // Look up vault from MultiRewards address.
  const vaultInfo = await getVaultFromMultiRewards(
    context,
    multiRewardsAddress,
    event.block.number // already bigint
  );

  if (!vaultInfo) {
    console.warn(`Unknown MultiRewards address: ${multiRewardsAddress}`);
    return;
  }

  const { vault: vaultAddress, config } = vaultInfo;
  const timestamp = event.block.timestamp; // already bigint
  const user = event.args.user.toLowerCase();
  const amount = event.args.amount; // Vault shares staked

  const positionId = `${BERACHAIN_ID}_${user}_${vaultAddress}`;
  const statsId = `${BERACHAIN_ID}_${vaultAddress}`;

  const position = await context.db.find(sfPosition, { id: positionId });
  const stats = await context.db.find(sfVaultStats, { id: statsId });

  // Track per-MultiRewards position.
  const multiRewardsPositionId = `${BERACHAIN_ID}_${user}_${multiRewardsAddress}`;
  const multiRewardsPosition = await context.db.find(sfMultiRewardsPosition, {
    id: multiRewardsPositionId,
  });

  // Update position.
  if (position) {
    const newStakedShares = position.stakedShares + amount;

    // When staking, shares move from vault to staked.
    let newVaultShares = position.vaultShares - amount;

    // Ensure vaultShares doesn't go negative.
    if (newVaultShares < BigInt(0)) {
      newVaultShares = BigInt(0);
    }

    // totalShares remains the same (just moving between buckets).
    const newTotalShares = newVaultShares + newStakedShares;

    const updatedPosition: SFPositionRow = {
      ...position,
      vaultShares: newVaultShares,
      stakedShares: newStakedShares,
      totalShares: newTotalShares,
      multiRewards: multiRewardsAddress,
      lastActivityAt: timestamp,
    };
    await setSFPosition(context, updatedPosition);

    // Update stats.
    if (stats) {
      const updatedStats: SFVaultStatsRow = {
        ...stats,
        totalStaked: stats.totalStaked + amount,
        lastActivityAt: timestamp,
      };
      await setSFVaultStats(context, updatedStats);
    }
  }

  const updatedMultiRewardsPosition: SFMultiRewardsPositionRow = multiRewardsPosition
    ? {
        ...multiRewardsPosition,
        stakedShares: multiRewardsPosition.stakedShares + amount,
        totalStaked: multiRewardsPosition.totalStaked + amount,
        lastActivityAt: timestamp,
      }
    : {
        id: multiRewardsPositionId,
        user,
        vault: vaultAddress,
        multiRewards: multiRewardsAddress,
        stakedShares: amount,
        totalStaked: amount,
        totalUnstaked: BigInt(0),
        totalClaimed: BigInt(0),
        firstStakeAt: timestamp,
        lastActivityAt: timestamp,
        chainId: BERACHAIN_ID,
      };

  await setSFMultiRewardsPosition(context, updatedMultiRewardsPosition);

  // Record action for activity feed.
  await recordAction(context, {
    actionType: "sf_rewards_stake",
    actor: user,
    primaryCollection: vaultAddress,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    numeric1: amount, // Shares staked
    context: {
      vault: vaultAddress,
      multiRewards: multiRewardsAddress,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════
// SFMultiRewards:Withdrawn (envio handleSFMultiRewardsWithdrawn, sf-vaults.ts:938-1042)
//   Withdrawn(user, amount). Moves shares staked→vault in sf_position (stakedShares
//   floored at 0), increments sf_vault_stats.totalUnstaked, decrements the per-
//   MultiRewards position's stakedShares (floored at 0). recordAction("sf_rewards_unstake").
// ═════════════════════════════════════════════════════════════════════════
ponder.on("SFMultiRewards:Withdrawn", async ({ event, context }) => {
  const multiRewardsAddress = event.log.address.toLowerCase();

  const vaultInfo = await getVaultFromMultiRewards(
    context,
    multiRewardsAddress,
    event.block.number // already bigint
  );

  if (!vaultInfo) {
    console.warn(`Unknown MultiRewards address: ${multiRewardsAddress}`);
    return;
  }

  const { vault: vaultAddress, config } = vaultInfo;
  const timestamp = event.block.timestamp; // already bigint
  const user = event.args.user.toLowerCase();
  const amount = event.args.amount; // Vault shares unstaked

  const positionId = `${BERACHAIN_ID}_${user}_${vaultAddress}`;
  const statsId = `${BERACHAIN_ID}_${vaultAddress}`;
  const multiRewardsPositionId = `${BERACHAIN_ID}_${user}_${multiRewardsAddress}`;

  const position = await context.db.find(sfPosition, { id: positionId });
  const stats = await context.db.find(sfVaultStats, { id: statsId });
  const multiRewardsPosition = await context.db.find(sfMultiRewardsPosition, {
    id: multiRewardsPositionId,
  });

  // Update position.
  if (position) {
    let newStakedShares = position.stakedShares - amount;

    // Ensure stakedShares doesn't go negative.
    if (newStakedShares < BigInt(0)) {
      newStakedShares = BigInt(0);
    }

    // When unstaking, shares move from staked to vault.
    const newVaultShares = position.vaultShares + amount;

    // totalShares remains the same (just moving between buckets).
    const newTotalShares = newVaultShares + newStakedShares;

    const updatedPosition: SFPositionRow = {
      ...position,
      vaultShares: newVaultShares,
      stakedShares: newStakedShares,
      totalShares: newTotalShares,
      multiRewards: multiRewardsAddress,
      lastActivityAt: timestamp,
    };
    await setSFPosition(context, updatedPosition);

    // Update stats.
    if (stats) {
      const updatedStats: SFVaultStatsRow = {
        ...stats,
        totalUnstaked: stats.totalUnstaked + amount,
        lastActivityAt: timestamp,
      };
      await setSFVaultStats(context, updatedStats);
    }
  }

  if (multiRewardsPosition) {
    let newStakedShares = multiRewardsPosition.stakedShares - amount;
    if (newStakedShares < BigInt(0)) {
      newStakedShares = BigInt(0);
    }

    const updatedMultiRewardsPosition: SFMultiRewardsPositionRow = {
      ...multiRewardsPosition,
      stakedShares: newStakedShares,
      totalUnstaked: multiRewardsPosition.totalUnstaked + amount,
      lastActivityAt: timestamp,
    };
    await setSFMultiRewardsPosition(context, updatedMultiRewardsPosition);
  }

  // Record action for activity feed.
  await recordAction(context, {
    actionType: "sf_rewards_unstake",
    actor: user,
    primaryCollection: vaultAddress,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    numeric1: amount, // Shares unstaked
    context: {
      vault: vaultAddress,
      multiRewards: multiRewardsAddress,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════
// SFMultiRewards:RewardPaid (envio handleSFMultiRewardsRewardPaid, sf-vaults.ts:1048-1135)
//   RewardPaid(user, rewardsToken, reward). Accrues sf_position.totalClaimed +
//   sf_vault_stats.totalClaimed/claimCount (the income metric) + the per-
//   MultiRewards position's totalClaimed. recordAction("sf_rewards_claim").
// ═════════════════════════════════════════════════════════════════════════
ponder.on("SFMultiRewards:RewardPaid", async ({ event, context }) => {
  const multiRewardsAddress = event.log.address.toLowerCase();

  const vaultInfo = await getVaultFromMultiRewards(
    context,
    multiRewardsAddress,
    event.block.number // already bigint
  );

  if (!vaultInfo) {
    console.warn(`Unknown MultiRewards address: ${multiRewardsAddress}`);
    return;
  }

  const { vault: vaultAddress, config } = vaultInfo;
  const timestamp = event.block.timestamp; // already bigint
  const user = event.args.user.toLowerCase();
  const rewardsToken = event.args.rewardsToken.toLowerCase();
  const reward = event.args.reward; // HENLO amount claimed

  const positionId = `${BERACHAIN_ID}_${user}_${vaultAddress}`;
  const statsId = `${BERACHAIN_ID}_${vaultAddress}`;
  const multiRewardsPositionId = `${BERACHAIN_ID}_${user}_${multiRewardsAddress}`;

  const position = await context.db.find(sfPosition, { id: positionId });
  const stats = await context.db.find(sfVaultStats, { id: statsId });
  const multiRewardsPosition = await context.db.find(sfMultiRewardsPosition, {
    id: multiRewardsPositionId,
  });

  // Update position's total claimed.
  if (position) {
    const updatedPosition: SFPositionRow = {
      ...position,
      totalClaimed: position.totalClaimed + reward,
      multiRewards: multiRewardsAddress,
      lastActivityAt: timestamp,
    };
    await setSFPosition(context, updatedPosition);
  }

  // Update vault stats total claimed (income metric!).
  if (stats) {
    const updatedStats: SFVaultStatsRow = {
      ...stats,
      totalClaimed: stats.totalClaimed + reward,
      claimCount: stats.claimCount + 1,
      lastActivityAt: timestamp,
    };
    await setSFVaultStats(context, updatedStats);
  }

  // Track per-MultiRewards position claims.
  if (multiRewardsPosition) {
    const updatedMultiRewardsPosition: SFMultiRewardsPositionRow = {
      ...multiRewardsPosition,
      totalClaimed: multiRewardsPosition.totalClaimed + reward,
      lastActivityAt: timestamp,
    };
    await setSFMultiRewardsPosition(context, updatedMultiRewardsPosition);
  }

  // Record action for activity feed.
  await recordAction(context, {
    actionType: "sf_rewards_claim",
    actor: user,
    primaryCollection: vaultAddress,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    numeric1: reward, // HENLO claimed
    context: {
      vault: vaultAddress,
      multiRewards: multiRewardsAddress,
      rewardsToken,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════
// SFMultiRewards:RebatePaid (envio handleSFMultiRewardsRebatePaid, sf-vaults.ts:1145-1188)
//   RebatePaid(user, amount). Rebates are automatic HENLO rewards sent directly
//   to badge holders' wallets — they DON'T update position.totalClaimed (the
//   reward isn't claimed from the vault). This handler ONLY records the activity.
//   recordAction("sf_rewards_rebate").
// ═════════════════════════════════════════════════════════════════════════
ponder.on("SFMultiRewards:RebatePaid", async ({ event, context }) => {
  const multiRewardsAddress = event.log.address.toLowerCase();

  const vaultInfo = await getVaultFromMultiRewards(
    context,
    multiRewardsAddress,
    event.block.number // already bigint
  );

  if (!vaultInfo) {
    console.warn(`Unknown MultiRewards address for rebate: ${multiRewardsAddress}`);
    return;
  }

  const { vault: vaultAddress, config } = vaultInfo;
  const timestamp = event.block.timestamp; // already bigint
  const user = event.args.user.toLowerCase();
  const amount = event.args.amount; // HENLO rebate amount

  // Record action for activity feed.
  // Note: Rebates don't update position.totalClaimed since they're sent directly
  // to the user's wallet, not claimed from the vault.
  await recordAction(context, {
    actionType: "sf_rewards_rebate",
    actor: user,
    primaryCollection: vaultAddress,
    timestamp,
    chainId: BERACHAIN_ID,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    numeric1: amount, // HENLO rebate amount
    context: {
      vault: vaultAddress,
      multiRewards: multiRewardsAddress,
      kitchenTokenSymbol: config.kitchenTokenSymbol,
    },
  });
});
