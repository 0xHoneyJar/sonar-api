/**
 * collection-registry.ts — the generic SVM NFT-collection registry (cycle svm-collection-events, Sprint 4).
 *
 * The schema / parser / writer are already collection_key-keyed (generic), so onboarding a new SVM NFT
 * collection to the event index is a CONFIG entry here + a backfill run (`--collection <key>`), NOT new
 * code. Pythenians is the first entry; the next collection is one line below.
 *
 * NOTE (per SDD §4.4 / FAGAN): the current backfill walks the mint's Enhanced address-history, which is
 * complete for ProgrammableNonFungible (pNFT) collections like Pythenians. Before adding a CLASSIC-SPL or
 * COMPRESSED collection, confirm coverage via the §4.5 reconciliation gate (compressed needs
 * getSignaturesForAsset + Bubblegum; classic-SPL with raw Transfers needs token-account tracing).
 */
import { PYTHIANS_COLLECTION } from "./pythians-collection-indexer";

export interface CollectionConfig {
  // ── INFRA ID layer (stable, opaque) — never rename; consumers (score-api) query by it ──
  readonly collectionKey: string; // the generic key written to svm.collection_event.collection_key
  readonly collectionMint: string; // the Metaplex collection mint (DAS getAssetsByGroup groupValue)
  // ── PRESENTATION layer (the single source of truth for naming) — derive ALL display from here ──
  readonly displayName: string; // canonical human name (on-chain Metaplex `name`); never re-type elsewhere
  readonly symbol: string; // on-chain symbol
  // ── OWNERSHIP — drives the attestation model ──
  // "external" = not owned by us (the scale case): labels come from CHAIN + RESEARCH only, no operator
  //   insider attestation. "registered" = a team registered + may operator-attest (sign) their own addresses.
  readonly ownership: "external" | "registered";
}

export const COLLECTIONS: Readonly<Record<string, CollectionConfig>> = {
  // Pythenians ($PTN) — first GTM collection. The KEY stays the stable opaque id "pythians"; the NAME is
  // "Pythenians" (chain-confirmed) and lives ONLY here. external = chain+research labels, no insider attestation.
  pythians: { collectionKey: "pythians", collectionMint: PYTHIANS_COLLECTION, displayName: "Pythenians", symbol: "$PTN", ownership: "external" },
  // next: "<key>": { collectionKey, collectionMint, displayName, symbol, ownership },
};

export const DEFAULT_COLLECTION_KEY = "pythians";

/** Resolve a collection by key (whitespace-trimmed); throws (listing known keys) on an unknown key. */
export function resolveCollection(key: string): CollectionConfig {
  const c = COLLECTIONS[key.trim()]; // trim — a trailing space in a YAML/Railway env is an easy footgun (FAGAN NIT)
  if (!c) {
    throw new Error(
      `unknown collection '${key}' — add it to COLLECTIONS in collection-registry.ts (known: ${Object.keys(COLLECTIONS).join(", ")})`,
    );
  }
  return c;
}
