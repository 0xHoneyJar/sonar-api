/**
 * collection-registry.ts — the generic SVM NFT-collection registry (cycle svm-collection-events, Sprint 4).
 *
 * The schema / parser / writer are already collection_key-keyed (generic), so onboarding a new SVM NFT
 * collection to the event index is a CONFIG entry here + a backfill run (`--collection <key>`), NOT new
 * code. Pythians is the first entry; the next collection is one line below.
 *
 * NOTE (per SDD §4.4 / FAGAN): the current backfill walks the mint's Enhanced address-history, which is
 * complete for ProgrammableNonFungible (pNFT) collections like Pythians. Before adding a CLASSIC-SPL or
 * COMPRESSED collection, confirm coverage via the §4.5 reconciliation gate (compressed needs
 * getSignaturesForAsset + Bubblegum; classic-SPL with raw Transfers needs token-account tracing).
 */
import { PYTHIANS_COLLECTION } from "./pythians-collection-indexer";

export interface CollectionConfig {
  readonly collectionKey: string; // the generic key written to svm.collection_event.collection_key
  readonly collectionMint: string; // the Metaplex collection mint (DAS getAssetsByGroup groupValue)
}

export const COLLECTIONS: Readonly<Record<string, CollectionConfig>> = {
  pythians: { collectionKey: "pythians", collectionMint: PYTHIANS_COLLECTION },
  // next: "<key>": { collectionKey: "<key>", collectionMint: "<metaplex-collection-mint>" },
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
