// ponder-runtime/tests/erc1155-holder.test.ts
//
// Unit tests for the per-tokenId ERC-1155 holder-balance helpers (sonar-api#62).
// The handler that uses them registers via ponder.on() at module-load time and
// needs the ponder runtime to exercise end-to-end (see byte-parity test). These
// tests target the SHARED PURE HELPERS in src/lib/erc1155-holder.ts:
//
//   - erc1155HolderId      composite key {contract}_{chainId}_{tokenId}_{address}
//   - nextBalance          floor-at-zero + delete-on-empty running-balance math
//   - aggregateBatchDeltas per-tokenId quantity rollup for TransferBatch
//
// These three are the entire new logic; the DB read-modify-write glue is a thin
// port of trackedHolder's proven adjustHolder1155 (handler lines 361-417).

import { describe, expect, it } from "vitest";
import {
  erc1155HolderId,
  nextBalance,
  aggregateBatchDeltas,
} from "../src/lib/erc1155-holder";

describe("erc1155-holder — erc1155HolderId", () => {
  it("composes {contract}_{chainId}_{tokenId}_{address}", () => {
    expect(erc1155HolderId("0xabc", 8453, 4n, "0xdef")).toBe("0xabc_8453_4_0xdef");
  });

  it("lowercases contract and address (key stable regardless of caller hygiene)", () => {
    expect(erc1155HolderId("0xCAFE", 1, 0n, "0xBEEF")).toBe("0xcafe_1_0_0xbeef");
  });

  it("renders very large uint256 tokenIds without precision loss", () => {
    const huge = 2n ** 256n - 1n;
    expect(erc1155HolderId("0xa", 8453, huge, "0xb")).toBe(`0xa_8453_${huge.toString()}_0xb`);
  });

  it("distinguishes editions of the same contract+holder", () => {
    const id4 = erc1155HolderId("0xc", 8453, 4n, "0xw");
    const id5 = erc1155HolderId("0xc", 8453, 5n, "0xw");
    expect(id4).not.toBe(id5);
  });
});

describe("erc1155-holder — nextBalance (floor-at-zero, delete-on-empty)", () => {
  it("increments from zero (first-time holder of an edition)", () => {
    expect(nextBalance(0n, 5n)).toEqual({ stored: 5n, shouldDelete: false });
  });

  it("increments an existing balance", () => {
    expect(nextBalance(3n, 2n)).toEqual({ stored: 5n, shouldDelete: false });
  });

  it("decrements but stays positive", () => {
    expect(nextBalance(5n, -2n)).toEqual({ stored: 3n, shouldDelete: false });
  });

  it("deletes on exact zero", () => {
    expect(nextBalance(5n, -5n)).toEqual({ stored: 0n, shouldDelete: true });
  });

  it("floors and deletes on over-decrement (never persists negative)", () => {
    expect(nextBalance(2n, -5n)).toEqual({ stored: 0n, shouldDelete: true });
  });

  it("handles large uint256 quantities", () => {
    const big = 2n ** 200n;
    expect(nextBalance(big, big)).toEqual({ stored: big * 2n, shouldDelete: false });
  });
});

describe("erc1155-holder — aggregateBatchDeltas", () => {
  it("returns an empty map for empty input", () => {
    expect(aggregateBatchDeltas([], [])).toEqual(new Map());
  });

  it("maps one tokenId to its value", () => {
    expect(aggregateBatchDeltas([4n], [3n])).toEqual(new Map([[4n, 3n]]));
  });

  it("keeps distinct tokenIds separate", () => {
    const m = aggregateBatchDeltas([4n, 5n], [3n, 7n]);
    expect(m.get(4n)).toBe(3n);
    expect(m.get(5n)).toBe(7n);
  });

  it("sums a repeated tokenId so each edition's row is touched once", () => {
    const m = aggregateBatchDeltas([4n, 4n], [3n, 2n]);
    expect(m.get(4n)).toBe(5n);
    expect(m.size).toBe(1);
  });

  it("skips zero-value entries", () => {
    const m = aggregateBatchDeltas([4n, 5n], [0n, 7n]);
    expect(m.has(4n)).toBe(false);
    expect(m.get(5n)).toBe(7n);
  });

  it("throws on an ids/values length mismatch (malformed batch — refuse, don't half-record)", () => {
    expect(() => aggregateBatchDeltas([4n, 5n], [3n])).toThrow(/length mismatch/);
    expect(() => aggregateBatchDeltas([4n], [3n, 7n])).toThrow(/length mismatch/);
  });

  it("accepts equal-length arrays (the EIP-1155 invariant)", () => {
    const m = aggregateBatchDeltas([4n, 5n], [3n, 7n]);
    expect(m.size).toBe(2);
  });
});
