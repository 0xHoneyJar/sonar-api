// ponder-runtime/tests/outbox-pruning.test.ts — T-A2.10 AC unit tests

import { describe, expect, it, vi } from "vitest";
import { pruneOutbox, pruneSql, PRUNE_CONFIG } from "../src/lib/outbox-pruning";

describe("pruneSql", () => {
  it("targets ponder.pending_emits schema-qualified", () => {
    expect(pruneSql()).toContain("ponder.pending_emits");
  });

  it("filters on published_at non-null", () => {
    expect(pruneSql()).toContain("published_at IS NOT NULL");
  });

  it("default retention is 7 days", () => {
    expect(PRUNE_CONFIG.retentionDays).toBe(7);
    expect(pruneSql()).toContain("INTERVAL '7 days'");
  });

  it("custom retention is respected", () => {
    expect(pruneSql(14)).toContain("INTERVAL '14 days'");
  });

  it("converts NOW() to unix-ms bigint", () => {
    expect(pruneSql()).toContain("extract(epoch from");
    expect(pruneSql()).toContain("* 1000");
    expect(pruneSql()).toContain("::bigint");
  });
});

describe("pruneOutbox", () => {
  it("invokes client.query with the prune SQL and returns deleted count", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rowCount: 42 });
    const result = await pruneOutbox({ query: queryMock } as any);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toBe(pruneSql());
    expect(result.deleted).toBe(42);
  });

  it("rejects non-integer retention", async () => {
    const queryMock = vi.fn();
    await expect(pruneOutbox({ query: queryMock } as any, 1.5)).rejects.toThrow(
      /positive integer/,
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects negative retention", async () => {
    await expect(pruneOutbox({ query: vi.fn() } as any, -1)).rejects.toThrow();
  });

  it("returns 0 when rowCount is null", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rowCount: null });
    const result = await pruneOutbox({ query: queryMock } as any);
    expect(result.deleted).toBe(0);
  });
});
