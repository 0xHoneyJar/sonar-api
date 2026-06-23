import {
  indexer,
  type BadgeHolder as BadgeHolderEntity,
  type BadgeBalance as BadgeBalanceEntity,
  type BadgeAmount as BadgeAmountEntity,
  type EvmOnEventContext,
} from "envio";

import { ZERO_ADDRESS } from "./constants";
import { recordAction } from "../lib/actions";

const ZERO = ZERO_ADDRESS.toLowerCase();

interface BalanceAdjustmentArgs {
  context: EvmOnEventContext;
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
  tokenId: bigint,
) => `${holderId}-${contract}-${tokenId.toString()}`;

const makeHoldingsKey = (contract: string, tokenId: bigint): string =>
  `${contract}-${tokenId.toString()}`;

const cloneHoldings = (
  rawHoldings: unknown,
): Record<string, string> => {
  if (!rawHoldings || typeof rawHoldings !== "object") {
    return {};
  }

  const entries = Object.entries(
    rawHoldings as Record<string, unknown>,
  );

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

  const existingBalance = await context.BadgeBalance.get(balanceId);
  const currentBalance = existingBalance?.amount ?? 0n;

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
  const existingHolder = await context.BadgeHolder.get(holderId);
  const holderAddressField = existingHolder?.address ?? normalizedAddress;
  const currentHoldings = cloneHoldings(existingHolder?.holdings);
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

  const currentTotal = existingHolder?.totalBadges ?? 0n;
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

  recordAction(context, {
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

  const holder: BadgeHolderEntity = {
    id: holderId,
    address: holderAddressField,
    chainId,
    totalBadges: nextTotal,
    totalAmount: nextTotal,
    holdings: currentHoldings,
    updatedAt: timestamp,
  };

  context.BadgeHolder.set(holder);

  const existingBadgeAmount =
    (await context.BadgeAmount.get(badgeAmountId)) ??
    (await context.BadgeAmount.get(legacyBadgeAmountId));
  if (nextHoldingAmount === 0n) {
    if (existingBadgeAmount) {
      context.BadgeAmount.deleteUnsafe(existingBadgeAmount.id);
    }
    if (
      legacyBadgeAmountId !== existingBadgeAmount?.id &&
      legacyBadgeAmountId !== badgeAmountId
    ) {
      const legacyRecord = await context.BadgeAmount.get(legacyBadgeAmountId);
      if (legacyRecord) {
        context.BadgeAmount.deleteUnsafe(legacyBadgeAmountId);
      }
    }
  } else {
    const badgeAmount: BadgeAmountEntity = {
      id: badgeAmountId,
      holder_id: holderId,
      badgeId: holdingsKey,
      amount: nextHoldingAmount,
      updatedAt: timestamp,
    };
    context.BadgeAmount.set(badgeAmount);

    if (legacyBadgeAmountId !== badgeAmountId) {
      const legacyRecord = await context.BadgeAmount.get(legacyBadgeAmountId);
      if (legacyRecord) {
        context.BadgeAmount.deleteUnsafe(legacyBadgeAmountId);
      }
    }
  }

  if (nextBalance <= 0n) {
    if (existingBalance) {
      context.BadgeBalance.deleteUnsafe(balanceId);
    }
    return;
  }

  const balance: BadgeBalanceEntity = {
    id: balanceId,
    holder_id: holderId,
    contract: normalizedContract,
    tokenId,
    chainId,
    amount: nextBalance,
    updatedAt: timestamp,
  };

  context.BadgeBalance.set(balance);
}

indexer.onEvent({ contract: "CubBadges1155", event: "TransferSingle" }, async ({ event, context }) => {
    const { from, to, id, value } = event.params;
    const chainId = event.chainId;
    const timestamp = BigInt(event.block.timestamp);
    const contractAddress = event.srcAddress.toLowerCase();
    const tokenId = BigInt(id.toString());
    const quantity = BigInt(value.toString());
    const txHash = event.transaction.hash;
    const logIndex = Number(event.logIndex);

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

indexer.onEvent({ contract: "CubBadges1155", event: "TransferBatch" }, async ({ event, context }) => {
    const { from, to, ids, values } = event.params;
    const chainId = event.chainId;
    const timestamp = BigInt(event.block.timestamp);
    const contractAddress = event.srcAddress.toLowerCase();
    const txHash = event.transaction.hash;
    const baseLogIndex = Number(event.logIndex);

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
