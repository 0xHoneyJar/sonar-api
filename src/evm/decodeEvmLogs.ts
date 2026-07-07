/**
 * decodeEvmLogs.ts — PURE EVM log decoder: raw.evm_log rows → EvmOwnershipEvents
 * (Sprint 4 Track A, SDD §2.4).
 *
 * Ports the decodeSqdBlocks CONTRACT from src/svm/sqd-collection-event-source.ts:
 *   - Never throws on malformed input — never halts the pipeline.
 *   - validate-then-skip-and-count discipline: validation failure → rejected++;
 *     valid row with unmatched topic0 or viem decode error → skipped++.
 *   - memberSet filters to in-scope contract addresses (lowercased); non-member
 *     valid rows are filter-spillover — silently skipped, NOT counted as rejected
 *     (mirrors SVM spillover rule: sqd-collection-event-source.ts:130-143).
 *   - No network, no DB, no fs — rows in, result out.
 *
 * Two SVM concepts that drop out on the EVM side:
 *   - seenMints (cross-window first-appearance state): unnecessary — each EVM Transfer
 *     log carries the complete custody change (from, to, tokenId); mint/transfer/burn
 *     is derived directly from the zero/burn address without cross-log state.
 *   - ambiguousGroups (net-pair inference): N/A — each log is one atomic ownership
 *     change, not a balance-diff pair requiring reconciliation.
 *
 * Idempotency is carried by the (chain_id, block_number, log_index) PK, replacing
 * the SVM resume-safe seen-set.
 *
 * [LIVE-GATE] Out-of-S4-scope entities (deferred — require collection-specific lookup
 * tables, cross-chain aggregation, or sale-resolution joins not available from a single
 * raw.evm_log row):
 *
 *   - Holder             — HoneyJar-scoped balance; requires `HONEY_JAR_COLLECTIONS`
 *                          allowlist lookup and cross-chain Holder entity resolution.
 *   - CollectionStat     — collection-scoped aggregate (floorPrice, totalSupply,
 *                          uniqueHolderCount); requires cross-log aggregation state.
 *   - UserBalance        — per-user, per-collection balance; requires Holder read.
 *   - GlobalCollectionStat — chain-agnostic aggregate; requires cross-chain join.
 *   - MintActivity       — time-series mint record; derivable but out of S4 decode scope
 *                          (no additional rawlog info needed, but parity deferred to T3).
 *   - Action             — generic action ledger entry; requires collection-key resolution
 *                          from a config map not available in this pure decoder.
 *   - MiberaTransfer     — Mibera-specific transfer ledger; requires knowing contractAddress
 *                          === MIBERA_CONTRACT and staking contract address resolution.
 */

import { decodeAbiParameters } from "viem";
import type { EvmLogRow, ValidEvmLogRow } from "./sqd-evm-loader.js";
import { validateEvmLogRow } from "./sqd-evm-loader.js";

// ── Topic0 constants (keccak256 of the canonical ABI signature) ──────────────

/** Transfer(address indexed from, address indexed to, uint256 indexed tokenId) */
const TOPIC0_ERC721_TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

/** TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value) */
const TOPIC0_ERC1155_TRANSFER_SINGLE =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62" as const;

/** TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values) */
const TOPIC0_ERC1155_TRANSFER_BATCH =
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb" as const;

/** Zero address (mints originate from here). */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Common burn destination (vitalik.eth dead address). */
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead" as const;

// ── EVM ABI decode params (static — never reconstructed per call) ─────────────

/** TransferSingle data: (uint256 id, uint256 value) */
const ABI_TRANSFER_SINGLE_DATA = [
  { type: "uint256", name: "id" },
  { type: "uint256", name: "value" },
] as const;

/** TransferBatch data: (uint256[] ids, uint256[] values) */
const ABI_TRANSFER_BATCH_DATA = [
  { type: "uint256[]", name: "ids" },
  { type: "uint256[]", name: "values" },
] as const;

// ── Output types ──────────────────────────────────────────────────────────────

/**
 * One decoded ownership-change event derived from a single raw.evm_log row.
 * ERC721 produces one event per Transfer log.
 * ERC1155 TransferSingle produces one event per log.
 * ERC1155 TransferBatch produces N events per log (one per (id, value) pair).
 */
export interface EvmOwnershipEvent {
  /** Source chain ID (string; matches raw.evm_log.chain_id). */
  chainId: string;
  /** Contract address (0x-prefixed, lowercased). */
  contract: string;
  /** NFT standard driving the decode path. */
  standard: "erc721" | "erc1155";
  /** Token ID (bigint). */
  tokenId: bigint;
  /** Sender address (0x-prefixed, lowercased). */
  from: string;
  /** Recipient address (0x-prefixed, lowercased). */
  to: string;
  /** Token quantity transferred (always 1n for ERC-721). */
  quantity: bigint;
  /** Ownership-change kind derived from from/to address only. */
  kind: "mint" | "transfer" | "burn";
  /** Block number (integer). */
  blockNumber: number;
  /** Block timestamp (ISO-8601). */
  blockTime: string;
  /** Transaction hash (0x-prefixed hex). */
  txHash: string;
  /** Log index within the transaction. */
  logIndex: number;
}

/** Structured decode result (mirrors SqdDecodeResult shape). */
export interface EvmDecodeResult {
  /** Successfully decoded ownership events. */
  events: EvmOwnershipEvent[];
  /**
   * Rows that failed validateEvmLogRow (trust-boundary validation failures).
   * Non-member rows are NOT counted here — they are filter spillover.
   */
  rejected: number;
  /**
   * Rows that passed validation but either:
   *   (a) had no matching topic0 (not one of the three in-scope signatures), or
   *   (b) matched a topic0 but viem raised a decode error (malformed data/topics).
   */
  skipped: number;
}

// ── Belt-handler ownership-derivation seam ────────────────────────────────────
//
// [SEAM] The functions below isolate the belt handler's entity-derivation
// semantics so T2 can assert the ownership-derivation rules without T3's live
// Hasura dependencies.
//
// Grounded at:
//   src/handlers/tracked-erc721.ts:223   — TrackedHolder.id format
//   src/lib/erc1155-holder.ts            — erc1155HolderId, nextBalance, aggregateBatchDeltas
//   src/handlers/puru-apiculture1155.ts  — adjustHolder1155Token delta sign convention

/** Minimal TrackedHolder delta (T2 assertable without live Hasura). */
export interface TrackedHolderDelta {
  /** TrackedHolder.id: `${contract}_${chainId}_${address}` */
  id: string;
  contract: string;
  chainId: string;
  address: string;
  /** +1 on gain, -1 on loss; caller resolves against current tokenCount. */
  delta: number;
}

/** Minimal TrackedHolder1155 delta (T2 assertable without live Hasura). */
export interface TrackedHolder1155Delta {
  /** TrackedHolder1155.id: `${contract}_${chainId}_${tokenId}_${address}` */
  id: string;
  contract: string;
  chainId: string;
  tokenId: bigint;
  address: string;
  /** Signed quantity delta; caller resolves against current balance. */
  delta: bigint;
}

/**
 * Derive TrackedHolder deltas for an ERC-721 Transfer event.
 *
 * Belt handler rule (tracked-erc721.ts:214-225):
 *   - adjustHolder is called for BOTH from and to, skipping ZERO.
 *   - delta: from → -1, to → +1.
 *   - ZERO_ADDRESS is never a TrackedHolder row (guarded by `if (address === ZERO) return`).
 *
 * [LIVE-GATE] collectionKey resolution (TRACKED_ERC721_COLLECTION_KEYS map) is not
 * reproduced here — the seam exposes the structural delta only; the actual entity
 * write also needs collectionKey which requires config lookup out of decoder scope.
 */
export function deriveErc721HolderDeltas(event: EvmOwnershipEvent): TrackedHolderDelta[] {
  const { contract, chainId, from, to } = event;
  const deltas: TrackedHolderDelta[] = [];
  if (from !== ZERO_ADDRESS) {
    deltas.push({
      id: `${contract}_${chainId}_${from}`,
      contract,
      chainId,
      address: from,
      delta: -1,
    });
  }
  if (to !== ZERO_ADDRESS && to !== DEAD_ADDRESS) {
    deltas.push({
      id: `${contract}_${chainId}_${to}`,
      contract,
      chainId,
      address: to,
      delta: 1,
    });
  }
  return deltas;
}

/**
 * Derive TrackedHolder1155 per-tokenId balance deltas and aggregate TrackedHolder
 * delta for an ERC-1155 ownership event.
 *
 * Belt handler rules (puru-apiculture1155.ts:168-221):
 *   - TrackedHolder (aggregate): adjustHolder1155 called for from (delta=-quantity) if
 *     !isMint, and for to (delta=+quantity) if !isBurnAddress(to).
 *   - TrackedHolder1155 (per-tokenId): adjustHolder1155Token called for from
 *     (delta=-quantity) if !isMint && from!==to, and for to (delta=+quantity) if
 *     !isBurnAddress(to) && from!==to.
 *   - ZERO_ADDRESS is never a row (isMint guard skips from; isBurnAddress guard skips to).
 *
 * [LIVE-GATE] collectionKey and lastUpdated (block timestamp as BigInt) not reproduced —
 * pure delta shape only; callers supply collectionKey from config.
 */
export function deriveErc1155HolderDeltas(event: EvmOwnershipEvent): {
  aggregateDeltas: TrackedHolderDelta[];
  perTokenDeltas: TrackedHolder1155Delta[];
} {
  const { contract, chainId, from, to, tokenId, quantity, kind } = event;
  const isMint = kind === "mint";
  const toBurn = to === ZERO_ADDRESS || to === DEAD_ADDRESS;
  const sameAddress = from === to;

  const aggregateDeltas: TrackedHolderDelta[] = [];
  const perTokenDeltas: TrackedHolder1155Delta[] = [];

  // Aggregate TrackedHolder deltas
  if (!isMint) {
    aggregateDeltas.push({
      id: `${contract}_${chainId}_${from}`,
      contract,
      chainId,
      address: from,
      // verify:s4 MEDIUM: the belt aggregate TrackedHolder count is a SUM OF QUANTITIES, not a
      // per-event ±1 (belt erc1155-holder nextBalance / aggregateBatchDeltas + the handler's
      // adjustHolder1155 both use ±quantity). This is the token-count, not a distinct-holding flag.
      delta: -Number(quantity),
    });
  }
  if (!toBurn) {
    aggregateDeltas.push({
      id: `${contract}_${chainId}_${to}`,
      contract,
      chainId,
      address: to,
      delta: Number(quantity),
    });
  }

  // Per-tokenId TrackedHolder1155 deltas (only when from !== to)
  if (!sameAddress) {
    if (!isMint) {
      perTokenDeltas.push({
        id: `${contract}_${chainId}_${tokenId}_${from}`,
        contract,
        chainId,
        tokenId,
        address: from,
        delta: -quantity,
      });
    }
    if (!toBurn) {
      perTokenDeltas.push({
        id: `${contract}_${chainId}_${tokenId}_${to}`,
        contract,
        chainId,
        tokenId,
        address: to,
        delta: quantity,
      });
    }
  }

  return { aggregateDeltas, perTokenDeltas };
}

// ── Kind derivation ───────────────────────────────────────────────────────────

/** Derive ownership-change kind from from/to addresses only (no external state). */
function deriveKind(from: string, to: string): "mint" | "transfer" | "burn" {
  if (from === ZERO_ADDRESS) return "mint";
  if (to === ZERO_ADDRESS || to === DEAD_ADDRESS) return "burn";
  return "transfer";
}

// ── Topic helpers ─────────────────────────────────────────────────────────────

/**
 * Decode a 32-byte ABI-encoded address topic into a 20-byte address string.
 * EVM pads addresses to 32 bytes as: 0x000...000<20-byte-address>.
 * Returns lowercased `0x${last40hex}` or null if the topic is null/malformed.
 */
function decodeAddressTopic(topic: string | null): string | null {
  if (topic === null) return null;
  // topic is 0x + 64 hex chars; address is the last 40 chars
  if (topic.length !== 66) return null;
  return ("0x" + topic.slice(26)).toLowerCase();
}

/**
 * Decode a 32-byte ABI-encoded uint256 topic into a bigint.
 * Returns null if the topic is null/malformed.
 */
function decodeUint256Topic(topic: string | null): bigint | null {
  if (topic === null) return null;
  if (topic.length !== 66) return null;
  try {
    return BigInt(topic);
  } catch {
    return null;
  }
}

// ── Main decoder ──────────────────────────────────────────────────────────────

/**
 * Decode a batch of raw EVM log rows into ownership events.
 *
 * Contract (ported from decodeSqdBlocks, src/svm/sqd-collection-event-source.ts:92-99):
 *   - Never throws on malformed input.
 *   - validateEvmLogRow is the trust-boundary validator (sqd-evm-loader.ts:152).
 *   - Validation failure → rejected++ (non-member rows silently skipped, NOT counted).
 *   - Valid row, unmatched topic0 or decode error → skipped++.
 *   - PURE: no DB, no network, no fs.
 *
 * @param rawLogs  Untrusted input rows (all fields unknown).
 * @param opts.memberSet  Set of lowercased contract addresses in scope for this decode pass.
 */
export function decodeEvmLogs(
  rawLogs: readonly EvmLogRow[],
  opts: { memberSet: ReadonlySet<string> },
): EvmDecodeResult {
  const { memberSet } = opts;
  const events: EvmOwnershipEvent[] = [];
  let rejected = 0;
  let skipped = 0;

  for (const raw of rawLogs) {
    // ── Step 1: trust-boundary validation (reuse exported validator) ───────
    const v: ValidEvmLogRow | null = validateEvmLogRow(raw);
    if (v === null) {
      // Distinguish member-named rows from filter spillover:
      // Only count as rejected if the row NAMED a member contract but failed validation.
      // Mirrors SVM: sqd-collection-event-source.ts:130-143.
      const namedMember =
        typeof raw.address === "string" && memberSet.has(raw.address.toLowerCase());
      if (namedMember) {
        rejected++;
      }
      // Non-member or no-address rows are filter spillover — silently ignored.
      continue;
    }

    // ── Step 2: memberSet filter (spillover rows are not rejected) ─────────
    if (!memberSet.has(v.address)) {
      // Valid row for a contract not in this decode pass — silently skip.
      continue;
    }

    // ── Step 3: topic0 routing ─────────────────────────────────────────────
    const topic0 = v.topic0;
    if (topic0 === null) {
      // Anonymous event (no topic0) — not an ownership event.
      skipped++;
      continue;
    }

    try {
      if (topic0 === TOPIC0_ERC721_TRANSFER) {
        // Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
        // topic1=from, topic2=to, topic3=tokenId (all indexed → in topics, not data)
        const from = decodeAddressTopic(v.topic1);
        const to = decodeAddressTopic(v.topic2);
        const tokenId = decodeUint256Topic(v.topic3);

        if (from === null || to === null || tokenId === null) {
          skipped++;
          continue;
        }

        events.push({
          chainId: v.chain_id,
          contract: v.address,
          standard: "erc721",
          tokenId,
          from,
          to,
          quantity: 1n,
          kind: deriveKind(from, to),
          blockNumber: v.block_number,
          blockTime: v.block_time,
          txHash: v.tx_hash,
          logIndex: v.log_index,
        });
      } else if (topic0 === TOPIC0_ERC1155_TRANSFER_SINGLE) {
        // TransferSingle(address indexed operator, address indexed from, address indexed to,
        //                uint256 id, uint256 value)
        // topic1=operator, topic2=from, topic3=to; data=(uint256 id, uint256 value)
        const from = decodeAddressTopic(v.topic2);
        const to = decodeAddressTopic(v.topic3);
        if (from === null || to === null) {
          skipped++;
          continue;
        }

        const [decoded] = [decodeAbiParameters(ABI_TRANSFER_SINGLE_DATA, v.data as `0x${string}`)];
        const id = decoded[0];
        const value = decoded[1];

        // Skip zero-quantity transfers (belt handler: puru-apiculture1155.ts:61-63)
        if (value === 0n) {
          skipped++;
          continue;
        }

        events.push({
          chainId: v.chain_id,
          contract: v.address,
          standard: "erc1155",
          tokenId: id,
          from,
          to,
          quantity: value,
          kind: deriveKind(from, to),
          blockNumber: v.block_number,
          blockTime: v.block_time,
          txHash: v.tx_hash,
          logIndex: v.log_index,
        });
      } else if (topic0 === TOPIC0_ERC1155_TRANSFER_BATCH) {
        // TransferBatch(address indexed operator, address indexed from, address indexed to,
        //               uint256[] ids, uint256[] values)
        // topic1=operator, topic2=from, topic3=to; data=(uint256[] ids, uint256[] values)
        const from = decodeAddressTopic(v.topic2);
        const to = decodeAddressTopic(v.topic3);
        if (from === null || to === null) {
          skipped++;
          continue;
        }

        const [decoded] = [decodeAbiParameters(ABI_TRANSFER_BATCH_DATA, v.data as `0x${string}`)];
        const ids = decoded[0] as readonly bigint[];
        const values = decoded[1] as readonly bigint[];

        const length = Math.min(ids.length, values.length);
        let anyEmitted = false;

        for (let i = 0; i < length; i++) {
          const tokenId = ids[i];
          const quantity = values[i];
          if (tokenId === undefined || quantity === undefined) continue;
          // Skip zero-quantity pairs (belt handler: puru-apiculture1155.ts:267-269)
          if (quantity === 0n) continue;

          events.push({
            chainId: v.chain_id,
            contract: v.address,
            standard: "erc1155",
            tokenId,
            from,
            to,
            quantity,
            kind: deriveKind(from, to),
            blockNumber: v.block_number,
            blockTime: v.block_time,
            txHash: v.tx_hash,
            logIndex: v.log_index,
          });
          anyEmitted = true;
        }

        // A batch with no non-zero pairs counts as skipped (no events produced).
        if (!anyEmitted) {
          skipped++;
        }
      } else {
        // topic0 does not match any in-scope signature — not an ownership event.
        skipped++;
      }
    } catch {
      // viem decode error or any other exception — count as skipped, never rethrow.
      skipped++;
    }
  }

  return { events, rejected, skipped };
}
