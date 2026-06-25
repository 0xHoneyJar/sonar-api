/**
 * map-svm.ts — pure normalization: sonar's SVM `CollectionEvent` → the canonical,
 * chain-agnostic `NftActivity` (SDD §2; cycle canonical-event-normalization).
 *
 * PURE: no network, no Effect runtime — returns `Either<NftActivity, SchemaInvalid>`.
 * SCHEMA-validity is guaranteed by decoding the candidate through `NftActivitySchema`
 * (the single shared contract in @0xhoneyjar/events): a schema-malformed activity
 * never reaches downstream; bad / drifted source data surfaces as a typed
 * {@link SchemaInvalid} on the left.
 *
 * It does NOT enforce semantic verb×field CONVENTIONS (mint⇒from=null, burn⇒to=null,
 * sale⇒both parties set): `NftActivitySchema` deliberately leaves `from`/`to`
 * independently nullable, so `mapSvm` RELIES on sonar's SVM source already upholding
 * those conventions (an unresolved sale with null parties is schema-valid and passes
 * through — a source data-quality concern, not a mapper guard).
 *
 * SVM specifics are folded in HERE so the consumer never branches on chain:
 *  - `value` is the lamport price as a DECIMAL STRING (never a float) + `decimals=9`.
 *  - `verb` IS `event.kind` — sonar's SVM source already classified mint/transfer/sale/burn.
 *  - `from`/`to` are owner-level (Helius resolves ATAs to owners; sale carries seller/buyer).
 */
import { Schema as S, TreeFormatter } from "@effect/schema";
import { Either } from "effect";
import { NftActivitySchema, type NftActivity } from "@0xhoneyjar/events";
import type { CollectionEvent } from "../svm/collection-event-source";
import { SchemaInvalid } from "./errors";

/** SOL is denominated in lamports — 9 decimals. */
const LAMPORT_DECIMALS = 9;

const decodeActivity = S.decodeUnknownEither(NftActivitySchema);

/** Per-collection context the `CollectionEvent` itself doesn't carry (the source is per-collection). */
export interface SvmCollectionContext {
  /** Topic-segment slug (`/^[a-z][a-z0-9-]*$/`), e.g. "pythians" / "genesis-stones". */
  readonly collectionKey: string;
  /** base58 collection mint (the on-chain collection identity). */
  readonly collectionMint: string;
}

/**
 * Map one SVM `CollectionEvent` to a validated `NftActivity`.
 *
 * Returns `Either.left(SchemaInvalid)` when the source data can't form a valid
 * canonical activity: a non-positive block time, a non-integer / negative lamport
 * price, or any `NftActivitySchema` rejection (e.g. a collection_key that isn't a
 * legal topic segment).
 */
export function mapSvm(
  event: CollectionEvent,
  ctx: SvmCollectionContext,
): Either.Either<NftActivity, SchemaInvalid> {
  // A real on-chain event always has a positive block time. Two failure modes,
  // both surfaced as a typed left rather than allowed downstream:
  //  - blockTime <= 0 maps to 1970-01-01 — which toISOString() renders and the
  //    ISO-8601 schema would ACCEPT — a bogus timestamp into the chain.
  //  - blockTime beyond ~8.64e12 s overflows JS Date's ±8.64e15 ms range, so
  //    new Date(...).toISOString() THROWS a RangeError that would escape the
  //    Either/no-throw contract (SDD §2). Number.isInteger also rejects
  //    NaN / Infinity / fractional seconds.
  const tsMs = event.blockTime * 1000;
  if (!Number.isInteger(event.blockTime) || event.blockTime <= 0 || Number.isNaN(new Date(tsMs).getTime())) {
    return Either.left(
      new SchemaInvalid({
        reason: `out-of-range blockTime ${event.blockTime} for mint ${event.nftMint} (tx ${event.txSignature})`,
      }),
    );
  }

  const hasPrice = event.price !== null;
  // Lamports are integers; guard so `value` stays a clean decimal string and never
  // renders as "3.087e9" / a fractional that the schema's /^\d+$/ would reject.
  if (hasPrice && (!Number.isInteger(event.price as number) || (event.price as number) < 0)) {
    return Either.left(
      new SchemaInvalid({
        reason: `non-integer or negative lamport price ${event.price} for mint ${event.nftMint} (tx ${event.txSignature})`,
      }),
    );
  }

  const candidate = {
    verb: event.kind,
    chain: "svm",
    collection_key: ctx.collectionKey,
    asset_ref: event.nftMint,
    from: event.from,
    to: event.to,
    value: hasPrice ? String(event.price) : null,
    decimals: hasPrice ? LAMPORT_DECIMALS : null,
    tx: event.txSignature,
    timestamp: new Date(tsMs).toISOString(),
    metadata: {
      chain: "svm",
      collection_mint: ctx.collectionMint,
      nft_mint: event.nftMint,
      instruction_index: event.instructionIndex,
      slot: event.slot,
      // marketplace is sale-only + optional — include only when present.
      ...(event.marketplace !== null ? { marketplace: event.marketplace } : {}),
    },
  };

  return Either.mapLeft(
    decodeActivity(candidate),
    (parseError) =>
      new SchemaInvalid({
        reason: `NftActivity decode failed for mint ${event.nftMint} (verb ${event.kind}): ${TreeFormatter.formatErrorSync(parseError)}`,
        parseError,
      }),
  );
}
