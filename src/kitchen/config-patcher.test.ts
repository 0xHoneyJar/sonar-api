import { describe, expect, it } from "vitest";

import {
  appendTrackedErc1155ToChainBlock,
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

  it("appends into a terminal EthTrackedErc721 address list", () => {
    const terminal = [
      "  - id: 1",
      "    contracts:",
      "      - name: EthTrackedErc721",
      "        address:",
      "          - 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # existing",
    ].join("\n");
    const patched = appendTrackedErc721ToChainBlock(
      terminal,
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "new_collection",
      "EthTrackedErc721",
    );
    expect(patched).toContain(
      [
        "        address:",
        "          - 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # existing",
        "          - 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # new_collection",
      ].join("\n"),
    );
    expect(patched.match(/^        address:$/gm)).toHaveLength(1);
  });

  it("creates EthTrackedErc721 on Ethereum", () => {
    const { changed, configYaml } = patchConfigForKitchenIngest({
      configYaml: FIXTURE,
      key: { chainId: 1, contract: "0xED5Af388653567Af2F388e6224DcC93746104133" },
      label: "azuki_kitchen_e2e",
    });
    expect(changed).toBe(true);
    expect(configYaml).toContain("EthTrackedErc721");
    expect(configYaml.toLowerCase()).toContain("0xed5af388653567af2f388e6224dcc93746104133");
  });

  it("is idempotent when the contract is already listed", () => {
    const { changed } = patchConfigForKitchenIngest({
      configYaml: FIXTURE,
      key: { chainId: 1, contract: "0xa20cf9b0874c3e46b344deaeea9c2e0c3e1db37d" },
    });
    expect(changed).toBe(false);
  });

  it("creates a TrackedErc1155 block for an observed erc1155", () => {
    const { changed, configYaml } = patchConfigForKitchenIngest({
      configYaml: FIXTURE,
      key: { chainId: 80094, contract: "0xecA03517c5195F1edD634DA6D690D6c72407c40c" },
      label: "mibera_candies",
      tokenStandard: "erc1155",
    });
    expect(changed).toBe(true);
    expect(configYaml).toContain(
      [
        "      # Kitchen ingest — community onboarding ERC-1155 holder tracking",
        "      - name: TrackedErc1155",
        "        address:",
        "          - 0xeca03517c5195f1edd634da6d690d6c72407c40c # mibera_candies",
      ].join("\n"),
    );
    // The 721 block for this chain is untouched.
    expect(configYaml).toContain("      - name: TrackedErc721");
  });

  it("creates EthTrackedErc1155 for an erc1155 on Ethereum (envio #120 shape)", () => {
    const { configYaml } = patchConfigForKitchenIngest({
      configYaml: FIXTURE,
      key: { chainId: 1, contract: "0x2079812353e2c9409A788FBF5f383fa62aD85bE8" },
      label: "bobu",
      tokenStandard: "erc1155",
    });
    expect(configYaml).toContain("- name: EthTrackedErc1155");
    expect(configYaml).toContain("0x2079812353e2c9409a788fbf5f383fa62ad85be8 # bobu");
  });

  it("appends into an existing TrackedErc1155 address list", () => {
    const existing = [
      "  - id: 8453",
      "    contracts:",
      "      - name: TrackedErc1155",
      "        address:",
      "          - 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # existing",
    ].join("\n");
    const patched = appendTrackedErc1155ToChainBlock(
      existing,
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "new_collection",
    );
    expect(patched).toContain(
      [
        "          - 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # existing",
        "          - 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # new_collection",
      ].join("\n"),
    );
    expect(patched.match(/^        address:$/gm)).toHaveLength(1);
  });

  it("defaults to the erc721 belt contract when no standard is given", () => {
    const { configYaml } = patchConfigForKitchenIngest({
      configYaml: FIXTURE,
      key: { chainId: 80094, contract: "0x1111111111111111111111111111111111111111" },
    });
    expect(configYaml).not.toContain("TrackedErc1155");
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
