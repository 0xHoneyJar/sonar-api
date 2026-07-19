/**
 * CR-RECOG-PROBE — multi-chain default recognize set + CAIP-10 qualifiers.
 *
 * Hermetic only: no placeable Ordering digests, no live RPC.
 */
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  classifyCollectionIdentifier,
  selectRecognizeCapabilities,
  type CapabilitySnapshot,
} from "../src/collection-resolver/identifier.js";
import {
  arbitrumMainnetCapability,
  baseMainnetCapability,
  berachainMainnetCapability,
  defaultLiveRecognizeNetworkCapabilities,
  defaultMainnetRegistryInput,
  ethereumMainnetCapability,
  optimismMainnetCapability,
  DEFAULT_REGISTRY_EPOCH,
} from "../src/collection-resolver/capability-registry/fixtures.js";
import {
  selectDefaultRecognizeNetworks,
} from "../src/collection-resolver/capability-registry/search.js";
import { CAPABILITY_REGISTRY_SCHEMA_VERSION } from "../src/collection-resolver/capability-registry/schemas.js";
import { decodeCapabilityRegistrySnapshot } from "../src/collection-resolver/capability-registry/snapshot.js";
import {
  createHermeticBoundedDeps,
  defaultBoundedResolverConfig,
  hermeticResolveRequest,
  resolveBounded,
} from "../src/collection-resolver/bounded-core/index.js";
import { resolveProbeRuntimeFromEnv } from "../src/kitchen/resolve-probe-runtime.js";

const expectSuccess = <A, E>(effect: Effect.Effect<A, E>): A => {
  const exit = Effect.runSyncExit(effect);
  if (exit._tag === "Failure") {
    throw new Error(`expected success, got ${String(exit.cause)}`);
  }
  return exit.value;
};

const networkKeys = (
  hits: ReturnType<typeof selectDefaultRecognizeNetworks>,
): string[] =>
  hits.map(
    (h) =>
      `${h.network.network.network_namespace}:${h.network.network.network_reference}`,
  );

describe("CR-RECOG-PROBE default live recognize set", () => {
  it("includes Eth / Base / OP / Arb / Berachain when healthy (≤8)", () => {
    const networks = defaultLiveRecognizeNetworkCapabilities();
    expect(networks.length).toBeLessThanOrEqual(8);
    expect(networks.length).toBe(5);

    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot({
        schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
        version: {
          registry_epoch: DEFAULT_REGISTRY_EPOCH,
          registry_sequence: "4",
        },
        networks,
      }),
    );

    const keys = networkKeys(selectDefaultRecognizeNetworks(snapshot));
    expect(keys).toEqual([
      "eip155:80094", // berachain priority 5
      "eip155:1",
      "eip155:8453",
      "eip155:10",
      "eip155:42161",
    ]);
    expect(keys).toContain("eip155:80094");
    expect(keys.length).toBeLessThanOrEqual(8);
  });

  it("full default catalog still surfaces Berachain for bare EVM search", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(defaultMainnetRegistryInput()),
    );
    const bare = expectSuccess(
      classifyCollectionIdentifier("0x6666397dfe9a8c469bf65dc744cb1c733416c420"),
    );
    const keys = networkKeys(selectDefaultRecognizeNetworks(snapshot, bare));
    expect(keys).toContain("eip155:80094");
    expect(keys).toContain("eip155:1");
    expect(keys).toContain("eip155:8453");
    expect(keys).toContain("eip155:10");
    expect(keys).toContain("eip155:42161");
    expect(keys.every((k) => k.startsWith("eip155:"))).toBe(true);
    expect(keys).not.toContain("eip155:4663");
  });

  it("excludes Berachain from default search when recognize is degraded", () => {
    const degradedBera = {
      ...berachainMainnetCapability(),
      operations: {
        ...berachainMainnetCapability().operations,
        recognize: {
          ...berachainMainnetCapability().operations.recognize,
          enabled: true,
          state: "degraded" as const,
          reason_class: "availability_degradation" as const,
          reason: "berachain recognize degraded",
          normative_effects: {
            new_work: "partial_diagnostics" as const,
            queued_in_flight: "follow_drain" as const,
            existing_evidence: "reuse_if_availability_degradation" as const,
          },
        },
      },
    };
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot({
        schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
        version: {
          registry_epoch: DEFAULT_REGISTRY_EPOCH,
          registry_sequence: "9",
        },
        networks: [
          degradedBera,
          ethereumMainnetCapability(),
          baseMainnetCapability(),
          optimismMainnetCapability(),
          arbitrumMainnetCapability(),
        ],
      }),
    );
    const keys = networkKeys(selectDefaultRecognizeNetworks(snapshot));
    expect(keys).not.toContain("eip155:80094");
    expect(keys).toContain("eip155:1");
  });
});

describe("CR-RECOG-PROBE CAIP-10 / chain-qualified identifiers", () => {
  it("classifies eip155:80094:0x… with Berachain qualifier", () => {
    const classified = expectSuccess(
      classifyCollectionIdentifier(
        "eip155:80094:0x6666397dfe9a8c469bf65dc744cb1c733416c420",
      ),
    );
    expect(classified.identifier.format).toBe("evm_address");
    expect(classified.identifier.raw.toLowerCase()).toBe(
      "0x6666397dfe9a8c469bf65dc744cb1c733416c420",
    );
    expect(classified.network_qualifier).toEqual({
      schema_version: 1,
      network_namespace: "eip155",
      network_reference: "80094",
    });
  });

  it("selectDefaultRecognizeNetworks honors CAIP-10 qualifier", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot({
        schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
        version: {
          registry_epoch: DEFAULT_REGISTRY_EPOCH,
          registry_sequence: "4",
        },
        networks: defaultLiveRecognizeNetworkCapabilities(),
      }),
    );
    const classified = expectSuccess(
      classifyCollectionIdentifier(
        "eip155:80094:0x6666397dfe9a8c469bf65dc744cb1c733416c420",
      ),
    );
    const keys = networkKeys(selectDefaultRecognizeNetworks(snapshot, classified));
    expect(keys).toEqual(["eip155:80094"]);
  });

  it("resolveBounded probes only the qualified chain and lists it in searched", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot({
        schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
        version: {
          registry_epoch: DEFAULT_REGISTRY_EPOCH,
          registry_sequence: "4",
        },
        networks: defaultLiveRecognizeNetworkCapabilities(),
      }),
    );
    const { deps, config } = createHermeticBoundedDeps({
      capabilitySnapshot: snapshot,
      script: {
        "eip155:1": { kind: "miss" },
        "eip155:8453": { kind: "miss" },
        "eip155:10": { kind: "miss" },
        "eip155:42161": { kind: "miss" },
        "eip155:80094": { kind: "miss" },
      } as never,
    });

    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(
          "eip155:80094:0x6666397dfe9a8c469bf65dc744cb1c733416c420",
        ),
        config: config ?? defaultBoundedResolverConfig(),
        deps,
      }),
    );

    expect(response.candidates).toEqual([]);
    expect(
      response.diagnostics.searched.map(
        (n) => `${n.network_namespace}:${n.network_reference}`,
      ),
    ).toEqual(["eip155:80094"]);
  });

  it("bare address fanout lists every searched live-default chain in diagnostics", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot({
        schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
        version: {
          registry_epoch: DEFAULT_REGISTRY_EPOCH,
          registry_sequence: "4",
        },
        networks: defaultLiveRecognizeNetworkCapabilities(),
      }),
    );
    const { deps, config } = createHermeticBoundedDeps({
      capabilitySnapshot: snapshot,
      script: {
        "eip155:1": { kind: "miss" },
        "eip155:8453": { kind: "miss" },
        "eip155:10": { kind: "miss" },
        "eip155:42161": { kind: "miss" },
        "eip155:80094": { kind: "miss" },
      } as never,
    });

    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(
          "0x6666397dfe9a8c469bf65dc744cb1c733416c420",
        ),
        config,
        deps,
      }),
    );

    const searched = response.diagnostics.searched.map(
      (n) => `${n.network_namespace}:${n.network_reference}`,
    );
    // diagnostics.searched is lexicographically sorted (sortNetworkRefs).
    expect(searched).toEqual([
      "eip155:1",
      "eip155:10",
      "eip155:42161",
      "eip155:80094",
      "eip155:8453",
    ]);
    expect(response.candidates).toEqual([]);
  });

  it("unsupported CAIP-10 chain yields no healthy capability (503 path)", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot({
        schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
        version: {
          registry_epoch: DEFAULT_REGISTRY_EPOCH,
          registry_sequence: "4",
        },
        networks: defaultLiveRecognizeNetworkCapabilities(),
      }),
    );
    const classified = expectSuccess(
      classifyCollectionIdentifier(
        "eip155:999999:0x6666397dfe9a8c469bf65dc744cb1c733416c420",
      ),
    );
    expect(selectDefaultRecognizeNetworks(snapshot, classified)).toEqual([]);

    const { deps, config } = createHermeticBoundedDeps({
      capabilitySnapshot: snapshot,
    });
    const exit = Effect.runSyncExit(
      resolveBounded({
        request: hermeticResolveRequest(
          "eip155:999999:0x6666397dfe9a8c469bf65dc744cb1c733416c420",
        ),
        config,
        deps,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("NoHealthyCapability");
  });

  it("CR-003 selectRecognizeCapabilities honors CAIP-10 qualifier", () => {
    const snapshot: CapabilitySnapshot = {
      version: {
        registry_epoch: DEFAULT_REGISTRY_EPOCH,
        registry_sequence: "1",
      },
      capabilities: defaultLiveRecognizeNetworkCapabilities().map((network) => ({
        network: network.network,
        display_name: network.display.display_name,
        environment: "mainnet" as const,
        probe_adapter: "evm_rpc" as const,
        recognize: true,
        index: network.index_support,
        supported_standards: [...network.supported_standards],
        finality_policy_version: network.finality_policy.policy_version,
        health: "available" as const,
      })),
    };
    const classified = expectSuccess(
      classifyCollectionIdentifier(
        "eip155:1:0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
      ),
    );
    const selected = selectRecognizeCapabilities(snapshot, classified);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.network.network_reference).toBe("1");
  });
});

describe("CR-RECOG-PROBE Kitchen catalog runtime", () => {
  it("catalog resolve-probe searches the multi-chain live-default set", async () => {
    const runtime = resolveProbeRuntimeFromEnv({ RESOLVER_MODE: "catalog" });
    expect(runtime.mode).toBe("catalog");
    const result = await runtime.resolve(
      "0x0000000000000000000000000000000000000001",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const searched = result.body.diagnostics.searched.map(
      (n) => `${n.network_namespace}:${n.network_reference}`,
    );
    expect(searched).toEqual([
      "eip155:1",
      "eip155:10",
      "eip155:42161",
      "eip155:80094",
      "eip155:8453",
    ]);
    expect(result.body.candidates).toEqual([]);
  });

  it("catalog accepts CAIP-10 Berachain qualifier without 503", async () => {
    const runtime = resolveProbeRuntimeFromEnv({ RESOLVER_MODE: "catalog" });
    const result = await runtime.resolve(
      "eip155:80094:0x6666397dfe9a8c469bf65dc744cb1c733416c420",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.body.diagnostics.searched.map(
        (n) => `${n.network_namespace}:${n.network_reference}`,
      ),
    ).toEqual(["eip155:80094"]);
  });
});
