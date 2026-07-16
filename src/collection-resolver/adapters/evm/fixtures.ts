/**
 * Hermetic recorded EVM RPC fixtures for CR-103.
 *
 * No network I/O. Scripts are keyed by network identity (`eip155:1`, …).
 * Deadline checks use the injected MonotonicClock (same domain as CR-102).
 */
import { Effect } from "effect";
import type { MonotonicClock } from "../../bounded-core/clock.js";
import { networkIdentityKey } from "../../capability-registry/keys.js";
import type { NetworkRef } from "../../protocol.js";
import {
  ERC1155_SUPPORTS_CALLDATA,
  ERC721_SUPPORTS_CALLDATA,
  encodeContractUriCall,
  encodeNameCall,
  encodeSymbolCall,
} from "./abi.js";
import { EIP1967_IMPLEMENTATION_SLOT, SAFE_MESSAGES } from "./constants.js";
import type {
  EthCallResult,
  EvmObservationBlock,
  EvmRpcFailure,
  EvmRpcPort,
} from "./ports.js";
import { evmRpcFailure } from "./ports.js";

const encodeAbiString = (value: string): `0x${string}` => {
  const strHex = Buffer.from(value, "utf8").toString("hex");
  const len = Buffer.from(value, "utf8").length;
  const offset = "0".repeat(62) + "20";
  const length = len.toString(16).padStart(64, "0");
  const padded = strHex.padEnd(Math.ceil(strHex.length / 64) * 64, "0");
  return `0x${offset}${length}${padded}` as `0x${string}`;
};

const encodeAbiBool = (value: boolean): `0x${string}` =>
  (`0x${"0".repeat(63)}${value ? "1" : "0"}`) as `0x${string}`;

const ZERO_WORD =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

const addressToWord = (address: `0x${string}`): `0x${string}` =>
  (`0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`) as `0x${string}`;

export const FIXTURE_BLOCK: EvmObservationBlock = {
  block_number: 19_000_001n,
  block_hash: `0x${"ab".repeat(32)}` as `0x${string}`,
  finality: "finalized",
};

export const FIXTURE_BLOCK_BASE: EvmObservationBlock = {
  block_number: 20_000_001n,
  block_hash: `0x${"cd".repeat(32)}` as `0x${string}`,
  finality: "finalized",
};

/** Minimal contract-like bytecode (non-empty). */
export const FIXTURE_BYTECODE = "0x608060405234801561001057600080fd5b50" as `0x${string}`;
export const FIXTURE_IMPL_BYTECODE =
  "0x60806040526004361061001e5760003560e01c5b" as `0x${string}`;

export const FIXTURE_IMPL_ADDRESS =
  "0x1111111111111111111111111111111111111111" as `0x${string}`;

export type FixtureAccount = {
  readonly code: `0x${string}`;
  readonly storage?: Readonly<Record<string, `0x${string}`>>;
  readonly calls?: Readonly<
    Record<string, EthCallResult | ((to: `0x${string}`) => EthCallResult)>
  >;
};

export type NetworkFixtureScript = {
  readonly block?: EvmObservationBlock | EvmRpcFailure;
  readonly accounts: Readonly<Record<string, FixtureAccount>>;
  /** Force resolveObservationBlock / getCode / ethCall failures by method. */
  readonly fail?: {
    readonly resolveBlock?: EvmRpcFailure;
    readonly getCode?: EvmRpcFailure;
    readonly ethCall?: EvmRpcFailure;
    readonly getStorageAt?: EvmRpcFailure;
  };
  /** Delay (ms) before each RPC op — used with abort tests. */
  readonly delayMs?: number;
  /** When true, ignore abort until delay completes (late settlement). */
  readonly ignoreAbort?: boolean;
  readonly callLog?: string[];
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const guardAbort = (input: {
  readonly abort: AbortSignal;
  readonly deadline_at_ms: number;
  readonly now_ms: number;
  readonly ignoreAbort?: boolean;
}): EvmRpcFailure | undefined => {
  if (input.ignoreAbort) return undefined;
  if (input.abort.aborted) {
    return evmRpcFailure("rpc_aborted", SAFE_MESSAGES.rpc_aborted);
  }
  if (input.now_ms >= input.deadline_at_ms) {
    return evmRpcFailure("rpc_timeout", SAFE_MESSAGES.rpc_timeout);
  }
  return undefined;
};

export interface FixtureEvmRpcPortOptions {
  /** Same monotonic clock domain as CR-102 / the adapter. Required. */
  readonly clock: MonotonicClock;
}

/**
 * Build a hermetic EvmRpcPort from per-network fixture scripts.
 */
export const createFixtureEvmRpcPort = (
  scripts: Readonly<Record<string, NetworkFixtureScript>>,
  options: FixtureEvmRpcPortOptions,
): EvmRpcPort & { readonly callLog: () => ReadonlyArray<string> } => {
  const sharedLog: string[] = [];
  const clock = options.clock;

  const run = <A>(
    network: NetworkRef,
    method: string,
    input: {
      readonly abort: AbortSignal;
      readonly deadline_at_ms: number;
    },
    body: (script: NetworkFixtureScript) => A | EvmRpcFailure,
  ): Effect.Effect<A, EvmRpcFailure> => {
    const key = networkIdentityKey(network);
    const script = scripts[key];
    const log = script?.callLog ?? sharedLog;

    const executeSync = (): A => {
      log.push(`${key}:${method}`);
      if (script === undefined) {
        throw evmRpcFailure("rpc_unsupported_network", SAFE_MESSAGES.rpc_unsupported_network);
      }
      const gated = guardAbort({
        abort: input.abort,
        deadline_at_ms: input.deadline_at_ms,
        now_ms: clock.nowMs(),
        ignoreAbort: script.ignoreAbort,
      });
      if (gated) throw gated;
      const result = body(script);
      if (
        result !== null &&
        typeof result === "object" &&
        "_tag" in result &&
        (result as EvmRpcFailure)._tag === "EvmRpcFailure"
      ) {
        throw result as EvmRpcFailure;
      }
      return result as A;
    };

    // Sync path when no artificial delay — keeps hermetic probes runSync-friendly.
    if (script === undefined || script.delayMs === undefined || script.delayMs <= 0) {
      return Effect.try({
        try: executeSync,
        catch: (cause) => {
          if (
            cause !== null &&
            typeof cause === "object" &&
            "_tag" in cause &&
            (cause as EvmRpcFailure)._tag === "EvmRpcFailure"
          ) {
            return cause as EvmRpcFailure;
          }
          return evmRpcFailure("rpc_transport_failed", SAFE_MESSAGES.rpc_transport_failed);
        },
      });
    }

    return Effect.tryPromise({
      try: async () => {
        await sleep(script.delayMs!);
        return executeSync();
      },
      catch: (cause) => {
        if (
          cause !== null &&
          typeof cause === "object" &&
          "_tag" in cause &&
          (cause as EvmRpcFailure)._tag === "EvmRpcFailure"
        ) {
          return cause as EvmRpcFailure;
        }
        return evmRpcFailure("rpc_transport_failed", SAFE_MESSAGES.rpc_transport_failed);
      },
    });
  };

  return {
    callLog: () => [...sharedLog],
    resolveObservationBlock: (input) =>
      run(input.network, "resolveObservationBlock", input, (script) => {
        if (script.fail?.resolveBlock) return script.fail.resolveBlock;
        if (script.block && "_tag" in script.block) return script.block;
        return script.block ?? FIXTURE_BLOCK;
      }),
    getCode: (input) =>
      run(input.network, "getCode", input, (script) => {
        if (script.fail?.getCode) return script.fail.getCode;
        const account = script.accounts[input.address.toLowerCase()];
        return account?.code ?? ("0x" as `0x${string}`);
      }),
    ethCall: (input) =>
      run(input.network, "ethCall", input, (script) => {
        if (script.fail?.ethCall) return script.fail.ethCall;
        const account = script.accounts[input.to.toLowerCase()];
        if (account === undefined) return { kind: "revert" } as const;
        const handler = account.calls?.[input.data.toLowerCase()];
        if (handler === undefined) return { kind: "revert" } as const;
        return typeof handler === "function" ? handler(input.to) : handler;
      }),
    getStorageAt: (input) =>
      run(input.network, "getStorageAt", input, (script) => {
        if (script.fail?.getStorageAt) return script.fail.getStorageAt;
        const account = script.accounts[input.address.toLowerCase()];
        const slot = input.slot.toLowerCase();
        return account?.storage?.[slot] ?? ZERO_WORD;
      }),
  };
};

const nftCalls = (input: {
  readonly erc721: boolean | "revert";
  readonly erc1155: boolean | "revert";
  readonly name?: string | "revert";
  readonly symbol?: string | "revert";
  readonly contractUri?: string | "revert";
}): FixtureAccount["calls"] => {
  const boolResult = (v: boolean | "revert"): EthCallResult =>
    v === "revert" ? { kind: "revert" } : { kind: "success", data: encodeAbiBool(v) };
  const strResult = (v: string | "revert" | undefined): EthCallResult | undefined => {
    if (v === undefined) return undefined;
    if (v === "revert") return { kind: "revert" };
    return { kind: "success", data: encodeAbiString(v) };
  };

  const calls: Record<string, EthCallResult> = {
    [ERC721_SUPPORTS_CALLDATA.toLowerCase()]: boolResult(input.erc721),
    [ERC1155_SUPPORTS_CALLDATA.toLowerCase()]: boolResult(input.erc1155),
  };
  const name = strResult(input.name);
  if (name) calls[encodeNameCall().toLowerCase()] = name;
  const symbol = strResult(input.symbol);
  if (symbol) calls[encodeSymbolCall().toLowerCase()] = symbol;
  const uri = strResult(input.contractUri);
  if (uri) calls[encodeContractUriCall().toLowerCase()] = uri;
  return calls;
};

export const FIXTURE_ADDRESS =
  "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" as const;
export const FIXTURE_ADDRESS_NORMALIZED =
  "0xabcdef0123456789abcdef0123456789abcdef01" as const;

/** ERC-721 with name/symbol and no contractURI. */
export const scriptErc721 = (address = FIXTURE_ADDRESS_NORMALIZED): NetworkFixtureScript => ({
  block: FIXTURE_BLOCK,
  accounts: {
    [address]: {
      code: FIXTURE_BYTECODE,
      calls: nftCalls({
        erc721: true,
        erc1155: false,
        name: "Mibera",
        symbol: "MIB",
      }),
      storage: { [EIP1967_IMPLEMENTATION_SLOT.toLowerCase()]: ZERO_WORD },
    },
  },
});

/** ERC-1155. */
export const scriptErc1155 = (address = FIXTURE_ADDRESS_NORMALIZED): NetworkFixtureScript => ({
  block: FIXTURE_BLOCK,
  accounts: {
    [address]: {
      code: FIXTURE_BYTECODE,
      calls: nftCalls({
        erc721: false,
        erc1155: true,
        name: "Multi",
        symbol: "MLT",
      }),
    },
  },
});

/** Both interfaces true → ambiguous. */
export const scriptBothInterfaces = (
  address = FIXTURE_ADDRESS_NORMALIZED,
): NetworkFixtureScript => ({
  block: FIXTURE_BLOCK,
  accounts: {
    [address]: {
      code: FIXTURE_BYTECODE,
      calls: nftCalls({
        erc721: true,
        erc1155: true,
        name: "Both",
        symbol: "BOTH",
      }),
    },
  },
});

/** Bytecode without NFT interfaces. */
export const scriptUnknownInterface = (
  address = FIXTURE_ADDRESS_NORMALIZED,
): NetworkFixtureScript => ({
  block: FIXTURE_BLOCK,
  accounts: {
    [address]: {
      code: FIXTURE_BYTECODE,
      calls: nftCalls({
        erc721: false,
        erc1155: false,
        name: "NotAnNft",
        symbol: "NAN",
      }),
    },
  },
});

/** EIP-1967 proxy pointing at implementation with ERC-721 (complete binding). */
export const scriptEip1967Proxy = (
  address = FIXTURE_ADDRESS_NORMALIZED,
): NetworkFixtureScript => ({
  block: FIXTURE_BLOCK,
  accounts: {
    [address]: {
      code: FIXTURE_BYTECODE,
      storage: {
        [EIP1967_IMPLEMENTATION_SLOT.toLowerCase()]: addressToWord(FIXTURE_IMPL_ADDRESS),
      },
      calls: nftCalls({
        erc721: true,
        erc1155: false,
        name: "Proxied",
        symbol: "PRX",
      }),
    },
    [FIXTURE_IMPL_ADDRESS]: {
      code: FIXTURE_IMPL_BYTECODE,
      calls: {},
    },
  },
});

/**
 * EIP-1967 slot nonzero but implementation code absent — recognition may remain,
 * binding_evidence must be omitted.
 */
export const scriptIncompleteEip1967Proxy = (
  address = FIXTURE_ADDRESS_NORMALIZED,
): NetworkFixtureScript => ({
  block: FIXTURE_BLOCK,
  accounts: {
    [address]: {
      code: FIXTURE_BYTECODE,
      storage: {
        [EIP1967_IMPLEMENTATION_SLOT.toLowerCase()]: addressToWord(FIXTURE_IMPL_ADDRESS),
      },
      calls: nftCalls({
        erc721: true,
        erc1155: false,
        name: "IncompleteProxy",
        symbol: "IPX",
      }),
    },
    [FIXTURE_IMPL_ADDRESS]: {
      code: "0x",
      calls: {},
    },
  },
});

/** Healthy call reverts on supportsInterface — absent evidence, still has bytecode. */
export const scriptHealthyRevert = (
  address = FIXTURE_ADDRESS_NORMALIZED,
): NetworkFixtureScript => ({
  block: FIXTURE_BLOCK,
  accounts: {
    [address]: {
      code: FIXTURE_BYTECODE,
      calls: nftCalls({
        erc721: "revert",
        erc1155: "revert",
        name: "RevertName",
        symbol: "RV",
      }),
    },
  },
});

/** EOA — empty code. */
export const scriptEoa = (address = FIXTURE_ADDRESS_NORMALIZED): NetworkFixtureScript => ({
  block: FIXTURE_BLOCK,
  accounts: {
    [address]: {
      code: "0x",
      calls: {},
    },
  },
});

/** Transport failure on eth_call. */
export const scriptTransportFailure = (
  address = FIXTURE_ADDRESS_NORMALIZED,
): NetworkFixtureScript => ({
  block: FIXTURE_BLOCK,
  accounts: {
    [address]: {
      code: FIXTURE_BYTECODE,
      calls: {},
    },
  },
  fail: {
    ethCall: evmRpcFailure("rpc_transport_failed", SAFE_MESSAGES.rpc_transport_failed),
  },
});

/** Quorum failure resolving observation block. */
export const scriptQuorumFailure = (): NetworkFixtureScript => ({
  accounts: {},
  fail: {
    resolveBlock: evmRpcFailure("rpc_quorum_failed", SAFE_MESSAGES.rpc_quorum_failed),
  },
});

/** ERC-721 with contractURI for metadata tests. */
export const scriptWithContractUri = (
  uri: string,
  address = FIXTURE_ADDRESS_NORMALIZED,
): NetworkFixtureScript => ({
  block: FIXTURE_BLOCK,
  accounts: {
    [address]: {
      code: FIXTURE_BYTECODE,
      calls: nftCalls({
        erc721: true,
        erc1155: false,
        name: "Meta",
        symbol: "META",
        contractUri: uri,
      }),
    },
  },
});

/** Same address on ethereum + base with distinct blocks. */
export const multiNetworkScripts = (
  address = FIXTURE_ADDRESS_NORMALIZED,
): Record<string, NetworkFixtureScript> => ({
  "eip155:1": {
    block: FIXTURE_BLOCK,
    accounts: {
      [address]: {
        code: FIXTURE_BYTECODE,
        calls: nftCalls({
          erc721: true,
          erc1155: false,
          name: "Shared",
          symbol: "SHR",
        }),
      },
    },
  },
  "eip155:8453": {
    block: FIXTURE_BLOCK_BASE,
    accounts: {
      [address]: {
        code: FIXTURE_BYTECODE,
        calls: nftCalls({
          erc721: true,
          erc1155: false,
          name: "Shared",
          symbol: "SHR",
        }),
      },
    },
  },
});

export const secretLeakSentinel = {
  provider_url: "https://rpc.example/secret-key-SUPERSECRET",
  api_key: "SUPERSECRET_RPC_KEY",
  raw_body: '{"jsonrpc":"2.0","error":{"message":"api_key=SUPERSECRET"}}',
};
