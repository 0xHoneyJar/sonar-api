import { describe, expect, it } from "vitest";

import { resolvePreparationCapability } from "./capability.js";

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

  it("enables Robinhood Chain preparation for erc721", async () => {
    const rh = await resolvePreparationCapability({
      network: network("4663"),
      tokenStandard: "erc721",
    });
    expect(rh.enabled).toBe(true);
    expect(rh.health).toBe("available");
    expect(rh.finalityPolicyVersion).toBe("robinhood-finalized.v1");
    expect(rh.prepareAdapterId).toBe("belt.evm-erc721");
  });
});
