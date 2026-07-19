/**
 * CR-401 — Robinhood Chain mainnet (eip155:4663) capability proof.
 *
 * Hermetic G6 packet: identity, Robinhood finality, recognize/index orthogonality,
 * enable/disable registry transitions, EVM probe fixture, and honest index bounds.
 */
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  applyCapabilityRegistryTransition,
  CAPABILITY_REGISTRY_SCHEMA_VERSION,
  decodeCapabilityRegistrySnapshot,
  selectDefaultRecognizeNetworks,
  toRecognizeCapabilitySnapshot,
} from "../src/collection-resolver/capability-registry/index.js";
import {
  defaultMainnetRegistryInput,
  integrityDisabledRecognizeOp,
  integrityDisabledPrepareOp,
  robinhoodMainnetCapability,
  robinhoodRecognizeOnlyCapability,
  ROBINHOOD_CHAIN_EVIDENCE_REFERENCE,
  ROBINHOOD_MAINNET_CHAIN_ID,
  FIXTURE_EFFECTIVE_AT,
} from "../src/collection-resolver/capability-registry/testing.js";
import {
  applyIndexSupportBound,
  createEvmNftProbeAdapter,
  createFixtureEvmRpcPort,
  createScriptedIndexStatusPort,
  robinhoodChainScript,
  ROBINHOOD_FIXTURE_COLLECTION,
  ROBINHOOD_FIXTURE_COLLECTION_NORMALIZED,
  scriptEoa,
  scriptQuorumFailure,
  scriptTransportFailure,
} from "../src/collection-resolver/adapters/evm/index.js";
import { createVirtualClock } from "../src/collection-resolver/bounded-core/clock.js";
import type { NetworkCapability } from "../src/collection-resolver/capability-registry/schemas.js";
import { resolvePreparationCapability } from "../src/kitchen/capability.js";
import robinhoodEvidence from "../grimoires/loa/coordination/collection-report/robinhood-chain-evidence.json";

const expectSuccess = <A, E>(effect: Effect.Effect<A, E>): A => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isFailure(exit)) {
    throw new Error(`expected success, got ${String(exit.cause)}`);
  }
  return exit.value;
};

const withNetworks = (
  networks: NetworkCapability[],
  sequence = "1",
) => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  version: {
    registry_epoch: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    registry_sequence: sequence,
  },
  networks,
});

const audit = {
  reason_class: "catalog_update" as const,
  effective_at: FIXTURE_EFFECTIVE_AT,
  actor: { kind: "operator" as const, id: "cr-401-test-operator" },
};

describe("CR-401 Robinhood Chain network identity", () => {
  it("binds mainnet chain id 4663 from coordination evidence", () => {
    expect(robinhoodEvidence.observation.mainnet_chain_id).toBe(4663);
    expect(robinhoodEvidence.observation.testnet_chain_id).toBe(46630);
    expect(String(robinhoodEvidence.observation.mainnet_chain_id)).toBe(
      ROBINHOOD_MAINNET_CHAIN_ID,
    );
    expect(robinhoodEvidence.source_url).toBe(
      "https://docs.robinhood.com/chain/connecting/",
    );
  });

  it("declares Robinhood-specific finality (block depth, not Ethereum finalized_tag)", () => {
    const capability = robinhoodMainnetCapability();
    expect(capability.finality_policy.family).toBe("evm");
    expect(capability.finality_policy.policy_version).toBe("robinhood-finalized.v1");
    expect(capability.finality_policy.policy_version.startsWith("ethereum-")).toBe(false);
    expect(capability.finality_policy.confirmation).toEqual({
      kind: "block_depth",
      min_depth: 32,
    });
    expect(capability.finality_policy.reorg.invalidation_depth).toBe(32);
    expect(capability.source_provenance.reference).toContain(
      ROBINHOOD_CHAIN_EVIDENCE_REFERENCE,
    );
  });
});

describe("CR-401 recognize versus index declarations", () => {
  it("projects recognize-only staging with index false", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([robinhoodRecognizeOnlyCapability()], "2"),
      ),
    );
    const [projected] = toRecognizeCapabilitySnapshot(snapshot).capabilities;
    expect(projected?.recognize).toBe(true);
    expect(projected?.index).toBe(false);
    expect(snapshot.networks[0]?.index_support).toBe(false);
    expect(snapshot.networks[0]?.operations.prepare.enabled).toBe(false);
  });

  it("projects full capability with recognize and index when prepare is available", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([robinhoodMainnetCapability()], "3"),
      ),
    );
    const [projected] = toRecognizeCapabilitySnapshot(snapshot).capabilities;
    expect(projected?.recognize).toBe(true);
    expect(projected?.index).toBe(true);
    expect(snapshot.networks[0]?.index_support).toBe(true);
  });

  it("default catalog enables Robinhood in default search (CR-RECOG-RH)", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(defaultMainnetRegistryInput()),
    );
    const robinhood = snapshot.networks.find(
      (network) => network.network.network_reference === ROBINHOOD_MAINNET_CHAIN_ID,
    )!;
    expect(robinhood.kill_switch).toBe(false);
    expect(robinhood.operations.recognize.enabled).toBe(true);
    expect(robinhood.index_support).toBe(true);

    const keys = selectDefaultRecognizeNetworks(snapshot).map(
      (hit) => `${hit.network.network.network_namespace}:${hit.network.network.network_reference}`,
    );
    expect(keys).toContain("eip155:4663");
    expect(keys).not.toContain("eip155:46630");
  });

  it("admits Robinhood to default search when enabled fixture replaces disabled row", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([robinhoodMainnetCapability()], "5"),
      ),
    );
    const keys = selectDefaultRecognizeNetworks(snapshot).map(
      (hit) => `${hit.network.network.network_namespace}:${hit.network.network.network_reference}`,
    );
    expect(keys).toEqual(["eip155:4663"]);
  });
});

describe("CR-401 operator disable without deploy", () => {
  it("sequence_advance can kill-switch Robinhood after enable", () => {
    const current = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([robinhoodMainnetCapability()], "10"),
      ),
    );
    expect(selectDefaultRecognizeNetworks(current)).toHaveLength(1);

    const disabled: NetworkCapability = {
      ...robinhoodMainnetCapability(),
      kill_switch: true,
      index_support: false,
      operations: {
        recognize: integrityDisabledRecognizeOp(
          "221",
          "operator kill switch — Robinhood mainnet",
        ),
        prepare: integrityDisabledPrepareOp(
          "222",
          "operator kill switch — Robinhood mainnet",
        ),
        read_evidence: integrityDisabledPrepareOp(
          "223",
          "operator kill switch — Robinhood mainnet",
        ),
      },
    };

    const next = expectSuccess(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "11" },
          networks: [disabled],
          reason_class: "kill_switch",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
        },
      }),
    );
    expect(next.snapshot.networks[0]?.kill_switch).toBe(true);
    expect(selectDefaultRecognizeNetworks(next.snapshot)).toHaveLength(0);
    expect(
      next.snapshot.networks[0]?.operations.recognize.reason_class,
    ).toBe("kill_switch");
  });
});

describe("CR-401 EVM NFT probe fixture", () => {
  const clock = createVirtualClock({
    originMs: 1_700_000_000_000,
    isoBase: "2026-07-16T12:00:00.000Z",
  });

  const probeRobinhood = async (input: {
    readonly indexStatus: "indexed" | "missing" | "failed";
    readonly script?: ReturnType<typeof robinhoodChainScript>;
    readonly address?: `0x${string}`;
  }) => {
    const capability = robinhoodMainnetCapability();
    const address = input.address ?? ROBINHOOD_FIXTURE_COLLECTION;
    const rpc = createFixtureEvmRpcPort(
      { "eip155:4663": input.script ?? robinhoodChainScript() },
      { clock },
    );
    const adapter = createEvmNftProbeAdapter({
      rpc,
      indexStatus: createScriptedIndexStatusPort({
        [`4663:${ROBINHOOD_FIXTURE_COLLECTION_NORMALIZED}`]: input.indexStatus,
      }),
      clock,
    });
    const abort = new AbortController();
    return Effect.runPromise(
      adapter.probe({
        network: capability.network,
        network_capability: capability,
        address,
        abort: {
          signal: abort.signal,
          get aborted() {
            return abort.signal.aborted;
          },
        },
        clock,
        deadline_at_ms: clock.nowMs() + 5_000,
      }),
    );
  };

  it("recognizes controlled ERC-721 deployment with indexed status", async () => {
    const hit = await probeRobinhood({ indexStatus: "indexed" });
    expect(hit.kind).toBe("hit");
    if (hit.kind !== "hit") return;
    expect(hit.token_standard).toBe("erc721");
    expect(hit.name).toBe("Robinhood Fixture Collection");
    expect(hit.index_status).toBe("indexed");
    expect(hit.report_readiness).toBe("ready");
  });

  it("truthfully reports missing index when Kitchen has no snapshot", async () => {
    const hit = await probeRobinhood({ indexStatus: "missing" });
    expect(hit.kind).toBe("hit");
    if (hit.kind !== "hit") return;
    expect(hit.index_status).toBe("missing");
    expect(hit.report_readiness).toBe("preparation_required");
  });

  it("bounds index claims when capability index_support is false", () => {
    expect(applyIndexSupportBound("indexed", false)).toBe("unsupported");
    expect(applyIndexSupportBound("missing", false)).toBe("unsupported");
  });

  it("misses EOA addresses and surfaces transport failures", async () => {
    const capability = robinhoodMainnetCapability();
    const rpcMiss = createFixtureEvmRpcPort(
      { "eip155:4663": scriptEoa(ROBINHOOD_FIXTURE_COLLECTION_NORMALIZED) },
      { clock },
    );
    const adapterMiss = createEvmNftProbeAdapter({
      rpc: rpcMiss,
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const abort = new AbortController();
    const miss = await Effect.runPromise(
      adapterMiss.probe({
        network: capability.network,
        network_capability: capability,
        address: ROBINHOOD_FIXTURE_COLLECTION,
        abort: {
          signal: abort.signal,
          get aborted() {
            return abort.signal.aborted;
          },
        },
        clock,
        deadline_at_ms: clock.nowMs() + 5_000,
      }),
    );
    expect(miss.kind).toBe("miss");

    const rpcFail = createFixtureEvmRpcPort(
      {
        "eip155:4663": scriptTransportFailure(ROBINHOOD_FIXTURE_COLLECTION_NORMALIZED),
      },
      { clock },
    );
    const adapterFail = createEvmNftProbeAdapter({
      rpc: rpcFail,
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const transport = await Effect.runPromise(
      adapterFail.probe({
        network: capability.network,
        network_capability: capability,
        address: ROBINHOOD_FIXTURE_COLLECTION,
        abort: {
          signal: abort.signal,
          get aborted() {
            return abort.signal.aborted;
          },
        },
        clock,
        deadline_at_ms: clock.nowMs() + 5_000,
      }),
    );
    expect(transport.kind).toBe("unavailable");

    const rpcQuorum = createFixtureEvmRpcPort(
      { "eip155:4663": scriptQuorumFailure() },
      { clock },
    );
    const adapterQuorum = createEvmNftProbeAdapter({
      rpc: rpcQuorum,
      indexStatus: createScriptedIndexStatusPort({}),
      clock,
    });
    const quorum = await Effect.runPromise(
      adapterQuorum.probe({
        network: capability.network,
        network_capability: capability,
        address: ROBINHOOD_FIXTURE_COLLECTION,
        abort: {
          signal: abort.signal,
          get aborted() {
            return abort.signal.aborted;
          },
        },
        clock,
        deadline_at_ms: clock.nowMs() + 5_000,
      }),
    );
    expect(quorum.kind).toBe("unavailable");
  });
});

describe("CR-401 Kitchen preparation boundary (honest production gate)", () => {
  it("keeps Kitchen prepare disabled until RH sidecar canary (contract truth)", async () => {
    const preparation = await resolvePreparationCapability({
      network: {
        schema_version: 1,
        network_namespace: "eip155",
        network_reference: ROBINHOOD_MAINNET_CHAIN_ID,
      },
      tokenStandard: "erc721",
    });
    expect(preparation).toMatchObject({
      enabled: false,
      health: "disabled",
      reasonClass: "supply_lane_pending",
      prepareAdapterId: "belt.evm-erc721.robinhood-sidecar",
      prepareAdapterVersion: "rh-hyperindex-sidecar.v1",
      finalityPolicyVersion: "robinhood-finalized.v1",
    });
  });
});
