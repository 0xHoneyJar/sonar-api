/**
 * parity.ts — the EXECUTABLE S5 consumer-parity gate (SDD §8.5), shipped INERT ahead of the handshake.
 *
 * The S5 gate is the cross-building checkpoint: before ANY go-live, the canonical NftActivity stream
 * (this producer) must be shown to COVER what the score-mibera consumer's CURRENT fetchers produce —
 * dedup-keyed by (tx, asset_ref, verb), the §4 consumer dedup identity. This module turns that gate
 * from a prose checklist into a PURE function the handshake runs against REAL data: no network, no
 * emit, no live dependency — it compares two key-sets and reports.
 *
 * SCOPE — PRESENCE parity, NOT field-value parity (MAJOR-2). This checks (tx, asset_ref, verb) key
 * PRESENCE. A `matched` key whose re-derived `from`/`to`/`value` DIFFERS between canonical and legacy
 * is still reported as matched (`valueParityChecked: false`). That matters because map-evm RE-DERIVES
 * the sale seller/buyer/price (a port of score-api `fetchMiberaBuyers/Sellers`) — a re-implementation
 * can diverge, and the consumer scores on those resolved values. So a GREEN here means "canonical
 * covers the consumer's (tx,asset_ref,verb) tuples", NOT "canonical faithfully replaces legacy".
 * Value-parity over `matched` (esp. sale parties/price) is a SEPARATE handshake step — the legacy
 * input here is key-only.
 *
 * The contract it enforces:
 *  - Parity HOLDS iff `legacyOnly` is EMPTY — the canonical stream loses NOTHING the consumer relies
 *    on (the cardinal-sin / silent-loss guard, at the consumer boundary).
 *  - `canonicalOnly` is the producer's EXTRA emits — including the KNOWN MAJOR-3 market-routing-hop
 *    `verb=transfer` over-emits. These do NOT break parity; surfaced + quantified by verb so the S5
 *    handshake DECIDES (tolerate / suppress with real topology). BUT: read `verbDisagreements` FIRST —
 *    a canonicalOnly entry whose (tx,asset_ref) is in a disagreement is a MISCLASSIFICATION, not a
 *    tolerable over-emit (MAJOR-1).
 *  - `verbDisagreements` (MAJOR-1): the same (tx, asset_ref) classified DIFFERENTLY by each side —
 *    e.g. a sale the producer demoted to a transfer (map-evm MINOR-1's leading-zero join-miss). These
 *    are real losses (the legacy verb is in `legacyOnly`, so `parityHolds` is already false), named
 *    separately so a demoted sale can never hide among the tolerable routing-hop transfers.
 *
 * Pairs with map-evm.ts / map-svm.ts (the producers of `canonical`) — see SDD §8.5 S5 checklist.
 */
import type { NftActivity } from "@0xhoneyjar/events";

/** The §4 consumer dedup identity: one logical activity per (tx, asset_ref, verb). */
export interface ParityKey {
  readonly tx: string;
  readonly asset_ref: string;
  readonly verb: string;
}

/** Collision-proof composite key — JSON-encoded, so a `|`/`,`/quote inside an opaque tx or asset_ref
 *  (both are schema-`minLength(1)`-only, and the legacy side is externally-sourced + unvalidated)
 *  cannot shift the boundary and false-merge two distinct tuples (which would mask a loss → false GREEN). */
export function parityKey(k: ParityKey): string {
  return JSON.stringify([k.tx, k.asset_ref, k.verb]);
}

export function activityParityKey(a: NftActivity): string {
  return parityKey({ tx: a.tx, asset_ref: a.asset_ref, verb: a.verb });
}

/** A per-(tx,asset_ref) verb misclassification: the asset+tx is on BOTH sides but classified differently. */
export interface VerbDisagreement {
  readonly tx: string;
  readonly asset_ref: string;
  readonly canonicalVerbs: readonly string[];
  readonly legacyVerbs: readonly string[];
}

export interface ParityReport {
  /** keys present in BOTH canonical + legacy (the overlap — parity core). Presence only (see SCOPE). */
  readonly matched: readonly string[];
  /** keys in canonical but NOT legacy — producer extras (routing-hop over-emits / genuinely-new / a
   *  disagreement's canonical side — cross-ref `verbDisagreements`). */
  readonly canonicalOnly: readonly string[];
  /** keys in legacy but NOT canonical — PARITY FAILURES (data the consumer relies on that canonical lost). */
  readonly legacyOnly: readonly string[];
  /** parity HOLDS iff the canonical stream loses nothing legacy has (legacyOnly empty). */
  readonly parityHolds: boolean;
  /** canonicalOnly broken down by verb — the routing-hop transfer over-emit, visible + quantified. */
  readonly canonicalOnlyByVerb: Readonly<Record<string, number>>;
  /** legacyOnly broken down by verb — which verbs are being LOST (the actionable failure detail). */
  readonly legacyOnlyByVerb: Readonly<Record<string, number>>;
  /** per-(tx,asset_ref) verb MISCLASSIFICATIONS (MAJOR-1) — read FIRST; not tolerable over-emits. */
  readonly verbDisagreements: readonly VerbDisagreement[];
  /** raw cardinalities — guard a vacuous GREEN on an empty/partial legacy fetch (MAJOR/MINOR-2): a
   *  trustworthy GREEN needs `matched > 0` (a real sample produced overlap) + both inputs complete. */
  readonly canonicalCount: number;
  readonly legacyCount: number;
  /** This gate is PRESENCE parity only — field-value (re-derived sale from/to/value) is NOT checked here. */
  readonly valueParityChecked: false;
}

function tallyByVerb(keys: readonly string[], verbOf: ReadonlyMap<string, string>): Record<string, number> {
  const m: Record<string, number> = {};
  for (const k of keys) {
    const v = verbOf.get(k) ?? "?";
    m[v] = (m[v] ?? 0) + 1;
  }
  return m;
}

function addVerb(map: Map<string, Set<string>>, assetKey: string, verb: string): void {
  let s = map.get(assetKey);
  if (!s) map.set(assetKey, (s = new Set()));
  s.add(verb);
}

/**
 * Compare the canonical activities against the consumer's legacy key-set. `legacy` is the consumer's
 * CURRENT (tx, asset_ref, verb) tuples (whatever its existing fetchers produce); `canonical` is what
 * this producer would emit. Returns the parity report — `parityHolds` is the go/no-go signal.
 */
export function parityReport(
  canonical: readonly NftActivity[],
  legacy: readonly ParityKey[],
): ParityReport {
  const verbOf = new Map<string, string>();
  const canonKeys = new Set<string>();
  const canonVerbsByAsset = new Map<string, Set<string>>();
  for (const a of canonical) {
    const k = activityParityKey(a);
    canonKeys.add(k);
    verbOf.set(k, a.verb);
    addVerb(canonVerbsByAsset, JSON.stringify([a.tx, a.asset_ref]), a.verb);
  }
  const legacyKeys = new Set<string>();
  const legacyVerbsByAsset = new Map<string, Set<string>>();
  for (const l of legacy) {
    const k = parityKey(l);
    legacyKeys.add(k);
    if (!verbOf.has(k)) verbOf.set(k, l.verb);
    addVerb(legacyVerbsByAsset, JSON.stringify([l.tx, l.asset_ref]), l.verb);
  }

  const matched: string[] = [];
  const canonicalOnly: string[] = [];
  for (const k of canonKeys) (legacyKeys.has(k) ? matched : canonicalOnly).push(k);
  const legacyOnly: string[] = [];
  for (const k of legacyKeys) if (!canonKeys.has(k)) legacyOnly.push(k);

  // MAJOR-1: a (tx,asset_ref) on BOTH sides whose verb-sets differ — a legacy verb missing from
  // canonical (a real loss) AND a canonical verb the legacy lacks (the differing classification).
  const verbDisagreements: VerbDisagreement[] = [];
  for (const [assetKey, legacyVerbs] of legacyVerbsByAsset) {
    const canonVerbs = canonVerbsByAsset.get(assetKey);
    if (!canonVerbs) continue; // asset absent from canonical → plain legacyOnly loss, not a disagreement
    const legacyMissing = [...legacyVerbs].some((v) => !canonVerbs.has(v));
    const canonExtra = [...canonVerbs].some((v) => !legacyVerbs.has(v));
    if (legacyMissing && canonExtra) {
      const [tx, asset_ref] = JSON.parse(assetKey) as [string, string];
      verbDisagreements.push({
        tx,
        asset_ref,
        canonicalVerbs: [...canonVerbs].sort(),
        legacyVerbs: [...legacyVerbs].sort(),
      });
    }
  }

  return {
    matched,
    canonicalOnly,
    legacyOnly,
    parityHolds: legacyOnly.length === 0,
    canonicalOnlyByVerb: tallyByVerb(canonicalOnly, verbOf),
    legacyOnlyByVerb: tallyByVerb(legacyOnly, verbOf),
    verbDisagreements,
    canonicalCount: canonKeys.size,
    legacyCount: legacyKeys.size,
    valueParityChecked: false,
  };
}
