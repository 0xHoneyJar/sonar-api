import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  ERC1155_SUPPORTS_CALLDATA,
  ERC165_SUPPORTS_CALLDATA,
  ERC721_SUPPORTS_CALLDATA,
  INVALID_INTERFACE_SUPPORTS_CALLDATA,
} from "../collection-resolver/adapters/evm/abi.js";
import { evmRpcFailure } from "../collection-resolver/adapters/evm/ports.js";
import type {
  EthCallResult,
  EvmObservationBlock,
  EvmRpcPort,
} from "../collection-resolver/adapters/evm/ports.js";
import { ethereumMainnetCapability } from "../collection-resolver/capability-registry/fixtures.js";
import type { EvmFinalityPolicy } from "../collection-resolver/capability-registry/schemas.js";
import type { NetworkRef } from "../collection-resolver/protocol.js";
import { createEvmRpcTokenStandardDetector } from "./standard-detection.js";

const ETH_NETWORK = {
  schema_version: 1,
  network_namespace: "eip155",
  network_reference: "1",
} as unknown as NetworkRef;

const ADDRESS = "0x2079812353e2c9409a788fbf5f383fa62ad85be8" as const;

const BLOCK: EvmObservationBlock = {
  block_number: 21_000_000n,
  block_hash: `0x${"ab".repeat(32)}`,
  finality: "finalized",
};

const ABI_TRUE = `0x${"0".repeat(63)}1` as const;
const ABI_FALSE = `0x${"0".repeat(64)}` as const;

const finalityByNetwork: Record<string, EvmFinalityPolicy> = {
  "eip155:1": ethereumMainnetCapability().finality_policy as EvmFinalityPolicy,
};

const clock = { nowMs: () => 0, nowIso: () => new Date(0).toISOString() };

/** Hermetic EvmRpcPort — `calls` maps calldata to a canned eth_call result. */
function makeRpc(options: {
  code?: `0x${string}`;
  calls?: Record<string, EthCallResult>;
  blockFails?: boolean;
}): EvmRpcPort {
  return {
    resolveObservationBlock: () =>
      options.blockFails
        ? Effect.fail(evmRpcFailure("rpc_transport_failed", "boom"))
        : Effect.succeed(BLOCK),
    getCode: () => Effect.succeed(options.code ?? "0x60806040"),
    ethCall: (input) =>
      Effect.succeed(options.calls?.[input.data] ?? ({ kind: "revert" } as const)),
    getStorageAt: () => Effect.succeed(`0x${"0".repeat(64)}` as `0x${string}`),
  };
}

/** ERC-165 handshake: supports 165, rejects the 0xffffffff sentinel. */
const erc165Handshake: Record<string, EthCallResult> = {
  [ERC165_SUPPORTS_CALLDATA]: { kind: "success", data: ABI_TRUE },
  [INVALID_INTERFACE_SUPPORTS_CALLDATA]: { kind: "success", data: ABI_FALSE },
};

const detect = (rpc: EvmRpcPort) =>
  createEvmRpcTokenStandardDetector({ rpc, finalityByNetwork, clock }).detect({
    network: ETH_NETWORK,
    address: ADDRESS,
  });

describe("kitchen token standard detection", () => {
  it("detects erc1155 when supportsInterface(0xd9b67a26) is true", async () => {
    const result = await detect(
      makeRpc({
        calls: {
          ...erc165Handshake,
          [ERC721_SUPPORTS_CALLDATA]: { kind: "success", data: ABI_FALSE },
          [ERC1155_SUPPORTS_CALLDATA]: { kind: "success", data: ABI_TRUE },
        },
      }),
    );
    expect(result).toEqual({ ok: true, tokenStandard: "erc1155" });
  });

  it("still admits a genuine erc721", async () => {
    const result = await detect(
      makeRpc({
        calls: {
          ...erc165Handshake,
          [ERC721_SUPPORTS_CALLDATA]: { kind: "success", data: ABI_TRUE },
          [ERC1155_SUPPORTS_CALLDATA]: { kind: "success", data: ABI_FALSE },
        },
      }),
    );
    expect(result).toEqual({ ok: true, tokenStandard: "erc721" });
  });

  it("refuses an address with no contract code", async () => {
    const result = await detect(makeRpc({ code: "0x" }));
    expect(result).toMatchObject({ ok: false, code: "no_contract_code" });
  });

  it("refuses when supportsInterface reverts (CryptoPunks) — never falls back to erc721", async () => {
    // No `calls` entries at all: every eth_call reverts.
    const result = await detect(makeRpc({}));
    expect(result).toMatchObject({ ok: false, code: "standard_inconclusive" });
  });

  it("refuses when the RPC is unavailable", async () => {
    const result = await detect(makeRpc({ blockFails: true }));
    expect(result).toMatchObject({ ok: false, code: "detection_unavailable" });
  });

  it("refuses a contract claiming both erc721 and erc1155 as ambiguous", async () => {
    const result = await detect(
      makeRpc({
        calls: {
          ...erc165Handshake,
          [ERC721_SUPPORTS_CALLDATA]: { kind: "success", data: ABI_TRUE },
          [ERC1155_SUPPORTS_CALLDATA]: { kind: "success", data: ABI_TRUE },
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "standard_inconclusive" });
  });
});
