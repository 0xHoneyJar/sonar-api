import { describe, expect, it } from "vitest";

import {
  createRoutedCollectionStatusReader,
  ROBINHOOD_CHAIN_ID,
} from "./routed-status-reader.js";
import type { CollectionStatusReader } from "./status.js";

describe("createRoutedCollectionStatusReader", () => {
  it("routes 4663 to robinhood reader and others to default", async () => {
    const calls: string[] = [];
    const defaultReader: CollectionStatusReader = {
      readIndexedSnapshot: async (key) => {
        calls.push(`default:${key.chainId}`);
        return { holderCount: 1, indexedAtMs: 1000 };
      },
    };
    const robinhoodReader: CollectionStatusReader = {
      readIndexedSnapshot: async (key) => {
        calls.push(`rh:${key.chainId}`);
        return { holderCount: 9, indexedAtMs: 2000 };
      },
    };
    const routed = createRoutedCollectionStatusReader({
      defaultReader,
      robinhoodReader,
    });

    const rh = await routed.readIndexedSnapshot({
      chainId: ROBINHOOD_CHAIN_ID,
      contract: "0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0",
    });
    const base = await routed.readIndexedSnapshot({
      chainId: 8453,
      contract: "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684",
    });

    expect(rh.holderCount).toBe(9);
    expect(base.holderCount).toBe(1);
    expect(calls).toEqual(["rh:4663", "default:8453"]);
  });
});
