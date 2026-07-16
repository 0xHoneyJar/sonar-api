import { describe, expect, it } from "vitest";

import { ethereumMainnetCapability } from "../collection-resolver/capability-registry/fixtures.js";
import { resolvePreparationCapability } from "./capability.js";

describe("recognition versus preparation capability boundary", () => {
  it("preserves shared ERC-1155 recognition while Kitchen rejects preparation locally", async () => {
    expect(ethereumMainnetCapability().supported_standards).toContain("erc1155");
    const preparation = await resolvePreparationCapability({
      network: {
        schema_version: 1,
        network_namespace: "eip155",
        network_reference: "1",
      },
      tokenStandard: "erc1155",
    });
    expect(preparation).toMatchObject({
      enabled: false,
      health: "disabled",
      reasonClass: "capability_unsupported",
      prepareAdapterId: "unsupported",
    });
  });
});
