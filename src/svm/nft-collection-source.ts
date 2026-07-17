/**
 * nft-collection-source.ts — the SVM substrate SEAM for NFT-collection per-token OWNERSHIP.
 *
 * Sibling of stone-source.ts (genesis stones). For a Metaplex Certified Collection, the indexer reads
 * an ownership SNAPSHOT (every member NFT → its current holder) from an `NftCollectionSource` and
 * never learns the substrate. v1 = Helius DAS (`getAssetsByGroup` on the collection — handles regular
 * AND compressed NFTs and returns the owner directly); `HyperSyncNftCollectionSource` swaps in behind
 * the SAME interface when Solana HyperSync ships the account/instruction handlers it lacks today
 * (2026-06-20-svm-substrate-finding.md).
 *
 * Pythenians = the Metaplex collection mint `pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru` (on-chain name
 * "Pythenians" / $PTN; classic SPL mint, supply 1, decimals 0 — grounded on-chain 2026-06-23). Generic
 * on the collection: any collection is indexed by changing the indexer's CONFIG constants.
 *
 * Ownership is CURRENT-STATE (who holds which NFT now), so the source returns the full member set at a
 * slot and the indexer reconciles (see pythians-collection-indexer.ts).
 *
 * ESCROW/STAKING CAVEAT (BB review H1): DAS `ownership.owner` is the on-chain token-account owner. For
 * escrow-style marketplace listings and most staking programs the NFT sits in a program PDA, so `owner`
 * is the marketplace/vault, not the human lister/staker. We surface BOTH `owner` and `delegate` so a
 * downstream consumer can decide; resolving escrow PDAs back to the lister is a future enhancement.
 */

import { classifyRpcMethod, meter } from "./helius-meter";

/** One NFT in the collection + its current holder. */
export interface CollectionMember {
  readonly nftMint: string; // base58 NFT mint (the entity key)
  readonly owner: string; // base58 token-account owner (may be an escrow/stake PDA — see caveat)
  readonly delegate: string | null; // base58 delegate, if any (often the real lister for escrowless listings)
  readonly name: string | null;
  readonly image: string | null; // resolved image URL (content.links.image — Helius resolves this server-side; PYTH-1)
  readonly uri: string | null; // canonical metadata pointer (content.json_uri; PYTH-1)
  readonly compressed: boolean; // Bubblegum cNFT vs regular
}

/** A full current-state ownership snapshot for one collection at one slot. */
export interface CollectionSnapshot {
  readonly collectionMint: string;
  readonly slot: number;
  readonly source: "das" | "hypersync";
  readonly members: readonly CollectionMember[];
}

export interface SourceHealth {
  readonly ok: boolean;
  readonly detail: string;
}

/** The SEAM. Any substrate (DAS today, HyperSync tomorrow) implements this. */
export interface NftCollectionSource {
  snapshot(): Promise<CollectionSnapshot>;
  health(): Promise<SourceHealth>;
}

// ── pure parsing (no network — unit-testable) ───────────────────────────────

/** A Metaplex DAS asset (the subset we read). */
export interface DasAsset {
  id?: string;
  burnt?: boolean;
  ownership?: { owner?: string; delegate?: string | null };
  content?: { metadata?: { name?: string }; json_uri?: string; links?: { image?: string } };
  compression?: { compressed?: boolean };
}

/** Map a DAS asset to a CollectionMember, or null if it's burnt / missing required fields. */
export function parseAsset(asset: DasAsset | null | undefined): CollectionMember | null {
  if (!asset || asset.burnt) return null;
  const nftMint = asset.id;
  const owner = asset.ownership?.owner;
  if (!nftMint || !owner) return null;
  return {
    nftMint,
    owner,
    delegate: asset.ownership?.delegate ?? null,
    name: asset.content?.metadata?.name ?? null,
    // content.links.image is Helius' server-side-resolved image URL (primary); content.json_uri is the
    // canonical metadata pointer. Both nullable — a burnt/odd asset may lack them; never fabricate (PYTH-1).
    image: asset.content?.links?.image ?? null,
    uri: asset.content?.json_uri ?? null,
    compressed: Boolean(asset.compression?.compressed),
  };
}

// ── v1 DAS substrate ────────────────────────────────────────────────────────

/** Page-based pagination safety valve — fail BEFORE any reconcile rather than loop/OOM (BB review M2). */
const MAX_PAGES = 5000; // 5000 × 1000 = 5M NFTs; far above Pythenians, and below Helius' page*limit ceiling

/**
 * v1 — Helius DAS substrate. Pages `getAssetsByGroup(collection)` for verified members + owners, then
 * reads the snapshot slot. Requires a DAS-capable RPC (Helius via SOLANA_RPC_URL) — `getAssetsByGroup`
 * is a DAS extension, not a core RPC method; `health()` probes it directly (BB review H2).
 */
export class DasNftCollectionSource implements NftCollectionSource {
  constructor(
    private readonly rpcUrl: string,
    readonly collectionMint: string,
    private readonly pageLimit = 1000,
  ) {}

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    meter(classifyRpcMethod(method), method); // count the attempt even when it goes on to fail — KF-018 runs burn credits, then die
    const res = await /* @non-metadata-fetch collection RPC */ fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "sonar", method, params }),
      signal: AbortSignal.timeout(30_000), // hung-socket guard (run 28736768956 lesson)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${method}: HTTP ${res.status} ${body.slice(0, 200)}`); // surface 429/5xx/auth clearly (BB L1)
    }
    const d = (await res.json()) as { result?: T; error?: unknown };
    if (d.error) throw new Error(`${method}: ${JSON.stringify(d.error)}`);
    return d.result as T;
  }

  async snapshot(): Promise<CollectionSnapshot> {
    const members: CollectionMember[] = [];
    for (let page = 1; ; page++) {
      const r = await this.rpc<{ items?: DasAsset[] }>("getAssetsByGroup", {
        groupKey: "collection",
        groupValue: this.collectionMint,
        page,
        limit: this.pageLimit,
      });
      const items = r?.items ?? [];
      for (const a of items) {
        const m = parseAsset(a);
        if (m) members.push(m);
      }
      if (items.length < this.pageLimit) break; // short/last page
      if (page >= MAX_PAGES) {
        throw new Error(`getAssetsByGroup exceeded ${MAX_PAGES} pages for ${this.collectionMint} — aborting before any write (switch to cursor pagination for a collection this large)`);
      }
    }
    const slot = await this.rpc<number>("getSlot", []);
    return { collectionMint: this.collectionMint, slot, source: "das", members };
  }

  async health(): Promise<SourceHealth> {
    // Probe the DAS surface SPECIFICALLY. getSlot succeeds on any RPC (incl. non-DAS public endpoints),
    // so it would falsely report healthy on the default endpoint and let snapshot() throw later (H2).
    try {
      await this.rpc<{ items?: DasAsset[] }>("getAssetsByGroup", {
        groupKey: "collection",
        groupValue: this.collectionMint,
        page: 1,
        limit: 1,
      });
      return { ok: true, detail: "das getAssetsByGroup reachable" };
    } catch (e) {
      return { ok: false, detail: `das getAssetsByGroup unavailable (need a Helius/DAS RPC): ${(e as Error).message}` };
    }
  }
}

/**
 * FUTURE — HyperSync substrate. Stubbed deliberately (mirrors HyperSyncStoneSource). Implement against
 * the firehose once Solana HyperSync ships token-account/Bubblegum state — the indexer needs ZERO
 * change (the seam paying off).
 */
export class HyperSyncNftCollectionSource implements NftCollectionSource {
  async snapshot(): Promise<CollectionSnapshot> {
    throw new Error("HyperSyncNftCollectionSource: not yet — Solana HyperSync lacks NFT-ownership handlers (see SVM finding). Swap in when GA.");
  }
  async health(): Promise<SourceHealth> {
    return { ok: false, detail: "hypersync-svm: not GA for NFT ownership (stub)" };
  }
}
