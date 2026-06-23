/*
 * nft-collection-source.test.ts — unit coverage for the SVM NFT-collection ownership pipe.
 *
 * Pure parsing (parseAsset), DAS pagination (mocked fetch), and the indexSnapshot upsert→reconcile
 * flow incl. the empty-snapshot wipe guard. No live RPC/Hasura.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseAsset,
  DasNftCollectionSource,
  type DasAsset,
  type CollectionSnapshot,
  type NftCollectionSource,
} from "../src/svm/nft-collection-source";
import { indexSnapshot, toRows } from "../src/svm/pythians-collection-indexer";

afterEach(() => vi.unstubAllGlobals());

const asset = (over: Partial<DasAsset> & { id: string }): DasAsset => ({
  ownership: { owner: "OWNER" },
  content: { metadata: { name: "Pythian #1" } },
  compression: { compressed: false },
  ...over,
});

describe("parseAsset", () => {
  it("maps a DAS asset to a member", () => {
    expect(parseAsset(asset({ id: "MINT1" }))).toEqual({
      nftMint: "MINT1",
      owner: "OWNER",
      name: "Pythian #1",
      compressed: false,
    });
  });
  it("drops burnt assets", () => {
    expect(parseAsset(asset({ id: "MINT1", burnt: true }))).toBeNull();
  });
  it("drops assets missing an owner", () => {
    expect(parseAsset({ id: "MINT1", ownership: {} })).toBeNull();
  });
  it("flags compressed NFTs and tolerates a missing name", () => {
    const m = parseAsset({ id: "MINT2", ownership: { owner: "W" }, compression: { compressed: true } });
    expect(m).toEqual({ nftMint: "MINT2", owner: "W", name: null, compressed: true });
  });
});

describe("DasNftCollectionSource.snapshot", () => {
  it("paginates getAssetsByGroup then reads the slot", async () => {
    const fetchMock = vi
      .fn()
      // page 1 — full (== limit 2) → keep paging
      .mockResolvedValueOnce({ json: async () => ({ result: { items: [asset({ id: "A" }), asset({ id: "B" })] } }) })
      // page 2 — partial (< limit) → last page
      .mockResolvedValueOnce({ json: async () => ({ result: { items: [asset({ id: "C", burnt: true })] } }) })
      // getSlot
      .mockResolvedValueOnce({ json: async () => ({ result: 777 }) });
    vi.stubGlobal("fetch", fetchMock);

    const src = new DasNftCollectionSource("https://rpc.example", "pyTh", 2);
    const snap = await src.snapshot();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(snap.slot).toBe(777);
    expect(snap.members.map((m) => m.nftMint)).toEqual(["A", "B"]); // C burnt → dropped
    const body1 = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body1.method).toBe("getAssetsByGroup");
    expect(body1.params).toMatchObject({ groupKey: "collection", groupValue: "pyTh", page: 1, limit: 2 });
  });
});

describe("indexSnapshot", () => {
  const sourceWith = (members: CollectionSnapshot["members"], slot = 200): NftCollectionSource => ({
    snapshot: async () => ({ collectionMint: "pyTh", slot, source: "das", members }),
    health: async () => ({ ok: true, detail: "" }),
  });

  it("skips upsert AND reconcile when the snapshot is empty (no wipe)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await indexSnapshot(sourceWith([], 222), "pythians", "2026-06-23T00:00:00.000Z");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toEqual({ upserted: 0, removed: 0, slot: 222 });
  });

  it("upserts members then reconciles stale rows", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ data: { insert_svm_collection_nft: { affected_rows: 2 } } }) })
      .mockResolvedValueOnce({ json: async () => ({ data: { delete_svm_collection_nft: { affected_rows: 4 } } }) });
    vi.stubGlobal("fetch", fetchMock);

    const res = await indexSnapshot(
      sourceWith([
        { nftMint: "A", owner: "W1", name: "Pythian #1", compressed: false },
        { nftMint: "B", owner: "W2", name: null, compressed: true },
      ], 333),
      "pythians",
      "2026-06-23T00:00:00.000Z",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reconcileBody = JSON.parse((fetchMock.mock.calls[1][1] as any).body);
    expect(reconcileBody.variables).toEqual({ ck: "pythians", slot: 333 });
    expect(res).toEqual({ upserted: 2, removed: 4, slot: 333 });
  });
});

describe("toRows", () => {
  it("keys rows on the NFT mint and carries owner + collection", () => {
    const snap: CollectionSnapshot = {
      collectionMint: "pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru",
      slot: 100,
      source: "das",
      members: [{ nftMint: "MINT1", owner: "Alice", name: "Pythian #1", compressed: false }],
    };
    expect(toRows(snap, "pythians", "2026-06-23T00:00:00.000Z")).toEqual([
      {
        id: "MINT1",
        collection_key: "pythians",
        collection_mint: "pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru",
        nft_mint: "MINT1",
        owner: "Alice",
        name: "Pythian #1",
        compressed: false,
        slot: 100,
        source: "das",
        updated_at: "2026-06-23T00:00:00.000Z",
      },
    ]);
  });
});
