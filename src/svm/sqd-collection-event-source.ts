/**
 * sqd-collection-event-source.ts — pure decode: SQD Portal token-balance diffs → CollectionEvents
 * (cycle svm-sqd-substrate, SDD §2.2). The block-stream substrate the seam comment in
 * nft-collection-source.ts anticipated — SQD Portal instead of Solana HyperSync, same role.
 *
 * Decode is per (tx, mint) from balance rows alone — no instruction parsing, no marketplace
 * attribution (kinds: mint/transfer/burn ONLY; sale/list/delist remain the Enhanced/program-ID
 * lane's job, PRD OUT). NFT semantics: amounts are "1"/"0" strings; a tx's rows for one mint form
 * legs:
 *   losing leg  = pre=1 → post=0 (account gives up the token)
 *   gaining leg = pre=0(or absent) → post=1 (account receives it)
 *   transfer    = losing + gaining in same tx (from=losing preOwner, to=gaining postOwner)
 *   mint        = gaining only, AND the mint has never been seen before by this decode pass
 *                 (first-appearance rule — candy-guard mints have no prior account)
 *   burn        = losing only (token account closed/emptied with no receiver)
 *   ambiguous   = anything else (multi-hop custody in one tx that doesn't net out) → REJECTED and
 *                 counted, never guessed (warehouse-loader precedent; the §4.5 gate + G1 fixture
 *                 recall bound how often this path fires).
 *
 * instructionIndex = per-(tx,mint) occurrence ordinal in (slot, txIndex) order — the SAME rule as
 * parseHeliusTx and warehouse mapRows, so the content-addressed PK {tx}:{mint}:{ordinal} converges
 * byte-identically across all three supply lanes (pinned by test).
 *
 * Rows are UNTRUSTED (network substrate): field-validated, reject-don't-coerce.
 */
import type { CollectionEvent } from "./collection-event-source";

/** One tokenBalance row as Portal returns it (subset we read). */
export interface SqdTokenBalanceRow {
  transactionIndex?: unknown;
  account?: unknown;
  preMint?: unknown;
  postMint?: unknown;
  preOwner?: unknown;
  postOwner?: unknown;
  preAmount?: unknown;
  postAmount?: unknown;
}

/** One streamed block line (subset). */
export interface SqdBlock {
  header?: { number?: unknown; timestamp?: unknown };
  tokenBalances?: SqdTokenBalanceRow[];
  transactions?: Array<{ transactionIndex?: unknown; signatures?: unknown[] }>;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

interface ValidBalRow {
  txIndex: number;
  mint: string;
  account: string;
  preOwner: string | null;
  postOwner: string | null;
  preAmount: bigint;
  postAmount: bigint;
}

export function validateBalRow(r: SqdTokenBalanceRow, memberSet: ReadonlySet<string>): ValidBalRow | null {
  const mint = typeof r.postMint === "string" ? r.postMint : typeof r.preMint === "string" ? r.preMint : null;
  if (!mint || !BASE58.test(mint) || !memberSet.has(mint)) return null;
  if (typeof r.account !== "string" || !BASE58.test(r.account)) return null;
  const txIndex = Number(r.transactionIndex);
  if (!Number.isInteger(txIndex) || txIndex < 0) return null;
  const amt = (v: unknown): bigint | null => {
    if (v === null || v === undefined) return 0n; // absent side = no prior/posterior account
    if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
    return null;
  };
  const pre = amt(r.preAmount);
  const post = amt(r.postAmount);
  if (pre === null || post === null) return null;
  const owner = (v: unknown): string | null => (typeof v === "string" && BASE58.test(v) ? v : null);
  return { txIndex, mint, account: r.account, preOwner: owner(r.preOwner), postOwner: owner(r.postOwner), preAmount: pre, postAmount: post };
}

export interface SqdDecodeResult {
  events: CollectionEvent[];
  rejectedRows: number; // failed field validation
  ambiguousGroups: number; // (tx,mint) groups that didn't decode — counted, never guessed
  skippedMalformedCount: number; // malformed balance entries skipped this call
}

/** Logger interface — defaulted to console in production; injected in tests. */
export interface SqdDecodeLogger {
  warn: (m: string) => void;
  error: (m: string) => void;
}

const MALFORMED_RATE_THRESHOLD = 0.10; // escalate to error if >10% entries skipped in a block

/**
 * Decode a batch of streamed blocks. `seenMints` carries first-appearance state ACROSS windows —
 * the caller owns it (pass a set pre-seeded from existing DB mints when resuming mid-history,
 * else the first transfer after a resume would masquerade as a mint).
 *
 * T-8 input validation (SDD §6.3): each tokenBalance entry is validated; malformed entries are
 * warned and skipped. Never throws on malformed input — never halts the stream.
 */
export function decodeSqdBlocks(
  blocks: readonly SqdBlock[],
  memberSet: ReadonlySet<string>,
  seenMints: Set<string>,
  log: SqdDecodeLogger = { warn: console.warn, error: console.error },
): SqdDecodeResult {
  const events: CollectionEvent[] = [];
  let rejectedRows = 0;
  let ambiguousGroups = 0;
  let skippedMalformedCount = 0;

  for (const b of blocks) {
    const slot = Number(b.header?.number);
    const blockTime = Number(b.header?.timestamp);
    if (!Number.isInteger(slot) || !Number.isFinite(blockTime)) continue;
    // tx signature lookup by index (first signature = the tx id, Solana convention)
    const sigByIndex = new Map<number, string>();
    for (const t of b.transactions ?? []) {
      const i = Number(t.transactionIndex);
      const sig = Array.isArray(t.signatures) ? t.signatures[0] : undefined;
      if (Number.isInteger(i) && typeof sig === "string") sigByIndex.set(i, sig);
    }

    const totalEntriesInBlock = b.tokenBalances?.length ?? 0;
    let blockSkipped = 0;

    // group valid rows by (txIndex, mint)
    const groups = new Map<string, ValidBalRow[]>();
    for (const raw of b.tokenBalances ?? []) {
      const v = validateBalRow(raw, memberSet);
      if (!v) {
        // rows for non-member mints are filter spillover, not corruption — only count rows that
        // NAMED a member mint but failed validation
        const namedMember =
          (typeof raw.postMint === "string" && memberSet.has(raw.postMint)) ||
          (typeof raw.preMint === "string" && memberSet.has(raw.preMint));
        if (namedMember) {
          rejectedRows++;
          blockSkipped++;
          skippedMalformedCount++;
          log.warn(`[SQD SKIP] malformed balance entry at block ${slot}`);
        }
        continue;
      }
      const k = `${v.txIndex}:${v.mint}`;
      const g = groups.get(k) ?? [];
      g.push(v);
      groups.set(k, g);
    }

    // T-8: escalate if >10% of block entries were malformed (possible protocol change)
    if (totalEntriesInBlock > 0 && blockSkipped / totalEntriesInBlock > MALFORMED_RATE_THRESHOLD) {
      log.error(`[SQD MALFORMED] >${Math.round(MALFORMED_RATE_THRESHOLD * 100)}% entries skipped in block ${slot} (${blockSkipped}/${totalEntriesInBlock})`);
    }

    // per-(tx,mint) ordinal state within this block, keyed by `${sig}:${mint}`
    const ordinals = new Map<string, number>();
    for (const [key, rows] of [...groups.entries()].sort((a, b2) => Number(a[0].split(":")[0]) - Number(b2[0].split(":")[0]))) {
      const txIndex = Number(key.split(":")[0]);
      const mint = rows[0].mint;
      const sig = sigByIndex.get(txIndex);
      if (!sig) {
        ambiguousGroups++; // balance rows without a resolvable tx signature can't form a PK
        continue;
      }
      const losing = rows.filter((r) => r.preAmount > 0n && r.postAmount === 0n);
      const gaining = rows.filter((r) => r.preAmount === 0n && r.postAmount > 0n);

      let kind: "mint" | "transfer" | "burn";
      let from: string | null;
      let to: string | null;
      // Shared ambiguous exit (BB #141 LOW): mark the mint SEEN (bd-zyli — its next
      // appearance must not fake a first-appearance mint) and count the group.
      const markAmbiguous = (): void => {
        seenMints.add(mint);
        ambiguousGroups++;
      };
      // Null-owner doctrine (dissent iter-1/2 + BB #141 MEDIUMs): a null owner row
      // carries no custody information. It may not form an event endpoint, and in a
      // multi-row group it may BE the true counterparty — so its mere presence makes
      // net-custody attribution unknowable. Ambiguity over guessing, on every path.
      const hasNullOwnerRow = losing.some((r) => r.preOwner === null) || gaining.some((r) => r.postOwner === null);
      if (hasNullOwnerRow) {
        markAmbiguous();
        continue;
      }
      if (losing.length === 1 && gaining.length === 1) {
        kind = "transfer";
        from = losing[0].preOwner;
        to = gaining[0].postOwner;
      } else if (gaining.length === 1 && losing.length === 0) {
        if (seenMints.has(mint)) {
          // token appeared without a losing counterpart mid-history: custody arrival we can't
          // source (e.g. cross-program escrow release outside balance rows) → ambiguous
          markAmbiguous();
          continue;
        }
        kind = "mint";
        from = null;
        to = gaining[0].postOwner;
      } else if (losing.length === 1 && gaining.length === 0) {
        kind = "burn";
        from = losing[0].preOwner;
        to = null;
      } else {
        // multi-hop in one tx: NET custody = owners that lost minus owners that gained.
        // Intermediaries (escrow hops) appear on both sides and cancel — order-INDEPENDENT
        // (bd-k5fh: Portal row order within a group is not contractually stable, so any
        // positional pick could decode the same transfer differently across fetches).
        // No unique net pair → honestly ambiguous, never an arbitrary pick.
        // (No null filtering needed here — the hasNullOwnerRow gate above already
        // rejected any group where a null row could be the true counterparty.)
        const lostOwners = new Set(losing.map((r) => r.preOwner as string));
        const gainedOwners = new Set(gaining.map((r) => r.postOwner as string));
        const netLosers = [...lostOwners].filter((o) => !gainedOwners.has(o));
        const netGainers = [...gainedOwners].filter((o) => !lostOwners.has(o));
        if (netLosers.length === 1 && netGainers.length === 1) {
          kind = "transfer";
          from = netLosers[0];
          to = netGainers[0];
        } else {
          markAmbiguous();
          continue;
        }
      }
      seenMints.add(mint);
      const ok = `${sig}:${mint}`;
      const ordinal = ordinals.get(ok) ?? 0;
      ordinals.set(ok, ordinal + 1);
      events.push({
        nftMint: mint,
        kind,
        from: kind === "mint" ? null : from,
        to: kind === "burn" ? null : to,
        instructionIndex: ordinal,
        price: null,
        marketplace: null,
        slot,
        blockTime: blockTime, // Portal header.timestamp is unix seconds [MEASURED: 1783236984 ≈ 2026-07-05]
        txSignature: sig,
      });
    }
  }
  return { events, rejectedRows, ambiguousGroups, skippedMalformedCount };
}
