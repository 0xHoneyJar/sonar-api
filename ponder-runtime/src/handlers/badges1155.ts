// ponder-runtime/src/handlers/badges1155.ts
//
// PORTED FROM: src/handlers/badges1155.ts (envio, source-of-truth)
// Contract: CubBadges1155 (ERC-1155 on Berachain 80094).
//
// Mibera-gap handler-only port (registered-but-unsubscribed, RLAI-verified).
// CubBadges1155 IS in ponder.config.mibera.ts:202 (Erc1155Abi) and its tables
// (badge_holder / badge_amount / badge_balance) EXIST in ponder.schema.ts —
// there was no handler, so badge holdings were silently never written.
//
// NO NATS path (unlike GeneralMints / puru-apiculture1155). This handler only
// writes the three badge tables + recordAction parallel writes. Mirrors the
// ERC-1155 TransferSingle/TransferBatch decode + per-id loop shape of
// puru-apiculture1155.ts; the rollup logic (balance adjustment, holdings map,
// totals) is a verbatim port of the envio source's adjustBadgeBalances.
//
// ENVIO→PONDER API pivot (vs envio src/handlers/badges1155.ts):
//   event.params              → event.args
//   event.chainId             → context.chain.id
//   event.srcAddress          → event.log.address
//   event.logIndex            → event.log.logIndex
//   event.block.timestamp     → already bigint (no BigInt() wrap)
//   context.E.get(id)         → await context.db.find(table, { id })
//   context.E.set(obj) [lww]  → find → update(table,{id}).set({...})
//                               else insert(table).values(obj).onConflictDoNothing()
//   context.E.deleteUnsafe(id)→ await context.db.delete(table, { id })
//
// SCHEMA NOTE: ponder.schema.ts badgeHolder.holdings is t.text() (envio used a
// Json column). We JSON.stringify on write and JSON.parse the stored text on
// read at the handler boundary — the in-handler `holdings` value is the same
// Record<string,string> object the envio source manipulated.

import { ponder } from "ponder:registry";
import {
  badgeHolder,
  badgeAmount,
  badgeBalance,
} from "../../ponder.schema";
import { recordAction } from "../lib/record-action";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO = ZERO_ADDRESS.toLowerCase();

interface BalanceAdjustmentArgs {
  context: any;
  holderAddress: string;
  contractAddress: string;
  tokenId: bigint;
  amountDelta: bigint;
  timestamp: bigint;
  chainId: number;
  txHash: string;
  logIndex: number;
  direction: "in" | "out";
  batchIndex?: number;
}

const makeHolderId = (address: string) => address;

const makeBalanceId = (
  chainId: number,
  address: string,
  contract: string,
  tokenId: bigint
) => `${chainId}-${address}-${contract}-${tokenId.toString()}`;

const makeBadgeAmountId = (
  holderId: string,
  contract: string,
  tokenId: bigint
) => `${holderId}-${contract}-${tokenId.toString()}`;

const makeHoldingsKey = (contract: string, tokenId: bigint): string =>
  `${contract}-${tokenId.toString()}`;

// envio stored `holdings` as a Json object; ponder stores it as text.
// Parse the stored text back to the Record<string,string> shape the envio
// rollup logic operates on. Verbatim port of envio's cloneHoldings, adapted to
// accept the text-serialized form read from the row.
const parseHoldings = (rawHoldings: unknown): Record<string, string> => {
  let source: unknown = rawHoldings;
  if (typeof rawHoldings === "string") {
    if (rawHoldings.length === 0) return {};
    try {
      source = JSON.parse(rawHoldings);
    } catch {
      return {};
    }
  }

  if (!source || typeof source !== "object") {
    return {};
  }

  const entries = Object.entries(source as Record<string, unknown>);

  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (typeof value === "number") {
      result[key] = Math.trunc(value).toString();
    } else if (typeof value === "bigint") {
      result[key] = value.toString();
    }
  }

  return result;
};

async function adjustBadgeBalances({
  context,
  holderAddress,
  contractAddress,
  tokenId,
  amountDelta,
  timestamp,
  chainId,
  txHash,
  logIndex,
  direction,
  batchIndex,
}: BalanceAdjustmentArgs): Promise<void> {
  if (amountDelta === 0n) {
    return;
  }

  const normalizedAddress = holderAddress.toLowerCase();
  if (normalizedAddress === ZERO) {
    return;
  }

  const normalizedContract = contractAddress.toLowerCase();
  const holderId = makeHolderId(normalizedAddress);
  const balanceId = makeBalanceId(
    chainId,
    normalizedAddress,
    normalizedContract,
    tokenId
  );
  const badgeAmountId = makeBadgeAmountId(
    holderId,
    normalizedContract,
    tokenId
  );
  const legacyBadgeAmountId = `${holderId}-${tokenId.toString()}`;

  const existingBalance = await context.db.find(badgeBalance, { id: balanceId });
  // mode:"bigint" numeric columns can infer through as number under this
  // ponder/drizzle version (see puru-apiculture1155.ts:369) — coerce to bigint.
  const currentBalance = BigInt(existingBalance?.amount ?? 0n);

  let appliedDelta = amountDelta;
  let nextBalance = currentBalance + amountDelta;

  if (amountDelta < 0n) {
    const removeAmount =
      currentBalance < -amountDelta ? currentBalance : -amountDelta;

    if (removeAmount === 0n) {
      return;
    }

    appliedDelta = -removeAmount; // Both are bigint now
    nextBalance = currentBalance - removeAmount;
  }

  if (appliedDelta === 0n) {
    return;
  }

  const holdingsKey = makeHoldingsKey(normalizedContract, tokenId);
  const legacyKey = tokenId.toString();
  const existingHolder = await context.db.find(badgeHolder, { id: holderId });
  const holderAddressField = existingHolder?.address ?? normalizedAddress;
  const currentHoldings = parseHoldings(existingHolder?.holdings);
  const resolvedHoldingRaw =
    currentHoldings[holdingsKey] ?? currentHoldings[legacyKey] ?? "0";
  const previousHoldingAmount = BigInt(resolvedHoldingRaw);
  let nextHoldingAmount = previousHoldingAmount + appliedDelta;
  if (nextHoldingAmount < 0n) {
    nextHoldingAmount = 0n;
  }

  if (nextHoldingAmount === 0n) {
    delete currentHoldings[holdingsKey];
    delete currentHoldings[legacyKey];
  } else {
    currentHoldings[holdingsKey] = nextHoldingAmount.toString();
    if (legacyKey in currentHoldings && legacyKey !== holdingsKey) {
      delete currentHoldings[legacyKey];
    }
  }

  const currentTotal = BigInt(existingHolder?.totalBadges ?? 0n);
  let nextTotal = currentTotal + appliedDelta;

  if (nextTotal < 0n) {
    nextTotal = 0n;
  }

  const actionSuffixParts = [
    direction,
    tokenId.toString(),
    batchIndex !== undefined ? batchIndex.toString() : undefined,
  ].filter((part): part is string => part !== undefined);
  const actionId = `${txHash}_${logIndex}_${actionSuffixParts.join("_")}`;
  const tokenCount = nextHoldingAmount < 0n ? 0n : nextHoldingAmount;

  await recordAction(context, {
    id: actionId,
    actionType: "hold1155",
    actor: normalizedAddress,
    primaryCollection: normalizedContract,
    timestamp,
    chainId,
    txHash,
    logIndex,
    numeric1: tokenCount,
    context: {
      contract: normalizedContract,
      tokenId: tokenId.toString(),
      amount: tokenCount.toString(),
      direction,
      holdingsKey,
      batchIndex,
    },
  });

  // BadgeHolder upsert (envio: context.BadgeHolder.set, last-write-wins).
  const serializedHoldings = JSON.stringify(currentHoldings);
  const existingHolderRow = await context.db.find(badgeHolder, { id: holderId });
  if (existingHolderRow) {
    await context.db.update(badgeHolder, { id: holderId }).set({
      address: holderAddressField as `0x${string}`,
      chainId,
      totalBadges: nextTotal,
      totalAmount: nextTotal,
      holdings: serializedHoldings,
      updatedAt: timestamp,
    });
  } else {
    await context.db
      .insert(badgeHolder)
      .values({
        id: holderId,
        address: holderAddressField as `0x${string}`,
        chainId,
        totalBadges: nextTotal,
        totalAmount: nextTotal,
        holdings: serializedHoldings,
        updatedAt: timestamp,
      })
      .onConflictDoNothing();
  }

  const existingBadgeAmount =
    (await context.db.find(badgeAmount, { id: badgeAmountId })) ??
    (await context.db.find(badgeAmount, { id: legacyBadgeAmountId }));
  if (nextHoldingAmount === 0n) {
    if (existingBadgeAmount) {
      await context.db.delete(badgeAmount, { id: existingBadgeAmount.id });
    }
    if (
      legacyBadgeAmountId !== existingBadgeAmount?.id &&
      legacyBadgeAmountId !== badgeAmountId
    ) {
      const legacyRecord = await context.db.find(badgeAmount, {
        id: legacyBadgeAmountId,
      });
      if (legacyRecord) {
        await context.db.delete(badgeAmount, { id: legacyBadgeAmountId });
      }
    }
  } else {
    // BadgeAmount upsert (envio: context.BadgeAmount.set, last-write-wins).
    const existingBadgeAmountRow = await context.db.find(badgeAmount, {
      id: badgeAmountId,
    });
    if (existingBadgeAmountRow) {
      await context.db.update(badgeAmount, { id: badgeAmountId }).set({
        holderId,
        badgeId: holdingsKey,
        amount: nextHoldingAmount,
        updatedAt: timestamp,
      });
    } else {
      await context.db
        .insert(badgeAmount)
        .values({
          id: badgeAmountId,
          holderId,
          badgeId: holdingsKey,
          amount: nextHoldingAmount,
          updatedAt: timestamp,
        })
        .onConflictDoNothing();
    }

    if (legacyBadgeAmountId !== badgeAmountId) {
      const legacyRecord = await context.db.find(badgeAmount, {
        id: legacyBadgeAmountId,
      });
      if (legacyRecord) {
        await context.db.delete(badgeAmount, { id: legacyBadgeAmountId });
      }
    }
  }

  if (nextBalance <= 0n) {
    if (existingBalance) {
      await context.db.delete(badgeBalance, { id: balanceId });
    }
    return;
  }

  // BadgeBalance upsert (envio: context.BadgeBalance.set, last-write-wins).
  const existingBalanceRow = await context.db.find(badgeBalance, {
    id: balanceId,
  });
  if (existingBalanceRow) {
    await context.db.update(badgeBalance, { id: balanceId }).set({
      holderId,
      contract: normalizedContract as `0x${string}`,
      tokenId,
      chainId,
      amount: nextBalance,
      updatedAt: timestamp,
    });
  } else {
    await context.db
      .insert(badgeBalance)
      .values({
        id: balanceId,
        holderId,
        contract: normalizedContract as `0x${string}`,
        tokenId,
        chainId,
        amount: nextBalance,
        updatedAt: timestamp,
      })
      .onConflictDoNothing();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// TransferSingle — verbatim port of envio handleCubBadgesTransferSingle.
// ────────────────────────────────────────────────────────────────────────────
ponder.on("CubBadges1155:TransferSingle", async ({ event, context }) => {
  const { from, to, id, value } = event.args;
  const chainId = context.chain.id;
  const timestamp = event.block.timestamp;
  const contractAddress = event.log.address.toLowerCase();
  const tokenId = BigInt(id.toString());
  const quantity = BigInt(value.toString());
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  if (quantity === 0n) {
    return;
  }

  await adjustBadgeBalances({
    context,
    holderAddress: from,
    contractAddress,
    tokenId,
    amountDelta: -quantity,
    timestamp,
    chainId,
    txHash,
    logIndex,
    direction: "out",
  });

  await adjustBadgeBalances({
    context,
    holderAddress: to,
    contractAddress,
    tokenId,
    amountDelta: quantity,
    timestamp,
    chainId,
    txHash,
    logIndex,
    direction: "in",
  });
});

// ────────────────────────────────────────────────────────────────────────────
// TransferBatch — verbatim port of envio handleCubBadgesTransferBatch.
// ────────────────────────────────────────────────────────────────────────────
ponder.on("CubBadges1155:TransferBatch", async ({ event, context }) => {
  const { from, to, ids, values } = event.args;
  const chainId = context.chain.id;
  const timestamp = event.block.timestamp;
  const contractAddress = event.log.address.toLowerCase();
  const txHash = event.transaction.hash;
  const baseLogIndex = event.log.logIndex;

  const idsArray = Array.from(ids);
  const valuesArray = Array.from(values);
  const length = Math.min(idsArray.length, valuesArray.length);

  for (let index = 0; index < length; index += 1) {
    const rawId = idsArray[index];
    const rawValue = valuesArray[index];

    if (rawId === undefined || rawValue === undefined || rawValue === null) {
      continue;
    }

    const tokenId = BigInt(rawId.toString());
    const quantity = BigInt(rawValue.toString());

    if (quantity === 0n) {
      continue;
    }

    await adjustBadgeBalances({
      context,
      holderAddress: from,
      contractAddress,
      tokenId,
      amountDelta: -quantity,
      timestamp,
      chainId,
      txHash,
      logIndex: baseLogIndex,
      direction: "out",
      batchIndex: index,
    });

    await adjustBadgeBalances({
      context,
      holderAddress: to,
      contractAddress,
      tokenId,
      amountDelta: quantity,
      timestamp,
      chainId,
      txHash,
      logIndex: baseLogIndex,
      direction: "in",
      batchIndex: index,
    });
  }
});
