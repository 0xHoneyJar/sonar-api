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

  it("declares Robinhood sidecar adapter but keeps preparation disabled until canary", async () => {
    const rh = await resolvePreparationCapability({
      network: network("4663"),
      tokenStandard: "erc721",
    });
    expect(rh.enabled).toBe(false);
    expect(rh.health).toBe("disabled");
    expect(rh.reasonClass).toBe("supply_lane_pending");
    expect(rh.finalityPolicyVersion).toBe("robinhood-finalized.v1");
    expect(rh.prepareAdapterId).toBe("belt.evm-erc721.robinhood-sidecar");
    expect(rh.prepareAdapterVersion).toBe("rh-hyperindex-sidecar.v1");
  });
});
