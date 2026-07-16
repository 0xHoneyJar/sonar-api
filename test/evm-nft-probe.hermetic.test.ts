/**
 * CR-103 hermetic EVM NFT probe adapter proofs.
 */
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  createEvmNftProbeAdapter,
  createFixtureEvmRpcPort,
  createKitchenIndexStatusPort,
  createScriptedIndexStatusPort,
  multiNetworkScripts,
  scriptBothInterfaces,
  scriptEip1967Proxy,
  scriptIncompleteEip1967Proxy,
  scriptEoa,
  scriptErc1155,
  scriptErc721,
  scriptHealthyRevert,
  scriptQuorumFailure,
  scriptTransportFailure,
  scriptUnknownInterface,
  scriptWithContractUri,
  FIXTURE_ADDRESS,
  FIXTURE_ADDRESS_NORMALIZED,
  FIXTURE_IMPL_ADDRESS,
  secretLeakSentinel,
  SAFE_MESSAGES,
  EVM_NFT_PROBE_ADAPTER_VERSION,
  mapRpcFailure,
  normalizeAddressOnce,
  metadataSubDeadlineAtMs,
  resolveMetadataBudgetConfig,
  DEFAULT_METADATA_BUDGET_MAX_MS,
  DEFAULT_POST_METADATA_RESERVE_MS,
  POST_METADATA_RESERVE_SAFETY_FLOOR_MS,
  type EvmMetadataBudgetConfig,
} from "../src/collection-resolver/adapters/evm/index.js";
import {
  decodeAbiBool,
  decodeAbiString,
  encodeSupportsInterface,
  ERC721_SUPPORTS_CALLDATA,
  INVALID_INTERFACE_SUPPORTS_CALLDATA,
} from "../src/collection-resolver/adapters/evm/abi.js";
import { ethereumMainnetCapability, baseMainnetCapability } from "../src/collection-resolver/capability-registry/fixtures.js";
import type { AdapterProbeRequest } from "../src/collection-resolver/bounded-core/ports.js";
import { createEvmNftProbeAdapter as createAdapter } from "../src/collection-resolver/adapters/evm/adapter.js";
import type { EvmMetadataEnrichPort } from "../src/collection-resolver/adapters/evm/ports.js";
import { evmRpcFailure } from "../src/collection-resolver/adapters/evm/ports.js";
import { codeDigestFromBytecode } from "../src/collection-resolver/adapters/evm/digests.js";
import {
  FIXTURE_BYTECODE,
  FIXTURE_IMPL_BYTECODE,
} from "../src/collection-resolver/adapters/evm/fixtures.js";
import {
  asDeadlineTimer,
  createProcessMonotonicClock,
  createVirtualClock,
  type MonotonicClock,
} from "../src/collection-resolver/bounded-core/clock.js";
import {
  hermeticResolveRequest,
  MULTI_CHAIN_EVM_ADDRESS,
  loadHermeticCapabilitySnapshot,
} from "../src/collection-resolver/bounded-core/fixtures.js";
import { resolveBounded } from "../src/collection-resolver/bounded-core/resolve-bounded.js";
import { createMemoryResolverCache } from "../src/collection-resolver/bounded-core/caching/store.js";
import { createMemoryInvalidationEdgePort } from "../src/collection-resolver/bounded-core/caching/invalidation.js";
import { createMemoryCircuitBreaker } from "../src/collection-resolver/bounded-core/circuit-breaker.js";
import { createMemoryRateLimiter } from "../src/collection-resolver/bounded-core/rate-limit.js";
import { createMemoryCoalesce } from "../src/collection-resolver/bounded-core/coalesce.js";
import { createMemoryMetrics } from "../src/collection-resolver/bounded-core/metrics.js";
import { defaultBoundedResolverConfig } from "../src/collection-resolver/bounded-core/config.js";
import type { BoundedResolverDeps } from "../src/collection-resolver/bounded-core/ports.js";
const expectSuccess = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(exit)) {
    throw new Error(`expected success, got ${String(exit.cause)}`);
  }
  return exit.value;
};

const makeAbort = (aborted = false): AbortController => {
  const c = new AbortController();
  if (aborted) c.abort("test");
  return c;
};

const virtualClock = (originMs = 1_700_000_000_000) =>
  createVirtualClock({ originMs, isoBase: "2026-07-16T12:00:00.000Z" });

const requestFor = (input: {
  readonly capability?: ReturnType<typeof ethereumMainnetCapability>;
  readonly address?: string;
  readonly abort?: AbortController;
  readonly deadline_at_ms?: number;
  readonly clock?: MonotonicClock & { scheduleAt: (at_ms: number, cb: () => void) => () => void };
}): AdapterProbeRequest => {
  const capability = input.capability ?? ethereumMainnetCapability();
  const abort = input.abort ?? makeAbort();
  const clock = input.clock ?? virtualClock();
  return {
    network: capability.network,
    network_capability: capability,
    address: input.address ?? FIXTURE_ADDRESS,
    abort: {
      signal: abort.signal,
      get aborted() {
        return abort.signal.aborted;
      },
    },
    deadline_at_ms: input.deadline_at_ms ?? clock.nowMs() + 5_000,
  };
};

const makeAdapter = (input: {
  readonly rpc: ReturnType<typeof createFixtureEvmRpcPort>;
  readonly indexStatus?: ReturnType<typeof createScriptedIndexStatusPort>;
  readonly metadata?: EvmMetadataEnrichPort;
  readonly metadata_budget?: EvmMetadataBudgetConfig;
  readonly clock?: MonotonicClock & { scheduleAt: (at_ms: number, cb: () => void) => () => void };
  readonly observedAt?: () => string;
}) => {
  const clock = input.clock ?? virtualClock();
  return createEvmNftProbeAdapter({
    rpc: input.rpc,
    indexStatus:
      input.indexStatus ??
      createScriptedIndexStatusPort({
        [`1:${FIXTURE_ADDRESS_NORMALIZED}`]: "indexed",
      }),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.metadata_budget !== undefined
      ? { metadata_budget: input.metadata_budget }
      : {}),
    clock,
    ...(input.observedAt !== undefined ? { observedAt: input.observedAt } : {}),
  });
};

const fixtureRpc = (
  scripts: Parameters<typeof createFixtureEvmRpcPort>[0],
  clock: MonotonicClock = virtualClock(),
) => createFixtureEvmRpcPort(scripts, { clock });

const runProbe = async (
  adapter: ReturnType<typeof createEvmNftProbeAdapter>,
  req: AdapterProbeRequest,
) => expectSuccess(adapter.probe(req));

const assertNoProviderLeak = (value: unknown): void => {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain("SUPERSECRET");
  expect(serialized).not.toMatch(/https?:\/\/[^\s"]+/i);
  expect(serialized).not.toContain("api_key=");
  expect(serialized).not.toContain("Authorization");
  expect(serialized).not.toContain("rpc.example");
  expect(serialized).not.toContain("alchemy");
  expect(serialized).not.toContain("infura");
};

describe("CR-103 EVM NFT probe adapter", () => {
  it("refuses malformed addresses at the adapter normalization boundary", () => {
    expect(() => normalizeAddressOnce("not-an-address")).toThrow(
      /invalid EVM address/,
    );
    expect(() => normalizeAddressOnce("0x1234")).toThrow(/invalid EVM address/);
    expect(normalizeAddressOnce(FIXTURE_ADDRESS)).toEqual({
      normalized: FIXTURE_ADDRESS_NORMALIZED,
      normalization_count: 1,
    });
  });

  it("does not turn malformed addresses into conclusive misses", async () => {
    const adapter = makeAdapter({ rpc: fixtureRpc({}) });
    const outcome = await runProbe(adapter, requestFor({ address: "0x1234" }));
    expect(outcome).toMatchObject({ kind: "unavailable", safe_code: "rpc_invalid_response" });
  });

  it("preserves an indexed Kitchen snapshot when optional job lookup fails", async () => {
    const clock = virtualClock();
    const port = createKitchenIndexStatusPort({
      reader: {
        readIndexedSnapshot: async () => ({ holderCount: 12, indexedAtMs: 1 }),
      },
      getJob: async () => {
        throw new Error("optional job store unavailable");
      },
      clock,
    });
    const status = await Effect.runPromise(
      port.lookup({
        chain_id: 1,
        normalized_address: FIXTURE_ADDRESS_NORMALIZED,
        abort: makeAbort().signal,
        deadline_at_ms: clock.nowMs() + 50,
      }),
    );
    expect(status).toBe("indexed");
  });

  it("ABI-encodes ERC-165 bytes4 arguments with right padding", () => {
    expect(encodeSupportsInterface("0x80ac58cd")).toBe(
      "0x01ffc9a780ac58cd00000000000000000000000000000000000000000000000000000000",
    );
    expect(encodeSupportsInterface("0xd9b67a26")).toBe(
      "0x01ffc9a7d9b67a2600000000000000000000000000000000000000000000000000000000",
    );
    expect(() => encodeSupportsInterface("0x1234")).toThrow(/four hex bytes/);
    expect(() => encodeSupportsInterface("0xzzzzzzzz")).toThrow(/four hex bytes/);
  });

  it("decodes only canonical ABI bool words", () => {
    expect(decodeAbiBool(`0x${"0".repeat(64)}`)).toBe(false);
    expect(decodeAbiBool(`0x${"0".repeat(63)}1`)).toBe(true);
    expect(decodeAbiBool(`0x${"0".repeat(63)}2`)).toBeUndefined();
    expect(decodeAbiBool(`0x1${"0".repeat(63)}`)).toBeUndefined();
  });

  it("rejects ABI strings containing embedded NUL bytes", () => {
    const text = Buffer.from("safe\u0000evil", "utf8");
    const offset = `${"0".repeat(62)}20`;
    const length = text.byteLength.toString(16).padStart(64, "0");
    const data = text.toString("hex").padEnd(64, "0");
    expect(decodeAbiString(`0x${offset}${length}${data}`, 64)).toBeUndefined();
    expect([...text]).toContain(0);
  });

  it("preserves case-sensitive ABI string bytes", () => {
    const text = Buffer.from("ipfs://CaseSensitiveCID/Meta.JSON", "utf8");
    const offset = `${"0".repeat(62)}20`;
    const length = text.byteLength.toString(16).padStart(64, "0");
    const data = text.toString("hex").padEnd(Math.ceil(text.byteLength / 32) * 64, "0");
    expect(decodeAbiString(`0x${offset}${length}${data}`, 128)).toBe(
      "ipfs://CaseSensitiveCID/Meta.JSON",
    );
  });

  it("treats a non-canonical RPC bool word as absent interface evidence", async () => {
    const clock = virtualClock();
    const script = scriptErc721();
    const account = script.accounts[FIXTURE_ADDRESS_NORMALIZED]!;
    const adapter = makeAdapter({
      rpc: fixtureRpc(
        {
          "eip155:1": {
            ...script,
            accounts: {
              ...script.accounts,
              [FIXTURE_ADDRESS_NORMALIZED]: {
                ...account,
                calls: {
                  ...account.calls,
                  [ERC721_SUPPORTS_CALLDATA.toLowerCase()]: {
                    kind: "success",
                    data: `0x${"0".repeat(63)}2`,
                  },
                },
              },
            },
          },
        },
        clock,
      ),
      clock,
    });

    const outcome = await runProbe(adapter, requestFor({ clock }));

    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.token_standard).toBe("unknown");
    expect(outcome.recognition).toBe("ambiguous");
    expect(outcome.binding_evidence?.standard_evidence).toMatchObject({
      token_standard: "unknown",
      evidence_quality: "unknown",
    });
    expect(outcome.binding_evidence?.standard_evidence.interface_bits).not.toContain(
      "erc165:0x80ac58cd",
    );
  });

  it("does not trust NFT interface claims from an invalid ERC-165 responder", async () => {
    const clock = virtualClock();
    const script = scriptErc721();
    const account = script.accounts[FIXTURE_ADDRESS_NORMALIZED]!;
    const adapter = makeAdapter({
      rpc: fixtureRpc(
        {
          "eip155:1": {
            ...script,
            accounts: {
              ...script.accounts,
              [FIXTURE_ADDRESS_NORMALIZED]: {
                ...account,
                calls: {
                  ...account.calls,
                  [INVALID_INTERFACE_SUPPORTS_CALLDATA.toLowerCase()]: {
                    kind: "success",
                    data: `0x${"0".repeat(63)}1`,
                  },
                },
              },
            },
          },
        },
        clock,
      ),
      clock,
    });

    const outcome = await runProbe(adapter, requestFor({ clock }));

    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.token_standard).toBe("unknown");
    expect(outcome.recognition).toBe("ambiguous");
    expect(outcome.binding_evidence?.standard_evidence.interface_bits).toEqual([]);
  });

  it("recognizes ERC-721 with binding evidence and one boundary normalization", async () => {
    const clock = virtualClock();
    const rpc = fixtureRpc({ "eip155:1": scriptErc721() }, clock);
    const adapter = makeAdapter({
      rpc,
      clock,
      observedAt: () => "2026-07-16T12:00:00Z",
    });

    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.address).toBe(FIXTURE_ADDRESS_NORMALIZED);
    expect(outcome.token_standard).toBe("erc721");
    expect(outcome.recognition).toBe("recognized");
    expect(outcome.name).toBe("Mibera");
    expect(outcome.symbol).toBe("MIB");
    expect(outcome.index_status).toBe("indexed");
    expect(outcome.report_readiness).toBe("ready");
    expect(outcome.binding_evidence).toBeDefined();
    expect(outcome.binding_evidence?.standard_evidence.evidence_quality).toBe("confirmed");
    expect(outcome.binding_evidence?.proxy_evidence.is_proxy).toBe(false);
    expect(outcome.binding_evidence?.adapter_version).toBe(EVM_NFT_PROBE_ADAPTER_VERSION);
    expect(outcome.binding_evidence?.observed_position).toMatchObject({
      family: "evm",
      block_number: "19000001",
      finality: "finalized",
    });
    expect(adapter.normalizationCount()).toBe(1);
    assertNoProviderLeak(outcome);
  });

  it("shares process monotonic clock with CR-102 — one RPC, no immediate timeout", async () => {
    const clock = createProcessMonotonicClock();
    const rpc = fixtureRpc({ "eip155:1": scriptQuorumFailure() }, clock);
    const adapter = makeAdapter({
      rpc,
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });

    const outcome = await runProbe(
      adapter,
      requestFor({ clock, deadline_at_ms: clock.nowMs() + 1_500 }),
    );

    expect(outcome.kind).not.toBe("timeout");
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.safe_code).toBe("rpc_quorum_failed");
    expect(outcome.safe_message).toBe(SAFE_MESSAGES.rpc_quorum_failed);
    expect(rpc.callLog()).toEqual(["eip155:1:resolveObservationBlock"]);
  });

  it("recognizes ERC-1155 from explicit interface evidence", async () => {
    const clock = virtualClock();
    const adapter = makeAdapter({
      rpc: fixtureRpc({ "eip155:1": scriptErc1155() }, clock),
      indexStatus: createScriptedIndexStatusPort({
        [`1:${FIXTURE_ADDRESS_NORMALIZED}`]: "missing",
      }),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.token_standard).toBe("erc1155");
    expect(outcome.recognition).toBe("recognized");
    expect(outcome.report_readiness).toBe("preparation_required");
  });

  it("treats both-interface true as unknown/ambiguous and never report-ready", async () => {
    const clock = virtualClock();
    const adapter = makeAdapter({
      rpc: fixtureRpc({ "eip155:1": scriptBothInterfaces() }, clock),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.token_standard).toBe("unknown");
    expect(outcome.recognition).toBe("ambiguous");
    expect(outcome.report_readiness).toBe("unknown");
    expect(outcome.name).toBe("Both");
  });

  it("does not let name() upgrade missing NFT interface evidence", async () => {
    const clock = virtualClock();
    const adapter = makeAdapter({
      rpc: fixtureRpc({ "eip155:1": scriptUnknownInterface() }, clock),
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.name).toBe("NotAnNft");
    expect(outcome.token_standard).toBe("unknown");
    expect(outcome.recognition).toBe("ambiguous");
    expect(outcome.report_readiness).not.toBe("ready");
  });

  it("models complete EIP-1967 proxy with implementation digest when observed", async () => {
    const clock = virtualClock();
    const adapter = makeAdapter({
      rpc: fixtureRpc({ "eip155:1": scriptEip1967Proxy() }, clock),
      indexStatus: createScriptedIndexStatusPort({
        [`1:${FIXTURE_ADDRESS_NORMALIZED}`]: "missing",
      }),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.binding_evidence?.proxy_evidence.is_proxy).toBe(true);
    expect(outcome.binding_evidence?.proxy_evidence.proxy_kind).toBe("eip1967");
    expect(outcome.binding_evidence?.proxy_evidence.implementation_digest).toBe(
      codeDigestFromBytecode(FIXTURE_IMPL_BYTECODE),
    );
    expect(JSON.stringify(outcome)).toContain("eip1967");
    expect(JSON.stringify(outcome)).not.toContain(FIXTURE_IMPL_ADDRESS.slice(2));
  });

  it("omits binding_evidence when EIP-1967 slot is nonzero but implementation incomplete", async () => {
    const clock = virtualClock();
    const adapter = makeAdapter({
      rpc: fixtureRpc({ "eip155:1": scriptIncompleteEip1967Proxy() }, clock),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.recognition).toBe("recognized");
    expect(outcome.token_standard).toBe("erc721");
    expect(outcome.binding_evidence).toBeUndefined();
    expect(
      (outcome.evidence_material as { proxy: { is_proxy: boolean } }).proxy.is_proxy,
    ).toBe(true);
  });

  it("treats healthy supportsInterface revert as absent evidence, not transport outage", async () => {
    const clock = virtualClock();
    const adapter = makeAdapter({
      rpc: fixtureRpc({ "eip155:1": scriptHealthyRevert() }, clock),
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.token_standard).toBe("unknown");
    expect(outcome.recognition).toBe("ambiguous");
    expect(outcome.name).toBe("RevertName");
  });

  it("returns conclusive miss for EOA / empty bytecode", async () => {
    const clock = virtualClock();
    const adapter = makeAdapter({
      rpc: fixtureRpc({ "eip155:1": scriptEoa() }, clock),
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome).toEqual({ kind: "miss" });
  });

  it("refuses malformed RPC bytecode before creating binding evidence", async () => {
    const clock = virtualClock();
    const script = scriptErc721();
    const account = script.accounts[FIXTURE_ADDRESS_NORMALIZED]!;
    const adapter = makeAdapter({
      rpc: fixtureRpc(
        {
          "eip155:1": {
            ...script,
            accounts: {
              ...script.accounts,
              [FIXTURE_ADDRESS_NORMALIZED]: {
                ...account,
                code: "0x0g" as `0x${string}`,
              },
            },
          },
        },
        clock,
      ),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome).toMatchObject({
      kind: "unavailable",
      safe_code: "rpc_invalid_response",
    });
    expect(JSON.stringify(outcome)).not.toContain("binding_evidence");
  });

  it("types transport failure as ProbeUnavailable with stable safe code/message", async () => {
    const clock = virtualClock();
    const adapter = makeAdapter({
      rpc: fixtureRpc({ "eip155:1": scriptTransportFailure() }, clock),
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.safe_code).toBe("rpc_transport_failed");
    expect(outcome.safe_message).toBe(SAFE_MESSAGES.rpc_transport_failed);
    assertNoProviderLeak(outcome);
  });

  it("maps dependency errors with HTTPS provider URLs to canonical diagnostics only", async () => {
    const providerUrl =
      "https://eth-mainnet.g.alchemy.com/v2/project-id-abc123/getCode?api_key=SUPERSECRET";
    const poisoned = evmRpcFailure(
      "rpc_transport_failed",
      `upstream failed contacting ${providerUrl} body={"error":"rate limit"}`,
    );
    const mapped = mapRpcFailure(poisoned);
    expect(mapped).toEqual({
      kind: "unavailable",
      safe_code: "rpc_transport_failed",
      safe_message: SAFE_MESSAGES.rpc_transport_failed,
    });
    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("alchemy.com");
    expect(serialized).not.toContain("project-id");
    expect(serialized).not.toContain("SUPERSECRET");
    expect(serialized).not.toContain("eth-mainnet");
    expect(serialized).not.toContain("/v2/");
    expect(serialized).not.toContain("getCode");

    const clock = virtualClock();
    const adapter = makeAdapter({
      rpc: fixtureRpc(
        {
          "eip155:1": {
            ...scriptErc721(),
            fail: { ethCall: poisoned },
          },
        },
        clock,
      ),
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.safe_message).toBe(SAFE_MESSAGES.rpc_transport_failed);
    assertNoProviderLeak(outcome);
  });

  it("preserves RPC-port abort diagnostics without collapsing them into timeout", () => {
    const mapped = mapRpcFailure(
      evmRpcFailure("rpc_aborted", "provider-specific abort detail"),
    );

    expect(mapped).toEqual({
      kind: "unavailable",
      safe_code: "rpc_aborted",
      safe_message: SAFE_MESSAGES.rpc_aborted,
    });
    expect(JSON.stringify(mapped)).not.toContain("provider-specific");
    expect(mapRpcFailure(evmRpcFailure("rpc_timeout", "late provider"))).toEqual({
      kind: "timeout",
    });
  });

  it("bounds a never-settling Kitchen index lookup by the shared deadline", async () => {
    const clock = virtualClock();
    const port = createKitchenIndexStatusPort({
      reader: { readIndexedSnapshot: () => new Promise(() => undefined) },
      clock,
    });
    const pending = Effect.runPromise(
      port.lookup({
        chain_id: 1,
        normalized_address: FIXTURE_ADDRESS_NORMALIZED,
        abort: makeAbort().signal,
        deadline_at_ms: clock.nowMs() + 25,
      }),
    );
    clock.advanceMs(25);
    await expect(pending).resolves.toBe("unknown");
  });

  it("rejects a hit when index lookup consumes the remaining deadline", async () => {
    const clock = virtualClock();
    const adapter = createEvmNftProbeAdapter({
      rpc: fixtureRpc({ "eip155:1": scriptErc721() }, clock),
      indexStatus: {
        lookup: () =>
          Effect.sync(() => {
            clock.advanceMs(50);
            return "indexed" as const;
          }),
      },
      clock,
    });
    const outcome = await runProbe(
      adapter,
      requestFor({ clock, deadline_at_ms: clock.nowMs() + 50 }),
    );
    expect(outcome).toEqual({ kind: "timeout" });
  });

  it("types quorum failure as unavailable without raw cause", async () => {
    const clock = virtualClock();
    const adapter = makeAdapter({
      rpc: fixtureRpc({ "eip155:1": scriptQuorumFailure() }, clock),
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome).toMatchObject({
      kind: "unavailable",
      safe_code: "rpc_quorum_failed",
      safe_message: SAFE_MESSAGES.rpc_quorum_failed,
    });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("SUPERSECRET");
    expect(serialized).not.toContain("provider");
  });

  it("degrades metadata quality on missing contractURI without erasing recognition", async () => {
    const clock = virtualClock();
    const adapter = makeAdapter({
      rpc: fixtureRpc({ "eip155:1": scriptErc721() }, clock),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.token_standard).toBe("erc721");
    expect(outcome.recognition).toBe("recognized");
    expect(outcome.metadata_quality).toBe("onchain");
  });

  it("degrades metadata on malformed/hostile remote metadata without erasing recognition", async () => {
    const clock = virtualClock();
    const metadata: EvmMetadataEnrichPort = {
      enrich: async () => ({
        metadata_quality: "partial",
        name: undefined,
        symbol: undefined,
        image: undefined,
      }),
    };
    const adapter = makeAdapter({
      rpc: fixtureRpc(
        { "eip155:1": scriptWithContractUri("https://meta.example/collection.json") },
        clock,
      ),
      metadata,
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.token_standard).toBe("erc721");
    expect(outcome.recognition).toBe("recognized");
    expect(outcome.name).toBe("Meta");
    expect(outcome.metadata_quality).toBe("onchain");
  });

  it("degrades metadata on Promise rejection without erasing recognition", async () => {
    const clock = virtualClock();
    const metadata: EvmMetadataEnrichPort = {
      enrich: async () => {
        throw new Error(
          "metadata fetch failed https://meta.provider.example/v1/project-xyz body=boom",
        );
      },
    };
    const adapter = makeAdapter({
      rpc: fixtureRpc(
        { "eip155:1": scriptWithContractUri("https://meta.example/reject.json") },
        clock,
      ),
      metadata,
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.recognition).toBe("recognized");
    expect(outcome.token_standard).toBe("erc721");
    expect(outcome.name).toBe("Meta");
    expect(outcome.metadata_quality).toBe("onchain");
    assertNoProviderLeak(outcome);
  });

  it("degrades metadata on enrich timeout without erasing recognition", async () => {
    const clock = createProcessMonotonicClock();
    let metadataAbortObserved = false;
    const metadata: EvmMetadataEnrichPort = {
      enrich: async ({ abort }) => {
        abort.addEventListener(
          "abort",
          () => {
            metadataAbortObserved = true;
          },
          { once: true },
        );
        await new Promise((r) => setTimeout(r, 250));
        return {
          metadata_quality: "external_pointer",
          name: "LateFromUri",
          symbol: "LATE",
          image: undefined,
        };
      },
    };
    const adapter = makeAdapter({
      rpc: fixtureRpc(
        { "eip155:1": scriptWithContractUri("https://meta.example/slow.json") },
        clock,
      ),
      indexStatus: createScriptedIndexStatusPort({
        [`1:${FIXTURE_ADDRESS_NORMALIZED}`]: "indexed",
      }),
      metadata,
      clock,
    });
    const outcome = await runProbe(
      adapter,
      requestFor({ clock, deadline_at_ms: clock.nowMs() + 200 }),
    );
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.recognition).toBe("recognized");
    expect(outcome.token_standard).toBe("erc721");
    expect(outcome.name).toBe("Meta");
    expect(outcome.metadata_quality).toBe("onchain");
    expect(metadataAbortObserved).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("LateFromUri");
  });

  it("applies successful remote metadata without claiming trusted image", async () => {
    const clock = virtualClock();
    const metadata: EvmMetadataEnrichPort = {
      enrich: async () => ({
        metadata_quality: "external_pointer",
        name: "FromUri",
        symbol: "URI",
        image: undefined,
      }),
    };
    const adapter = makeAdapter({
      rpc: fixtureRpc(
        { "eip155:1": scriptWithContractUri("https://meta.example/ok.json") },
        clock,
      ),
      indexStatus: createScriptedIndexStatusPort({}),
      metadata,
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.name).toBe("Meta");
    expect(outcome.image).toBeUndefined();
  });

  it("honors abort and does not apply post-abort late metadata mutation", async () => {
    const clock = virtualClock();
    const controller = makeAbort();
    let enrichStarted = false;
    let enrichCancelled = false;
    const metadata: EvmMetadataEnrichPort = {
      enrich: ({ abort }) => {
        enrichStarted = true;
        controller.abort("during-enrich");
        return new Promise((resolve) => {
          const cancel = () => {
            enrichCancelled = true;
            resolve({
              metadata_quality: "partial",
              name: undefined,
              symbol: undefined,
              image: undefined,
            });
          };
          if (abort.aborted) cancel();
          else abort.addEventListener("abort", cancel, { once: true });
        });
      },
    };
    const adapter = makeAdapter({
      rpc: fixtureRpc(
        { "eip155:1": scriptWithContractUri("https://meta.example/slow.json") },
        clock,
      ),
      indexStatus: createScriptedIndexStatusPort({}),
      metadata,
      clock,
    });
    const outcome = await Effect.runPromise(
      adapter.probe(
        requestFor({
          abort: controller,
          clock,
          deadline_at_ms: clock.nowMs() + 5_000,
        }),
      ),
    );
    expect(enrichStarted).toBe(true);
    expect(enrichCancelled).toBe(true);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.safe_code).toBe("rpc_aborted");
    }
    expect(JSON.stringify(outcome)).not.toContain("LateName");
  });

  it("returns timeout when deadline already passed", async () => {
    const clock = virtualClock(5_000);
    const adapter = makeAdapter({
      rpc: fixtureRpc({ "eip155:1": scriptErc721() }, clock),
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const outcome = await runProbe(
      adapter,
      requestFor({ clock, deadline_at_ms: 1_000 }),
    );
    expect(outcome.kind).toBe("timeout");
  });

  it("preserves chain-qualified identity for the same address on two networks", async () => {
    const clock = virtualClock();
    const scripts = multiNetworkScripts();
    const rpc = fixtureRpc(scripts, clock);
    const adapter = makeAdapter({
      rpc,
      indexStatus: createScriptedIndexStatusPort({
        [`1:${FIXTURE_ADDRESS_NORMALIZED}`]: "indexed",
        [`8453:${FIXTURE_ADDRESS_NORMALIZED}`]: "missing",
      }),
      clock,
    });

    const eth = await runProbe(
      adapter,
      requestFor({ capability: ethereumMainnetCapability(), clock }),
    );
    const base = await runProbe(
      adapter,
      requestFor({ capability: baseMainnetCapability(), clock }),
    );

    expect(eth.kind).toBe("hit");
    expect(base.kind).toBe("hit");
    if (eth.kind !== "hit" || base.kind !== "hit") return;

    expect(eth.address).toBe(base.address);
    expect(eth.binding_evidence?.observed_position).toMatchObject({
      block_number: "19000001",
    });
    expect(base.binding_evidence?.observed_position).toMatchObject({
      block_number: "20000001",
    });
    expect(eth.index_status).toBe("indexed");
    expect(base.index_status).toBe("missing");
    expect((eth.evidence_material as { network_key: string }).network_key).toBe("eip155:1");
    expect((base.evidence_material as { network_key: string }).network_key).toBe(
      "eip155:8453",
    );
    expect(adapter.normalizationCount()).toBe(2);
  });

  it.each(["missing", "failed", "unknown"] as const)(
    "clamps %s Kitchen status to unsupported on a recognize-only network",
    async (observedIndex) => {
      const clock = virtualClock();
      const capability = {
        ...ethereumMainnetCapability(),
        index_support: false,
      };
      const adapter = makeAdapter({
        rpc: fixtureRpc({ "eip155:1": scriptErc721() }, clock),
        indexStatus: createScriptedIndexStatusPort({
          [`1:${FIXTURE_ADDRESS_NORMALIZED}`]: observedIndex,
        }),
        clock,
      });
      const outcome = await runProbe(adapter, requestFor({ capability, clock }));
      expect(outcome.kind).toBe("hit");
      if (outcome.kind !== "hit") return;
      expect(outcome.recognition).toBe("recognized");
      expect(outcome.index_status).toBe("unsupported");
      expect(outcome.report_readiness).toBe("unsupported");
    },
  );

  it("never leaks provider URLs, credentials, or raw RPC bodies in outcomes", async () => {
    const clock = virtualClock();
    const adapter = createAdapter({
      rpc: fixtureRpc(
        {
          "eip155:1": {
            ...scriptTransportFailure(),
            fail: {
              ethCall: {
                _tag: "EvmRpcFailure",
                safe_code: "rpc_transport_failed",
                safe_message: `transport failed at ${secretLeakSentinel.provider_url}`,
              },
            },
          },
        },
        clock,
      ),
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    const outcomeOnly = JSON.stringify(outcome);
    expect(outcomeOnly).not.toContain("SUPERSECRET");
    expect(outcomeOnly).not.toContain("rpc.example");
    expect(outcomeOnly).not.toContain("api_key");
    expect(outcomeOnly).not.toContain(secretLeakSentinel.raw_body);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") {
      expect(outcome.safe_message).toBe(SAFE_MESSAGES.rpc_transport_failed);
    }
    assertNoProviderLeak(outcome);
  });

  it("does not accept solana capability rows", async () => {
    const clock = virtualClock();
    const solanaCap = ethereumMainnetCapability();
    const bad = {
      ...solanaCap,
      network: {
        schema_version: 1 as const,
        network_namespace: "solana" as const,
        network_reference: "mainnet-beta",
      },
      probe_adapter: { adapter_id: "solana_das" as const, adapter_version: "x" },
    };
    const adapter = makeAdapter({
      rpc: fixtureRpc({}, clock),
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ capability: bad as never, clock }));
    expect(outcome.kind).toBe("unavailable");
  });

  it("omits binding when observation block hash proof is incomplete", async () => {
    const clock = virtualClock();
    const adapter = makeAdapter({
      rpc: fixtureRpc(
        {
          "eip155:1": {
            ...scriptErc721(),
            block: {
              block_number: 1n,
              block_hash: "0xdead" as `0x${string}`,
              finality: "finalized",
            },
          },
        },
        clock,
      ),
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.binding_evidence).toBeUndefined();
    expect(outcome.recognition).toBe("recognized");
  });

  it("uses bytecode digest in binding — never raw bytecode in evidence", async () => {
    const clock = virtualClock();
    const adapter = makeAdapter({
      rpc: fixtureRpc({ "eip155:1": scriptErc721() }, clock),
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const outcome = await runProbe(adapter, requestFor({ clock }));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.binding_evidence?.code_digest).toBe(
      codeDigestFromBytecode(FIXTURE_BYTECODE),
    );
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(FIXTURE_BYTECODE.slice(2));
  });

  it("skips metadata immediately when reserve would not fit before outer deadline", async () => {
    const clock = createProcessMonotonicClock();
    let enrichCalls = 0;
    const metadata: EvmMetadataEnrichPort = {
      enrich: async () => {
        enrichCalls += 1;
        return {
          metadata_quality: "external_pointer",
          name: "ShouldNotApply",
          symbol: "NO",
          image: undefined,
        };
      },
    };
    const adapter = makeAdapter({
      rpc: fixtureRpc(
        { "eip155:1": scriptWithContractUri("https://meta.example/tight.json") },
        clock,
      ),
      indexStatus: createScriptedIndexStatusPort({
        [`1:${FIXTURE_ADDRESS_NORMALIZED}`]: "indexed",
      }),
      metadata,
      // Large reserve relative to a tight outer deadline → skip enrich.
      metadata_budget: {
        max_ms: 200,
        fraction: 1,
        post_metadata_reserve_ms: 5_000,
      },
      clock,
    });
    const started = clock.nowMs();
    const deadline = started + 80;
    const outcome = await runProbe(
      adapter,
      requestFor({ clock, deadline_at_ms: deadline }),
    );
    const elapsed = clock.nowMs() - started;
    expect(enrichCalls).toBe(0);
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.recognition).toBe("recognized");
    expect(outcome.metadata_quality).toBe("onchain");
    expect(elapsed).toBeLessThan(80);
    expect(JSON.stringify(outcome)).not.toContain("ShouldNotApply");
  });

  it("metadata sub-budget ends before request deadline under defaults", () => {
    const config = resolveMetadataBudgetConfig();
    const now = 1_000;
    const requestDeadline = now + 1_500;
    const sub = metadataSubDeadlineAtMs({
      now_ms: now,
      request_deadline_at_ms: requestDeadline,
      config,
    });
    expect(sub).toBeDefined();
    if (sub === undefined) return;
    expect(sub).toBeLessThan(requestDeadline);
    expect(requestDeadline - sub).toBeGreaterThanOrEqual(DEFAULT_POST_METADATA_RESERVE_MS);
    expect(requestDeadline - sub).toBeGreaterThanOrEqual(POST_METADATA_RESERVE_SAFETY_FLOOR_MS);
    expect(sub - now).toBeLessThanOrEqual(DEFAULT_METADATA_BUDGET_MAX_MS);
  });

  it("zero reserve override cannot drop below safety floor; sub-deadline stays material", () => {
    const config = resolveMetadataBudgetConfig({
      max_ms: 10_000,
      fraction: 1,
      post_metadata_reserve_ms: 0,
    });
    expect(config.post_metadata_reserve_ms).toBe(POST_METADATA_RESERVE_SAFETY_FLOOR_MS);
    expect(config.post_metadata_reserve_ms).toBeGreaterThanOrEqual(
      POST_METADATA_RESERVE_SAFETY_FLOOR_MS,
    );

    const now = 1_000;
    const requestDeadline = now + 1_500;
    const sub = metadataSubDeadlineAtMs({
      now_ms: now,
      request_deadline_at_ms: requestDeadline,
      config,
    });
    expect(sub).toBeDefined();
    if (sub === undefined) return;
    expect(sub).toBeLessThan(requestDeadline);
    expect(requestDeadline - sub).toBeGreaterThanOrEqual(POST_METADATA_RESERVE_SAFETY_FLOOR_MS);
    // Adversarial: fraction=1 + huge max must still leave the floor gap (never equal outer).
    expect(sub).toBe(requestDeadline - POST_METADATA_RESERVE_SAFETY_FLOOR_MS);
  });

  it("tiny reserve override cannot drop below safety floor; sub-deadline stays material", () => {
    const config = resolveMetadataBudgetConfig({
      max_ms: 10_000,
      fraction: 1,
      post_metadata_reserve_ms: 1,
    });
    expect(config.post_metadata_reserve_ms).toBe(POST_METADATA_RESERVE_SAFETY_FLOOR_MS);

    const now = 2_000;
    const requestDeadline = now + 1_500;
    const sub = metadataSubDeadlineAtMs({
      now_ms: now,
      request_deadline_at_ms: requestDeadline,
      config,
    });
    expect(sub).toBeDefined();
    if (sub === undefined) return;
    expect(sub).toBeLessThan(requestDeadline);
    expect(requestDeadline - sub).toBeGreaterThanOrEqual(POST_METADATA_RESERVE_SAFETY_FLOOR_MS);
  });

  it("operator may raise reserve above the safety floor", () => {
    const raised = 120;
    const config = resolveMetadataBudgetConfig({
      post_metadata_reserve_ms: raised,
    });
    expect(config.post_metadata_reserve_ms).toBe(raised);
    expect(config.post_metadata_reserve_ms).toBeGreaterThan(POST_METADATA_RESERVE_SAFETY_FLOOR_MS);
  });

  it("skips metadata when safety floor cannot fit before outer deadline", () => {
    const config = resolveMetadataBudgetConfig({
      max_ms: 10_000,
      fraction: 1,
      post_metadata_reserve_ms: 0,
    });
    expect(config.post_metadata_reserve_ms).toBe(POST_METADATA_RESERVE_SAFETY_FLOOR_MS);
    const now = 1_000;
    // Remaining equals floor → cannot leave a material gap; skip.
    const sub = metadataSubDeadlineAtMs({
      now_ms: now,
      request_deadline_at_ms: now + POST_METADATA_RESERVE_SAFETY_FLOOR_MS,
      config,
    });
    expect(sub).toBeUndefined();
  });
});

describe("CR-103 ↔ CR-102 resolver binding via EVM adapter", () => {
  const buildDeps = (input: {
    readonly scripts: Parameters<typeof createFixtureEvmRpcPort>[0];
    readonly clock?: MonotonicClock & { scheduleAt: (at_ms: number, cb: () => void) => () => void };
    readonly metadata?: EvmMetadataEnrichPort;
    readonly metadata_budget?: EvmMetadataBudgetConfig;
    readonly config?: ReturnType<typeof defaultBoundedResolverConfig>;
  }) => {
    const clock =
      input.clock ??
      createVirtualClock({ originMs: 0, isoBase: "2026-07-16T12:00:00.000Z" });
    const rpc = createFixtureEvmRpcPort(input.scripts, { clock });
    const adapter = createEvmNftProbeAdapter({
      rpc,
      indexStatus: createScriptedIndexStatusPort({
        [`1:${FIXTURE_ADDRESS_NORMALIZED}`]: "indexed",
        [`8453:${FIXTURE_ADDRESS_NORMALIZED}`]: "missing",
      }),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.metadata_budget !== undefined
        ? { metadata_budget: input.metadata_budget }
        : {}),
      clock,
    });
    const config = input.config ?? defaultBoundedResolverConfig();
    const cache = createMemoryResolverCache({ nowMs: () => clock.nowMs() });
    const edges = createMemoryInvalidationEdgePort({});
    const negativeKeys = new Set<string>();
    const wrappedCache = {
      ...cache,
      setNegative: (key: string, entry: Parameters<typeof cache.setNegative>[1]) =>
        Effect.gen(function* () {
          negativeKeys.add(key);
          yield* cache.setNegative(key, entry);
        }),
      getNegative: (key: string) =>
        Effect.gen(function* () {
          const entry = yield* cache.getNegative(key);
          if (entry !== undefined) negativeKeys.add(key);
          return entry;
        }),
    };
    const deps: BoundedResolverDeps = {
      clock,
      timer: asDeadlineTimer(clock),
      adapter,
      cache: wrappedCache,
      invalidationEdges: edges,
      circuitBreaker: createMemoryCircuitBreaker(config.circuit_breaker),
      rateLimiter: createMemoryRateLimiter({
        caller: config.caller_rate_limit,
        global: config.global_rate_limit,
      }),
      coalesce: createMemoryCoalesce({
        isNegativeCached: (key: string) => {
          const digest =
            key.startsWith("neg:") || key.startsWith("demand:")
              ? key.replace(/^(neg:|demand:)/, "")
              : key;
          return negativeKeys.has(digest);
        },
      }),
      metrics: createMemoryMetrics(),
      capabilitySnapshot: loadHermeticCapabilitySnapshot(),
    };
    return { deps, config, cache: wrappedCache, clock };
  };

  it("refuses positive/readiness cache when incomplete EIP-1967 proxy omits binding", async () => {
    const { deps, config, cache } = buildDeps({
      scripts: {
        "eip155:1": scriptIncompleteEip1967Proxy(),
        "eip155:8453": scriptEoa(),
      },
    });
    const response = await expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(response.candidates.length).toBeGreaterThan(0);
    expect(response.candidates.some((c) => c.recognition === "recognized")).toBe(true);
    expect(
      response.diagnostics.entries.some((e) => e.code === "binding_evidence_absent"),
    ).toBe(true);
    expect(cache.__debug().positive).toBe(0);
    expect(cache.__debug().readiness).toBe(0);
  });

  it("writes positive cache for complete EIP-1967 proxy binding", async () => {
    const { deps, config, cache } = buildDeps({
      scripts: {
        "eip155:1": scriptEip1967Proxy(),
        "eip155:8453": scriptEoa(),
      },
    });
    const response = await expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(response.candidates.length).toBeGreaterThan(0);
    expect(response.candidates[0]?.recognition).toBe("recognized");
    expect(cache.__debug().positive).toBeGreaterThan(0);
    expect(
      response.diagnostics.entries.some((e) => e.code === "binding_evidence_absent"),
    ).toBe(false);
  });
});

describe("CR-103 ↔ CR-102 metadata sub-budget under controlling race", () => {
  const neverSettlingMetadata = (): EvmMetadataEnrichPort => ({
    enrich: () => new Promise(() => undefined),
  });

  const slowMetadata = (delayMs: number): EvmMetadataEnrichPort => ({
    enrich: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return {
        metadata_quality: "external_pointer",
        name: "LateRemote",
        symbol: "LATE",
        image: undefined,
      };
    },
  });

  const runResolveWithMetadata = async (input: {
    readonly metadata: EvmMetadataEnrichPort;
    readonly global_deadline_ms: number;
    readonly per_network_deadline_ms: number;
    readonly metadata_budget?: EvmMetadataBudgetConfig;
  }) => {
    const clock = createProcessMonotonicClock();
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: input.global_deadline_ms,
      per_network_deadline_ms: input.per_network_deadline_ms,
      max_searched_networks: 2,
      max_concurrent_probes: 2,
    };
    const rpc = createFixtureEvmRpcPort(
      {
        "eip155:1": scriptWithContractUri("https://meta.example/race.json"),
        "eip155:8453": scriptEoa(),
      },
      { clock },
    );
    const adapter = createEvmNftProbeAdapter({
      rpc,
      indexStatus: createScriptedIndexStatusPort({
        [`1:${FIXTURE_ADDRESS_NORMALIZED}`]: "indexed",
        [`8453:${FIXTURE_ADDRESS_NORMALIZED}`]: "missing",
      }),
      metadata: input.metadata,
      ...(input.metadata_budget !== undefined
        ? { metadata_budget: input.metadata_budget }
        : {}),
      clock,
    });
    const cache = createMemoryResolverCache({ nowMs: () => clock.nowMs() });
    const edges = createMemoryInvalidationEdgePort({});
    const negativeKeys = new Set<string>();
    const wrappedCache = {
      ...cache,
      setNegative: (key: string, entry: Parameters<typeof cache.setNegative>[1]) =>
        Effect.gen(function* () {
          negativeKeys.add(key);
          yield* cache.setNegative(key, entry);
        }),
      getNegative: (key: string) =>
        Effect.gen(function* () {
          const entry = yield* cache.getNegative(key);
          if (entry !== undefined) negativeKeys.add(key);
          return entry;
        }),
    };
    const deps: BoundedResolverDeps = {
      clock,
      timer: asDeadlineTimer(clock),
      adapter,
      cache: wrappedCache,
      invalidationEdges: edges,
      circuitBreaker: createMemoryCircuitBreaker(config.circuit_breaker),
      rateLimiter: createMemoryRateLimiter({
        caller: config.caller_rate_limit,
        global: config.global_rate_limit,
      }),
      coalesce: createMemoryCoalesce({
        isNegativeCached: (key: string) => {
          const digest =
            key.startsWith("neg:") || key.startsWith("demand:")
              ? key.replace(/^(neg:|demand:)/, "")
              : key;
          return negativeKeys.has(digest);
        },
      }),
      metrics: createMemoryMetrics(),
      capabilitySnapshot: loadHermeticCapabilitySnapshot(),
    };
    const started = clock.nowMs();
    const response = await expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    const elapsed = clock.nowMs() - started;
    return { response, elapsed, cache: wrappedCache, config };
  };

  const assertRecognizedDegradedBeforeDeadline = (input: {
    readonly response: Awaited<ReturnType<typeof runResolveWithMetadata>>["response"];
    readonly elapsed: number;
    readonly cache: Awaited<ReturnType<typeof runResolveWithMetadata>>["cache"];
    readonly deadline_ms: number;
  }) => {
    const recognized = input.response.candidates.filter((c) => c.recognition === "recognized");
    expect(recognized).toHaveLength(1);
    expect(recognized[0]?.metadata_quality).toBe("onchain");
    expect(recognized[0]?.identity.name).toBe("Meta");
    expect(JSON.stringify(input.response)).not.toContain("LateRemote");
    // Prompt completion before the configured outer deadline (CR-102 race included).
    expect(input.elapsed).toBeLessThan(input.deadline_ms);
    // Truthful cache: complete binding → positive write; partial metadata does not erase recognition.
    expect(input.cache.__debug().positive).toBeGreaterThan(0);
    expect(input.response.diagnostics.timed_out).toHaveLength(0);
    expect(input.response.candidates.some((c) => c.recognition === "recognized")).toBe(true);
  };

  it("default deadlines: slow metadata returns recognized degraded hit before outer race", async () => {
    const { response, elapsed, cache, config } = await runResolveWithMetadata({
      metadata: slowMetadata(2_000),
      global_deadline_ms: defaultBoundedResolverConfig().global_deadline_ms,
      per_network_deadline_ms: defaultBoundedResolverConfig().per_network_deadline_ms,
    });
    assertRecognizedDegradedBeforeDeadline({
      response,
      elapsed,
      cache,
      deadline_ms: config.per_network_deadline_ms,
    });
  });

  it("default deadlines: never-settling metadata returns recognized degraded hit before outer race", async () => {
    const { response, elapsed, cache, config } = await runResolveWithMetadata({
      metadata: neverSettlingMetadata(),
      global_deadline_ms: defaultBoundedResolverConfig().global_deadline_ms,
      per_network_deadline_ms: defaultBoundedResolverConfig().per_network_deadline_ms,
    });
    assertRecognizedDegradedBeforeDeadline({
      response,
      elapsed,
      cache,
      deadline_ms: config.per_network_deadline_ms,
    });
  });

  it("short deadlines: slow metadata returns recognized degraded hit before outer race", async () => {
    const { response, elapsed, cache, config } = await runResolveWithMetadata({
      metadata: slowMetadata(2_000),
      global_deadline_ms: 250,
      per_network_deadline_ms: 200,
    });
    assertRecognizedDegradedBeforeDeadline({
      response,
      elapsed,
      cache,
      deadline_ms: config.per_network_deadline_ms,
    });
  });

  it("short deadlines: never-settling metadata returns recognized degraded hit before outer race", async () => {
    const { response, elapsed, cache, config } = await runResolveWithMetadata({
      metadata: neverSettlingMetadata(),
      global_deadline_ms: 250,
      per_network_deadline_ms: 200,
    });
    assertRecognizedDegradedBeforeDeadline({
      response,
      elapsed,
      cache,
      deadline_ms: config.per_network_deadline_ms,
    });
  });

  it("zero reserve override + fraction 1 + never-settling metadata: recognized degraded before outer race", async () => {
    const { response, elapsed, cache, config } = await runResolveWithMetadata({
      metadata: neverSettlingMetadata(),
      global_deadline_ms: defaultBoundedResolverConfig().global_deadline_ms,
      per_network_deadline_ms: defaultBoundedResolverConfig().per_network_deadline_ms,
      metadata_budget: {
        max_ms: 10_000,
        fraction: 1,
        post_metadata_reserve_ms: 0,
      },
    });
    // Floor still applied at resolve time.
    expect(
      resolveMetadataBudgetConfig({
        max_ms: 10_000,
        fraction: 1,
        post_metadata_reserve_ms: 0,
      }).post_metadata_reserve_ms,
    ).toBeGreaterThanOrEqual(POST_METADATA_RESERVE_SAFETY_FLOOR_MS);
    assertRecognizedDegradedBeforeDeadline({
      response,
      elapsed,
      cache,
      deadline_ms: config.per_network_deadline_ms,
    });
  });

  it("tiny reserve override + fraction 1 + never-settling metadata: recognized degraded before outer race", async () => {
    const { response, elapsed, cache, config } = await runResolveWithMetadata({
      metadata: neverSettlingMetadata(),
      global_deadline_ms: defaultBoundedResolverConfig().global_deadline_ms,
      per_network_deadline_ms: defaultBoundedResolverConfig().per_network_deadline_ms,
      metadata_budget: {
        max_ms: 10_000,
        fraction: 1,
        post_metadata_reserve_ms: 1,
      },
    });
    expect(
      resolveMetadataBudgetConfig({
        max_ms: 10_000,
        fraction: 1,
        post_metadata_reserve_ms: 1,
      }).post_metadata_reserve_ms,
    ).toBe(POST_METADATA_RESERVE_SAFETY_FLOOR_MS);
    assertRecognizedDegradedBeforeDeadline({
      response,
      elapsed,
      cache,
      deadline_ms: config.per_network_deadline_ms,
    });
  });

  it("zero reserve override + fraction 1 + slow metadata: recognized degraded before outer race", async () => {
    const { response, elapsed, cache, config } = await runResolveWithMetadata({
      metadata: slowMetadata(2_000),
      global_deadline_ms: defaultBoundedResolverConfig().global_deadline_ms,
      per_network_deadline_ms: defaultBoundedResolverConfig().per_network_deadline_ms,
      metadata_budget: {
        max_ms: 10_000,
        fraction: 1,
        post_metadata_reserve_ms: 0,
      },
    });
    assertRecognizedDegradedBeforeDeadline({
      response,
      elapsed,
      cache,
      deadline_ms: config.per_network_deadline_ms,
    });
  });
});
