/*
 * nft-collection-source.test.ts — unit coverage for the SVM NFT-collection ownership pipe.
 *
 * Pure parsing (parseAsset, incl. delegate), DAS pagination + health probe (mocked fetch), and the
 * indexSnapshot COUNT→upsert→reconcile flow incl. BOTH wipe guards (0-member + proportional/partial).
 * No live RPC/Hasura.
 *
 * PYTH-1 real-fixture coverage: a REAL captured Helius getAssetsByGroup response (5 Pythenians items,
 * all carrying a resolved ipfs.pythenians.xyz image) drives parseAsset + toRows — the write-half seam
 * test. A hand-authored fixture asserted against itself is the tautology that let Pythenians 404
 * unnoticed for months (see feedback_test-the-seam-not-the-stub); this fixture is production data.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_DAS_FIXTURE: { result: { items: DasAsset[] } } = JSON.parse(
  readFileSync(join(HERE, "fixtures", "pyth-das-getassetsbygroup.json"), "utf8"),
);

const asset = (over: Partial<DasAsset> & { id: string }): DasAsset => ({
  ownership: { owner: "OWNER" },
  content: { metadata: { name: "Pythian #1" } },
  compression: { compressed: false },
  ...over,
});

describe("parseAsset", () => {
  it("maps a DAS asset to a member (delegate null when absent)", () => {
    expect(parseAsset(asset({ id: "MINT1" }))).toEqual({
      nftMint: "MINT1",
      owner: "OWNER",
      delegate: null,
      name: "Pythian #1",
      image: null,
      uri: null,
      compressed: false,
    });
  });
  it("carries the delegate when present (e.g. an escrowless listing)", () => {
    const m = parseAsset({ id: "MINT1", ownership: { owner: "OWNER", delegate: "MARKETPLACE" } });
    expect(m).toMatchObject({ nftMint: "MINT1", owner: "OWNER", delegate: "MARKETPLACE" });
  });
  it("drops burnt assets", () => {
    expect(parseAsset(asset({ id: "MINT1", burnt: true }))).toBeNull();
  });
  it("drops assets missing an owner", () => {
    expect(parseAsset({ id: "MINT1", ownership: {} })).toBeNull();
  });
  it("flags compressed NFTs and tolerates a missing name", () => {
    const m = parseAsset({ id: "MINT2", ownership: { owner: "W" }, compression: { compressed: true } });
    expect(m).toEqual({ nftMint: "MINT2", owner: "W", delegate: null, name: null, image: null, uri: null, compressed: true });
  });

  // PYTH-1: maps content.links.image (resolved image URL) + content.json_uri (canonical metadata
  // pointer) — nullable when absent, never fabricated.
  it("maps image from content.links.image and uri from content.json_uri when present", () => {
    const m = parseAsset({
      id: "MINT3",
      ownership: { owner: "W" },
      content: { json_uri: "https://ipfs.pythenians.xyz/metadata/1.json", links: { image: "https://ipfs.pythenians.xyz/nft/abc.png" } },
    });
    expect(m).toMatchObject({ image: "https://ipfs.pythenians.xyz/nft/abc.png", uri: "https://ipfs.pythenians.xyz/metadata/1.json" });
  });
  it("publishes null (never fabricates) when content.links.image / content.json_uri are absent", () => {
    const m = parseAsset({ id: "MINT4", ownership: { owner: "W" } });
    expect(m).toMatchObject({ image: null, uri: null });
  });

  // The write-half seam test: feed parseAsset the REAL captured Helius getAssetsByGroup response
  // (not a hand-authored fixture) and assert every item's image/uri thread through. This is the
  // exact shape sonar receives in production — if the field mapping breaks (wrong path, typo,
  // dropped optional chain), this fails; a fixture asserted against itself would not have caught it.
  it("PYTH-1: threads image + uri through for every item in the real captured DAS fixture", () => {
    const items = REAL_DAS_FIXTURE.result.items;
    expect(items.length).toBe(5); // sanity: the fixture is the real 5-item capture, not empty/truncated
    for (const item of items) {
      const m = parseAsset(item);
      expect(m).not.toBeNull();
      expect(m!.image).toMatch(/^https:\/\/ipfs\.pythenians\.xyz\/nft\/.+\.png$/);
      expect(m!.uri).toMatch(/^https:\/\/ipfs\.pythenians\.xyz\/metadata\/\d+\.json$/);
      // the resolved image URL must come from content.links.image, not be re-derived/guessed
      expect(m!.image).toBe(item.content!.links!.image);
      expect(m!.uri).toBe(item.content!.json_uri);
    }
  });
});

describe("DasNftCollectionSource", () => {
  it("paginates getAssetsByGroup then reads the slot", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { items: [asset({ id: "A" }), asset({ id: "B" })] } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { items: [asset({ id: "C", burnt: true })] } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 777 }) });
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

  it("health() probes getAssetsByGroup (not getSlot) so a non-DAS RPC reports unhealthy", async () => {
    const okMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ result: { items: [] } }) });
    vi.stubGlobal("fetch", okMock);
    expect((await new DasNftCollectionSource("https://helius", "pyTh").health()).ok).toBe(true);
    expect(JSON.parse((okMock.mock.calls[0][1] as any).body).method).toBe("getAssetsByGroup");

    const errMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ error: { code: -32601, message: "Method not found" } }) });
    vi.stubGlobal("fetch", errMock);
    const h = await new DasNftCollectionSource("https://public-non-das", "pyTh").health();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/getAssetsByGroup/);
  });

  it("surfaces a non-2xx HTTP status instead of an opaque json error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 429, text: async () => "rate limited" }));
    await expect(new DasNftCollectionSource("https://helius", "pyTh").snapshot()).rejects.toThrow(/HTTP 429/);
  });
});

describe("indexSnapshot", () => {
  const sourceWith = (members: CollectionSnapshot["members"], slot = 200): NftCollectionSource => ({
    snapshot: async () => ({ collectionMint: "pyTh", slot, source: "das", members }),
    health: async () => ({ ok: true, detail: "" }),
  });
  const member = (nftMint: string, owner: string) => ({ nftMint, owner, delegate: null, name: null, image: null, uri: null, compressed: false });

  it("skips everything (incl. the COUNT query) when the snapshot is empty (no wipe)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await indexSnapshot(sourceWith([], 222), "pythians", "2026-06-23T00:00:00.000Z");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toEqual({ upserted: 0, removed: 0, slot: 222 });
  });

  it("upserts members then reconciles by run marker (updated_at)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { svm_collection_nft_aggregate: { aggregate: { count: 3 } } } }) }) // COUNT
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { insert_svm_collection_nft: { affected_rows: 2 } } }) }) // UPSERT
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { delete_svm_collection_nft: { affected_rows: 4 } } }) }); // RECONCILE
    vi.stubGlobal("fetch", fetchMock);

    const res = await indexSnapshot(sourceWith([member("A", "W1"), member("B", "W2")], 333), "pythians", "2026-06-23T00:00:00.000Z");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const reconcileBody = JSON.parse((fetchMock.mock.calls[2][1] as any).body);
    expect(reconcileBody.variables).toEqual({ ck: "pythians", runIso: "2026-06-23T00:00:00.000Z" });
    expect(res).toEqual({ upserted: 2, removed: 4, slot: 333 });
  });

  it("REFUSES to reconcile a partial read that shrinks holders below the ratio (B2)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { svm_collection_nft_aggregate: { aggregate: { count: 100 } } } }) }) // COUNT: 100 exist
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { insert_svm_collection_nft: { affected_rows: 2 } } }) }); // UPSERT only
    vi.stubGlobal("fetch", fetchMock);

    // 2 members vs 100 existing (< 50%) → reconcile must be skipped (no 3rd/delete call).
    const res = await indexSnapshot(sourceWith([member("A", "W1"), member("B", "W2")], 444), "pythians", "2026-06-23T00:00:00.000Z");

    expect(fetchMock).toHaveBeenCalledTimes(2); // COUNT + UPSERT, NO reconcile
    expect(res).toEqual({ upserted: 2, removed: 0, slot: 444 });
  });
});

describe("toRows", () => {
  it("keys rows on the NFT mint and carries owner + delegate + collection + image + uri", () => {
    const snap: CollectionSnapshot = {
      collectionMint: "pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru",
      slot: 100,
      source: "das",
      members: [
        {
          nftMint: "MINT1",
          owner: "Alice",
          delegate: "Market",
          name: "Pythian #1",
          image: "https://ipfs.pythenians.xyz/nft/abc.png",
          uri: "https://ipfs.pythenians.xyz/metadata/1.json",
          compressed: false,
        },
      ],
    };
    expect(toRows(snap, "pythians", "2026-06-23T00:00:00.000Z")).toEqual([
      {
        id: "MINT1",
        collection_key: "pythians",
        collection_mint: "pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru",
        nft_mint: "MINT1",
        owner: "Alice",
        delegate: "Market",
        name: "Pythian #1",
        image: "https://ipfs.pythenians.xyz/nft/abc.png",
        uri: "https://ipfs.pythenians.xyz/metadata/1.json",
        compressed: false,
        slot: 100,
        source: "das",
        updated_at: "2026-06-23T00:00:00.000Z",
      },
    ]);
  });

  // PYTH-1 write-half seam test: real captured DAS items → parseAsset → toRows, asserting the
  // PRODUCED ROW (what actually gets upserted to Hasura) carries image/uri — not just the
  // intermediate CollectionMember. This is the exact seam that broke silently before (the read half
  // — parseAsset — could be right while the row-mapping still drops a field on the way to the wire).
  it("PYTH-1: real DAS fixture → parseAsset → toRows produces upsert-ready rows with image + uri", () => {
    const items = REAL_DAS_FIXTURE.result.items;
    const members = items.map(parseAsset).filter((m): m is NonNullable<typeof m> => m !== null);
    expect(members).toHaveLength(5);
    const snap: CollectionSnapshot = { collectionMint: "pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru", slot: 999, source: "das", members };
    const rows = toRows(snap, "pythians", "2026-07-13T00:00:00.000Z");
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.image).toMatch(/^https:\/\/ipfs\.pythenians\.xyz\/nft\/.+\.png$/);
      expect(row.uri).toMatch(/^https:\/\/ipfs\.pythenians\.xyz\/metadata\/\d+\.json$/);
    }
  });
});
