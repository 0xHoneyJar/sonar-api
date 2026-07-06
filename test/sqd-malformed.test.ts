/**
 * T-8: Malformed input logging tests — per-entry validation + rate escalation.
 *
 * SDD §6.3: malformed balance entries are warned and skipped; if >10% of a block's
 * entries are malformed, escalate to error (possible protocol change signal).
 * The stream MUST NOT halt on malformed input.
 */
import { describe, expect, it, vi } from "vitest";
import { decodeSqdBlocks, type SqdBlock } from "../src/svm/sqd-collection-event-source";

const MINT = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w";
const ALICE = "BUjZjAS2vbbb65g7Z1Ca9ZRVYoJscURG5L3AkVvHP9ac";
const BOB = "4mKSoDDqApmF1DqXvVTSL6tu2zixrSSNjqMxUnwvVzy2";
const ACC1 = "2gxanuBRcWieT3Y6ko5dYkFE3LsJK7XzX9EdJDGtYrCj";
const ACC2 = "9QcQnXF9AtixPDzQQvgt7NmWNgqjY6JttstqADzfcASW";
const SIG = "5qiEtJtRBzd6b49mcJdzCYHUtqsXqGC5FUX5SixxgVWErpsbqnabYLLQzSXQcqPr3KjeaXWXZ6GMrxvb1xn3Gqkn";
const MEMBERS = new Set([MINT]);

const goodLosing = {
  transactionIndex: 5, account: ACC1, preMint: MINT, postMint: MINT,
  preOwner: ALICE, postOwner: ALICE, preAmount: "1", postAmount: "0",
};
const goodGaining = {
  transactionIndex: 5, account: ACC2, preMint: MINT, postMint: MINT,
  preOwner: BOB, postOwner: BOB, preAmount: "0", postAmount: "1",
};
const malformedEntry = {
  transactionIndex: 5, account: "not-a-valid-base58!", preMint: MINT, postMint: MINT,
  preOwner: ALICE, postOwner: ALICE, preAmount: "1", postAmount: "0",
};

function makeBlock(tokenBalances: SqdBlock["tokenBalances"]): SqdBlock {
  return {
    header: { number: 428886218, timestamp: 1782422682 },
    transactions: [{ transactionIndex: 5, signatures: [SIG] }],
    tokenBalances,
  };
}

describe("decodeSqdBlocks — malformed entry handling (T-8)", () => {
  it("emits [SQD SKIP] warn for a single malformed member-mint balance entry", () => {
    const warns: string[] = [];
    const log = { warn: (m: string) => warns.push(m), error: vi.fn() };

    decodeSqdBlocks([makeBlock([malformedEntry])], MEMBERS, new Set([MINT]), log);

    expect(warns.some((w) => w.includes("[SQD SKIP]"))).toBe(true);
  });

  it("does NOT halt the stream on malformed entry — continues decoding", () => {
    const log = { warn: vi.fn(), error: vi.fn() };

    // Block with one malformed entry AND two valid entries forming a transfer
    const { events } = decodeSqdBlocks(
      [makeBlock([malformedEntry, goodLosing, goodGaining])],
      MEMBERS,
      new Set([MINT]),
      log,
    );

    // Transfer from the valid pair should still be decoded
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("transfer");
  });

  it("counts skipped malformed entries in skippedMalformedCount", () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const { skippedMalformedCount } = decodeSqdBlocks(
      [makeBlock([malformedEntry])],
      MEMBERS,
      new Set([MINT]),
      log,
    );
    expect(skippedMalformedCount).toBe(1);
  });

  it("escalates to error when >10% of block entries are malformed", () => {
    const errors: string[] = [];
    const log = { warn: vi.fn(), error: (m: string) => errors.push(m) };

    // 10 malformed entries + 1 valid = 91% malformed → escalate
    const tenMalformed = Array.from({ length: 10 }, () => ({ ...malformedEntry }));
    // One valid non-member row (should not count toward malformed)
    // Actually we need member-minting malformed rows: our malformedEntry is already member-minting
    decodeSqdBlocks([makeBlock(tenMalformed)], MEMBERS, new Set([MINT]), log);

    expect(errors.some((e) => e.includes("[SQD MALFORMED]"))).toBe(true);
  });

  it("does NOT escalate to error when malformed rate is <= 10%", () => {
    const errors: string[] = [];
    const log = { warn: vi.fn(), error: (m: string) => errors.push(m) };

    // 1 malformed + 9 valid losing (same tx+mint, will be grouped) = 10% rate (not > 10%)
    const nineValid = Array.from({ length: 9 }, () => ({ ...goodLosing }));
    decodeSqdBlocks([makeBlock([malformedEntry, ...nineValid])], MEMBERS, new Set([MINT]), log);

    expect(errors.some((e) => e.includes("[SQD MALFORMED]"))).toBe(false);
  });

  it("non-member mint rows are NOT counted as malformed (filter spillover)", () => {
    const warns: string[] = [];
    const log = { warn: (m: string) => warns.push(m), error: vi.fn() };

    const nonMemberRow = {
      transactionIndex: 5, account: "not-valid!", preMint: "SomEOtherMint1111111111111111111111111111111",
      postMint: "SomEOtherMint1111111111111111111111111111111",
      preOwner: ALICE, postOwner: ALICE, preAmount: "1", postAmount: "0",
    };
    decodeSqdBlocks([makeBlock([nonMemberRow])], MEMBERS, new Set([MINT]), log);

    // Filter spillover — not counted as malformed, no SKIP warn
    expect(warns.some((w) => w.includes("[SQD SKIP]"))).toBe(false);
  });
});
