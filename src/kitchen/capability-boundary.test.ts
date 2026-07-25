import { describe, expect, it } from "vitest";

import { ethereumMainnetCapability } from "../collection-resolver/capability-registry/fixtures.js";
import { resolvePreparationCapability } from "./capability.js";

const ETHEREUM = {
  schema_version: 1,
  network_namespace: "eip155",
  network_reference: "1",
} as const;

describe("recognition versus preparation capability boundary", () => {
  it("now backs shared ERC-1155 recognition with a Kitchen preparation worker", async () => {
    expect(ethereumMainnetCapability().supported_standards).toContain("erc1155");
    const preparation = await resolvePreparationCapability({
      network: ETHEREUM,
      tokenStandard: "erc1155",
    });
    expect(preparation).toMatchObject({
      enabled: true,
      health: "available",
      reasonClass: "healthy",
      prepareAdapterId: "belt.eth-erc1155",
    });
  });

  it("keeps the boundary for standards recognition may name but preparation cannot serve", async () => {
    const preparation = await resolvePreparationCapability({
      network: ETHEREUM,
      tokenStandard: "compressed_nft",
    });
    expect(preparation).toMatchObject({
      enabled: false,
      health: "disabled",
      reasonClass: "capability_unsupported",
      prepareAdapterId: "unsupported",
    });
  });
});
