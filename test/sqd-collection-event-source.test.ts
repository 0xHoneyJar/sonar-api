/**
 * SDD §8.2: sqd-collection-event-source tests
 *
 * Covers T-2 (SqdCollectionEventSource decode, PK, transfer pairing) and
 * T-3 (FR-2 convergence gate). Tests are intentionally orthogonal to
 * sqd-decode.test.ts (basic kinds) and sqd-malformed.test.ts (T-8 logging);
 * this file focuses on the multi-event / ATA-creation / convergence cases
 * mandated by SDD §8.2.
 */
import { describe, expect, it, vi } from "vitest";
import { decodeSqdBlocks, type SqdBlock } from "../src/svm/sqd-collection-event-source";
import { parseHeliusTx } from "../src/svm/collection-event-source";
import { eventId } from "../src/svm/collection-event-writer";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const MINT_A = "J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w";
const MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // second distinct mint
const ALICE = "BUjZjAS2vbbb65g7Z1Ca9ZRVYoJscURG5L3AkVvHP9ac";
const BOB = "4mKSoDDqApmF1DqXvVTSL6tu2zixrSSNjqMxUnwvVzy2";
const CAROL = "7dFpHU66x3Teg4e8EgTiENzmrGxXmqyvs2mR8MsJkd3A";
const ATA_OLD = "2gxanuBRcWieT3Y6ko5dYkFE3LsJK7XzX9EdJDGtYrCj";
const ATA_NEW = "9QcQnXF9AtixPDzQQvgt7NmWNgqjY6JttstqADzfcASW";
const SIG = "5qiEtJtRBzd6b49mcJdzCYHUtqsXqGC5FUX5SixxgVWErpsbqnabYLLQzSXQcqPr3KjeaXWXZ6GMrxvb1xn3Gqkn";
const SIG_B = "3xQzJT4QvbbCrBnXzwu9tHkJdzKYHUtqsXqGC5FUX5SixxgVWErpsbqnabYLLQzSXQcqPr3KjeaXWX26GMrxvb1xA";
const SLOT = 428886218;
const BLOCK_TIME = 1782422682;

const MEMBERS_A = new Set([MINT_A]);
const MEMBERS_AB = new Set([MINT_A, MINT_B]);

function makeBlock(
  txIndex: number,
  sig: string,
  tokenBalances: SqdBlock["tokenBalances"],
  extra: Partial<SqdBlock> = {},
): SqdBlock {
  return {
    header: { number: SLOT, timestamp: BLOCK_TIME },
    transactions: [{ transactionIndex: txIndex, signatures: [sig] }],
    tokenBalances,
    ...extra,
  };
}

// ─── ATA-creation transfer pairing ───────────────────────────────────────────

describe("ATA-creation transfer pairing (T-2 FL-6)", () => {
  it("two tokenBalance rows for same mint — old ATA losing, new ATA gaining → one transfer", () => {
    // Scenario: ATA migration (Phantom wallet create-new-ATA-and-migrate).
    // Two rows for MINT_A: old ATA sends (pre=1→post=0), new ATA receives (pre=0→post=1).
    // Both rows are for the same tx and same mint; should produce ONE transfer event.
    const oldAtaLosing = {
      transactionIndex: 0, account: ATA_OLD,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: ALICE, postOwner: ALICE,
      preAmount: "1", postAmount: "0",
    };
    const newAtaGaining = {
      transactionIndex: 0, account: ATA_NEW,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: BOB, postOwner: BOB,
      preAmount: "0", postAmount: "1",
    };
    const b = makeBlock(0, SIG, [oldAtaLosing, newAtaGaining]);
    const { events, ambiguousGroups, rejectedRows } = decodeSqdBlocks([b], MEMBERS_A, new Set([MINT_A]));

    expect(rejectedRows).toBe(0);
    expect(ambiguousGroups).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "transfer",
      from: ALICE,   // pre-owner of the losing ATA
      to: BOB,       // post-owner of the gaining ATA
      nftMint: MINT_A,
      txSignature: SIG,
      slot: SLOT,
    });
  });

  it("ATA-creation pairing assigns ordinal 0 for the first (and only) occurrence of mint in tx", () => {
    const losing = {
      transactionIndex: 0, account: ATA_OLD,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: ALICE, postOwner: ALICE,
      preAmount: "1", postAmount: "0",
    };
    const gaining = {
      transactionIndex: 0, account: ATA_NEW,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: BOB, postOwner: BOB,
      preAmount: "0", postAmount: "1",
    };
    const { events } = decodeSqdBlocks([makeBlock(0, SIG, [losing, gaining])], MEMBERS_A, new Set([MINT_A]));
    expect(events[0].instructionIndex).toBe(0);
  });
});

// ─── Multi-mint tx — per-mint ordinals ───────────────────────────────────────

describe("Multi-mint tx — independent per-mint ordinals (T-2 SDD §8.2)", () => {
  it("two distinct mints transferred in same tx → two events, each with instructionIndex=0", () => {
    // MINT_A and MINT_B are both transferred in the same transaction.
    // Each mint's ordinal counter is independent: both start at 0.
    const mintALosing = {
      transactionIndex: 0, account: ATA_OLD,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: ALICE, postOwner: ALICE,
      preAmount: "1", postAmount: "0",
    };
    const mintAGaining = {
      transactionIndex: 0, account: ATA_NEW,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: BOB, postOwner: BOB,
      preAmount: "0", postAmount: "1",
    };
    const mintBLosing = {
      transactionIndex: 0, account: ATA_OLD,
      preMint: MINT_B, postMint: MINT_B,
      preOwner: BOB, postOwner: BOB,
      preAmount: "1", postAmount: "0",
    };
    const mintBGaining = {
      transactionIndex: 0, account: ATA_NEW,
      preMint: MINT_B, postMint: MINT_B,
      preOwner: CAROL, postOwner: CAROL,
      preAmount: "0", postAmount: "1",
    };
    const b = makeBlock(0, SIG, [mintALosing, mintAGaining, mintBLosing, mintBGaining]);
    const { events } = decodeSqdBlocks([b], MEMBERS_AB, new Set([MINT_A, MINT_B]));

    expect(events).toHaveLength(2);
    const evA = events.find((e) => e.nftMint === MINT_A)!;
    const evB = events.find((e) => e.nftMint === MINT_B)!;
    // Per-mint ordinals: each mint's first event gets ordinal 0
    expect(evA.instructionIndex).toBe(0);
    expect(evB.instructionIndex).toBe(0);
    expect(evA.kind).toBe("transfer");
    expect(evB.kind).toBe("transfer");
  });

  it("same mint appearing in two different txs in the same block gets ordinal 0 in each tx", () => {
    const txA_losing = {
      transactionIndex: 0, account: ATA_OLD,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: ALICE, postOwner: ALICE,
      preAmount: "1", postAmount: "0",
    };
    const txA_gaining = {
      transactionIndex: 0, account: ATA_NEW,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: BOB, postOwner: BOB,
      preAmount: "0", postAmount: "1",
    };
    const txB_losing = {
      transactionIndex: 1, account: ATA_NEW,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: BOB, postOwner: BOB,
      preAmount: "1", postAmount: "0",
    };
    const txB_gaining = {
      transactionIndex: 1, account: ATA_OLD,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: CAROL, postOwner: CAROL,
      preAmount: "0", postAmount: "1",
    };
    const b: SqdBlock = {
      header: { number: SLOT, timestamp: BLOCK_TIME },
      transactions: [
        { transactionIndex: 0, signatures: [SIG] },
        { transactionIndex: 1, signatures: [SIG_B] },
      ],
      tokenBalances: [txA_losing, txA_gaining, txB_losing, txB_gaining],
    };
    const { events } = decodeSqdBlocks([b], MEMBERS_A, new Set([MINT_A]));
    expect(events).toHaveLength(2);
    expect(events[0].instructionIndex).toBe(0); // first occurrence in SIG tx
    expect(events[1].instructionIndex).toBe(0); // first occurrence in SIG_B tx
    expect(events[0].txSignature).toBe(SIG);
    expect(events[1].txSignature).toBe(SIG_B);
  });
});

// ─── Event field completeness ─────────────────────────────────────────────────

describe("Event field completeness (T-2 — all required fields present)", () => {
  it("every decoded event carries slot, blockTime, txSignature, nftMint, kind, instructionIndex", () => {
    const losing = {
      transactionIndex: 0, account: ATA_OLD,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: ALICE, postOwner: ALICE,
      preAmount: "1", postAmount: "0",
    };
    const gaining = {
      transactionIndex: 0, account: ATA_NEW,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: BOB, postOwner: BOB,
      preAmount: "0", postAmount: "1",
    };
    const { events } = decodeSqdBlocks([makeBlock(0, SIG, [losing, gaining])], MEMBERS_A, new Set([MINT_A]));
    const ev = events[0];
    expect(ev.slot).toBe(SLOT);
    expect(ev.blockTime).toBe(BLOCK_TIME);
    expect(ev.txSignature).toBe(SIG);
    expect(ev.nftMint).toBe(MINT_A);
    expect(["mint", "transfer", "burn"]).toContain(ev.kind);
    expect(typeof ev.instructionIndex).toBe("number");
  });

  it("mint event: from=null, to=newOwner", () => {
    const gaining = {
      transactionIndex: 0, account: ATA_NEW,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: BOB, postOwner: BOB,
      preAmount: "0", postAmount: "1",
    };
    const { events } = decodeSqdBlocks([makeBlock(0, SIG, [gaining])], MEMBERS_A, new Set());
    expect(events[0]).toMatchObject({ kind: "mint", from: null, to: BOB });
  });

  it("burn event: from=prevOwner, to=null", () => {
    const losing = {
      transactionIndex: 0, account: ATA_OLD,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: ALICE, postOwner: ALICE,
      preAmount: "1", postAmount: "0",
    };
    const { events } = decodeSqdBlocks([makeBlock(0, SIG, [losing])], MEMBERS_A, new Set([MINT_A]));
    expect(events[0]).toMatchObject({ kind: "burn", from: ALICE, to: null });
  });
});

// ─── FR-2 convergence (T-3) ───────────────────────────────────────────────────

describe("FR-2 PK convergence — SQD decode ↔ parseHeliusTx (T-3)", () => {
  it("same transfer tx yields identical eventId from both decode paths", () => {
    const sqdLosing = {
      transactionIndex: 0, account: ATA_OLD,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: ALICE, postOwner: ALICE,
      preAmount: "1", postAmount: "0",
    };
    const sqdGaining = {
      transactionIndex: 0, account: ATA_NEW,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: BOB, postOwner: BOB,
      preAmount: "0", postAmount: "1",
    };
    const [sqdEvent] = decodeSqdBlocks(
      [makeBlock(0, SIG, [sqdLosing, sqdGaining])],
      MEMBERS_A,
      new Set([MINT_A]),
    ).events;

    const [heliusEvent] = parseHeliusTx(
      {
        signature: SIG,
        slot: SLOT,
        timestamp: BLOCK_TIME,
        type: "TRANSFER",
        tokenTransfers: [
          { mint: MINT_A, fromUserAccount: ALICE, toUserAccount: BOB, tokenStandard: "NonFungible" },
        ],
      },
      (m) => m === MINT_A,
    );

    expect(eventId(sqdEvent)).toBe(eventId(heliusEvent));
    expect(sqdEvent.kind).toBe(heliusEvent.kind);
    expect(sqdEvent.from).toBe(heliusEvent.from);
    expect(sqdEvent.to).toBe(heliusEvent.to);
    expect(sqdEvent.slot).toBe(heliusEvent.slot);
    expect(sqdEvent.blockTime).toBe(heliusEvent.blockTime);
  });

  it("instructionIndex matches between SQD and Helius paths for a single-event tx", () => {
    const sqdLosing = {
      transactionIndex: 0, account: ATA_OLD,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: ALICE, postOwner: ALICE,
      preAmount: "1", postAmount: "0",
    };
    const sqdGaining = {
      transactionIndex: 0, account: ATA_NEW,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: BOB, postOwner: BOB,
      preAmount: "0", postAmount: "1",
    };
    const [sqdEvent] = decodeSqdBlocks(
      [makeBlock(0, SIG, [sqdLosing, sqdGaining])],
      MEMBERS_A,
      new Set([MINT_A]),
    ).events;

    const [heliusEvent] = parseHeliusTx(
      {
        signature: SIG,
        slot: SLOT,
        timestamp: BLOCK_TIME,
        type: "TRANSFER",
        tokenTransfers: [
          { mint: MINT_A, fromUserAccount: ALICE, toUserAccount: BOB, tokenStandard: "NonFungible" },
        ],
      },
      (m) => m === MINT_A,
    );

    expect(sqdEvent.instructionIndex).toBe(heliusEvent.instructionIndex);
    expect(sqdEvent.instructionIndex).toBe(0);
  });
});

// ─── Malformed entry handling (SDD §8.2 / §6.3) ──────────────────────────────

describe("Malformed entry handling (SDD §8.2 — §6.3 cases)", () => {
  const malformed = {
    transactionIndex: 0, account: "!not-base58!", // invalid account
    preMint: MINT_A, postMint: MINT_A,
    preOwner: ALICE, postOwner: ALICE,
    preAmount: "1", postAmount: "0",
  };

  it("malformed member-mint entry emits [SQD SKIP] warn", () => {
    const warns: string[] = [];
    const log = { warn: (m: string) => warns.push(m), error: vi.fn() };
    decodeSqdBlocks([makeBlock(0, SIG, [malformed])], MEMBERS_A, new Set([MINT_A]), log);
    expect(warns.some((w) => w.includes("[SQD SKIP]"))).toBe(true);
  });

  it("stream continues decoding valid rows after a malformed entry", () => {
    const good_losing = {
      transactionIndex: 0, account: ATA_OLD,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: ALICE, postOwner: ALICE,
      preAmount: "1", postAmount: "0",
    };
    const good_gaining = {
      transactionIndex: 0, account: ATA_NEW,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: BOB, postOwner: BOB,
      preAmount: "0", postAmount: "1",
    };
    const log = { warn: vi.fn(), error: vi.fn() };
    const { events } = decodeSqdBlocks(
      [makeBlock(0, SIG, [malformed, good_losing, good_gaining])],
      MEMBERS_A,
      new Set([MINT_A]),
      log,
    );
    // The valid pair should still produce a transfer
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("transfer");
  });

  it("high malformed rate (>10%) escalates to error log", () => {
    const errors: string[] = [];
    const log = { warn: vi.fn(), error: (m: string) => errors.push(m) };
    // 11 malformed entries (all member-mint, all bad account) → 100% malformed → escalate
    const tenMalformed = Array.from({ length: 11 }, () => ({ ...malformed }));
    decodeSqdBlocks([makeBlock(0, SIG, tenMalformed)], MEMBERS_A, new Set([MINT_A]), log);
    expect(errors.some((e) => e.includes("[SQD MALFORMED]"))).toBe(true);
  });

  it("low malformed rate (≤10%) does NOT escalate to error", () => {
    const errors: string[] = [];
    const log = { warn: vi.fn(), error: (m: string) => errors.push(m) };
    // 1 malformed + 9 valid entries → 10% rate (not > 10%) → no escalation
    const nineGood = Array.from({ length: 9 }, () => ({
      transactionIndex: 0, account: ATA_OLD,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: ALICE, postOwner: ALICE,
      preAmount: "1", postAmount: "0",
    }));
    decodeSqdBlocks([makeBlock(0, SIG, [malformed, ...nineGood])], MEMBERS_A, new Set([MINT_A]), log);
    expect(errors.some((e) => e.includes("[SQD MALFORMED]"))).toBe(false);
  });
});

// ─── Continuation semantics ───────────────────────────────────────────────────

describe("Continuation semantics — seenMints carried across windows", () => {
  it("a mint in window-1 is NOT re-classified as mint in window-2 (same seenMints set)", () => {
    const gaining = {
      transactionIndex: 0, account: ATA_NEW,
      preMint: MINT_A, postMint: MINT_A,
      preOwner: BOB, postOwner: BOB,
      preAmount: "0", postAmount: "1",
    };
    const seenMints = new Set<string>();

    // Window 1: MINT_A first appears → kind='mint'
    const r1 = decodeSqdBlocks([makeBlock(0, SIG, [gaining])], MEMBERS_A, seenMints);
    expect(r1.events[0].kind).toBe("mint");
    expect(seenMints.has(MINT_A)).toBe(true); // seenMints mutated in-place

    // Window 2: same MINT_A appears gaining-only again → ambiguous (seen, no loser)
    const r2 = decodeSqdBlocks([makeBlock(0, SIG_B, [gaining])], MEMBERS_A, seenMints);
    expect(r2.events).toHaveLength(0);
    expect(r2.ambiguousGroups).toBe(1);
  });
});
