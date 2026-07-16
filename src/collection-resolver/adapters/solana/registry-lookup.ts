/**
 * Exact-case Solana collection-mint → local SVM registry lookup.
 *
 * Never trims, folds, or lowercases mints. Enrichment is display-only and
 * never creates cross-deployment equivalence.
 */
import {
  COLLECTIONS,
  type CollectionConfig,
} from "../../../svm/collection-registry.js";

/**
 * Find a registry entry whose `collectionMint` equals `collectionMint`
 * byte-for-byte. Case mismatch is a miss.
 */
export const findCollectionByMintExact = (
  collectionMint: string,
): CollectionConfig | undefined => {
  for (const config of Object.values(COLLECTIONS)) {
    if (config.collectionMint === collectionMint) {
      return config;
    }
  }
  return undefined;
};

/** All registered collection mints (exact case) — hermetic fixture aid. */
export const listRegisteredCollectionMints = (): ReadonlyArray<string> =>
  Object.values(COLLECTIONS).map((c) => c.collectionMint);
