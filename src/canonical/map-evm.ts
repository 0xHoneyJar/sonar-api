/**
 * map-evm.ts — pure normalization: native EVM ownership legs → canonical NftActivity.
 *
 * Per-LEG verb derivation, NEVER-DROP (1:1 legs→activities; silent loss is the cardinal sin):
 *   - mint     = a Transfer FROM the zero address
 *   - burn     = a Transfer TO the zero address (or an NftBurn leg)
 *   - sale     = the CARRIER leg of a (tx, tokenId) matched by a marketplace SALE row → resolved
 *                seller/buyer + price (port of score-api fetchMiberaBuyers/Sellers). The carrier is
 *                the deterministic MIN-logIndex non-zero matched leg — exactly ONE per (tx,tokenId) sale.
 *   - transfer = any other non-mint/non-burn leg: unmatched by a sale, OR a NON-carrier leg of a
 *                matched (tx,tokenId) (precedence sale > transfer applies PER LEG: the carrier is the
 *                sale, never also a transfer).
 *
 * KNOWN over-emit (FAGAN MAJOR-3 — tracked to the S5 parity gate, SDD §8.5): a non-carrier leg of a
 * matched (tx,tokenId) is a market-ROUTING hop (seller→market→buyer) OR a genuine pre/post retransfer
 * (X→seller / buyer→C) — INDISTINGUISHABLE from legs alone without owner-topology — so it is emitted
 * as verb=transfer. This is the SAFE direction (never-drop: a genuine retransfer MUST survive; v1's
 * collapse silently lost it). The routing-hop transfers are VISIBLE, not silent. Whether/how to
 * suppress routing is decided at the S5 consumer handshake against REAL mibera topology — NOT guessed
 * here: a topology heuristic without data re-introduces silent loss on multi-leg pre/post chains
 * (a longer X→Y→seller chain would mis-suppress X→Y). So per-leg never-drop now; principled
 * suppression only once S5 confirms the real leg shapes. EVM metadata carries no `marketplace` field,
 * so the consumer cannot filter the hop in-band — another reason the suppression decision is S5's.
 *
 * PURE: no network, no Effect runtime — `Either<NftActivity, SchemaInvalid>`. Validity is decoded
 * through `NftActivitySchema` (the shared contract), so a schema-malformed activity never reaches
 * downstream. EVM specifics folded in here so the consumer never branches on chain:
 *   - `value` (sale) = price in WEI as a DECIMAL STRING (uint256 exceeds 2^53; taken as a string,
 *     never a float) + `decimals=18`.
 *   - addresses are lowercased (the canonical EVM form; checksum casing is non-semantic).
 *
 * F9 (sale-derivation is a versioned producer contract): the derivation is re-derivable from
 * (tx, log_index, token_id) — top-level `tx` + `metadata.{log_index,token_id}` pin the raw leg, so
 * a heuristic change re-runs the join under a new schema_version (runbook), not an in-place mutation.
 * The EVM `from`/`to` for a sale are the RESOLVED seller/buyer (not the raw marketplace-routed legs).
 *
 * NOTE: the input leg/sale types are the normalized projection of the native Hasura entities
 * (MiberaTransfer / MintActivity SALE / NftBurn). The Hasura adapter that produces them is S4; this
 * mapper is pure over the shapes, mirroring how map-svm consumes the SVM `CollectionEvent`.
 *
 * NOTE (epoch guard — MINOR-4): unlike map-svm (which derives the timestamp from a numeric blockTime
 * and rejects ≤0 / Date-overflow), map-evm trusts a pre-formatted `leg.timestamp` STRING. The schema
 * validates only its ISO-8601 SHAPE — a well-formed bogus epoch ("1970-01-01T00:00:00Z") would pass.
 * Epoch/range validation is therefore the S4 EVM Hasura adapter's responsibility; the parity gap with
 * map-svm is intentional and owned there (different input contract: string vs numeric).
 *
 * NOTE (push/pull dedup parity — MINOR-2, §4 / consumer-owned): the pull projection PK is
 * {tx}:{asset_ref}:{verb}:{leg} (keeps every leg) but the NATS consumer-dedup key is
 * (tx, asset_ref, verb) (no leg). So same-verb multi-leg sequences in one tx (e.g. A→B→C, both
 * transfer) are distinct on the pull surface but collapse on push. The mapper emits them correctly
 * (one per leg); reconciling the two dedup grains is the §4 / score-mibera owner's call at the S5 handshake.
 */
import { Schema as S, TreeFormatter } from "@effect/schema";
import { Either } from "effect";
import { NftActivitySchema, type NftActivity } from "@0xhoneyjar/events";
import { SchemaInvalid } from "./errors";

/** EVM amounts are denominated in wei — 18 decimals. */
const WEI_DECIMALS = 18;
/** The EVM zero address — Transfer from it = mint, to it = burn. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const decodeActivity = S.decodeUnknownEither(NftActivitySchema);

/** A raw EVM ownership-transfer leg — the normalized projection of a MiberaTransfer / Transfer entity. */
export interface EvmTransferLeg {
  readonly txHash: string; // 0x… tx hash (opaque here; a producer may validate via EVM_TX_HASH_RX)
  readonly tokenId: string; // decimal string
  readonly from: string; // 0x… (the zero address for a mint)
  readonly to: string; // 0x… (the zero address for a burn)
  readonly logIndex: number; // non-negative log ordinal in the tx
  readonly blockNumber: number;
  readonly timestamp: string; // ISO-8601 UTC
}

/** A resolved marketplace sale — the projection of a MintActivity SALE row + score-api buyer/seller resolution. */
export interface EvmSaleRow {
  readonly txHash: string;
  readonly tokenId: string;
  readonly seller: string; // resolved owner-level seller
  readonly buyer: string; // resolved owner-level buyer
  readonly priceWei: string; // decimal string of wei (uint256 — string, never a number)
}

/** Per-collection context the leg/sale don't carry. */
export interface EvmCollectionContext {
  /** Topic-segment slug (`/^[a-z][a-z0-9-]*$/`), e.g. "mibera". */
  readonly collectionKey: string;
  /** EVM chain id, e.g. Berachain 80094. */
  readonly chainId: number;
  /** 0x… collection contract address (lowercased into metadata). */
  readonly contract: string;
}

/**
 * Canonicalize a decimal tokenId for the cross-projection join ("0123" → "123").
 * The join key bytes must match across TWO different Hasura projections (the transfer
 * projection vs the MintActivity-SALE projection); a leading-zero / non-canonical decimal
 * on one side would silently fail the join and demote a real sale to verb=transfer (MINOR-1).
 * A NON-decimal tokenId is left as-is — it fails the schema's token_id /^\d+$/ at decode and
 * surfaces as a typed SchemaInvalid, not a silent join miss (BigInt would mis-parse "0xabc").
 */
function canonTokenId(tokenId: string): string {
  return /^\d+$/.test(tokenId) ? String(BigInt(tokenId)) : tokenId;
}

/** The (txHash, tokenId) join key for sale-exclusivity — txHash lowercased, tokenId canonicalized. */
function saleKey(txHash: string, tokenId: string): string {
  return `${txHash.toLowerCase()}:${canonTokenId(tokenId)}`;
}

/** Build the (txHash, tokenId) → sale lookup the leg mapper consults for sale-exclusivity. */
export function indexSalesByLeg(sales: readonly EvmSaleRow[]): ReadonlyMap<string, EvmSaleRow> {
  const m = new Map<string, EvmSaleRow>();
  for (const s of sales) m.set(saleKey(s.txHash, s.tokenId), s);
  return m;
}

/**
 * Map ONE EVM transfer leg to exactly one canonical activity, applying sale > transfer precedence.
 * `matchedSale` is the sale row for this leg's (txHash, tokenId), or null/undefined if none.
 * Mint/burn (zero-address) are classified BEFORE sale — a zero-address leg is never a sale.
 */
export function mapEvmLeg(
  leg: EvmTransferLeg,
  ctx: EvmCollectionContext,
  matchedSale?: EvmSaleRow | null,
): Either.Either<NftActivity, SchemaInvalid> {
  const fromZero = leg.from.toLowerCase() === ZERO_ADDRESS;
  const toZero = leg.to.toLowerCase() === ZERO_ADDRESS;

  let verb: "mint" | "transfer" | "sale" | "burn";
  let from: string | null;
  let to: string | null;
  let value: string | null = null;
  let decimals: number | null = null;

  if (fromZero && toZero) {
    return Either.left(
      new SchemaInvalid({
        reason: `transfer from AND to the zero address (tx ${leg.txHash}, token ${leg.tokenId})`,
      }),
    );
  } else if (fromZero) {
    verb = "mint";
    from = null;
    to = leg.to.toLowerCase();
  } else if (toZero) {
    verb = "burn";
    from = leg.from.toLowerCase();
    to = null;
  } else if (matchedSale) {
    // sale > transfer (F4): a transfer matched by a marketplace sale IS the sale (resolved parties + price).
    verb = "sale";
    from = matchedSale.seller.toLowerCase();
    to = matchedSale.buyer.toLowerCase();
    value = matchedSale.priceWei;
    decimals = WEI_DECIMALS;
  } else {
    verb = "transfer";
    from = leg.from.toLowerCase();
    to = leg.to.toLowerCase();
  }

  const candidate = {
    verb,
    chain: "evm",
    collection_key: ctx.collectionKey,
    asset_ref: leg.tokenId,
    from,
    to,
    value,
    decimals,
    tx: leg.txHash,
    timestamp: leg.timestamp,
    metadata: {
      chain: "evm",
      chain_id: ctx.chainId,
      contract: ctx.contract.toLowerCase(),
      token_id: leg.tokenId,
      log_index: leg.logIndex,
      block_number: leg.blockNumber,
    },
  };

  return Either.mapLeft(
    decodeActivity(candidate),
    (parseError) =>
      new SchemaInvalid({
        reason: `NftActivity decode failed for token ${leg.tokenId} (verb ${verb}): ${TreeFormatter.formatErrorSync(parseError)}`,
        parseError,
      }),
  );
}

/**
 * Map ALL legs of a batch with sale-exclusivity — exactly ONE activity per leg (1:1, NO drop).
 *
 * F4 (one movement → ONE activity) is per-LEG: a leg matched by a sale → verb=sale (resolved
 * seller/buyer + price), never ALSO verb=transfer for that same leg. A (tx, tokenId) sale is
 * carried by exactly ONE leg — the deterministic MIN-logIndex non-zero matched leg — so a
 * marketplace sale that surfaces as one logical event is one `verb=sale` (not N). The carrier
 * pick is order-INDEPENDENT (min logIndex, not "first encountered"), so two backfills of the same
 * raw data pick the same carrier → the same signed/chained envelope hash; F9 re-derivability via
 * the (tx, log_index, token_id) locator is stable (MAJOR-2 fix).
 *
 * Every OTHER matched non-zero leg of that (tx, tokenId) is emitted as verb=transfer — NEVER
 * dropped (MAJOR-1 fix): a genuine post-sale retransfer (buyer→C in the same tx) is a distinct
 * movement the consumer's (tx, asset_ref, verb) dedup keeps. A market-routing hop (market→buyer) is
 * also emitted as a VISIBLE transfer (KNOWN over-emit, MAJOR-3) — its suppression is an S5/consumer-
 * topology decision, NOT an in-band filter here (EVM metadata carries no marketplace field; see the
 * file header). Silent suppression here would be unrecoverable loss, the worse failure. mint/burn
 * (zero-address) legs are classified by zero-address precedence regardless of any sale row.
 *
 * MINOR-5 (degenerate input): on-chain logIndex is unique per tx, so the min-logIndex carrier is
 * unique. Two non-zero matched legs with an identical logIndex (a reorg/projection artifact) would
 * both satisfy the carrier test → two sales; that is upstream/S4-dedup's responsibility (the
 * content-addressed event_id per §4 is the real guard), not this 1:1 pure mapper's.
 *
 * Returns one Either PER LEG, in input order.
 */
export function mapEvmLegs(
  legs: readonly EvmTransferLeg[],
  sales: readonly EvmSaleRow[],
  ctx: EvmCollectionContext,
): ReadonlyArray<Either.Either<NftActivity, SchemaInvalid>> {
  const saleIndex = indexSalesByLeg(sales);
  // Deterministic carrier per (tx, tokenId): the MIN-logIndex non-zero leg matched to a sale.
  const carrierLogIndex = new Map<string, number>();
  for (const leg of legs) {
    const key = saleKey(leg.txHash, leg.tokenId);
    if (!saleIndex.has(key)) continue;
    if (leg.from.toLowerCase() === ZERO_ADDRESS || leg.to.toLowerCase() === ZERO_ADDRESS) continue;
    const cur = carrierLogIndex.get(key);
    if (cur === undefined || leg.logIndex < cur) carrierLogIndex.set(key, leg.logIndex);
  }
  return legs.map((leg) => {
    const key = saleKey(leg.txHash, leg.tokenId);
    const matched = saleIndex.get(key) ?? null;
    const isCarrier =
      matched !== null &&
      carrierLogIndex.get(key) === leg.logIndex &&
      leg.from.toLowerCase() !== ZERO_ADDRESS &&
      leg.to.toLowerCase() !== ZERO_ADDRESS;
    // carrier → sale; any other matched non-zero leg → transfer (matched=null); zero-address → mint/burn.
    return mapEvmLeg(leg, ctx, isCarrier ? matched : null);
  });
}

/**
 * Sale rows with NO matching non-zero transfer leg in this batch. Leg-driven emission silently
 * omits these (a sale whose Transfer fell outside the backfill window), so the S4 layer that feeds
 * the mapper SHOULD log/reconcile `sales.length - emitted_sales` (MINOR-3 observability). Pure +
 * testable; the mapper itself never emits an orphan sale.
 */
export function findOrphanSales(
  legs: readonly EvmTransferLeg[],
  sales: readonly EvmSaleRow[],
): readonly EvmSaleRow[] {
  const legKeys = new Set(
    legs
      .filter((l) => l.from.toLowerCase() !== ZERO_ADDRESS && l.to.toLowerCase() !== ZERO_ADDRESS)
      .map((l) => saleKey(l.txHash, l.tokenId)),
  );
  return sales.filter((s) => !legKeys.has(saleKey(s.txHash, s.tokenId)));
}
