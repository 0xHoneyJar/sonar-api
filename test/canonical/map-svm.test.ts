import { describe, it, expect } from "vitest";
import { Either } from "effect";
import { mapSvm, isCanonicalOwnershipKind, type SvmCollectionContext } from "../../src/canonical/map-svm";
import type { CollectionEvent } from "../../src/svm/collection-event-source";

const ctx: SvmCollectionContext = {
  collectionKey: "pythians",
  collectionMint: "pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru",
};

// 1738525620 → 2025-02-02T19:47:00.000Z
const BLOCK_TIME = 1738525620;
const ISO = "2025-02-02T19:47:00.000Z";

function event(overrides: Partial<CollectionEvent> = {}): CollectionEvent {
  return {
    nftMint: "JE8VKG6sUqQgzPythianMint11111111111111111111",
    kind: "transfer",
    from: "5xJewztrSeller1111111111111111111111111111",
    to: "2Y1uiDUpBuyer11111111111111111111111111111",
    instructionIndex: 0,
    price: null,
    marketplace: null,
    slot: 314801673,
    blockTime: BLOCK_TIME,
    txSignature: "65SgkNWqSigPythians1111111111111111111111111111",
    ...overrides,
  };
}

/** Narrow an Either to its Right or fail the test loudly with the left reason. */
function right(e: Either.Either<unknown, { reason: string }>) {
  if (Either.isLeft(e)) throw new Error(`expected Right, got Left: ${e.left.reason}`);
  return e.right;
}

describe("mapSvm — verb mapping", () => {
  it("maps a mint (from=null, no value/decimals, no marketplace)", () => {
    const a = right(mapSvm(event({ kind: "mint", from: null }), ctx)) as any;
    expect(a.verb).toBe("mint");
    expect(a.chain).toBe("svm");
    expect(a.collection_key).toBe("pythians");
    expect(a.asset_ref).toBe(event().nftMint);
    expect(a.from).toBeNull();
    expect(a.value).toBeNull();
    expect(a.decimals).toBeNull();
    expect(a.timestamp).toBe(ISO);
    expect(a.metadata.chain).toBe("svm");
    expect(a.metadata.collection_mint).toBe(ctx.collectionMint);
    expect(a.metadata.nft_mint).toBe(event().nftMint);
    expect(a.metadata.instruction_index).toBe(0);
    expect(a.metadata.slot).toBe(314801673);
    expect("marketplace" in a.metadata).toBe(false);
  });

  it("maps a transfer (from/to set, value null)", () => {
    const a = right(mapSvm(event({ kind: "transfer" }), ctx)) as any;
    expect(a.verb).toBe("transfer");
    expect(a.from).toBe(event().from);
    expect(a.to).toBe(event().to);
    expect(a.value).toBeNull();
  });

  it("maps a sale (decimal-string lamport value + decimals=9 + marketplace in metadata)", () => {
    const a = right(
      mapSvm(event({ kind: "sale", price: 3087000000, marketplace: "MAGIC_EDEN" }), ctx),
    ) as any;
    expect(a.verb).toBe("sale");
    expect(a.value).toBe("3087000000"); // decimal string — no float precision loss
    expect(a.decimals).toBe(9);
    expect(a.metadata.marketplace).toBe("MAGIC_EDEN");
  });

  it("maps a burn (to=null)", () => {
    const a = right(mapSvm(event({ kind: "burn", to: null }), ctx)) as any;
    expect(a.verb).toBe("burn");
    expect(a.to).toBeNull();
  });
});

describe("mapSvm — typed-error rejections (SchemaInvalid on the left)", () => {
  it("rejects blockTime <= 0 (the 1970 latent-timestamp guard)", () => {
    const e = mapSvm(event({ blockTime: 0 }), ctx);
    expect(Either.isLeft(e)).toBe(true);
    if (Either.isLeft(e)) {
      expect(e.left._tag).toBe("SchemaInvalid");
      expect(e.left.reason).toContain("blockTime");
    }
  });

  it("rejects an out-of-range blockTime that overflows Date (would throw RangeError pre-fix — M1)", () => {
    // 1e13 s * 1000 = 1e16 ms > Date's ±8.64e15 ms range → new Date(...).toISOString() throws.
    // The guard must surface this as a typed left, never let the RangeError escape.
    const e = mapSvm(event({ blockTime: 1e13 }), ctx);
    expect(Either.isLeft(e)).toBe(true);
    if (Either.isLeft(e)) {
      expect(e.left._tag).toBe("SchemaInvalid");
      expect(e.left.reason).toContain("blockTime");
    }
  });

  it("rejects a negative lamport price", () => {
    const e = mapSvm(event({ kind: "sale", price: -1, marketplace: "TENSOR" }), ctx);
    expect(Either.isLeft(e)).toBe(true);
    if (Either.isLeft(e)) expect(e.left.reason).toContain("lamport price");
  });

  it("rejects a non-integer lamport price (float would not be a clean decimal string)", () => {
    const e = mapSvm(event({ kind: "sale", price: 3.087, marketplace: "TENSOR" }), ctx);
    expect(Either.isLeft(e)).toBe(true);
    if (Either.isLeft(e)) expect(e.left.reason).toContain("lamport price");
  });

  it("rejects a collection_key that isn't a legal topic segment (underscore) — schema reject", () => {
    const e = mapSvm(event({ kind: "mint", from: null }), { ...ctx, collectionKey: "genesis_stones" });
    expect(Either.isLeft(e)).toBe(true);
    if (Either.isLeft(e)) {
      expect(e.left._tag).toBe("SchemaInvalid");
      expect(e.left.reason).toContain("decode failed");
      expect(e.left.parseError).toBeDefined();
    }
  });

  it("#85: rejects list/delist — marketplace-state events are NOT canonical ownership activities", () => {
    for (const kind of ["list", "delist"] as const) {
      const e = mapSvm(event({ kind }), ctx);
      expect(Either.isLeft(e)).toBe(true);
      if (Either.isLeft(e)) {
        expect(e.left._tag).toBe("SchemaInvalid");
        expect(e.left.reason).toContain("marketplace-state");
      }
    }
  });
});

describe("isCanonicalOwnershipKind (#85)", () => {
  it("is true for ownership verbs, false for marketplace-state kinds", () => {
    expect(["mint", "transfer", "sale", "burn"].every((k) => isCanonicalOwnershipKind(k as never))).toBe(true);
    expect(isCanonicalOwnershipKind("list" as never)).toBe(false);
    expect(isCanonicalOwnershipKind("delist" as never)).toBe(false);
  });
});
