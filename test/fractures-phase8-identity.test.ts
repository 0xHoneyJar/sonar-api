import { describe, expect, it, vi } from "vitest";

vi.mock("envio", () => ({
  indexer: {
    onEvent: () => {},
  },
}));

import { ZERO_ADDRESS } from "../src/handlers/constants";
import { handleTrackedErc721Transfer } from "../src/handlers/tracked-erc721";
import {
  FRACTURES_PHASE_8_IDENTITY_V1,
  TRACKED_ERC721_COLLECTION_KEYS,
} from "../src/handlers/tracked-erc721/constants";

function makeStore<T extends { id: string }>() {
  const map = new Map<string, T>();
  return {
    map,
    get: async (id: string): Promise<T | undefined> => map.get(id),
    set: (entity: T) => void map.set(entity.id, entity),
    deleteUnsafe: (id: string) => void map.delete(id),
  };
}

function makeContext() {
  return {
    Token: makeStore<any>(),
    TrackedHolder: makeStore<any>(),
    Action: makeStore<any>(),
    MiberaStakedToken: makeStore<any>(),
    MiberaStaker: makeStore<any>(),
  };
}

describe("Fractures phase-8 collection identity (#219)", () => {
  it("declares canonical, accepted, and transitional emitted keys in schema v1", () => {
    expect(FRACTURES_PHASE_8_IDENTITY_V1).toEqual({
      schemaVersion: 1,
      address: "0xaab7b4502251ae393d0590bab3e208e2d58f4813",
      canonicalKey: "mireveal_6_9",
      acceptedKeys: ["mireveal_6_9", "mireveal_6_6"],
      emittedKey: "mireveal_6_6",
    });
    expect(
      TRACKED_ERC721_COLLECTION_KEYS[FRACTURES_PHASE_8_IDENTITY_V1.address],
    ).toBe(FRACTURES_PHASE_8_IDENTITY_V1.emittedKey);
  });

  it("keeps handler Action and TrackedHolder wire keys legacy-compatible", async () => {
    const context = makeContext();

    await handleTrackedErc721Transfer(
      {
        srcAddress: FRACTURES_PHASE_8_IDENTITY_V1.address,
        chainId: 80094,
        logIndex: 7,
        params: {
          from: ZERO_ADDRESS,
          to: "0x1111111111111111111111111111111111111111",
          tokenId: 69n,
        },
        transaction: { hash: "0xphase8" },
        block: { timestamp: 1_700_000_000, number: 12_345_678 },
      },
      context as any,
    );

    const actions = [...context.Action.map.values()];
    expect(actions.map((action) => action.primaryCollection)).toEqual([
      "mireveal_6_6",
      "mireveal_6_6",
    ]);
    expect(
      [...context.TrackedHolder.map.values()].map(
        (holder) => holder.collectionKey,
      ),
    ).toEqual(["mireveal_6_6"]);
    expect(
      actions
        .map((action) => `${action.primaryCollection}:${action.context ?? ""}`)
        .join("|"),
    ).not.toContain("mireveal_6_9");
  });
});
