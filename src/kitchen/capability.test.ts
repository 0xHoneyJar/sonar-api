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
    const unsupportedStandard = await resolvePreparationCapability({
      network: network("80094"),
      tokenStandard: "erc1155",
    });
    expect(new Set([
      bera.capabilityVersion,
      ethereum.capabilityVersion,
      unsupportedStandard.capabilityVersion,
    ]).size).toBe(3);
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
