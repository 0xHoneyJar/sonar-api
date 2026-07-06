/**
 * collection-event-source.ts — the SVM substrate SEAM for NFT-collection ownership EVENT history.
 *
 * Sibling of nft-collection-source.ts. Where that pipe reads a current-state SNAPSHOT (who holds which
 * NFT now), this one reads the EVENT STREAM (mint / transfer / burn / sale, with from/to/tx/slot/time) —
 * the SVM analog of the EVM `MiberaTransfer` entity the Score API derives scoring verbs from. Behind the
 * `CollectionEventSource` seam so the substrate (Helius today, Geyser/HyperSync tomorrow) is swappable
 * with zero writer/consumer change (cycle svm-collection-events; SDD §3).
 *
 * SUBSTRATE NOTE (SDD §4 + Sprint-2 empirical finding): the design feared a mint-keyed walk would miss
 * plain SPL `Transfer`s (mint absent from instruction accounts). VERIFIED 2026-06-24 against live Helius:
 * Pythenians are ProgrammableNonFungible (pNFT) — pNFT transfers route through Token Metadata WITH the mint
 * in-tx, so the mint's Enhanced address-history (`/v0/addresses/{mint}/transactions`) returns the COMPLETE
 * mint→transfer→sale→burn chain. So Sprint 2 walks mint-address-history (simpler than token-account
 * tracing); the §4.5 reconciliation-vs-DAS gate proves completeness empirically. Classic-SPL collections
 * with raw `Transfer`s would still need token-account tracing — a per-collection concern (SDD §4.4/§13),
 * gated by reconciliation when such a collection is added.
 */

import { DasNftCollectionSource } from "./nft-collection-source";
import { meter } from "./helius-meter";

/**
 * SVM collection-event kinds. `mint`/`transfer`/`burn`/`sale` are ownership changes (`sale` carries
 * resolved buyer/seller/price — SDD §4.3). `list`/`delist` are marketplace-STATE events (#85): the NFT
 * moves to/from a marketplace escrow WITHOUT a beneficial-owner change — emitted as a distinct kind (+
 * `marketplace`) so a consumer can tell a listing from a real peer-to-peer transfer instead of each
 * re-deriving it from escrow addresses (score-api request, issue #85).
 */
export type CollectionEventKind = "mint" | "transfer" | "burn" | "sale" | "list" | "delist";

/** One ownership-changing event for one NFT (the entity the writer upserts). */
export interface CollectionEvent {
  readonly nftMint: string; // base58 NFT mint
  readonly kind: CollectionEventKind;
  readonly from: string | null; // owner-level; null for mint; resolved SELLER for sale
  readonly to: string | null; // owner-level; null for burn; resolved BUYER for sale
  readonly instructionIndex: number; // per-NFT leg ordinal within the tx → PK uniqueness + consumer numeric1 (SDD H3/H4)
  readonly price: number | null; // sale: lamports; list: the ask amount (#85, single-listing only); null otherwise
  readonly marketplace: string | null; // sale/list/delist: Helius source (e.g. "MAGIC_EDEN"/"TENSOR"); null otherwise
  readonly slot: number;
  readonly blockTime: number; // on-chain block time, unix SECONDS (the scoring timestamp)
  readonly txSignature: string;
}

export interface SourceHealth {
  readonly ok: boolean;
  readonly detail: string;
}

/** The SEAM. Any substrate (Helius today, Geyser/HyperSync tomorrow) implements this. */
export interface CollectionEventSource {
  /** Stream the full event history for the configured collection (resumable via sinceSlot). */
  backfill(opts?: { sinceSlot?: number }): AsyncIterable<CollectionEvent>;
  health(): Promise<SourceHealth>;
}

// ── pure parsing (no network — unit-testable) ───────────────────────────────

/**
 * The subset of a Helius parsed/enhanced transaction we read. Field shapes are marked [VERIFY] where
 * they must be confirmed against live Helius responses in Sprint 2 (SDD §13) — we do NOT hard-assume
 * undocumented fields; the parser degrades gracefully (skips legs it can't classify).
 */
export interface HeliusTokenTransfer {
  mint?: string;
  fromUserAccount?: string | null; // [VERIFY] owner-level (not token-account) — Helius resolves ATAs to owners
  toUserAccount?: string | null;
  tokenStandard?: string; // [VERIFY] e.g. "NonFungible"
}

export interface HeliusNftEventNft {
  mint?: string;
}

export interface HeliusNftEvent {
  type?: string; // [VERIFY] e.g. "NFT_SALE"
  source?: string; // [VERIFY] marketplace, e.g. "TENSOR" / "MAGIC_EDEN"
  amount?: number; // [VERIFY] price in lamports
  buyer?: string;
  seller?: string;
  nfts?: readonly HeliusNftEventNft[];
}

export interface HeliusParsedTx {
  signature?: string;
  slot?: number;
  timestamp?: number; // [VERIFY] block time, unix seconds (Helius enhanced uses `timestamp`)
  type?: string; // [VERIFY] high-level type: NFT_MINT | NFT_SALE | NFT_LISTING | NFT_CANCEL_LISTING | TRANSFER | BURN | …
  source?: string; // marketplace for list/delist (top-level), e.g. "MAGIC_EDEN" / "TENSOR" (#85; VERIFIED live)
  tokenTransfers?: readonly HeliusTokenTransfer[];
  events?: { nft?: HeliusNftEvent };
}

// Helius high-level type strings. [VERIFY] exact tokens (NFT_MINT vs TOKEN_MINT; BURN vs NFT_BURN)
// against live responses in Sprint 2; the classifier treats anything else with a token-transfer as a
// plain transfer (the safe default), so an unknown mint/burn type degrades to `transfer`, never crashes.
const TYPE_MINT = new Set(["NFT_MINT", "TOKEN_MINT", "COMPRESSED_NFT_MINT"]);
const TYPE_BURN = new Set(["BURN", "NFT_BURN", "BURN_NFT", "COMPRESSED_NFT_BURN"]);
const TYPE_SALE = "NFT_SALE";
// Marketplace list/delist (#85). Helius emits a distinct `type` + `source` for these (VERIFIED live:
// NFT_LISTING / NFT_CANCEL_LISTING on MAGIC_EDEN + TENSOR), so an owner→escrow listing and an
// escrow→owner cancel are no longer indistinguishable from a peer-to-peer transfer. Unknown variants
// degrade to `transfer` (the safe default), never crash.
const TYPE_LIST = new Set(["NFT_LISTING", "LISTING", "LIST_NFT"]);
const TYPE_DELIST = new Set(["NFT_CANCEL_LISTING", "NFT_DELISTING", "DELIST_NFT", "CANCEL_LISTING"]);

// #85 DEPLOY GATE (FAGAN MAJOR-1): list/delist emission is OFF by default. The live svm.collection_event
// CHECK constraint must be widened to allow 'list'/'delist' BEFORE this is enabled — otherwise a single
// list event fails the WHOLE atomic batch upsert (drops co-bundled events + a Helius 500 retry-storm).
// Deploy with the flag OFF (a no-op — listings still emit as `transfer`, exactly as today), apply the
// ALTER, THEN set SVM_EMIT_MARKETPLACE_KINDS=true on the webhook + backfill, and re-backfill to reclassify.
const MARKETPLACE_KINDS_ENABLED = process.env.SVM_EMIT_MARKETPLACE_KINDS === "true";

/**
 * Decode one Helius parsed tx into the collection events it contains (one per member NFT leg).
 *
 * - SALE: prefer `events.nft` (Helius resolves the human seller/buyer/price behind the marketplace
 *   escrow). Emitting from `events.nft` and skipping the raw escrow→buyer tokenTransfer avoids
 *   double-counting (SDD §4.3 / H5).
 * - MINT / TRANSFER / BURN: from `tokenTransfers[]` (owner-level from/to). kind keyed off the tx
 *   `type` field, NOT a from-null/to-incinerator heuristic (SDD §4.2 / L3).
 *
 * `instructionIndex` is a PER-MINT occurrence ordinal (0 for the first leg of a given mint in this tx),
 * so the PK `{sig}:{mint}:{index}` is intrinsic to the event — batch txs get distinct PKs via distinct
 * mints, and re-decodes converge regardless of sibling-mint filtering/ordering (FAGAN C1).
 *
 * `isMember(mint)` filters to the collection under index. Pure — no network. Tolerant of partial/unknown
 * shapes (returns whatever it can classify; never throws on a malformed tx).
 */
export function parseHeliusTx(
  tx: HeliusParsedTx | null | undefined,
  isMember: (mint: string) => boolean,
  opts?: { emitMarketplaceKinds?: boolean },
): CollectionEvent[] {
  // #85 gate: emit list/delist only when enabled (default = the env-derived module const, OFF). When
  // OFF, a listing/cancel degrades to `kind=transfer` exactly as before — a safe no-op until the live
  // CHECK constraint is widened. Tests pass `opts.emitMarketplaceKinds` explicitly.
  const emitMarketplaceKinds = opts?.emitMarketplaceKinds ?? MARKETPLACE_KINDS_ENABLED;
  const out: CollectionEvent[] = [];
  if (!tx) return out;
  const txSignature = tx.signature;
  if (!txSignature) return out; // no signature → can't form a PK; skip
  const slot = tx.slot ?? 0;
  const blockTime = tx.timestamp ?? 0;
  // A valid event needs a real on-chain slot + block time. Both feed ordering and block_time is the
  // NOT NULL scoring timestamp; a missing value (0) would write 1970-01-01, sort as the oldest event, and
  // silently poison scoring + the §4.5 reconciliation. Skip rather than corrupt — a dropped event is
  // recoverable by re-run, a 1970 row is corruption that looks like data (FAGAN H2).
  if (slot <= 0 || blockTime <= 0) return out;
  const type = tx.type;

  // Per-mint occurrence ordinal — INTRINSIC to (sig, mint): independent of sibling mints, `isMember`
  // filtering, and tokenTransfers ordering. Keeps the content-addressed PK {sig}:{mint}:{index} a PURE
  // function of the event, so backfill + webhook converge even under member-set churn (DAS drops burnt
  // members) or surface reordering (SDD §13 [VERIFY]). In the ~always case (one leg per member per tx)
  // this is 0 (FAGAN C1). If Helius later exposes a real per-leg instruction index, prefer it.
  const occ = new Map<string, number>();
  const nextIndex = (mint: string): number => {
    const i = occ.get(mint) ?? 0;
    occ.set(mint, i + 1);
    return i;
  };

  // SALE — resolved parties from events.nft. Track which mints were emitted as sales so we skip ONLY
  // their escrow→buyer leg below (NOT the whole tx — a bundle/aggregator tx can sell M1 via events.nft
  // AND move member M2 via tokenTransfers; M2 must still be emitted) (FAGAN H1).
  const soldMints = new Set<string>();
  const nftEvent = tx.events?.nft;
  if (type === TYPE_SALE && nftEvent) {
    const saleMints = (nftEvent.nfts ?? [])
      .map((n) => n.mint)
      .filter((m): m is string => typeof m === "string" && isMember(m));
    for (const mint of saleMints) {
      out.push({
        nftMint: mint,
        kind: "sale",
        from: nftEvent.seller ?? null,
        to: nftEvent.buyer ?? null,
        instructionIndex: nextIndex(mint),
        // amount may serialize as a string for large lamport values — coerce, don't discard (FAGAN M1).
        price: Number.isFinite(Number(nftEvent.amount)) ? Number(nftEvent.amount) : null,
        marketplace: nftEvent.source ?? null,
        slot,
        blockTime,
        txSignature,
      });
      soldMints.add(mint);
    }
  }

  // MINT / TRANSFER / BURN — from token transfers. (An NFT_SALE whose events.nft is absent falls through
  // here and is recorded as kind='transfer' with from=<escrow PDA> and no price — a documented LOSSY
  // degradation, not a silent one: the leg is preserved, just un-resolved (FAGAN L1).)
  // Marketplace for list/delist (#85): top-level tx.source, else the nft event's source.
  const mpSource = tx.source ?? nftEvent?.source ?? null;
  for (const tt of tx.tokenTransfers ?? []) {
    const mint = tt.mint;
    if (!mint || !isMember(mint)) continue;
    if (soldMints.has(mint)) continue; // already emitted as a sale — skip its escrow→buyer leg (no double-count)
    let kind: CollectionEventKind;
    let from: string | null = tt.fromUserAccount ?? null;
    let to: string | null = tt.toUserAccount ?? null;
    let marketplace: string | null = null;
    let price: number | null = null;
    if (type && TYPE_MINT.has(type)) {
      kind = "mint";
      from = null; // a mint has no prior owner
    } else if (type && TYPE_BURN.has(type)) {
      kind = "burn";
      to = null; // a burn has no next owner
    } else if (emitMarketplaceKinds && type && TYPE_LIST.has(type)) {
      // a listing: owner→escrow. Keep the raw from/to (score-api filters escrow addresses on its side —
      // #85); the distinct kind + marketplace are the event fact it asked for.
      kind = "list";
      marketplace = mpSource;
      // price = the ask. Only for a SINGLE-NFT listing — a multi-mint listing shares one top-level
      // amount, so don't claim a (possibly-wrong) per-mint ask (FAGAN MINOR-2); leave null there.
      const singleListing = (nftEvent?.nfts?.length ?? 0) <= 1;
      price = singleListing && Number.isFinite(Number(nftEvent?.amount)) ? Number(nftEvent?.amount) : null;
    } else if (emitMarketplaceKinds && type && TYPE_DELIST.has(type)) {
      // a cancel-listing: escrow→owner. The NFT returns to the lister; no price on a cancel.
      kind = "delist";
      marketplace = mpSource;
    } else {
      kind = "transfer"; // safe default (incl. list/delist when the #85 gate is OFF) — never crashes
    }
    out.push({
      nftMint: mint,
      kind,
      from,
      to,
      instructionIndex: nextIndex(mint),
      price,
      marketplace,
      slot,
      blockTime,
      txSignature,
    });
  }
  return out;
}

// ── v1 Helius substrate ──────────────────────────────────────────────────────

const ADDRESS_HISTORY_LIMIT = 100; // Helius Enhanced address-history max per page
const MAX_PAGES_PER_MINT = 1000; // 100k txs/NFT — far above any real NFT; fail before an infinite loop
const MAX_RETRIES = 6; // retry budget per request on 429 / 5xx (Helius free tier = ~10 RPS)
const RETRY_BASE_MS = 700; // exponential backoff base: 0.7s, 1.4s, 2.8s … (capped)
const RETRY_CAP_MS = 12_000;
const DEFAULT_PACE_MS = 120; // inter-request spacing → stay just under the rate limit (≈8 RPS)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * v1 — Helius substrate. Enumerates collection members via DAS `getAssetsByGroup` (reusing the snapshot
 * source) and walks each member NFT's Enhanced parsed tx history (`/v0/addresses/{mint}/transactions`,
 * paged by `before`), decoding each tx with `parseHeliusTx`. For pNFT/modern NFTs the mint-address history
 * is the complete chain (verified — see SUBSTRATE NOTE). A tx that touches two member NFTs is fetched
 * under each mint's history; the per-mint `onlyThis` filter + the writer's PK de-dupe keep that correct
 * and idempotent.
 */
export class HeliusCollectionEventSource implements CollectionEventSource {
  private readonly rpcUrl: string;
  private readonly parseBase: string;
  private readonly paceMs: number;
  constructor(
    private readonly apiKey: string,
    readonly collectionMint: string,
    opts?: { rpcUrl?: string; parseBase?: string; paceMs?: number },
  ) {
    this.rpcUrl = opts?.rpcUrl ?? `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    this.parseBase = opts?.parseBase ?? "https://api.helius.xyz";
    this.paceMs = opts?.paceMs ?? DEFAULT_PACE_MS;
  }

  /** Enumerate the collection's current member NFTs (base58 mints) via DAS. */
  async members(): Promise<string[]> {
    const snap = await new DasNftCollectionSource(this.rpcUrl, this.collectionMint).snapshot();
    return snap.members.map((m) => m.nftMint);
  }

  /** Full event history for the collection: every member NFT's decoded tx history. */
  async *backfill(): AsyncIterable<CollectionEvent> {
    for (const mint of await this.members()) {
      yield* this.mintHistory(mint);
    }
  }

  /** Walk one NFT's parsed tx history (newest→older via `before`), yielding only THIS mint's events.
   * SVM_BACKFILL_SINCE (unix seconds) bounds the walk: pagination is newest-first, so once a page's
   * oldest tx predates the bound we stop — blue-chip mints carry 1000s of marketplace txs (SMB
   * measured ~30+ pages/mint, ~3,000cr/NFT: 15M credits for ONE collection unbounded; the 2026-07-05
   * walk-train discovery). Recent-window onboarding + warehouse deep-history is the composite. */
  async *mintHistory(mint: string): AsyncIterable<CollectionEvent> {
    const onlyThis = (m: string) => m === mint;
    const since = Number(process.env.SVM_BACKFILL_SINCE ?? 0) || 0;
    let before: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_MINT; page++) {
      const txs = await this.addressHistory(mint, before);
      if (txs.length === 0) break;
      let reachedBound = false;
      const inWindow = since > 0 ? txs.filter((t) => { const ts = Number(t.timestamp ?? 0); if (ts && ts < since) reachedBound = true; return !ts || ts >= since; }) : txs;
      if (since > 0) {
        for (const tx of inWindow) for (const ev of parseHeliusTx(tx, onlyThis)) yield ev;
        if (reachedBound) break;
        before = txs[txs.length - 1]?.signature;
        if (txs.length < ADDRESS_HISTORY_LIMIT || !before) break;
        continue;
      }
      for (const tx of txs) {
        for (const ev of parseHeliusTx(tx, onlyThis)) yield ev;
      }
      before = txs[txs.length - 1]?.signature;
      if (txs.length < ADDRESS_HISTORY_LIMIT || !before) break;
    }
  }

  private async addressHistory(address: string, before?: string): Promise<HeliusParsedTx[]> {
    const url = new URL(`${this.parseBase}/v0/addresses/${address}/transactions`);
    url.searchParams.set("api-key", this.apiKey);
    url.searchParams.set("limit", String(ADDRESS_HISTORY_LIMIT));
    if (before) url.searchParams.set("before", before);

    for (let attempt = 0; ; attempt++) {
      if (this.paceMs > 0) await sleep(this.paceMs); // spacing → stay under the rate limit
      meter("enhanced", "address-history"); // per ATTEMPT (retries included) — Enhanced bills 100 credits/call, the lane's dominant burn
      // Per-attempt timeout — run 28736768956 froze 4h on ONE hung socket (no AbortSignal),
      // burning the walk unpersisted. Timeout = transient: fall through to retry, 30s max per hang.
      let res: Response;
      try {
        res = await fetch(url.toString(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        if (attempt >= MAX_RETRIES) throw new Error(`helius address-history ${address}: ${(e as Error).name} after ${attempt} retries`);
        continue;
      }
      // 429 (rate limit) / 5xx are transient — back off and retry (respect Retry-After when present).
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(`helius address-history ${address}: HTTP ${res.status} after ${attempt} retries`);
        }
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        // Cap BOTH branches at RETRY_CAP_MS — an unbounded server-supplied Retry-After could stall the
        // backfill for an hour per retry (FAGAN F2).
        const wait =
          retryAfter > 0
            ? Math.min(RETRY_CAP_MS, retryAfter * 1000)
            : Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`helius address-history ${address}: HTTP ${res.status} ${body.slice(0, 160)}`);
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        throw new Error(`helius address-history ${address}: non-array response ${JSON.stringify(data).slice(0, 160)}`);
      }
      return data as HeliusParsedTx[];
    }
  }

  async health(): Promise<SourceHealth> {
    // Probe BOTH surfaces the backfill uses: DAS getAssetsByGroup (enumeration) AND the Enhanced
    // address-history endpoint (the hot path) — a tier/key mismatch can leave one reachable and the
    // other not (FAGAN F4).
    const das = await new DasNftCollectionSource(this.rpcUrl, this.collectionMint).health();
    if (!das.ok) return das;
    try {
      const url = new URL(`${this.parseBase}/v0/addresses/${this.collectionMint}/transactions`);
      url.searchParams.set("api-key", this.apiKey);
      url.searchParams.set("limit", "1");
      const res = await fetch(url.toString(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return { ok: false, detail: `helius enhanced address-history unavailable: HTTP ${res.status}` };
      return { ok: true, detail: "das getAssetsByGroup + enhanced address-history reachable" };
    } catch (e) {
      return { ok: false, detail: `helius enhanced address-history unreachable: ${(e as Error).message}` };
    }
  }
}
