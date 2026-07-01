import { describe, expect, it } from "vitest";

import {
  aggregateBatchDeltas,
  erc1155HolderId,
  nextBalance,
} from "../src/lib/erc1155-holder";

describe("erc1155-holder — erc1155HolderId", () => {
  it("composes {contract}_{chainId}_{tokenId}_{address}", () => {
    expect(erc1155HolderId("0xabc", 8453, 4n, "0xdef")).toBe("0xabc_8453_4_0xdef");
  });

  it("lowercases contract and address", () => {
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

describe("erc1155-holder — nextBalance", () => {
  it("increments from zero", () => {
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

  it("floors and deletes on over-decrement", () => {
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

  it("sums a repeated tokenId", () => {
    const m = aggregateBatchDeltas([4n, 4n], [3n, 2n]);
    expect(m.get(4n)).toBe(5n);
    expect(m.size).toBe(1);
  });

  it("skips zero-value entries", () => {
    const m = aggregateBatchDeltas([4n, 5n], [0n, 7n]);
    expect(m.has(4n)).toBe(false);
    expect(m.get(5n)).toBe(7n);
  });

  it("throws on length mismatch", () => {
    expect(() => aggregateBatchDeltas([4n, 5n], [3n])).toThrow(/length mismatch/);
    expect(() => aggregateBatchDeltas([4n], [3n, 7n])).toThrow(/length mismatch/);
  });
});
