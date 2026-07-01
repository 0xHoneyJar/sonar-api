import { describe, expect, it } from "vitest";

import { collectionKeyFromParams, makeIngestJobId } from "./normalize.js";

/** Berachain fixture from tracked-erc721-bera-collections.test.ts */
export const FIXTURE_CHAIN_ID = 80094;
export const FIXTURE_CONTRACT = "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684";

describe("collectionKeyFromParams", () => {
  it("accepts the tracked Berachain fixture contract", () => {
    const key = collectionKeyFromParams(String(FIXTURE_CHAIN_ID), FIXTURE_CONTRACT);
    expect(key).toEqual({
      chainId: FIXTURE_CHAIN_ID,
      contract: FIXTURE_CONTRACT,
    });
  });

  it("lowercases checksum addresses", () => {
    const key = collectionKeyFromParams(
      "80094",
      "0x4B08a069381EfbB9f08C73D6B2e975C9BE3c4684",
    );
    expect(key?.contract).toBe(FIXTURE_CONTRACT);
  });

  it("rejects invalid params", () => {
    expect(collectionKeyFromParams("abc", FIXTURE_CONTRACT)).toBeNull();
    expect(collectionKeyFromParams("80094", "not-an-address")).toBeNull();
  });
});

describe("makeIngestJobId", () => {
  it("is stable for a collection key", () => {
    const key = collectionKeyFromParams(String(FIXTURE_CHAIN_ID), FIXTURE_CONTRACT)!;
    expect(makeIngestJobId(key)).toBe(`ingest_80094_${FIXTURE_CONTRACT.slice(2)}`);
  });
});
