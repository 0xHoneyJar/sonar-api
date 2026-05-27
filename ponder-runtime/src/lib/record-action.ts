// ponder-runtime/src/lib/record-action.ts
//
// Ponder-side analog of envio's src/lib/actions.ts (recordAction).
// Same input shape; writes into the `action` ponder schema table via
// context.db.insert(action).values(...).onConflictDoNothing().
//
// envio used context.Action.set() (last-write-wins). Ponder uses an upsert
// pattern via onConflictDoNothing() since reorg-replay can re-execute a
// handler against an already-written id; preserving the existing row
// matches envio's semantics (the second write is just the same payload).
//
// Why we don't reuse envio's lib directly: envio's lib imports `from "generated"`
// (ReScript codegen output) and binds to the Action entity surface. Ponder
// doesn't run envio codegen, so the import surface is incompatible. The
// recordAction helper is small enough that a direct port is clearer than
// adapter shim.

import { action } from "../../ponder.schema";

type NumericInput = bigint | number | string | null | undefined;

export interface NormalizedActionInput {
  /** Unique identifier; defaults to `${txHash}_${logIndex}` when omitted. */
  id?: string;
  /** Mission/verifier friendly action type. */
  actionType: string;
  /** Wallet or contract that executed the action (lowercase expected). */
  actor: string;
  /** Optional collection/pool identifier used for grouping. */
  primaryCollection?: string | null;
  /** Block timestamp (seconds). */
  timestamp: bigint;
  /** Chain/network identifier. */
  chainId: number;
  /** Transaction hash for traceability. */
  txHash: string;
  /** Optional log index for deterministic id generation. */
  logIndex?: number | bigint;
  /** Primary numeric metric (raw token amount, shares, etc.). */
  numeric1?: NumericInput;
  /** Secondary numeric metric (usd value, bonus points, etc.). */
  numeric2?: NumericInput;
  /** Arbitrary context serialised as JSON for downstream filters. */
  context?: Record<string, unknown> | Array<unknown> | null;
}

const toOptionalBigInt = (value: NumericInput): bigint | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return BigInt(trimmed);
};

const serializeContext = (
  ctx: NormalizedActionInput["context"]
): string | null => {
  if (!ctx) return null;
  try {
    return JSON.stringify(ctx);
  } catch {
    return null;
  }
};

const resolveId = (
  input: Pick<NormalizedActionInput, "id" | "txHash" | "logIndex">
): string => {
  if (input.id) return input.id;
  if (input.logIndex === undefined) {
    throw new Error(
      `recordAction requires either an explicit id or logIndex for tx ${input.txHash}`
    );
  }
  return `${input.txHash}_${input.logIndex.toString()}`;
};

/**
 * Ponder-side recordAction: insert an `action` row idempotently.
 *
 * Accepts the same input shape as envio's lib so handlers ported from envio
 * read identically. Note the second arg is a ponder `context` (any-typed for
 * the same reasons documented in outbox-flush.ts G-6) — only `context.db` is
 * used.
 */
export async function recordAction(
  context: any,
  input: NormalizedActionInput
): Promise<void> {
  await context.db
    .insert(action)
    .values({
      id: resolveId(input),
      actionType: input.actionType,
      actor: input.actor as `0x${string}`,
      primaryCollection: input.primaryCollection ?? null,
      timestamp: input.timestamp,
      chainId: input.chainId,
      txHash: input.txHash as `0x${string}`,
      numeric1: toOptionalBigInt(input.numeric1),
      numeric2: toOptionalBigInt(input.numeric2),
      context: serializeContext(input.context),
    })
    .onConflictDoNothing();
}
