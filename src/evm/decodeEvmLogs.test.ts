/**
 * decodeEvmLogs.test.ts — pure unit tests for decodeEvmLogs (Sprint 4 Track A, T2).
 *
 * Mirror of src/svm/sqd-loader.test.ts import style (line 10: vitest first).
 *
 * PURE: no network, no DB, no viem mocking. Fixtures are hand-constructed EvmLogRow
 * objects with real keccak topic0 constants and correctly ABI-encoded topics/data
 * produced by viem's real encodeAbiParameters (no mocking, no stubs).
 *
 * Acceptance criteria tested:
 *   AC-1  ERC-721 Transfer: mint / transfer / burn (three sub-cases)
 *   AC-2  ERC-1155 TransferSingle: data-encoded (id, value)
 *   AC-3  ERC-1155 TransferBatch: 2-element (ids, values) → exactly 2 events
 *   AC-4  Belt-semantic SEAM: ownership sequence → TrackedHolder delta + Token owner+isBurned
 *   AC-5  Malformed-row handling: truncated topic → rejected++; unknown topic0 → skipped++;
 *         well-formed rows in same batch still decode (never-throw invariant)
 *   AC-6  Non-member contract: silently skipped (not in events, not in rejected)
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem";
import {
  decodeEvmLogs,
  deriveErc721HolderDeltas,
  deriveErc1155HolderDeltas,
} from "./decodeEvmLogs.js";
import type { EvmLogRow } from "./sqd-evm-loader.js";

// ── Topic0 keccak256 constants ────────────────────────────────────────────────
// Precomputed keccak256 of the canonical ABI event signatures (immutable).

/** Transfer(address indexed from, address indexed to, uint256 indexed tokenId) */
const TOPIC0_ERC721 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value) */
const TOPIC0_ERC1155_SINGLE =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

/** TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values) */
const TOPIC0_ERC1155_BATCH =
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

// ── Address constants ─────────────────────────────────────────────────────────

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
/** In-scope member contract (in MEMBER_SET across all tests). */
const CONTRACT = "0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
/** A valid EVM address NOT in MEMBER_SET — silently dropped by decoder. */
const NON_MEMBER = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead";
const USER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OPERATOR = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
/** Berachain mainnet chain ID (matches belt's deployed environment). */
const CHAIN_ID = "80084";

const MEMBER_SET = new Set([CONTRACT]);

// ── Topic encoding helpers ────────────────────────────────────────────────────

/**
 * ABI-encode a 20-byte address into a 32-byte indexed event topic.
 * EVM ABI spec: addresses are left-padded with 12 zero bytes (24 hex chars).
 */
function addrTopic(addr: string): string {
  // 12 zero bytes = 24 leading hex zeros; then the 40-char address hex body.
  return `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
}

/**
 * ABI-encode a uint256 into a 32-byte indexed event topic.
 * EVM ABI spec: big-endian, zero-padded to 32 bytes.
 */
function uint256Topic(n: bigint): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

// ── Base row fixture builder ───────────────────────────────────────────────────

/** A valid tx_hash (32-byte hex). */
const BASE_TX = `0x${"ab".repeat(32)}`;

/**
 * Build a minimal valid EvmLogRow. All fields pass validateEvmLogRow.
 * Callers override only the fields relevant to their test case.
 */
function baseRow(overrides: Partial<EvmLogRow> = {}): EvmLogRow {
  return {
    chain_id: CHAIN_ID,
    block_number: 1_000_000,
    block_time: 1_700_000_000, // unix-seconds integer — validator converts to ISO
    tx_hash: BASE_TX,
    log_index: 0,
    address: CONTRACT,
    topic0: null,
    topic1: null,
    topic2: null,
    topic3: null,
    data: "0x",
    ...overrides,
  };
}

// ── Event-type fixture builders ───────────────────────────────────────────────

/**
 * ERC-721 Transfer row.
 * Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
 * All three params are indexed: topic1=from, topic2=to, topic3=tokenId; data=0x.
 */
function erc721Row(
  from: string,
  to: string,
  tokenId: bigint,
  overrides: Partial<EvmLogRow> = {},
): EvmLogRow {
  return baseRow({
    topic0: TOPIC0_ERC721,
    topic1: addrTopic(from),
    topic2: addrTopic(to),
    topic3: uint256Topic(tokenId),
    data: "0x",
    ...overrides,
  });
}

/**
 * ERC-1155 TransferSingle row.
 * TransferSingle(address indexed operator, address indexed from, address indexed to,
 *                uint256 id, uint256 value)
 * Indexed: topic1=operator, topic2=from, topic3=to.
 * Data: ABI-encoded (uint256 id, uint256 value).
 */
function erc1155SingleRow(
  from: string,
  to: string,
  tokenId: bigint,
  quantity: bigint,
  overrides: Partial<EvmLogRow> = {},
): EvmLogRow {
  const data = encodeAbiParameters(
    [
      { type: "uint256", name: "id" },
      { type: "uint256", name: "value" },
    ] as const,
    [tokenId, quantity],
  );
  return baseRow({
    topic0: TOPIC0_ERC1155_SINGLE,
    topic1: addrTopic(OPERATOR),
    topic2: addrTopic(from),
    topic3: addrTopic(to),
    data,
    ...overrides,
  });
}

/**
 * ERC-1155 TransferBatch row.
 * TransferBatch(address indexed operator, address indexed from, address indexed to,
 *               uint256[] ids, uint256[] values)
 * Indexed: topic1=operator, topic2=from, topic3=to.
 * Data: ABI-encoded (uint256[] ids, uint256[] values) — dynamic ABI encoding.
 */
function erc1155BatchRow(
  from: string,
  to: string,
  ids: readonly bigint[],
  values: readonly bigint[],
  overrides: Partial<EvmLogRow> = {},
): EvmLogRow {
  const data = encodeAbiParameters(
    [
      { type: "uint256[]", name: "ids" },
      { type: "uint256[]", name: "values" },
    ] as const,
    [ids as bigint[], values as bigint[]],
  );
  return baseRow({
    topic0: TOPIC0_ERC1155_BATCH,
    topic1: addrTopic(OPERATOR),
    topic2: addrTopic(from),
    topic3: addrTopic(to),
    data,
    ...overrides,
  });
}

// ── AC-1: ERC-721 Transfer (mint / transfer / burn) ──────────────────────────

describe("decodeEvmLogs — ERC-721 Transfer (AC-1)", () => {
  it("mint (from=zero): exactly one event, standard=erc721, kind=mint, correct from/to/tokenId", () => {
    const tokenId = 42n;
    const row = erc721Row(ZERO, USER_A, tokenId);
    const { events, rejected, skipped } = decodeEvmLogs([row], { memberSet: MEMBER_SET });

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.standard).toBe("erc721");
    expect(ev.kind).toBe("mint");
    expect(ev.from).toBe(ZERO);
    expect(ev.to).toBe(USER_A);
    expect(ev.tokenId).toBe(tokenId);
    expect(ev.quantity).toBe(1n);
    expect(ev.contract).toBe(CONTRACT);
    expect(ev.chainId).toBe(CHAIN_ID);
    expect(rejected).toBe(0);
    expect(skipped).toBe(0);
  });

  it("transfer (from→to non-zero): one event, kind=transfer, correct addresses", () => {
    const tokenId = 7n;
    const row = erc721Row(USER_A, USER_B, tokenId);
    const { events, rejected, skipped } = decodeEvmLogs([row], { memberSet: MEMBER_SET });

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe("transfer");
    expect(ev.from).toBe(USER_A);
    expect(ev.to).toBe(USER_B);
    expect(ev.tokenId).toBe(tokenId);
    expect(ev.quantity).toBe(1n);
    expect(rejected).toBe(0);
    expect(skipped).toBe(0);
  });

  it("burn (to=zero address): one event, kind=burn, correct from/to", () => {
    const tokenId = 99n;
    const row = erc721Row(USER_A, ZERO, tokenId);
    const { events } = decodeEvmLogs([row], { memberSet: MEMBER_SET });

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe("burn");
    expect(ev.from).toBe(USER_A);
    expect(ev.to).toBe(ZERO);
    expect(ev.tokenId).toBe(tokenId);
  });

  it("burn (to=dead address): one event, kind=burn, to=dead", () => {
    const tokenId = 1n;
    const row = erc721Row(USER_A, DEAD, tokenId);
    const { events } = decodeEvmLogs([row], { memberSet: MEMBER_SET });

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe("burn");
    expect(ev.to).toBe(DEAD);
  });

  it("three rows (mint, transfer, burn) in one batch: three events in order", () => {
    const rows = [
      erc721Row(ZERO, USER_A, 1n, { log_index: 0 }),
      erc721Row(USER_A, USER_B, 1n, { log_index: 1 }),
      erc721Row(USER_B, ZERO, 1n, { log_index: 2 }),
    ];
    const { events } = decodeEvmLogs(rows, { memberSet: MEMBER_SET });

    expect(events).toHaveLength(3);
    expect(events[0]!.kind).toBe("mint");
    expect(events[1]!.kind).toBe("transfer");
    expect(events[2]!.kind).toBe("burn");
  });
});

// ── AC-2: ERC-1155 TransferSingle ────────────────────────────────────────────

describe("decodeEvmLogs — ERC-1155 TransferSingle (AC-2)", () => {
  it("one event, standard=erc1155, correct tokenId and quantity from data-encoded (id,value)", () => {
    const tokenId = 5n;
    const quantity = 3n;
    const row = erc1155SingleRow(USER_A, USER_B, tokenId, quantity);
    const { events, rejected, skipped } = decodeEvmLogs([row], { memberSet: MEMBER_SET });

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.standard).toBe("erc1155");
    expect(ev.tokenId).toBe(tokenId);
    expect(ev.quantity).toBe(quantity);
    expect(ev.from).toBe(USER_A);
    expect(ev.to).toBe(USER_B);
    expect(ev.kind).toBe("transfer");
    expect(ev.contract).toBe(CONTRACT);
    expect(rejected).toBe(0);
    expect(skipped).toBe(0);
  });

  it("mint (from=zero): standard=erc1155, kind=mint", () => {
    const row = erc1155SingleRow(ZERO, USER_A, 9n, 100n);
    const { events } = decodeEvmLogs([row], { memberSet: MEMBER_SET });

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("mint");
    expect(events[0]!.from).toBe(ZERO);
    expect(events[0]!.quantity).toBe(100n);
  });
});

// ── AC-3: ERC-1155 TransferBatch ─────────────────────────────────────────────

describe("decodeEvmLogs — ERC-1155 TransferBatch (AC-3)", () => {
  it("2-element batch: exactly 2 events, one per (id,value) pair with correct tokenId/quantity", () => {
    const ids = [1n, 2n] as const;
    const values = [3n, 4n] as const;
    const row = erc1155BatchRow(USER_A, USER_B, ids, values);
    const { events, rejected, skipped } = decodeEvmLogs([row], { memberSet: MEMBER_SET });

    expect(events).toHaveLength(2);
    // First pair
    expect(events[0]!.tokenId).toBe(1n);
    expect(events[0]!.quantity).toBe(3n);
    // Second pair
    expect(events[1]!.tokenId).toBe(2n);
    expect(events[1]!.quantity).toBe(4n);
    // Both share the same from/to/standard (single log)
    for (const ev of events) {
      expect(ev.standard).toBe("erc1155");
      expect(ev.from).toBe(USER_A);
      expect(ev.to).toBe(USER_B);
      expect(ev.kind).toBe("transfer");
      expect(ev.contract).toBe(CONTRACT);
    }
    expect(rejected).toBe(0);
    expect(skipped).toBe(0);
  });

  it("batch with zero-quantity pair: zero-quantity items skipped, non-zero still emitted", () => {
    // Belt handler: puru-apiculture1155.ts:267-269 — zero-quantity entries are skipped
    const ids = [10n, 20n] as const;
    const values = [0n, 5n] as const; // ids[0] has zero quantity → skip
    const row = erc1155BatchRow(USER_A, USER_B, ids, values);
    const { events } = decodeEvmLogs([row], { memberSet: MEMBER_SET });

    expect(events).toHaveLength(1);
    expect(events[0]!.tokenId).toBe(20n);
    expect(events[0]!.quantity).toBe(5n);
  });
});

// ── AC-4: Belt-semantic SEAM ──────────────────────────────────────────────────

describe("belt-semantic SEAM (AC-4)", () => {
  it("ERC-721 mint→transfer→burn: TrackedHolder delta resolves to zero net for each address", () => {
    // Simulates a full ownership lifecycle for tokenId=42:
    //   mint to USER_A, transfer to USER_B, burn from USER_B
    const tokenId = 42n;
    const rows: EvmLogRow[] = [
      erc721Row(ZERO, USER_A, tokenId, { log_index: 0 }),
      erc721Row(USER_A, USER_B, tokenId, { log_index: 1 }),
      erc721Row(USER_B, ZERO, tokenId, { log_index: 2 }),
    ];
    const { events } = decodeEvmLogs(rows, { memberSet: MEMBER_SET });
    expect(events).toHaveLength(3);

    // Accumulate tokenCount delta via belt-seam function.
    // Belt TrackedHolder.id format (grounded at tracked-erc721.ts:223):
    //   `${contractAddress}_${chainId}_${address}`
    const counts = new Map<string, number>();
    for (const ev of events) {
      for (const d of deriveErc721HolderDeltas(ev)) {
        // Assert ID format
        expect(d.id).toBe(`${d.contract}_${d.chainId}_${d.address}`);
        counts.set(d.id, (counts.get(d.id) ?? 0) + d.delta);
      }
    }

    const holderAId = `${CONTRACT}_${CHAIN_ID}_${USER_A}`;
    const holderBId = `${CONTRACT}_${CHAIN_ID}_${USER_B}`;
    // USER_A: +1 (mint), -1 (transfer) = 0
    expect(counts.get(holderAId) ?? 0).toBe(0);
    // USER_B: +1 (transfer), -1 (burn) = 0
    expect(counts.get(holderBId) ?? 0).toBe(0);
    // ZERO is never a TrackedHolder row (guarded: if (address === ZERO) return)
    expect(counts.has(`${CONTRACT}_${CHAIN_ID}_${ZERO}`)).toBe(false);
  });

  it("ERC-721 burn: Token entity resolves owner=to and isBurned=true after full lifecycle", () => {
    // Belt Token entity is last-write-wins on each Transfer.
    // Belt Token.id format (grounded at honey-jar-nfts.ts:192):
    //   `${collection}_${chainId}_${tokenId}`
    // [LIVE-GATE] collection→contract mapping is out of S4 scope; use CONTRACT as collection key.
    const tokenId = 42n;
    const rows: EvmLogRow[] = [
      erc721Row(ZERO, USER_A, tokenId, { log_index: 0 }),
      erc721Row(USER_A, USER_B, tokenId, { log_index: 1 }),
      erc721Row(USER_B, ZERO, tokenId, { log_index: 2 }),
    ];
    const { events } = decodeEvmLogs(rows, { memberSet: MEMBER_SET });

    // Simulate belt updateTokenOwnership (last event wins):
    //   owner = ev.to; isBurned = (ev.kind === "burn")
    let tokenOwner = "";
    let isBurned = false;
    for (const ev of events) {
      tokenOwner = ev.to;
      isBurned = ev.kind === "burn";
    }

    // Token ID format assertion
    const tokenEntityId = `${CONTRACT}_${CHAIN_ID}_${tokenId}`;
    expect(tokenEntityId).toBe(`${CONTRACT}_80084_42`);
    // After burn to ZERO: owner=ZERO, isBurned=true
    expect(tokenOwner).toBe(ZERO);
    expect(isBurned).toBe(true);
  });

  it("ERC-1155 mint→transfer: TrackedHolder1155 balance reflects correct per-tokenId delta", () => {
    // Mint 10 of tokenId=5 to USER_A; transfer 6 of tokenId=5 from USER_A to USER_B.
    // Expected per-tokenId balance: USER_A=4 (10-6), USER_B=6 (0+6).
    const tokenId = 5n;
    const mintRow = erc1155SingleRow(ZERO, USER_A, tokenId, 10n, { log_index: 0 });
    const transferRow = erc1155SingleRow(USER_A, USER_B, tokenId, 6n, { log_index: 1 });

    const { events } = decodeEvmLogs([mintRow, transferRow], { memberSet: MEMBER_SET });
    expect(events).toHaveLength(2);

    // Accumulate per-tokenId balances via belt-seam function.
    // Belt TrackedHolder1155.id format (grounded at erc1155-holder.ts:erc1155HolderId):
    //   `${contract}_${chainId}_${tokenId}_${address}`
    const balances = new Map<string, bigint>();
    for (const ev of events) {
      const { perTokenDeltas } = deriveErc1155HolderDeltas(ev);
      for (const d of perTokenDeltas) {
        // Assert ID format
        expect(d.id).toBe(`${d.contract}_${d.chainId}_${d.tokenId}_${d.address}`);
        balances.set(d.id, (balances.get(d.id) ?? 0n) + d.delta);
      }
    }

    const balAId = `${CONTRACT}_${CHAIN_ID}_${tokenId}_${USER_A}`;
    const balBId = `${CONTRACT}_${CHAIN_ID}_${tokenId}_${USER_B}`;
    // USER_A: +10 on mint (no from delta on mint), -6 on transfer = net 4
    expect(balances.get(balAId)).toBe(4n);
    // USER_B: +6 on transfer = 6
    expect(balances.get(balBId)).toBe(6n);
    // ZERO never gets a per-tokenId row (isMint guard skips from delta on mint)
    expect(balances.has(`${CONTRACT}_${CHAIN_ID}_${tokenId}_${ZERO}`)).toBe(false);
  });

  it("ERC-1155 aggregate TrackedHolder delta: ±quantity (belt token-count sum)", () => {
    // verify:s4 MEDIUM: the belt aggregate tokenCount is a SUM OF QUANTITIES, not ±1 per event
    // (erc1155-holder nextBalance/aggregateBatchDeltas + the handler's adjustHolder1155 all
    // apply ±quantity). mint 50 then transfer 20.
    const tokenId = 3n;
    const mintRow = erc1155SingleRow(ZERO, USER_A, tokenId, 50n, { log_index: 0 });
    const transferRow = erc1155SingleRow(USER_A, USER_B, tokenId, 20n, { log_index: 1 });

    const { events } = decodeEvmLogs([mintRow, transferRow], { memberSet: MEMBER_SET });

    const aggregateCounts = new Map<string, number>();
    for (const ev of events) {
      const { aggregateDeltas } = deriveErc1155HolderDeltas(ev);
      for (const d of aggregateDeltas) {
        aggregateCounts.set(d.id, (aggregateCounts.get(d.id) ?? 0) + d.delta);
      }
    }

    const aggA = `${CONTRACT}_${CHAIN_ID}_${USER_A}`;
    const aggB = `${CONTRACT}_${CHAIN_ID}_${USER_B}`;
    // USER_A: +50 (mint) −20 (transfer) = 30
    expect(aggregateCounts.get(aggA) ?? 0).toBe(30);
    // USER_B: +20 (transfer) = 20
    expect(aggregateCounts.get(aggB) ?? 0).toBe(20);
  });
});

// ── AC-5: Malformed-row handling (never-throw invariant) ─────────────────────

describe("decodeEvmLogs — malformed rows (AC-5)", () => {
  it("truncated topic0 on member address: rejected++, no throw, well-formed rows still decode", () => {
    // "0xdeadbeef" = 4 bytes = fails is32ByteHex (requires 32 bytes / 66 chars).
    // The row names a member address → counts as rejected (mirrors SVM spillover rule).
    const malformedRow: EvmLogRow = baseRow({
      address: CONTRACT, // member — so failed validation counts as rejected
      topic0: "0xdeadbeef", // 10 chars, not 66 → fails is32ByteHex
    });
    const goodRow = erc721Row(USER_A, USER_B, 1n, { log_index: 1 });

    const { events, rejected, skipped } = decodeEvmLogs(
      [malformedRow, goodRow],
      { memberSet: MEMBER_SET },
    );

    expect(rejected).toBe(1); // malformed member row counted
    expect(skipped).toBe(0);
    expect(events).toHaveLength(1); // good row still decoded — never-throw
    expect(events[0]!.from).toBe(USER_A);
  });

  it("non-hex topic0 on member address: rejected++, no throw", () => {
    // Completely non-hex value for topic0 also fails is32ByteHex.
    const malformedRow: EvmLogRow = baseRow({ topic0: "not-hex-at-all" });
    const { events, rejected, skipped } = decodeEvmLogs([malformedRow], { memberSet: MEMBER_SET });

    expect(rejected).toBe(1);
    expect(skipped).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("valid hex but unknown topic0: skipped++, no throw, well-formed rows still decode", () => {
    // A valid 32-byte hex that does not match any of the three in-scope topic0s.
    const unknownTopic0Row: EvmLogRow = baseRow({
      topic0: "0x1111111111111111111111111111111111111111111111111111111111111111",
      data: "0x",
      log_index: 0,
    });
    const goodRow = erc721Row(USER_A, USER_B, 1n, { log_index: 1 });

    const { events, rejected, skipped } = decodeEvmLogs(
      [unknownTopic0Row, goodRow],
      { memberSet: MEMBER_SET },
    );

    expect(skipped).toBe(1); // unknown topic0 → skipped
    expect(rejected).toBe(0);
    expect(events).toHaveLength(1); // good row still decoded
  });

  it("never-throw invariant: mixed batch (malformed, unknown, valid) produces correct counts", () => {
    // Three rows in one batch:
    //   Row 0: truncated topic0 (member address) → rejected=1
    //   Row 1: valid hex, unknown topic0 → skipped=1
    //   Row 2: well-formed ERC-721 mint → 1 event
    // The decoder must not throw on any row.
    const rows: EvmLogRow[] = [
      baseRow({ topic0: "0xbad", log_index: 0 }),
      baseRow({
        topic0: "0x2222222222222222222222222222222222222222222222222222222222222222",
        log_index: 1,
      }),
      erc721Row(ZERO, USER_A, 7n, { log_index: 2 }),
    ];

    // Must not throw
    const result = decodeEvmLogs(rows, { memberSet: MEMBER_SET });

    expect(result.rejected).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.kind).toBe("mint");
    expect(result.events[0]!.to).toBe(USER_A);
  });

  it("never-throw: malformed ERC-1155 data payload (truncated) → skipped, no throw", () => {
    // A row with ERC-1155 TransferSingle topic0 but truncated data (< 64 bytes).
    // decodeAbiParameters would throw internally → decoder catches and increments skipped.
    const badDataRow: EvmLogRow = baseRow({
      topic0: TOPIC0_ERC1155_SINGLE,
      topic1: addrTopic(OPERATOR),
      topic2: addrTopic(USER_A),
      topic3: addrTopic(USER_B),
      data: "0x1234", // truncated: only 2 bytes, not the expected 64
    });
    const goodRow = erc721Row(USER_A, USER_B, 55n, { log_index: 1 });

    const result = decodeEvmLogs([badDataRow, goodRow], { memberSet: MEMBER_SET });

    expect(result.skipped).toBe(1); // bad data caught inside try/catch → skipped
    expect(result.rejected).toBe(0);
    expect(result.events).toHaveLength(1); // good row unaffected
  });
});

// ── AC-6: Non-member contract silently skipped ────────────────────────────────

describe("decodeEvmLogs — non-member contract (AC-6)", () => {
  it("valid ERC-721 row for non-member address: not in events, not rejected, not skipped", () => {
    // NON_MEMBER is not in MEMBER_SET — the row is valid but out of scope for this pass.
    // Non-member valid rows are filter spillover: silently ignored, never counted.
    const nonMemberRow = erc721Row(USER_A, USER_B, 1n, { address: NON_MEMBER });

    const { events, rejected, skipped } = decodeEvmLogs([nonMemberRow], { memberSet: MEMBER_SET });

    expect(events).toHaveLength(0);
    expect(rejected).toBe(0); // non-member spillover: NOT counted as rejected
    expect(skipped).toBe(0);  // NOT counted as skipped either
  });

  it("mixed batch with one member and one non-member: only member produces event", () => {
    const memberRow = erc721Row(USER_A, USER_B, 2n, { log_index: 0 });
    const nonMemberRow = erc721Row(USER_A, USER_B, 3n, {
      address: NON_MEMBER,
      log_index: 1,
    });

    const { events, rejected, skipped } = decodeEvmLogs(
      [memberRow, nonMemberRow],
      { memberSet: MEMBER_SET },
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.tokenId).toBe(2n);  // only the member-contract event
    expect(events[0]!.contract).toBe(CONTRACT);
    expect(rejected).toBe(0);
    expect(skipped).toBe(0);
  });

  it("non-member with malformed topic: not counted as rejected (spillover takes precedence)", () => {
    // Non-member address that ALSO has a malformed topic.
    // Decoder rejects first if address is a namedMember; since NON_MEMBER is NOT in memberSet,
    // the failed-validation row is NOT counted (spillover rule).
    const row: EvmLogRow = baseRow({
      address: NON_MEMBER, // not in MEMBER_SET
      topic0: "0xtruncated",
    });

    const { events, rejected, skipped } = decodeEvmLogs([row], { memberSet: MEMBER_SET });

    expect(events).toHaveLength(0);
    expect(rejected).toBe(0); // namedMember check fails → not counted
    expect(skipped).toBe(0);
  });
});
