/**
 * classify-from-events.ts — own-indexed entity classification from svm_collection_event (SDD §6, T4.5).
 *
 * The cheapest, no-Helius reconcile source: our OWN indexed rows. An address that BOTH receives and sends
 * many NFTs of a collection is a marketplace escrow (NFT in to list, out to delist/sell); an address that
 * sends many but receives ~none is a distributor/airdrop (post-mint fan-out). Pure function over the
 * aggregated counts — verified on the Pythenians fixture (ME 1BWutm…: to 4067/from 1653 → escrow;
 * Tensor 4zdNG…: to 2918/from 1596 → escrow; pyThKE…: from 3182/to ~0 → distributor).
 */
import type { EntityType, LabelMethod } from "./types";

export interface AddrFlow {
  address: string;
  toCount: number; // NFTs received (transfer `to` this address)
  fromCount: number; // NFTs sent (transfer `from` this address)
}

export interface Classified {
  address: string;
  entityType: EntityType;
  method: LabelMethod; // always "own-indexed"
  patternStrength: number; // 0..1 → confidence
}

export interface ClassifyOpts {
  minFlow?: number; // ignore low-volume addresses (default 100)
  distributorInflowRatio?: number; // toCount < fromCount × this ⇒ distributor (default 0.2)
  strengthScale?: number; // count at which patternStrength saturates to 1 (default 4000)
}

/** Classify one address by its flow, or null if it doesn't match a structural pattern. */
export function classifyAddress(f: AddrFlow, opts: ClassifyOpts = {}): Classified | null {
  const minFlow = opts.minFlow ?? 100;
  const ratio = opts.distributorInflowRatio ?? 0.2;
  const scale = opts.strengthScale ?? 4000;
  const both = Math.min(f.toCount, f.fromCount);
  const total = f.toCount + f.fromCount;
  const strength = Math.max(0, Math.min(1, total / scale));

  if (f.toCount >= minFlow && f.fromCount >= minFlow && both >= minFlow) {
    return { address: f.address, entityType: "marketplace_escrow", method: "own-indexed", patternStrength: strength };
  }
  if (f.fromCount >= minFlow && f.toCount < f.fromCount * ratio) {
    return { address: f.address, entityType: "distributor", method: "own-indexed", patternStrength: strength };
  }
  return null;
}

/** Classify a batch (e.g. top-N from/to ranked from svm_collection_event), dropping non-matches. */
export function classifyFlows(flows: AddrFlow[], opts?: ClassifyOpts): Classified[] {
  return flows.map((f) => classifyAddress(f, opts)).filter((c): c is Classified => c !== null);
}
