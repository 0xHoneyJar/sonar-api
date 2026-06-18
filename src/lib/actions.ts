import type { Action, EvmOnEventContext } from "envio";

type NumericInput = bigint | number | string | null | undefined;

export interface NormalizedActionInput {
  /**
   * Unique identifier; defaults to `${txHash}_${logIndex}` when omitted.
   */
  id?: string;
  /**
   * Mission/verifier friendly action type such as `mint`, `burn`, `swap`, `deposit`.
   */
  actionType: string;
  /**
   * Wallet or contract that executed the action (expected to be lowercase already).
   */
  actor: string;
  /**
   * Optional collection/pool identifier used for grouping.
   */
  primaryCollection?: string | null;
  /**
   * Block timestamp (seconds).
   */
  timestamp: bigint;
  /**
   * Chain/network identifier.
   */
  chainId: number;
  /**
   * Transaction hash for traceability.
   */
  txHash: string;
  /**
   * Optional log index for deterministic id generation.
   */
  logIndex?: number | bigint;
  /**
   * Primary numeric metric (raw token amount, shares, etc.).
   */
  numeric1?: NumericInput;
  /**
   * Secondary numeric metric (usd value, bonus points, etc.).
   */
  numeric2?: NumericInput;
  /**
   * Arbitrary context serialised as JSON for downstream filters.
   */
  context?: Record<string, unknown> | Array<unknown> | null;
}

const toOptionalBigInt = (value: NumericInput): bigint | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return BigInt(trimmed);
};

const serializeContext = (
  context: NormalizedActionInput["context"]
): string | undefined => {
  if (!context) {
    return undefined;
  }

  try {
    return JSON.stringify(context);
  } catch (error) {
    return undefined;
  }
};

const resolveId = (
  input: Pick<NormalizedActionInput, "id" | "txHash" | "logIndex">
): string => {
  if (input.id) {
    return input.id;
  }

  if (input.logIndex === undefined) {
    throw new Error(
      `recordAction requires either an explicit id or logIndex for tx ${input.txHash}`
    );
  }

  return `${input.txHash}_${input.logIndex.toString()}`;
};

export const recordAction = (
  context: Pick<EvmOnEventContext, "Action">,
  input: NormalizedActionInput
): void => {
  const action: Action = {
    id: resolveId(input),
    actionType: input.actionType,
    actor: input.actor,
    primaryCollection: input.primaryCollection ?? undefined,
    timestamp: input.timestamp,
    chainId: input.chainId,
    txHash: input.txHash,
    numeric1: toOptionalBigInt(input.numeric1) ?? undefined,
    numeric2: toOptionalBigInt(input.numeric2) ?? undefined,
    context: serializeContext(input.context),
  };

  context.Action.set(action);
};

export const lowerCaseOrUndefined = (value?: string | null): string | undefined => {
  if (!value) {
    return undefined;
  }
  return value.toLowerCase();
};
