// ponder-runtime/tests/reorg-safe-emit.test.ts — T-A2.2 AC unit tests
//
// AC: deterministic IDs from cookbook §T-A0.9; per-chain reorg depth honored.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { keccak256, toBytes } from "viem";
import {
  deterministicEmitId,
  reorgSafeEmit,
  REORG_DEPTH_BY_CHAIN,
  reorgDepthFor,
} from "../src/lib/reorg-safe-emit";

describe("deterministicEmitId", () => {
  it("matches cookbook §T-A0.9 canonical form", () => {
    const chainId = 1;
    const txHash = "0xdeadbeef00000000000000000000000000000000000000000000000000000000" as `0x${string}`;
    const logIndex = 3;
    const envelopeType = "mint";
    const expected = keccak256(toBytes(`${chainId}|${txHash}|${logIndex}|${envelopeType}`));
    expect(deterministicEmitId(chainId, txHash, logIndex, envelopeType)).toBe(expected);
  });

  it("lowercases txHash before hashing (mixed-case input safe)", () => {
    const upper = "0xDEADBEEF00000000000000000000000000000000000000000000000000000000" as `0x${string}`;
    const lower = "0xdeadbeef00000000000000000000000000000000000000000000000000000000" as `0x${string}`;
    expect(deterministicEmitId(1, upper, 0, "mint")).toBe(deterministicEmitId(1, lower, 0, "mint"));
  });

  it("differentiates by logIndex (same-tx-multi-logs)", () => {
    const txHash = "0xabc0000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
    expect(deterministicEmitId(1, txHash, 0, "mint")).not.toBe(
      deterministicEmitId(1, txHash, 1, "mint"),
    );
  });

  it("differentiates by chainId (cross-chain)", () => {
    const txHash = "0xabc0000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
    expect(deterministicEmitId(1, txHash, 0, "mint")).not.toBe(
      deterministicEmitId(8453, txHash, 0, "mint"),
    );
  });

  it("differentiates by envelopeType (multi-envelope-per-event)", () => {
    const txHash = "0xabc0000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
    expect(deterministicEmitId(1, txHash, 0, "mint")).not.toBe(
      deterministicEmitId(1, txHash, 0, "transfer"),
    );
  });

  it("identical inputs produce identical id (reorg-replay idempotency)", () => {
    const txHash = "0xfeedface00000000000000000000000000000000000000000000000000000000" as `0x${string}`;
    expect(deterministicEmitId(80094, txHash, 7, "burn")).toBe(
      deterministicEmitId(80094, txHash, 7, "burn"),
    );
  });
});

describe("REORG_DEPTH_BY_CHAIN", () => {
  it("matches SDD §5.3 table", () => {
    expect(REORG_DEPTH_BY_CHAIN[1]).toBe(12n);
    expect(REORG_DEPTH_BY_CHAIN[10]).toBe(0n);
    expect(REORG_DEPTH_BY_CHAIN[8453]).toBe(0n);
    expect(REORG_DEPTH_BY_CHAIN[42161]).toBe(0n);
    expect(REORG_DEPTH_BY_CHAIN[7777777]).toBe(0n);
    expect(REORG_DEPTH_BY_CHAIN[80094]).toBe(200n);
  });

  it("reorgDepthFor falls back to 12 for unknown chain", () => {
    expect(reorgDepthFor(999999)).toBe(12n);
  });
});

describe("reorgSafeEmit — depth=0 L2 inline-publish", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does NOT write to outbox on Base (depth=0)", async () => {
    // We trigger the inline-publish path by leaving env vars unset → publisher
    // is permanently disabled → DROPPED log + early return inside
    // publishEnvelope. The lib's L2 branch wraps in try/catch swallow, so no
    // throw escapes here, AND no db.insert is made.
    delete process.env.NATS_URL;
    delete process.env.SONAR_SIGNING_SEED_HEX;

    const insertSpy = vi.fn(() => ({
      values: vi.fn(() => ({ onConflictDoNothing: vi.fn() })),
    }));
    const mockCtx = { db: { insert: insertSpy } };

    const envelope = {
      type: "mint" as const,
      subject: "nft.mint.detected.mibera-sets.v1",
      payload: {
        chain_id: 8453,
        contract: "0xabc",
        token_id: "1",
        minter: "0xdef",
        block_number: 100,
        transaction_hash: "0x123",
        timestamp: "2026-05-27T00:00:00.000Z",
      },
    };
    const event = {
      log: { logIndex: 0 },
      transaction: { hash: ("0x" + "1".repeat(64)) as `0x${string}` },
      block: { number: 100n },
    };

    await reorgSafeEmit(mockCtx as any, envelope, event, 8453);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe("reorgSafeEmit — depth>0 outbox insert", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes to pending_emits on Ethereum (depth=12)", async () => {
    const valuesSpy: any = vi.fn(() => ({ onConflictDoNothing: vi.fn() }));
    const insertSpy = vi.fn(() => ({ values: valuesSpy }));
    const mockCtx = { db: { insert: insertSpy } };

    const envelope = {
      type: "mint",
      subject: "nft.mint.detected.mibera-collection.v1",
      payload: {
        chain_id: 1,
        contract: "0xabc",
        token_id: "42",
        minter: "0xdef",
        block_number: 18000000,
        transaction_hash: "0x" + "1".repeat(64),
        timestamp: "2026-05-27T00:00:00.000Z",
      },
    };
    const event = {
      log: { logIndex: 7 },
      transaction: { hash: ("0x" + "1".repeat(64)) as `0x${string}` },
      block: { number: 18_000_000n },
    };

    await reorgSafeEmit(mockCtx as any, envelope, event, 1);

    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(valuesSpy).toHaveBeenCalledTimes(1);
    const row = valuesSpy.mock.calls[0][0];
    expect(row.chainId).toBe(1);
    expect(row.envelopeType).toBe("mint");
    expect(row.eventBlock).toBe(18_000_000n);
    expect(row.targetBlock).toBe(18_000_000n + 12n);
    expect(row.publishedAt).toBe(null);
    expect(row.attemptCount).toBe(0);
    expect(row.id).toBe(
      deterministicEmitId(1, ("0x" + "1".repeat(64)) as `0x${string}`, 7, "mint"),
    );
  });

  it("writes to pending_emits on Berachain (depth=200)", async () => {
    const valuesSpy: any = vi.fn(() => ({ onConflictDoNothing: vi.fn() }));
    const insertSpy = vi.fn(() => ({ values: valuesSpy }));
    const mockCtx = { db: { insert: insertSpy } };

    const envelope = {
      type: "transfer",
      subject: "nft.transfer.detected.mibera-collection.v1",
      payload: {
        chain_id: 80094,
        contract: "0x666",
        token_id: "100",
        minter: "0xdef",
        block_number: 5_000_000,
        transaction_hash: "0x" + "2".repeat(64),
        timestamp: "2026-05-27T00:00:00.000Z",
      },
    };
    const event = {
      log: { logIndex: 0 },
      transaction: { hash: ("0x" + "2".repeat(64)) as `0x${string}` },
      block: { number: 5_000_000n },
    };

    await reorgSafeEmit(mockCtx as any, envelope, event, 80094);
    const row = valuesSpy.mock.calls[0][0];
    expect(row.targetBlock).toBe(5_000_000n + 200n);
  });
});
