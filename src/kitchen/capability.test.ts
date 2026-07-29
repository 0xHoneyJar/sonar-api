import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePreparationCapability } from "./capability.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const network = (reference: string) => ({
  schema_version: 1 as const,
  network_namespace: "eip155" as const,
  network_reference: reference,
});

describe("operation-scoped preparation capability", () => {
  it("is stable for the same operation material", async () => {
    const first = await resolvePreparationCapability({
      network: network("80094"),
      tokenStandard: "erc721",
    });
    const second = await resolvePreparationCapability({
      network: network("80094"),
      tokenStandard: "erc721",
    });
    expect(first.capabilityVersion).toBe(second.capabilityVersion);
    expect(first.capabilityVersion).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes across network, standard, and adapter material", async () => {
    const bera = await resolvePreparationCapability({
      network: network("80094"),
      tokenStandard: "erc721",
    });
    const ethereum = await resolvePreparationCapability({
      network: network("1"),
      tokenStandard: "erc721",
    });
    const beraErc1155 = await resolvePreparationCapability({
      network: network("80094"),
      tokenStandard: "erc1155",
    });
    expect(new Set([
      bera.capabilityVersion,
      ethereum.capabilityVersion,
      beraErc1155.capabilityVersion,
    ]).size).toBe(3);
  });

  it("admits erc1155 on a network with a generic 1155 worker", async () => {
    for (const reference of ["10", "80094", "8453", "42161", "7777777"]) {
      const capability = await resolvePreparationCapability({
        network: network(reference),
        tokenStandard: "erc1155",
      });
      expect(capability.enabled).toBe(true);
      expect(capability.health).toBe("available");
      expect(capability.prepareAdapterId).toBe("belt.evm-erc1155");
      expect(capability.prepareAdapterVersion).toBe("belt-config-erc1155.v1");
    }
  });

  it("uses the dedicated Ethereum 1155 adapter on chain 1", async () => {
    const capability = await resolvePreparationCapability({
      network: network("1"),
      tokenStandard: "erc1155",
    });
    expect(capability.enabled).toBe(true);
    expect(capability.prepareAdapterId).toBe("belt.eth-erc1155");
    expect(capability.prepareAdapterVersion).toBe("belt-config-erc1155.v1");
  });

  it("keeps the adapter version standard-specific, not global", async () => {
    const erc721 = await resolvePreparationCapability({
      network: network("80094"),
      tokenStandard: "erc721",
    });
    const erc1155 = await resolvePreparationCapability({
      network: network("80094"),
      tokenStandard: "erc1155",
    });
    expect(erc721.prepareAdapterVersion).toBe("belt-config-erc721.v1");
    expect(erc1155.prepareAdapterVersion).toBe("belt-config-erc1155.v1");
  });

  it("still refuses every standard that has no worker", async () => {
    for (const tokenStandard of [
      "metaplex_collection",
      "programmable_nft",
      "compressed_nft",
    ] as const) {
      const capability = await resolvePreparationCapability({
        network: network("80094"),
        tokenStandard,
      });
      expect(capability.enabled).toBe(false);
      expect(capability.reasonClass).toBe("capability_unsupported");
      expect(capability.reason).toBe(
        `${tokenStandard} has no generic Kitchen preparation worker`,
      );
      expect(capability.prepareAdapterId).toBe("unsupported");
    }
  });

  it("refuses erc1155 on Robinhood — the sidecar has an erc721 worker only", async () => {
    vi.stubEnv(
      "ROBINHOOD_BELT_GRAPHQL_URL",
      "http://belt-hasura-robinhood.railway.internal:8080/v1/graphql",
    );
    const capability = await resolvePreparationCapability({
      network: network("4663"),
      tokenStandard: "erc1155",
    });
    expect(capability.enabled).toBe(false);
    expect(capability.reasonClass).toBe("capability_unsupported");
    expect(capability.prepareAdapterId).toBe("unsupported");
  });

  it("keeps Robinhood preparation disabled without sidecar GraphQL URL", async () => {
    vi.stubEnv("ROBINHOOD_BELT_GRAPHQL_URL", "");
    vi.stubEnv("ROBINHOOD_OWNERSHIP_SUPPLY_LANE", "");
    const rh = await resolvePreparationCapability({
      network: network("4663"),
      tokenStandard: "erc721",
    });
    expect(rh.enabled).toBe(false);
    expect(rh.health).toBe("disabled");
    expect(rh.reasonClass).toBe("supply_lane_pending");
    expect(rh.prepareAdapterId).toBe("belt.evm-erc721.robinhood-sidecar");
  });

  it("enables Robinhood preparation when ROBINHOOD_BELT_GRAPHQL_URL is set", async () => {
    vi.stubEnv(
      "ROBINHOOD_BELT_GRAPHQL_URL",
      "http://belt-hasura-robinhood.railway.internal:8080/v1/graphql",
    );
    const rh = await resolvePreparationCapability({
      network: network("4663"),
      tokenStandard: "erc721",
    });
    expect(rh.enabled).toBe(true);
    expect(rh.health).toBe("available");
    expect(rh.prepareAdapterId).toBe("belt.evm-erc721.robinhood-sidecar");
    expect(rh.prepareAdapterVersion).toBe("rh-hyperindex-sidecar.v1");
    expect(rh.finalityPolicyVersion).toBe("robinhood-finalized.v1");
  });
});
