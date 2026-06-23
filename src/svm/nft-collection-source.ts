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
 * Pythians = the Metaplex collection mint `pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru` (classic SPL
 * mint, supply 1, decimals 0 — grounded on-chain 2026-06-23). Generic on the collection: any
 * collection is indexed by changing the indexer's CONFIG constants.
 *
 * Ownership is CURRENT-STATE (who holds which NFT now), so the source returns the full member set at a
 * slot and the indexer reconciles (see pythians-collection-indexer.ts).
 */

/** One NFT in the collection + its current holder. */
export interface CollectionMember {
  readonly nftMint: string; // base58 NFT mint (the entity key)
  readonly owner: string; // base58 holder wallet
  readonly name: string | null;
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
  ownership?: { owner?: string };
  content?: { metadata?: { name?: string } };
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
    name: asset.content?.metadata?.name ?? null,
    compressed: Boolean(asset.compression?.compressed),
  };
}

// ── v1 DAS substrate ────────────────────────────────────────────────────────

/**
 * v1 — Helius DAS substrate. Pages `getAssetsByGroup(collection)` for verified members + owners, then
 * reads the snapshot slot. Requires a DAS-capable RPC (Helius via SOLANA_RPC_URL) — `getAssetsByGroup`
 * is a DAS extension, not a core RPC method, so a plain endpoint will error in health()/snapshot().
 */
export class DasNftCollectionSource implements NftCollectionSource {
  constructor(
    private readonly rpcUrl: string,
    readonly collectionMint: string,
    private readonly pageLimit = 1000,
  ) {}

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "sonar", method, params }),
    });
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
      if (items.length < this.pageLimit) break; // last page
    }
    const slot = await this.rpc<number>("getSlot", []);
    return { collectionMint: this.collectionMint, slot, source: "das", members };
  }

  async health(): Promise<SourceHealth> {
    try {
      const slot = await this.rpc<number>("getSlot", []);
      return { ok: true, detail: `das rpc reachable @ slot ${slot}` };
    } catch (e) {
      return { ok: false, detail: `das rpc: ${(e as Error).message}` };
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
