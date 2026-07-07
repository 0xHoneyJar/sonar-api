/**
 * [LIVE-GATE] gate2-evm-parity.ts — GATE-2 EVM ownership parity harness
 * (Sprint 4 · Track A · FR-A5 · SDD §2.4).
 *
 * Analog of the SVM 1767/1767 gate (test/sqd-45-gate-integration.test.ts +
 * scripts/parity-check.sh). Run MANUALLY on staging before an EVM chain alias
 * flip — NEVER in the CI decode-purity path.
 *
 * Live dependencies (both required; hence [LIVE-GATE]):
 *   1. raw.evm_log rows in Postgres (DATABASE_URL or EVM_HASURA_ENDPOINT run_sql)
 *   2. Belt Hasura output (EVM_HASURA_ENDPOINT + HASURA_GRAPHQL_ADMIN_SECRET)
 *   3. T1 decoder: src/evm/decodeEvmLogs.ts (T1 boundary stub below)
 *
 * Belt-semantic entity names and ID formats are the load-bearing dependency:
 *   TrackedHolder     id = "${contract}_${chainId}_${address}"      field: tokenCount
 *   Token             id = "${collection}_${chainId}_${tokenId}"     fields: owner, isBurned
 *   TrackedHolder1155 id = "${contract}_${chainId}_${tokenId}_${addr}" field: balance
 *
 * S4 scope (derivable from a single raw.evm_log row, no external lookup):
 *   ERC-721  Transfer(from, to, tokenId)               → TrackedHolder + Token (HoneyJar)
 *   ERC-1155 TransferSingle(op, from, to, id, value)   → TrackedHolder + TrackedHolder1155
 *   ERC-1155 TransferBatch(op, from, to, ids, values)  → TrackedHolder + TrackedHolder1155
 *
 * [LIVE-GATE] Out of S4 scope — entities that require cross-table state or
 * collection-specific joins: Holder, CollectionStat, UserBalance,
 * GlobalCollectionStat, MintActivity, MiberaTransfer, Action.
 *
 * Usage:
 *   tsx scripts/gate2-evm-parity.ts \
 *     --chain <chainId>    \
 *     --from-block <N>     \
 *     --to-block <M>       \
 *     [--contract <0xhex>]
 *
 * Authoritative gate: run with --from-block 0 --to-block <belt-head> for the
 * full-history comparison (EVM analog of 1767/1767 zero-divergence assertion).
 * Partial-range runs are useful regression probes but not the cutover gate.
 *
 * Exit codes:
 *   0 — divergent == 0 across TrackedHolder + Token + TrackedHolder1155
 *   1 — divergences detected; review table before alias flip
 *   2 — precondition failure (missing env, T1 unavailable, no rows in range)
 */

import { fileURLToPath } from "node:url";
import pg from "pg";

// ── Environment ────────────────────────────────────────────────────────────────
/** Belt Hasura GraphQL endpoint (admin access — run_sql + entity queries). */
const HASURA = (process.env.EVM_HASURA_ENDPOINT ?? process.env.SVM_HASURA_ENDPOINT ?? "").replace(/\/$/, "");
const SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? "";
/** Direct Postgres connection — used for raw.evm_log reads. Fallback: Hasura run_sql. */
const DATABASE_URL = process.env.DATABASE_URL ?? "";

// ── Address constants (mirrors src/handlers/mint-detection.ts) ─────────────────
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

function isBurnAddress(addr: string): boolean {
  const l = addr.toLowerCase();
  return l === ZERO_ADDRESS || l === DEAD_ADDRESS;
}

// ── [LIVE-GATE] HoneyJar collection map (mirrors src/handlers/constants.ts) ───
// Required for Token entity ID derivation: Token.id = "${collection}_${chainId}_${tokenId}".
// The collection NAME (not the contract address) is the first segment.
// Verify each entry against the live belt Hasura before running the full gate.
const ADDRESS_TO_COLLECTION: Record<string, string> = {
  // Ethereum
  "0xa20cf9b0874c3e46b344deaeea9c2e0c3e1db37d": "HoneyJar1",
  "0x98dc31a9648f04e23e4e36b0456d1951531c2a05": "HoneyJar6",
  "0xcb0477d1af5b8b05795d89d59f4667b59eae9244": "Honeycomb",
  "0x3f4dd25ba6fb6441bfd1a869cbda6a511966456d": "HoneyJar2",
  "0x49f3915a52e137e597d6bf11c73e78c68b082297": "HoneyJar3",
  "0x0b820623485dcfb1c40a70c55755160f6a42186d": "HoneyJar4",
  "0x39eb35a84752b4bd3459083834af1267d276a54c": "HoneyJar5",
  // Arbitrum
  "0x1b2751328f41d1a0b91f3710edcd33e996591b72": "HoneyJar2",
  // Zora
  "0xe798c4d40bc050bc93c7f3b149a0dfe5cfc49fb0": "HoneyJar3",
  // Optimism
  "0xe1d16cc75c9f39a2e0f5131eb39d4b634b23f301": "HoneyJar4",
  // Base
  "0xbad7b49d985bbfd3a22706c447fb625a28f048b4": "HoneyJar5",
  // Berachain
  "0xedc5dfd6f37464cc91bbce572b6fe2c97f1bc7b3": "HoneyJar1",
  "0x1c6c24cac266c791c4ba789c3ec91f04331725bd": "HoneyJar2",
  "0xf1e4a550772fabfc35b28b51eb8d0b6fcd1c4878": "HoneyJar3",
  "0xdb602ab4d6bd71c8d11542a9c8c936877a9a4f45": "HoneyJar4",
  "0x0263728e7f59f315c17d3c180aeade027a375f17": "HoneyJar5",
  "0xb62a9a21d98478f477e134e175fd2003c15cb83a": "HoneyJar6",
  "0x886d2176d899796cd1affa07eff07b9b2b80f1be": "Honeycomb",
};

// ── T1 boundary stub ───────────────────────────────────────────────────────────
//
// [LIVE-GATE] T1 = src/evm/decodeEvmLogs.ts (not yet built at T3 authoring time).
// When T1 is merged, replace the dynamic import below with:
//   import { decodeEvmLogs, type EvmOwnershipEvent, type EvmDecodeResult } from "../src/evm/decodeEvmLogs.js";
//
// This boundary defines the T1 contract that the gate enforces:
//   decodeEvmLogs(rows: ValidEvmLogRow[]) → EvmDecodeResult
//
// The decoder is PURE — no network, no DB reads. It mirrors the SVM decodeSqdBlocks
// invariants: never throws on malformed input; rejects+counts bad rows; each log is
// one atomic ownership change (no ambiguousGroups, no seenMints needed on the EVM side).

/** Typed EVM log row (post-validation by validateEvmLogRow in sqd-evm-loader.ts). */
export interface ValidEvmLogRow {
  chain_id: string;
  block_number: number;
  block_time: string;   // ISO-8601
  tx_hash: string;      // 0x-prefixed
  log_index: number;
  address: string;      // 0x-prefixed, lowercased contract address
  topic0: string | null;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  data: string;         // 0x-prefixed hex
}

/** Ownership event decoded from a single raw.evm_log row. */
export interface EvmOwnershipEvent {
  /** Which ABI event was decoded. */
  eventType: "erc721_transfer" | "erc1155_single" | "erc1155_batch_item";

  // Raw provenance
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: string;

  // Transfer parameters (all addresses lowercased)
  contract: string;    // on-chain contract address
  chainId: number;
  from: string;        // zero address = mint
  to: string;          // zero or dead address = burn
  tokenId: bigint;
  /** ERC-721: always 1. ERC-1155: quantity transferred. */
  value: bigint;

  /**
   * [LIVE-GATE] Collection name for Token entity ID derivation.
   * Populated by T1 when the contract is in the HoneyJar registry.
   * null when the contract is not a HoneyJar collection → Token parity skipped.
   */
  collection: string | null;
}

/** Result shape returned by decodeEvmLogs (T1). Mirrors SqdDecodeResult. */
export interface EvmDecodeResult {
  events: EvmOwnershipEvent[];
  /** Rows that failed validateEvmLogRow (hex format, missing required fields). */
  rejectedRows: number;
  /** topic0/data decode failures (e.g. ABI mismatch) — skipped, never throw. */
  skippedMalformedCount: number;
}

/** Internal decode fn this harness uses (T1 output already adapted to the shape above). */
type DecodeEvmLogsFn = (rows: ValidEvmLogRow[]) => EvmDecodeResult;

// verify:s4 MEDIUM — the REAL T1 contract differs from the T3-authoring stub above: it is
// decodeEvmLogs(rows, {memberSet}) and returns events with {standard,kind,quantity,chainId:string}
// + {rejected,skipped}. adaptT1Result() maps that to this harness's internal EvmOwnershipEvent /
// EvmDecodeResult so accumulateEvents (which reads eventType/value/collection/rejectedRows) is
// unchanged. Without this the gate threw TypeError (no memberSet) and read NaN/undefined fields.
interface T1Event {
  standard: "erc721" | "erc1155";
  kind: "mint" | "transfer" | "burn";
  contract: string;
  chainId: string;
  from: string;
  to: string;
  tokenId: bigint;
  quantity: bigint;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: string;
}
interface T1Result { events: T1Event[]; rejected: number; skipped: number; }
type RealDecodeFn = (rows: ValidEvmLogRow[], opts: { memberSet: ReadonlySet<string> }) => T1Result;

function adaptT1Result(r: T1Result): EvmDecodeResult {
  return {
    events: r.events.map((e): EvmOwnershipEvent => ({
      // T1 emits per-item events (batch already expanded), so erc1155 → single-item semantics.
      eventType: e.standard === "erc721" ? "erc721_transfer" : "erc1155_single",
      txHash: e.txHash,
      logIndex: e.logIndex,
      blockNumber: e.blockNumber,
      blockTime: e.blockTime,
      contract: e.contract,
      chainId: Number(e.chainId),
      from: e.from,
      to: e.to,
      tokenId: e.tokenId,
      value: e.quantity,
      // [LIVE-GATE] collection-name derivation still via the hand-maintained ADDRESS_TO_COLLECTION.
      collection: ADDRESS_TO_COLLECTION[e.contract.toLowerCase()] ?? null,
    })),
    rejectedRows: r.rejected,
    skippedMalformedCount: r.skipped,
  };
}

// ── Ownership state maps (decoder side) ───────────────────────────────────────

interface DecoderHolder {
  id: string;
  contract: string;
  chainId: number;
  address: string;
  tokenCount: number;
}

interface DecoderToken {
  id: string;
  collection: string;
  chainId: number;
  tokenId: bigint;
  owner: string;
  isBurned: boolean;
}

interface DecoderHolder1155 {
  id: string;
  contract: string;
  chainId: number;
  tokenId: bigint;
  address: string;
  balance: bigint;
}

// ── Belt Hasura entity shapes (wire representation) ──────────────────────────

interface BeltTrackedHolder {
  id: string;
  contract: string;
  chainId: number;
  address: string;
  tokenCount: number;
}

interface BeltToken {
  id: string;
  collection: string;
  chainId: number;
  tokenId: string;   // BigInt → string on wire
  owner: string;
  isBurned: boolean;
}

interface BeltTrackedHolder1155 {
  id: string;
  contract: string;
  chainId: number;
  tokenId: string;   // BigInt → string on wire
  address: string;
  balance: string;   // BigInt → string on wire
}

// ── CLI arg parsing ───────────────────────────────────────────────────────────

interface Args {
  chain: string;
  fromBlock: number;
  toBlock: number;
  contract: string | null;
}

function parseArgs(): Args | null {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };

  const chain = get("--chain");
  const fromStr = get("--from-block");
  const toStr = get("--to-block");
  const contract = get("--contract") ?? null;

  if (!chain || !fromStr || !toStr) return null;

  const fromBlock = Number(fromStr);
  const toBlock = Number(toStr);
  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock) {
    return null;
  }

  return { chain, fromBlock, toBlock, contract: contract?.toLowerCase() ?? null };
}

// ── raw.evm_log reader ────────────────────────────────────────────────────────

/** Read raw.evm_log rows for the given chain+block range via direct Postgres. */
async function readRawLogs(args: Args): Promise<ValidEvmLogRow[]> {
  if (!DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required for raw.evm_log reads. " +
      "Set DATABASE_URL to the Postgres connection string for the EVM lake DB.",
    );
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const params: (string | number)[] = [args.chain, args.fromBlock, args.toBlock];
    let sql = `
      SELECT
        chain_id,
        block_number::int  AS block_number,
        block_time::text   AS block_time,
        tx_hash,
        log_index,
        address,
        topic0,
        topic1,
        topic2,
        topic3,
        data
      FROM raw.evm_log
      WHERE chain_id = $1
        AND block_number >= $2
        AND block_number <= $3
    `;

    if (args.contract) {
      params.push(args.contract);
      sql += `    AND address = $${params.length}\n`;
    }

    sql += "    ORDER BY block_number, log_index";

    const result = await pool.query<{
      chain_id: string;
      block_number: number;
      block_time: string;
      tx_hash: string;
      log_index: number;
      address: string;
      topic0: string | null;
      topic1: string | null;
      topic2: string | null;
      topic3: string | null;
      data: string;
    }>(sql, params);

    return result.rows.map((r) => ({
      chain_id: r.chain_id,
      block_number: Number(r.block_number),
      block_time: r.block_time,
      tx_hash: r.tx_hash,
      log_index: Number(r.log_index),
      address: r.address.toLowerCase(),
      topic0: r.topic0,
      topic1: r.topic1,
      topic2: r.topic2,
      topic3: r.topic3,
      data: r.data,
    }));
  } finally {
    await pool.end();
  }
}

// ── Decoder event accumulation ────────────────────────────────────────────────

/** erc1155HolderId — mirrors src/lib/erc1155-holder.ts to avoid src/ import at gate runtime. */
function erc1155HolderId(
  contract: string,
  chainId: number,
  tokenId: bigint,
  address: string,
): string {
  return `${contract.toLowerCase()}_${chainId}_${tokenId.toString()}_${address.toLowerCase()}`;
}

interface DecoderState {
  holders: Map<string, DecoderHolder>;         // TrackedHolder
  tokens: Map<string, DecoderToken>;           // Token
  holders1155: Map<string, DecoderHolder1155>; // TrackedHolder1155
}

/** Accumulate EvmOwnershipEvents into final ownership state maps. */
function accumulateEvents(events: EvmOwnershipEvent[], chainId: number): DecoderState {
  const holders = new Map<string, DecoderHolder>();
  const tokens = new Map<string, DecoderToken>();
  const holders1155 = new Map<string, DecoderHolder1155>();

  const adjustHolder = (contract: string, address: string, delta: number): void => {
    const lAddr = address.toLowerCase();
    if (lAddr === ZERO_ADDRESS || isBurnAddress(lAddr)) return;
    const id = `${contract}_${chainId}_${lAddr}`;
    const cur = holders.get(id);
    const nextCount = (cur?.tokenCount ?? 0) + delta;
    if (nextCount <= 0) {
      holders.delete(id);
    } else {
      holders.set(id, {
        id,
        contract,
        chainId,
        address: lAddr,
        tokenCount: nextCount,
      });
    }
  };

  const adjustHolder1155 = (contract: string, address: string, tokenId: bigint, delta: bigint): void => {
    const lAddr = address.toLowerCase();
    if (lAddr === ZERO_ADDRESS || isBurnAddress(lAddr)) return;
    const id = erc1155HolderId(contract, chainId, tokenId, lAddr);
    const cur = holders1155.get(id);
    const nextBalance = (cur?.balance ?? 0n) + delta;
    if (nextBalance <= 0n) {
      holders1155.delete(id);
    } else {
      holders1155.set(id, {
        id,
        contract,
        chainId,
        tokenId,
        address: lAddr,
        balance: nextBalance,
      });
    }
  };

  for (const ev of events) {
    const contract = ev.contract;
    const from = ev.from.toLowerCase();
    const to = ev.to.toLowerCase();

    if (ev.eventType === "erc721_transfer") {
      // TrackedHolder (ERC-721 lane — delta ±1 per the belt handler)
      if (!isBurnAddress(from) && from !== ZERO_ADDRESS) {
        adjustHolder(contract, from, -1);
      }
      if (!isBurnAddress(to)) {
        adjustHolder(contract, to, +1);
      }

      // Token entity (HoneyJar-registered collections only)
      if (ev.collection !== null) {
        const tokenIdStr = ev.tokenId.toString();
        const id = `${ev.collection}_${chainId}_${tokenIdStr}`;
        const existing = tokens.get(id);
        tokens.set(id, {
          id,
          collection: ev.collection,
          chainId,
          tokenId: ev.tokenId,
          owner: to,
          isBurned: isBurnAddress(to),
          // mintedAt: preserved from first event if minting happened before this range
          // [LIVE-GATE] mintedAt comparison requires full-history decode; omitted here
        });
        // If this is a mint (from == zero) and token not yet seen: owner is set above
        // If token was seen before: update owner (last-write wins, belt does the same)
        void existing; // suppress unused-variable lint
      }

      // TrackedHolder aggregate for ERC-1155 events uses `value` (quantity)
      // ERC-721: value is always 1 — handled via adjustHolder above.

    } else if (ev.eventType === "erc1155_single" || ev.eventType === "erc1155_batch_item") {
      // TrackedHolder (ERC-1155 lane — delta by quantity, same ID format as ERC-721)
      if (!isBurnAddress(from) && from !== ZERO_ADDRESS) {
        adjustHolder(contract, from, -Number(ev.value));
      }
      if (!isBurnAddress(to)) {
        adjustHolder(contract, to, +Number(ev.value));
      }

      // TrackedHolder1155 (per-tokenId balance)
      if (from !== ZERO_ADDRESS && !isBurnAddress(from)) {
        adjustHolder1155(contract, from, ev.tokenId, -ev.value);
      }
      if (!isBurnAddress(to)) {
        adjustHolder1155(contract, to, ev.tokenId, ev.value);
      }
    }
  }

  return { holders, tokens, holders1155 };
}

// ── Hasura GraphQL helpers ────────────────────────────────────────────────────

function hasuraHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (SECRET) h["x-hasura-admin-secret"] = SECRET;
  return h;
}

async function graphqlQuery<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  if (!HASURA) {
    throw new Error(
      "EVM_HASURA_ENDPOINT (or SVM_HASURA_ENDPOINT) is required for belt Hasura queries.",
    );
  }
  const res = await fetch(`${HASURA}/v1/graphql`, {
    method: "POST",
    headers: hasuraHeaders(),
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Hasura HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as { data?: T; errors?: unknown[] };
  if (body.errors?.length) {
    throw new Error(`Hasura GraphQL errors: ${JSON.stringify(body.errors).slice(0, 500)}`);
  }
  return body.data as T;
}

/** Chunk an array into slices of at most `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const BATCH_SIZE = 500;

// ── Belt Hasura entity queries ────────────────────────────────────────────────

const TRACKED_HOLDER_QUERY = `
  query TrackedHolderGate($ids: [ID!]!) {
    TrackedHolder(where: { id: { _in: $ids } }) {
      id contract chainId address tokenCount
    }
  }
`;

const TOKEN_QUERY = `
  query TokenGate($ids: [ID!]!) {
    Token(where: { id: { _in: $ids } }) {
      id collection chainId tokenId owner isBurned
    }
  }
`;

const TRACKED_HOLDER_1155_QUERY = `
  query TrackedHolder1155Gate($ids: [ID!]!) {
    TrackedHolder1155(where: { id: { _in: $ids } }) {
      id contract chainId tokenId address balance
    }
  }
`;

async function fetchBeltTrackedHolders(ids: string[]): Promise<Map<string, BeltTrackedHolder>> {
  const out = new Map<string, BeltTrackedHolder>();
  for (const batch of chunk(ids, BATCH_SIZE)) {
    const data = await graphqlQuery<{ TrackedHolder: BeltTrackedHolder[] }>(
      TRACKED_HOLDER_QUERY,
      { ids: batch },
    );
    for (const r of data.TrackedHolder) out.set(r.id, r);
  }
  return out;
}

async function fetchBeltTokens(ids: string[]): Promise<Map<string, BeltToken>> {
  const out = new Map<string, BeltToken>();
  for (const batch of chunk(ids, BATCH_SIZE)) {
    const data = await graphqlQuery<{ Token: BeltToken[] }>(
      TOKEN_QUERY,
      { ids: batch },
    );
    for (const r of data.Token) out.set(r.id, r);
  }
  return out;
}

async function fetchBeltTrackedHolder1155s(ids: string[]): Promise<Map<string, BeltTrackedHolder1155>> {
  const out = new Map<string, BeltTrackedHolder1155>();
  for (const batch of chunk(ids, BATCH_SIZE)) {
    const data = await graphqlQuery<{ TrackedHolder1155: BeltTrackedHolder1155[] }>(
      TRACKED_HOLDER_1155_QUERY,
      { ids: batch },
    );
    for (const r of data.TrackedHolder1155) out.set(r.id, r);
  }
  return out;
}

// ── Parity diff helpers ───────────────────────────────────────────────────────

interface DivergenceHolder {
  id: string;
  decoderCount: number | null;
  beltCount: number | null;
}

interface DivergenceToken {
  id: string;
  decoderOwner: string | null;
  beltOwner: string | null;
  decoderBurned: boolean | null;
  beltBurned: boolean | null;
}

interface DivergenceHolder1155 {
  id: string;
  decoderBalance: bigint | null;
  beltBalance: bigint | null;
}

interface ParityResult<D> {
  total: number;   // decoder-side IDs checked
  matched: number;
  divergent: number;
  samples: D[];    // up to 20 divergent samples
}

function diffTrackedHolder(
  decoder: Map<string, DecoderHolder>,
  belt: Map<string, BeltTrackedHolder>,
): ParityResult<DivergenceHolder> {
  const allIds = new Set([...decoder.keys(), ...belt.keys()]);
  const divergences: DivergenceHolder[] = [];
  let matched = 0;

  for (const id of allIds) {
    const d = decoder.get(id);
    const b = belt.get(id);
    const dc = d?.tokenCount ?? null;
    const bc = b?.tokenCount ?? null;
    if (dc === bc) {
      matched++;
    } else {
      divergences.push({ id, decoderCount: dc, beltCount: bc });
    }
  }

  return {
    total: allIds.size,
    matched,
    divergent: divergences.length,
    samples: divergences.slice(0, 20),
  };
}

function diffToken(
  decoder: Map<string, DecoderToken>,
  belt: Map<string, BeltToken>,
): ParityResult<DivergenceToken> {
  const allIds = new Set([...decoder.keys(), ...belt.keys()]);
  const divergences: DivergenceToken[] = [];
  let matched = 0;

  for (const id of allIds) {
    const d = decoder.get(id);
    const b = belt.get(id);
    const dOwner = d?.owner ?? null;
    const bOwner = b?.owner ?? null;
    const dBurned = d?.isBurned ?? null;
    const bBurned = b?.isBurned ?? null;
    if (dOwner === bOwner && dBurned === bBurned) {
      matched++;
    } else {
      divergences.push({
        id,
        decoderOwner: dOwner,
        beltOwner: bOwner,
        decoderBurned: dBurned,
        beltBurned: bBurned,
      });
    }
  }

  return {
    total: allIds.size,
    matched,
    divergent: divergences.length,
    samples: divergences.slice(0, 20),
  };
}

function diffTrackedHolder1155(
  decoder: Map<string, DecoderHolder1155>,
  belt: Map<string, BeltTrackedHolder1155>,
): ParityResult<DivergenceHolder1155> {
  const allIds = new Set([...decoder.keys(), ...belt.keys()]);
  const divergences: DivergenceHolder1155[] = [];
  let matched = 0;

  for (const id of allIds) {
    const d = decoder.get(id);
    const b = belt.get(id);
    const dBal = d?.balance ?? null;
    const bBal = b ? BigInt(b.balance) : null;
    if (dBal === bBal) {
      matched++;
    } else {
      divergences.push({ id, decoderBalance: dBal, beltBalance: bBal });
    }
  }

  return {
    total: allIds.size,
    matched,
    divergent: divergences.length,
    samples: divergences.slice(0, 20),
  };
}

// ── Parity table rendering ────────────────────────────────────────────────────

function printParityTable(
  entity: string,
  result: ParityResult<DivergenceHolder | DivergenceToken | DivergenceHolder1155>,
): void {
  const status = result.divergent === 0 ? "PASS" : "FAIL";
  console.log(`\n── ${entity} ── ${status}`);
  console.log(`   total=${result.total}  matched=${result.matched}  divergent=${result.divergent}`);

  if (result.divergent > 0) {
    console.log(`   sample divergences (up to 20):`);
    for (const s of result.samples) {
      if ("decoderCount" in s) {
        console.log(`     [${s.id}]  decoder.tokenCount=${s.decoderCount ?? "MISSING"} | belt.tokenCount=${s.beltCount ?? "MISSING"}`);
      } else if ("decoderOwner" in s) {
        console.log(`     [${s.id}]  decoder.owner=${s.decoderOwner ?? "MISSING"} burned=${s.decoderBurned} | belt.owner=${s.beltOwner ?? "MISSING"} burned=${s.beltBurned}`);
      } else if ("decoderBalance" in s) {
        console.log(`     [${s.id}]  decoder.balance=${s.decoderBalance?.toString() ?? "MISSING"} | belt.balance=${s.beltBalance?.toString() ?? "MISSING"}`);
      }
    }
    if (result.divergent > 20) {
      console.log(`     … and ${result.divergent - 20} more`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[gate2] EVM ownership parity harness — GATE-2 [LIVE-GATE]");
  console.log("[gate2] Run before EVM alias flip; NEVER in CI.");

  const args = parseArgs();
  if (!args) {
    console.error(
      "[gate2] Usage: tsx scripts/gate2-evm-parity.ts --chain <id> --from-block <N> --to-block <M> [--contract <hex>]",
    );
    process.exit(2);
  }

  console.log(
    `[gate2] chain=${args.chain}  blocks=[${args.fromBlock}, ${args.toBlock}]` +
    (args.contract ? `  contract=${args.contract}` : ""),
  );
  console.log(`[gate2] EVM_HASURA_ENDPOINT: ${HASURA || "(not set)"}`);
  console.log(`[gate2] DATABASE_URL: ${DATABASE_URL ? "set" : "(not set)"}`);

  if (!HASURA) {
    console.error(
      "[gate2] EVM_HASURA_ENDPOINT (or SVM_HASURA_ENDPOINT) is required for belt Hasura queries.",
    );
    process.exit(2);
  }

  // ── Step 1: Load T1 decoder ─────────────────────────────────────────────────
  //
  // [LIVE-GATE] Dynamic import so this file type-checks before T1 is built.
  // When T1 is merged, replace with a static import (see T1 boundary stub above).
  process.stdout.write("[gate2] Loading T1 decoder (src/evm/decodeEvmLogs) ... ");
  let decodeEvmLogs: DecodeEvmLogsFn;
  try {
    // Indirection via variable prevents TypeScript from resolving the module at
    // compile time (if T1 doesn't exist yet). tsx resolves at runtime.
    const t1Path = "../src/evm/decodeEvmLogs.js";
    const t1 = (await import(t1Path)) as { decodeEvmLogs?: RealDecodeFn };
    if (typeof t1.decodeEvmLogs !== "function") {
      throw new Error("decodeEvmLogs is not a function in the T1 module");
    }
    const rawDecode = t1.decodeEvmLogs;
    // memberSet = every contract address present in the batch — decode ALL ingested logs (the raw
    // store already holds only tracked-contract logs). Passing the required opts fixes the TypeError;
    // adaptT1Result maps the real output shape back to this harness's internal shape.
    decodeEvmLogs = (rows) =>
      adaptT1Result(rawDecode(rows, { memberSet: new Set(rows.map((r) => r.address.toLowerCase())) }));
    console.log("OK");
  } catch (e) {
    console.log("BLOCKED");
    console.error("[gate2] T1 decoder not available: " + (e as Error).message);
    console.error("[gate2] Build src/evm/decodeEvmLogs.ts (T1) first and re-run.");
    process.exit(2);
  }

  // ── Step 2: Read raw.evm_log from Postgres ──────────────────────────────────
  process.stdout.write("[gate2] Reading raw.evm_log ... ");
  let rawRows: ValidEvmLogRow[];
  try {
    rawRows = await readRawLogs(args);
    console.log(`${rawRows.length} rows`);
  } catch (e) {
    console.log("ERROR");
    console.error("[gate2] raw.evm_log read failed: " + (e as Error).message);
    process.exit(2);
  }

  if (rawRows.length === 0) {
    console.error(
      `[gate2] No raw.evm_log rows found for chain=${args.chain} blocks=[${args.fromBlock},${args.toBlock}]` +
      (args.contract ? ` contract=${args.contract}` : "") +
      ". Verify the raw ingest (T1 loader) has been run for this range.",
    );
    process.exit(2);
  }

  // ── Step 3: Decode via T1 ───────────────────────────────────────────────────
  process.stdout.write(`[gate2] Decoding ${rawRows.length} rows via T1 ... `);
  const decodeResult = decodeEvmLogs(rawRows);
  console.log(
    `${decodeResult.events.length} events ` +
    `(rejected=${decodeResult.rejectedRows} malformed=${decodeResult.skippedMalformedCount})`,
  );

  if (decodeResult.rejectedRows > 0 || decodeResult.skippedMalformedCount > 0) {
    console.warn(
      `[gate2] WARN: decoder dropped rows — rejected=${decodeResult.rejectedRows} ` +
      `skipped=${decodeResult.skippedMalformedCount}. ` +
      "These rows are excluded from the parity comparison.",
    );
  }

  // Enrich events with collection names (for Token parity)
  // [LIVE-GATE] This mapping is authoritative only for the HoneyJar family.
  // If T1 already populates EvmOwnershipEvent.collection, it takes precedence.
  const enrichedEvents = decodeResult.events.map((ev) => ({
    ...ev,
    collection: ev.collection ?? ADDRESS_TO_COLLECTION[ev.contract] ?? null,
  }));

  // ── Step 4: Accumulate decoder state ────────────────────────────────────────
  const chainIdNum = Number(args.chain);
  process.stdout.write("[gate2] Accumulating decoder ownership state ... ");
  const decoderState = accumulateEvents(enrichedEvents, chainIdNum);
  console.log(
    `holders=${decoderState.holders.size} ` +
    `tokens=${decoderState.tokens.size} ` +
    `holders1155=${decoderState.holders1155.size}`,
  );

  // ── Step 5: Query belt Hasura ────────────────────────────────────────────────
  process.stdout.write("[gate2] Querying belt Hasura (TrackedHolder) ... ");
  const holderIds = [...decoderState.holders.keys()];
  let beltHolders: Map<string, BeltTrackedHolder>;
  try {
    beltHolders = holderIds.length > 0
      ? await fetchBeltTrackedHolders(holderIds)
      : new Map();
    console.log(`${beltHolders.size} rows`);
  } catch (e) {
    console.log("ERROR");
    console.error("[gate2] TrackedHolder query failed: " + (e as Error).message);
    process.exit(2);
  }

  process.stdout.write("[gate2] Querying belt Hasura (Token) ... ");
  const tokenIds = [...decoderState.tokens.keys()];
  let beltTokens: Map<string, BeltToken>;
  try {
    beltTokens = tokenIds.length > 0
      ? await fetchBeltTokens(tokenIds)
      : new Map();
    console.log(`${beltTokens.size} rows`);
  } catch (e) {
    console.log("ERROR");
    console.error("[gate2] Token query failed: " + (e as Error).message);
    process.exit(2);
  }

  process.stdout.write("[gate2] Querying belt Hasura (TrackedHolder1155) ... ");
  const holder1155Ids = [...decoderState.holders1155.keys()];
  let beltHolders1155: Map<string, BeltTrackedHolder1155>;
  try {
    beltHolders1155 = holder1155Ids.length > 0
      ? await fetchBeltTrackedHolder1155s(holder1155Ids)
      : new Map();
    console.log(`${beltHolders1155.size} rows`);
  } catch (e) {
    console.log("ERROR");
    console.error("[gate2] TrackedHolder1155 query failed: " + (e as Error).message);
    process.exit(2);
  }

  // ── Step 6: Diff ─────────────────────────────────────────────────────────────
  console.log("\n[gate2] === PARITY RESULTS ===");
  console.log(
    "[gate2] NOTE: authoritative gate = full-history run (--from-block 0 --to-block <head>). " +
    "Partial-range results reflect only the decoded delta, not total accumulated state.",
  );

  const holderResult  = diffTrackedHolder(decoderState.holders, beltHolders);
  const tokenResult   = diffToken(decoderState.tokens, beltTokens);
  const holder1155Res = diffTrackedHolder1155(decoderState.holders1155, beltHolders1155);

  printParityTable("TrackedHolder", holderResult);
  printParityTable("Token", tokenResult);
  printParityTable("TrackedHolder1155", holder1155Res);

  // ── Summary ──────────────────────────────────────────────────────────────────
  const totalDivergent = holderResult.divergent + tokenResult.divergent + holder1155Res.divergent;
  const totalMatched   = holderResult.matched   + tokenResult.matched   + holder1155Res.matched;
  const totalChecked   = holderResult.total     + tokenResult.total     + holder1155Res.total;

  console.log("\n[gate2] === SUMMARY ===");
  console.log(`[gate2] ${totalMatched}/${totalChecked} matched, ${totalDivergent} divergent`);

  if (totalDivergent === 0) {
    console.log(
      `[gate2] GATE-2 PASS — ${totalMatched}/${totalChecked}, 0 divergences. ` +
      "Safe to alias-flip this chain.",
    );
  } else {
    console.log(
      `[gate2] GATE-2 FAIL — ${totalDivergent} divergence(s) detected. ` +
      "Investigate before alias flip.",
    );
    console.log("[gate2] Common causes:");
    console.log("[gate2]   - Block range does not cover full history (use --from-block 0)");
    console.log("[gate2]   - Belt indexed events the decoder's T1 does not yet handle");
    console.log("[gate2]   - Collection name mapping mismatch (Token entity — see ADDRESS_TO_COLLECTION)");
    console.log("[gate2]   - raw.evm_log has gaps (re-run the T1 loader for missing ranges)");
  }

  process.exit(totalDivergent === 0 ? 0 : 1);
}

// ── Entry point ────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    console.error(`[gate2] FATAL: ${(e as Error).message}`);
    process.exit(1);
  });
}
