import { describe, expect, it } from "vitest";

import {
  appendTrackedErc721ToChainBlock,
  contractListedInChainBlock,
  patchConfigForKitchenIngest,
} from "./config-patcher.js";

const FIXTURE = `
chains:
  - id: 1
    start_block: 100
    contracts:
      - name: HoneyJar
        address:
          - 0xa20cf9b0874c3e46b344deaeea9c2e0c3e1db37d
  - id: 80094
    start_block: 1
    contracts:
      - name: TrackedErc721
        address:
          - 0x6b31859e5e32a5212f1ba4d7b377604b9d4c7a60
`.trim();

describe("config-patcher", () => {
  it("detects an existing contract address in a chain block", () => {
    const block = FIXTURE.split("chains:")[1];
    expect(
      contractListedInChainBlock(block, "0xa20cf9b0874c3e46b344deaeea9c2e0c3e1db37d"),
    ).toBe(true);
    expect(
      contractListedInChainBlock(block, "0xed5af388653567af2f388e6224dcc93746104133"),
    ).toBe(false);
  });

  it("appends to an existing TrackedErc721 address list", () => {
    const chain80094 = FIXTURE.split("  - id: 80094")[1];
    const patched = appendTrackedErc721ToChainBlock(
      chain80094,
      "0x1111111111111111111111111111111111111111",
      "test_collection",
    );
    expect(patched).toContain("0x1111111111111111111111111111111111111111");
  });

  it("creates TrackedErc721 when missing on the chain", () => {
    const { changed, configYaml } = patchConfigForKitchenIngest({
      configYaml: FIXTURE,
      key: { chainId: 1, contract: "0xED5Af388653567Af2F388e6224DcC93746104133" },
      label: "azuki_kitchen_e2e",
    });
    expect(changed).toBe(true);
    expect(configYaml).toContain("TrackedErc721");
    expect(configYaml.toLowerCase()).toContain("0xed5af388653567af2f388e6224dcc93746104133");
  });

  it("is idempotent when the contract is already listed", () => {
    const { changed } = patchConfigForKitchenIngest({
      configYaml: FIXTURE,
      key: { chainId: 1, contract: "0xa20cf9b0874c3e46b344deaeea9c2e0c3e1db37d" },
    });
    expect(changed).toBe(false);
  });

  it("sanitizes labels before embedding in YAML comments", () => {
    const { configYaml } = patchConfigForKitchenIngest({
      configYaml: FIXTURE,
      key: { chainId: 1, contract: "0xED5Af388653567Af2F388e6224DcC93746104133" },
      label: "evil\n      - name: Pwned",
    });
    expect(configYaml).not.toMatch(/\n\s+- name: Pwned/);
    expect(configYaml).toContain("# evil_");
  });
});
