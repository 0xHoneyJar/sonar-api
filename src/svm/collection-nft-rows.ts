/**
 * Shared persistence projection for SVM collection NFT ownership snapshots.
 *
 * Both the Pythians ownership indexer and the collection-resolver DAS normalize
 * path MUST use this projector so resolve-probe proofs exercise the same
 * `svm.collection_nft` row shape the indexer upserts (id, slot, mint, owner,
 * delegate, URI/metadata, compression).
 */

import type { CollectionSnapshot } from "./nft-collection-source.js";

/** Hasura upsert row for `svm.collection_nft` (keyed on NFT mint). */
export type NftRow = {
  id: string; // nft mint
  collection_key: string;
  collection_mint: string;
  nft_mint: string;
  owner: string;
  delegate: string | null;
  name: string | null;
  image: string | null;
  uri: string | null;
  compressed: boolean;
  slot: number;
  source: string;
  updated_at: string;
};

/**
 * Map an ownership snapshot to Hasura rows (keyed on the NFT mint).
 * Does not fabricate owners — each member's `owner` is required by
 * `CollectionMember` and by `parseAsset` (missing owner → null member).
 */
export function toRows(
  snap: CollectionSnapshot,
  collectionKey: string,
  nowIso: string,
): NftRow[] {
  return snap.members.map((m) => ({
    id: m.nftMint,
    collection_key: collectionKey,
    collection_mint: snap.collectionMint,
    nft_mint: m.nftMint,
    owner: m.owner,
    delegate: m.delegate,
    name: m.name,
    image: m.image,
    uri: m.uri,
    compressed: m.compressed,
    slot: snap.slot,
    source: snap.source,
    updated_at: nowIso,
  }));
}
