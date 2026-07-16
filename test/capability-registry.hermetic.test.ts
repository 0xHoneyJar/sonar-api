import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_REGISTRY_SCHEMA_VERSION,
  EvmFinalityPolicy,
  INITIAL_SOURCE_SEQUENCE,
  SolanaFinalityPolicy,
  UINT64_MAX,
  UINT64_ZERO,
  applyCapabilityRegistryTransition,
  assertFrozen,
  buildBaselineMaterial,
  compareDecimalUint64,
  compareSnapshotIdentities,
  createHermeticBaselineSignatureVerifier,
  decodeCapabilityRegistrySnapshot,
  defaultMainnetRegistryInput,
  degradedPrepareOp,
  degradedRecognizeOp,
  ethereumMainnetCapability,
  getSnapshotIdentity,
  hermeticBaselineSignatureHex,
  hermeticResolverRegistryInput,
  lookupNetwork,
  makeEpochResetBaseline,
  projectOrderingCapabilityViews,
  rejectAllBaselineSignatures,
  robinhoodDisabledCapability,
  robinhoodRecognizeOnlyCapability,
  selectDefaultRecognizeNetworks,
  selectDiagnosticRecognizeNetworks,
  solanaMainnetCapability,
  toRecognizeCapabilitySnapshot,
  availableOp,
  disabledPrepareOp,
  baseMainnetCapability,
  withInitialSourceSequences,
  FIXTURE_EFFECTIVE_AT,
  type NetworkCapability,
} from "../src/collection-resolver/capability-registry/index.js";
import { classifyCollectionIdentifier } from "../src/collection-resolver/identifier.js";

const expectSuccess = <A, E>(effect: Effect.Effect<A, E>): A => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isFailure(exit)) {
    throw new Error(`expected success, got ${String(exit.cause)}`);
  }
  return exit.value;
};

const expectFailure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) {
    throw new Error("expected failure");
  }
  const failure = exit.cause;
  if (failure._tag !== "Fail") {
    throw new Error(`expected Fail cause, got ${failure._tag}`);
  }
  return failure.error;
};

const withNetworks = (
  networks: NetworkCapability[],
  sequence = "1",
  epoch = "7c9e6679-7425-40de-944b-e07fc1f90ae7",
) => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  version: { registry_epoch: epoch, registry_sequence: sequence },
  networks,
});

const audit = {
  reason_class: "catalog_update" as const,
  effective_at: FIXTURE_EFFECTIVE_AT,
  actor: { kind: "operator" as const, id: "cr-101-test-operator" },
};

describe("CR-101 capability registry fixtures", () => {
  it("decodes representative EVM + Solana mainnets and Robinhood disabled", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(defaultMainnetRegistryInput()),
    );
    expect(snapshot.version.registry_sequence).toBe("1");
    expect(snapshot.networks.map((n) => `${n.network.network_namespace}:${n.network.network_reference}`)).toEqual([
      "eip155:80094",
      "eip155:1",
      "solana:mainnet-beta",
      "eip155:8453",
      "eip155:10",
      "eip155:42161",
      "eip155:7777777",
      "eip155:4663",
    ]);

    const robinhood = snapshot.networks.find(
      (n) => n.network.network_reference === "4663",
    )!;
    expect(robinhood.kill_switch).toBe(true);
    expect(robinhood.operations.recognize.enabled).toBe(false);
    expect(robinhood.source_provenance.kind).toBe("placeholder_until_capability");

    const solana = snapshot.networks.find(
      (n) => n.network.network_namespace === "solana",
    )!;
    expect(solana.index_support).toBe(false);
    expect(solana.operations.recognize.state).toBe("available");
    expect(solana.finality_policy.family).toBe("solana");

    const eth = snapshot.networks.find((n) => n.network.network_reference === "1")!;
    expect(eth.finality_policy.family).toBe("evm");
    expect(eth.finality_policy.policy_version).toBe("ethereum-finalized.v1");

    const base = snapshot.networks.find((n) => n.network.network_reference === "8453")!;
    expect(base.finality_policy.policy_version).toBe("base-finalized.v1");
    expect(base.finality_policy.policy_version.startsWith("ethereum-")).toBe(false);
  });

  it("accepts Robinhood recognize-only staging fixture without index", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([robinhoodRecognizeOnlyCapability()], "5"),
      ),
    );
    const rh = snapshot.networks[0]!;
    expect(rh.operations.recognize.enabled).toBe(true);
    expect(rh.index_support).toBe(false);
    expect(rh.operations.prepare.enabled).toBe(false);
  });
});

describe("CR-101 default search", () => {
  it("selects only enabled healthy mainnet recognize capabilities", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(defaultMainnetRegistryInput()),
    );
    const hits = selectDefaultRecognizeNetworks(snapshot);
    const keys = hits.map(
      (h) => `${h.network.network.network_namespace}:${h.network.network.network_reference}`,
    );
    expect(keys).not.toContain("eip155:4663");
    expect(keys).toContain("eip155:1");
    expect(keys).toContain("solana:mainnet-beta");
    expect(hits.every((h) => h.snapshot_identity === snapshot.version)).toBe(true);
    expect(hits.every((h) => h.network.environment === "mainnet")).toBe(true);
    expect(hits.every((h) => h.network.operations.recognize.state === "available")).toBe(
      true,
    );
  });

  it("kill switch and disable remove network from default search", () => {
    const live = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability(), robinhoodDisabledCapability()], "1"),
      ),
    );
    expect(
      selectDefaultRecognizeNetworks(live).map(
        (h) => h.network.network.network_reference,
      ),
    ).toEqual(["1"]);

    const ethDisabled: NetworkCapability = {
      ...ethereumMainnetCapability(),
      kill_switch: true,
      index_support: false,
      operations: {
        recognize: {
          ...ethereumMainnetCapability().operations.recognize,
          enabled: false,
          state: "disabled",
          reason_class: "kill_switch",
          reason: "operator kill switch",
          drain_policy: "cancel_and_reject",
          prior_evidence_revocation_policy: "revoke_integrity",
          normative_effects: {
            new_work: "exclude",
            queued_in_flight: "finish_or_capability_disabled",
            existing_evidence: "revoke",
          },
        },
        prepare: {
          ...ethereumMainnetCapability().operations.prepare,
          enabled: false,
          state: "disabled",
          reason_class: "kill_switch",
          reason: "operator kill switch",
          drain_policy: "cancel_and_reject",
          prior_evidence_revocation_policy: "revoke_integrity",
          normative_effects: {
            new_work: "reject",
            queued_in_flight: "finish_or_capability_disabled",
            existing_evidence: "revoke",
          },
        },
        read_evidence: {
          ...ethereumMainnetCapability().operations.read_evidence,
          enabled: false,
          state: "disabled",
          reason_class: "kill_switch",
          reason: "operator kill switch",
          drain_policy: "cancel_and_reject",
          prior_evidence_revocation_policy: "revoke_integrity",
          normative_effects: {
            new_work: "reject",
            queued_in_flight: "finish_or_capability_disabled",
            existing_evidence: "revoke",
          },
        },
      },
    };

    const killed = expectSuccess(
      decodeCapabilityRegistrySnapshot(withNetworks([ethDisabled], "2")),
    );
    expect(selectDefaultRecognizeNetworks(killed)).toEqual([]);
  });

  it("filters by identifier namespace and returns snapshot identity on lookup", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(hermeticResolverRegistryInput()),
    );
    const evmId = expectSuccess(
      classifyCollectionIdentifier("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"),
    );
    const solId = expectSuccess(
      classifyCollectionIdentifier("pyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru"),
    );
    expect(
      selectDefaultRecognizeNetworks(snapshot, evmId).every(
        (h) => h.network.network.network_namespace === "eip155",
      ),
    ).toBe(true);
    expect(
      selectDefaultRecognizeNetworks(snapshot, solId).every(
        (h) => h.network.network.network_namespace === "solana",
      ),
    ).toBe(true);

    const looked = lookupNetwork(snapshot, "eip155:1");
    expect(looked.snapshot_identity).toEqual(getSnapshotIdentity(snapshot));
    expect(looked.network?.display.display_name).toBe("Ethereum");
  });

  it("honestly projects recognize-without-index for Solana", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([solanaMainnetCapability()], "3"),
      ),
    );
    const projected = toRecognizeCapabilitySnapshot(snapshot);
    expect(projected.capabilities).toHaveLength(1);
    expect(projected.capabilities[0]!.recognize).toBe(true);
    expect(projected.capabilities[0]!.index).toBe(false);
    expect(projected.version).toEqual(snapshot.version);
  });

  it("projects index support only while prepare is enabled and available", () => {
    const baseline = expectSuccess(
      decodeCapabilityRegistrySnapshot(defaultMainnetRegistryInput()),
    );
    const baselineCapabilities = toRecognizeCapabilitySnapshot(baseline).capabilities;
    expect(
      baselineCapabilities.find(
        (capability) => capability.network.network_reference === "1",
      )?.index,
    ).toBe(true);
    expect(
      baselineCapabilities.some(
        (capability) => capability.network.network_reference === "4663",
      ),
    ).toBe(false);

    const prepareDegraded: NetworkCapability = {
      ...ethereumMainnetCapability(),
      operations: {
        ...ethereumMainnetCapability().operations,
        prepare: degradedPrepareOp("2", "indexer recovery in progress"),
      },
    };
    const degraded = expectSuccess(
      decodeCapabilityRegistrySnapshot(withNetworks([prepareDegraded], "2")),
    );
    const [projected] = toRecognizeCapabilitySnapshot(degraded).capabilities;
    expect(projected?.recognize).toBe(true);
    expect(projected?.index).toBe(false);
  });
});

describe("CR-101 validation refusals", () => {
  it("rejects zero source_sequence on direct snapshot decode", () => {
    const zeroSource: NetworkCapability = {
      ...ethereumMainnetCapability(),
      operations: {
        ...ethereumMainnetCapability().operations,
        recognize: {
          ...ethereumMainnetCapability().operations.recognize,
          source_sequence: "0",
        },
      },
    };
    const error = expectFailure(
      decodeCapabilityRegistrySnapshot(withNetworks([zeroSource], "0")),
    );
    expect(error._tag).toBe("CapabilityRegistryDecodeError");
    expect(String((error as { reason: string }).reason)).toMatch(/strict Effect Schema decode/);
  });

  it("rejects duplicate networks", () => {
    const error = expectFailure(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability(), ethereumMainnetCapability()], "1"),
      ),
    );
    expect(error._tag).toBe("CapabilityRegistryValidationError");
    expect(String((error as { reason: string }).reason)).toMatch(/duplicate network/);
  });

  it("rejects recognize disabled while prepare enabled", () => {
    const bad: NetworkCapability = {
      ...ethereumMainnetCapability(),
      operations: {
        recognize: {
          ...ethereumMainnetCapability().operations.recognize,
          enabled: false,
          state: "disabled",
          reason_class: "capability_unsupported",
          reason: "recognize off",
          drain_policy: "capability_disabled",
          prior_evidence_revocation_policy: "freshness_only",
          normative_effects: {
            new_work: "exclude",
            queued_in_flight: "finish_or_capability_disabled",
            existing_evidence: "freshness_policy",
          },
        },
        prepare: availableOp("99"),
        read_evidence: availableOp("98"),
      },
      index_support: true,
    };
    const error = expectFailure(
      decodeCapabilityRegistrySnapshot(withNetworks([bad], "1")),
    );
    expect(error._tag).toBe("CapabilityRegistryValidationError");
    expect(String((error as { reason: string }).reason)).toMatch(/recognize disabled/);
  });

  it("rejects kill-switch contradiction", () => {
    const bad: NetworkCapability = {
      ...ethereumMainnetCapability(),
      kill_switch: true,
    };
    const error = expectFailure(
      decodeCapabilityRegistrySnapshot(withNetworks([bad], "1")),
    );
    expect(error._tag).toBe("CapabilityRegistryValidationError");
    expect(String((error as { reason: string }).reason)).toMatch(/kill_switch/);
  });

  it("rejects kill-switch freshness-only / mixed / admit tuples", () => {
    const freshnessKill: NetworkCapability = {
      ...ethereumMainnetCapability(),
      kill_switch: true,
      index_support: false,
      operations: {
        recognize: {
          ...ethereumMainnetCapability().operations.recognize,
          enabled: false,
          state: "disabled",
          reason_class: "kill_switch",
          reason: "freshness kill",
          drain_policy: "capability_disabled",
          prior_evidence_revocation_policy: "freshness_only",
          normative_effects: {
            new_work: "exclude",
            queued_in_flight: "finish_or_capability_disabled",
            existing_evidence: "freshness_policy",
          },
        },
        prepare: {
          ...ethereumMainnetCapability().operations.prepare,
          enabled: false,
          state: "disabled",
          reason_class: "kill_switch",
          reason: "freshness kill",
          drain_policy: "capability_disabled",
          prior_evidence_revocation_policy: "freshness_only",
          normative_effects: {
            new_work: "reject",
            queued_in_flight: "finish_or_capability_disabled",
            existing_evidence: "freshness_policy",
          },
        },
        read_evidence: {
          ...ethereumMainnetCapability().operations.read_evidence,
          enabled: false,
          state: "disabled",
          reason_class: "kill_switch",
          reason: "freshness kill",
          drain_policy: "capability_disabled",
          prior_evidence_revocation_policy: "freshness_only",
          normative_effects: {
            new_work: "reject",
            queued_in_flight: "finish_or_capability_disabled",
            existing_evidence: "freshness_policy",
          },
        },
      },
    };
    const err = expectFailure(
      decodeCapabilityRegistrySnapshot(withNetworks([freshnessKill], "1")),
    );
    expect(err._tag).toBe("CapabilityRegistryValidationError");
    expect(String((err as { reason: string }).reason)).toMatch(
      /kill_switch|cancel_and_reject|revoke_integrity|freshness/,
    );

    const mixedKill: NetworkCapability = {
      ...ethereumMainnetCapability(),
      kill_switch: true,
      index_support: false,
      operations: {
        recognize: {
          enabled: false,
          state: "disabled",
          reason_class: "integrity_compromise",
          reason: "integrity",
          effective_at: FIXTURE_EFFECTIVE_AT,
          source_sequence: "1",
          drain_policy: "cancel_and_reject",
          prior_evidence_revocation_policy: "revoke_integrity",
          normative_effects: {
            new_work: "exclude",
            queued_in_flight: "finish_or_capability_disabled",
            existing_evidence: "revoke",
          },
          deadline: { deadline_ms: 1500, concurrency_class: "interactive" },
        },
        prepare: {
          enabled: false,
          state: "disabled",
          reason_class: "operator_policy",
          reason: "policy mixed",
          effective_at: FIXTURE_EFFECTIVE_AT,
          source_sequence: "2",
          drain_policy: "capability_disabled",
          prior_evidence_revocation_policy: "freshness_only",
          normative_effects: {
            new_work: "reject",
            queued_in_flight: "finish_or_capability_disabled",
            existing_evidence: "freshness_policy",
          },
          deadline: { deadline_ms: 1500, concurrency_class: "interactive" },
        },
        read_evidence: {
          enabled: false,
          state: "disabled",
          reason_class: "integrity_compromise",
          reason: "integrity",
          effective_at: FIXTURE_EFFECTIVE_AT,
          source_sequence: "3",
          drain_policy: "cancel_and_reject",
          prior_evidence_revocation_policy: "revoke_integrity",
          normative_effects: {
            new_work: "reject",
            queued_in_flight: "finish_or_capability_disabled",
            existing_evidence: "revoke",
          },
          deadline: { deadline_ms: 1500, concurrency_class: "interactive" },
        },
      },
    };
    const mixedErr = expectFailure(
      decodeCapabilityRegistrySnapshot(withNetworks([mixedKill], "1")),
    );
    expect(mixedErr._tag).toBe("CapabilityRegistryValidationError");
    expect(String((mixedErr as { reason: string }).reason)).toMatch(/kill_switch/);
  });

  it("rejects non-Ethereum EVM inheriting ethereum finality", () => {
    const bad: NetworkCapability = {
      ...baseMainnetCapability(),
      finality_policy: {
        ...baseMainnetCapability().finality_policy,
        policy_version: "ethereum-finalized.v1",
      },
    };
    const error = expectFailure(
      decodeCapabilityRegistrySnapshot(withNetworks([bad], "1")),
    );
    expect(error._tag).toBe("CapabilityRegistryValidationError");
    expect(String((error as { reason: string }).reason)).toMatch(/must not inherit ethereum/);
  });

  it("rejects unknown schema major and excess RPC properties", () => {
    const unknownMajor = expectFailure(
      decodeCapabilityRegistrySnapshot({
        ...defaultMainnetRegistryInput(),
        schema_version: 99,
      }),
    );
    expect(unknownMajor._tag).toBe("CapabilityRegistryDecodeError");
    expect(String((unknownMajor as { reason: string }).reason)).toMatch(/unknown .* schema major/);

    const excess = expectFailure(
      decodeCapabilityRegistrySnapshot({
        ...withNetworks([ethereumMainnetCapability()], "1"),
        rpc_url: "https://evil.example/rpc",
      }),
    );
    expect(excess._tag).toBe("CapabilityRegistryDecodeError");

    const excessNetwork = expectFailure(
      decodeCapabilityRegistrySnapshot(
        withNetworks([
          {
            ...ethereumMainnetCapability(),
            endpoint: "https://evil.example",
          } as unknown as NetworkCapability,
        ], "1"),
      ),
    );
    expect(excessNetwork._tag).toBe("CapabilityRegistryDecodeError");
  });

  it("rejects impossible enabled/disabled flag combinations", () => {
    const bad: NetworkCapability = {
      ...ethereumMainnetCapability(),
      operations: {
        ...ethereumMainnetCapability().operations,
        recognize: {
          ...availableOp("1"),
          enabled: true,
          state: "disabled",
          reason_class: "capability_unsupported",
          reason: "impossible",
          drain_policy: "capability_disabled",
          prior_evidence_revocation_policy: "freshness_only",
          normative_effects: {
            new_work: "exclude",
            queued_in_flight: "finish_or_capability_disabled",
            existing_evidence: "freshness_policy",
          },
        },
      },
    };
    const error = expectFailure(
      decodeCapabilityRegistrySnapshot(withNetworks([bad], "1")),
    );
    expect(error._tag).toBe("CapabilityRegistryValidationError");
  });

  it("rejects index_support=false with prepare available", () => {
    const bad: NetworkCapability = {
      ...solanaMainnetCapability(),
      index_support: false,
      operations: {
        recognize: availableOp("100"),
        prepare: availableOp("101"),
        read_evidence: disabledPrepareOp("102", "n/a"),
      },
    };
    const error = expectFailure(
      decodeCapabilityRegistrySnapshot(withNetworks([bad], "1")),
    );
    expect(error._tag).toBe("CapabilityRegistryValidationError");
    expect(String((error as { reason: string }).reason)).toMatch(/index_support=false/);
  });
});

describe("CR-101 probe 1 — contiguous registry sequences", () => {
  it("compares uint64 sequences exactly without floating numbers", () => {
    expect(compareDecimalUint64("9", "10")).toBe(-1);
    expect(compareDecimalUint64(UINT64_MAX, UINT64_MAX)).toBe(0);
    expect(compareDecimalUint64(UINT64_ZERO, "1")).toBe(-1);

    const overflow = expectFailure(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], "18446744073709551616"),
      ),
    );
    expect(overflow._tag).toBe("CapabilityRegistryDecodeError");

    const leadingZero = expectFailure(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], "01"),
      ),
    );
    expect(leadingZero._tag).toBe("CapabilityRegistryDecodeError");
  });

  it("rejects gaps, reuse, regression, and overflow on sequence advance", () => {
    const current = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], "5"),
      ),
    );

    const reuse = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "5" },
          networks: [ethereumMainnetCapability()],
          ...audit,
        },
      }),
    );
    expect(reuse._tag).toBe("CapabilityRegistryTransitionError");
    expect(String((reuse as { reason: string }).reason)).toMatch(/contiguous|stale|out-of-order/);

    const gap = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "7" },
          networks: [ethereumMainnetCapability()],
          ...audit,
        },
      }),
    );
    expect(gap._tag).toBe("CapabilityRegistryTransitionError");
    expect(String((gap as { reason: string }).reason)).toMatch(/contiguous/);

    const atMax = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], UINT64_MAX),
      ),
    );
    const overflow = expectFailure(
      applyCapabilityRegistryTransition({
        current: atMax,
        transition: {
          kind: "sequence_advance",
          from: atMax.version,
          to: { ...atMax.version, registry_sequence: "0" },
          networks: [ethereumMainnetCapability()],
          ...audit,
        },
      }),
    );
    expect(overflow._tag).toBe("CapabilityRegistryTransitionError");
    expect(String((overflow as { reason: string }).reason)).toMatch(/overflow|contiguous/);

    const next = expectSuccess(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "6" },
          networks: [
            {
              ...ethereumMainnetCapability(),
              operations: {
                recognize: degradedRecognizeOp("2", "rpc latency"),
                prepare: ethereumMainnetCapability().operations.prepare,
                read_evidence: ethereumMainnetCapability().operations.read_evidence,
              },
            },
          ],
          reason_class: "availability_degradation",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
        },
      }),
    );
    expect(next.snapshot.version.registry_sequence).toBe("6");
    expect(next.snapshot.networks[0]!.operations.recognize.state).toBe("degraded");
  });
});

describe("CR-101 probe 2 — cross-snapshot source sequencing", () => {
  it("requires exact next source_sequence on material change and retention when unchanged", () => {
    const current = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], "1"),
      ),
    );

    const silentAdvance = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [
            {
              ...ethereumMainnetCapability(),
              operations: {
                recognize: availableOp("2"),
                prepare: ethereumMainnetCapability().operations.prepare,
                read_evidence: ethereumMainnetCapability().operations.read_evidence,
              },
            },
          ],
          ...audit,
        },
      }),
    );
    expect(String((silentAdvance as { reason: string }).reason)).toMatch(
      /unchanged operation must retain/,
    );

    const staleMaterial = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [
            {
              ...ethereumMainnetCapability(),
              operations: {
                recognize: degradedRecognizeOp("1", "latency"),
                prepare: ethereumMainnetCapability().operations.prepare,
                read_evidence: ethereumMainnetCapability().operations.read_evidence,
              },
            },
          ],
          ...audit,
        },
      }),
    );
    expect(String((staleMaterial as { reason: string }).reason)).toMatch(
      /exact next source_sequence/,
    );

    const ok = expectSuccess(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [
            {
              ...ethereumMainnetCapability(),
              operations: {
                recognize: degradedRecognizeOp("2", "latency"),
                prepare: ethereumMainnetCapability().operations.prepare,
                read_evidence: ethereumMainnetCapability().operations.read_evidence,
              },
            },
          ],
          reason_class: "availability_degradation",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
        },
      }),
    );
    expect(ok.snapshot.networks[0]!.operations.recognize.source_sequence).toBe("2");
    expect(ok.snapshot.networks[0]!.operations.prepare.source_sequence).toBe("2");
  });

  it("requires INITIAL_SOURCE_SEQUENCE for newly introduced operations", () => {
    const current = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], "1"),
      ),
    );
    const badNew = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [
            ethereumMainnetCapability(),
            {
              ...baseMainnetCapability(),
              operations: {
                recognize: availableOp("10"),
                prepare: availableOp("11"),
                read_evidence: availableOp("12"),
              },
            },
          ],
          ...audit,
        },
      }),
    );
    expect(String((badNew as { reason: string }).reason)).toMatch(
      /INITIAL_SOURCE_SEQUENCE/,
    );

    const okNew = expectSuccess(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [
            ethereumMainnetCapability(),
            {
              ...baseMainnetCapability(),
              operations: {
                recognize: {
                  ...availableOp(INITIAL_SOURCE_SEQUENCE),
                  reason_class: "catalog_update",
                  reason: "catalog add base",
                },
                prepare: {
                  ...availableOp(INITIAL_SOURCE_SEQUENCE),
                  reason_class: "catalog_update",
                  reason: "catalog add base",
                },
                read_evidence: {
                  ...availableOp(INITIAL_SOURCE_SEQUENCE),
                  reason_class: "catalog_update",
                  reason: "catalog add base",
                },
              },
            },
          ],
          ...audit,
        },
      }),
    );
    expect(okNew.snapshot.networks).toHaveLength(2);
  });

  it("refuses physical deletion and remove/re-add source_sequence reset", () => {
    const current = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks(
          [ethereumMainnetCapability(), baseMainnetCapability()],
          "1",
        ),
      ),
    );

    const deleted = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [ethereumMainnetCapability()],
          ...audit,
        },
      }),
    );
    expect(deleted._tag).toBe("CapabilityRegistryTransitionError");
    expect(String((deleted as { reason: string }).reason)).toMatch(
      /physical deletion refused/,
    );

    const resetAttempt = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [
            ethereumMainnetCapability(),
            {
              ...baseMainnetCapability(),
              operations: {
                recognize: {
                  ...availableOp(INITIAL_SOURCE_SEQUENCE),
                  reason_class: "catalog_update",
                  reason: "illegal re-add reset",
                },
                prepare: {
                  ...availableOp(INITIAL_SOURCE_SEQUENCE),
                  reason_class: "catalog_update",
                  reason: "illegal re-add reset",
                },
                read_evidence: {
                  ...availableOp(INITIAL_SOURCE_SEQUENCE),
                  reason_class: "catalog_update",
                  reason: "illegal re-add reset",
                },
              },
            },
          ],
          ...audit,
        },
      }),
    );
    expect(String((resetAttempt as { reason: string }).reason)).toMatch(
      /exact next source_sequence|unchanged operation must retain/,
    );
  });
});

describe("CR-101 probe 3 — epoch reset binding signatures", () => {
  it("resets the default catalog while retaining every disabled operation reason", () => {
    const current = expectSuccess(
      decodeCapabilityRegistrySnapshot(defaultMainnetRegistryInput()),
    );
    const nextVersion = {
      registry_epoch: "22222222-2222-4222-8222-222222222222",
      registry_sequence: "0",
    };
    const candidateNetworks = current.networks.map(withInitialSourceSequences);

    const robinhood = candidateNetworks.find(
      (network) => network.network.network_reference === "4663",
    )!;
    expect(robinhood.kill_switch).toBe(true);
    expect(robinhood.operations.recognize.reason_class).toBe("kill_switch");
    expect(robinhood.operations.prepare.reason_class).toBe("kill_switch");
    expect(robinhood.operations.read_evidence.reason_class).toBe("kill_switch");
    for (const operation of Object.values(robinhood.operations)) {
      expect(operation.source_sequence).toBe(INITIAL_SOURCE_SEQUENCE);
    }

    const solana = candidateNetworks.find(
      (network) => network.network.network_namespace === "solana",
    )!;
    expect(solana.operations.recognize.reason_class).toBe("epoch_reset");
    expect(solana.operations.prepare.reason_class).toBe("capability_unsupported");
    expect(solana.operations.read_evidence.reason_class).toBe(
      "capability_unsupported",
    );

    const candidate = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks(
          candidateNetworks,
          nextVersion.registry_sequence,
          nextVersion.registry_epoch,
        ),
      ),
    );
    const baseline = expectSuccess(
      makeEpochResetBaseline({
        previousEpoch: current.version.registry_epoch,
        next: nextVersion,
      }),
    );
    const material = expectSuccess(buildBaselineMaterial(candidate, current.version));
    const publicKey = "aa".repeat(32);

    const reset = expectSuccess(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "epoch_reset",
          from: current.version,
          to: nextVersion,
          networks: candidateNetworks,
          baseline,
          signature: {
            algorithm: "ed25519",
            public_key_hex: publicKey,
            signature_hex: hermeticBaselineSignatureHex(
              material.binding_digest.digest,
              publicKey,
            ),
          },
          reason_class: "epoch_reset",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
        },
        signatureVerifier: createHermeticBaselineSignatureVerifier(),
      }),
    );
    expect(reset.snapshot.version).toEqual(nextVersion);
    expect(
      lookupNetwork(reset.snapshot, "eip155:4663").network!.operations.recognize
        .reason_class,
    ).toBe("kill_switch");
  });

  it("binds predecessor identity into binding_digest and rejects cross-predecessor reuse", () => {
    const current = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], "5"),
      ),
    );
    const nextVersion = {
      registry_epoch: "22222222-2222-4222-8222-222222222222",
      registry_sequence: "0",
    };
    expectFailure(compareSnapshotIdentities(current.version, nextVersion));

    const withoutSig = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "epoch_reset",
          from: current.version,
          to: nextVersion,
          networks: [withInitialSourceSequences(ethereumMainnetCapability())],
          reason_class: "epoch_reset",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
        },
        signatureVerifier: rejectAllBaselineSignatures,
      }),
    );
    expect(withoutSig._tag).toBe("CapabilityRegistryDecodeError");
    expect(String((withoutSig as { reason: string }).reason)).toMatch(
      /transition envelope failed strict decode/,
    );

    const baseline = expectSuccess(
      makeEpochResetBaseline({
        previousEpoch: current.version.registry_epoch,
        next: nextVersion,
      }),
    );
    const candidateNetworks = [withInitialSourceSequences(ethereumMainnetCapability())];
    const candidate = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks(
          candidateNetworks,
          nextVersion.registry_sequence,
          nextVersion.registry_epoch,
        ),
      ),
    );
    const material = expectSuccess(
      buildBaselineMaterial(candidate, current.version),
    );
    expect(material.previous_version).toEqual(current.version);
    expect(material.binding_digest.domain).toBe("capability.registry-baseline-binding");

    const verifier = createHermeticBaselineSignatureVerifier();
    const publicKey = "aa".repeat(32);
    const reset = expectSuccess(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "epoch_reset",
          from: current.version,
          to: nextVersion,
          networks: candidateNetworks,
          baseline,
          signature: {
            algorithm: "ed25519",
            public_key_hex: publicKey,
            signature_hex: hermeticBaselineSignatureHex(
              material.binding_digest.digest,
              publicKey,
            ),
          },
          reason_class: "epoch_reset",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
        },
        signatureVerifier: verifier,
      }),
    );
    expect(reset.snapshot.version).toEqual(nextVersion);

    // Signature over binding for predecessor A must not authorize reset from B.
    const otherCurrent = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks(
          [ethereumMainnetCapability()],
          "9",
          "33333333-3333-4333-8333-333333333333",
        ),
      ),
    );
    const forged = expectFailure(
      applyCapabilityRegistryTransition({
        current: otherCurrent,
        transition: {
          kind: "epoch_reset",
          from: otherCurrent.version,
          to: nextVersion,
          networks: candidateNetworks,
          baseline: expectSuccess(
            makeEpochResetBaseline({
              previousEpoch: otherCurrent.version.registry_epoch,
              next: nextVersion,
            }),
          ),
          signature: {
            algorithm: "ed25519",
            public_key_hex: publicKey,
            signature_hex: hermeticBaselineSignatureHex(
              material.binding_digest.digest,
              publicKey,
            ),
          },
          reason_class: "epoch_reset",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
        },
        signatureVerifier: verifier,
      }),
    );
    expect(forged._tag).toBe("CapabilityRegistrySignatureError");
  });
});

describe("CR-101 probe 4 — compatible health tuples", () => {
  it("rejects available+cancel/reject and integrity-disabled without revoke", () => {
    const availableCancel: NetworkCapability = {
      ...ethereumMainnetCapability(),
      operations: {
        ...ethereumMainnetCapability().operations,
        recognize: {
          ...availableOp("1"),
          drain_policy: "cancel_and_reject",
        },
      },
    };
    const err1 = expectFailure(
      decodeCapabilityRegistrySnapshot(withNetworks([availableCancel], "1")),
    );
    expect(err1._tag).toBe("CapabilityRegistryValidationError");

    const integrityIncomplete: NetworkCapability = {
      ...ethereumMainnetCapability(),
      operations: {
        ...ethereumMainnetCapability().operations,
        recognize: {
          ...availableOp("1"),
          enabled: false,
          state: "disabled",
          reason_class: "integrity_compromise",
          reason: "compromise",
          drain_policy: "capability_disabled",
          prior_evidence_revocation_policy: "revoke_integrity",
          normative_effects: {
            new_work: "exclude",
            queued_in_flight: "finish_or_capability_disabled",
            existing_evidence: "revoke",
          },
        },
      },
    };
    const err2 = expectFailure(
      decodeCapabilityRegistrySnapshot(withNetworks([integrityIncomplete], "1")),
    );
    expect(err2._tag).toBe("CapabilityRegistryValidationError");

    const degradedRevoke: NetworkCapability = {
      ...ethereumMainnetCapability(),
      operations: {
        ...ethereumMainnetCapability().operations,
        recognize: {
          ...degradedRecognizeOp("1", "latency"),
          prior_evidence_revocation_policy: "revoke_integrity",
        },
      },
    };
    const err3 = expectFailure(
      decodeCapabilityRegistrySnapshot(withNetworks([degradedRevoke], "1")),
    );
    expect(err3._tag).toBe("CapabilityRegistryValidationError");
  });
});

describe("CR-101 probe 5 — default healthy search vs diagnostic opt-in", () => {
  it("excludes degraded from default search and exposes them only via diagnostic API", () => {
    const current = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], "1"),
      ),
    );
    const degraded = expectSuccess(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [
            {
              ...ethereumMainnetCapability(),
              operations: {
                recognize: degradedRecognizeOp("2", "partial probe timeouts"),
                prepare: ethereumMainnetCapability().operations.prepare,
                read_evidence: ethereumMainnetCapability().operations.read_evidence,
              },
            },
          ],
          reason_class: "availability_degradation",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
        },
      }),
    );
    expect(selectDefaultRecognizeNetworks(degraded.snapshot)).toEqual([]);
    expect(
      selectDiagnosticRecognizeNetworks(degraded.snapshot, { include_degraded: true }),
    ).toHaveLength(1);
    expect(toRecognizeCapabilitySnapshot(degraded.snapshot).capabilities).toEqual([]);
  });
});

describe("CR-101 probe 6 — family-specific finality schemas", () => {
  it("rejects hybrid confirmation fields and wrong-family freshness clocks", () => {
    const strict = { errors: "all" as const, onExcessProperty: "error" as const };
    const decodeEvm = Schema.decodeUnknown(EvmFinalityPolicy, strict);
    const decodeSolana = Schema.decodeUnknown(SolanaFinalityPolicy, strict);

    const hybrid = expectFailure(
      decodeEvm({
        family: "evm",
        policy_version: "ethereum-finalized.v1",
        source_head_quorum: {
          min_agreeing_sources: 2,
          accepted_provider_set_id: "ethereum-source-head.v1",
        },
        confirmation: {
          kind: "block_depth",
          min_depth: 12,
          finalized_tag: "finalized",
        },
        reorg: { invalidation_depth: 64 },
        degradation: {
          on_quorum_loss: "degrade",
          on_freshness_breach: "partial_diagnostics",
        },
        freshness: { max_age_ms: 30_000, clock: "block_time" },
      }),
    );
    expect(hybrid).toBeTruthy();

    const wrongClock = expectFailure(
      decodeEvm({
        family: "evm",
        policy_version: "ethereum-finalized.v1",
        source_head_quorum: {
          min_agreeing_sources: 2,
          accepted_provider_set_id: "ethereum-source-head.v1",
        },
        confirmation: { kind: "finalized_tag", finalized_tag: "finalized" },
        reorg: { invalidation_depth: 64 },
        degradation: {
          on_quorum_loss: "degrade",
          on_freshness_breach: "partial_diagnostics",
        },
        freshness: { max_age_ms: 30_000, clock: "slot_time" },
      }),
    );
    expect(wrongClock).toBeTruthy();

    const solanaWrong = expectFailure(
      decodeSolana({
        family: "solana",
        policy_version: "solana-finalized.v2",
        source_head_quorum: {
          min_agreeing_sources: 1,
          accepted_provider_set_id: "solana-das-mainnet.v1",
        },
        commitment: "finalized",
        fork: {
          compare: "root_slot",
          invalidate_on_fork_divergence: true,
        },
        degradation: {
          on_quorum_loss: "degrade",
          on_freshness_breach: "partial_diagnostics",
        },
        freshness: { max_age_ms: 15_000, clock: "block_time" },
      }),
    );
    expect(solanaWrong).toBeTruthy();
  });
});

describe("CR-101 probe 7 — transition and Ordering audit fields", () => {
  it("records transition audit fields and projects effective_at/source_sequence/reason_class", () => {
    const current = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], "1"),
      ),
    );
    const transitionAt = "2026-07-16T12:00:00Z";
    const result = expectSuccess(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [
            {
              ...ethereumMainnetCapability(),
              operations: {
                recognize: {
                  ...degradedRecognizeOp("2", "partial probe timeouts"),
                  effective_at: transitionAt,
                },
                prepare: ethereumMainnetCapability().operations.prepare,
                read_evidence: ethereumMainnetCapability().operations.read_evidence,
              },
            },
          ],
          reason_class: "availability_degradation",
          effective_at: transitionAt,
          actor: { kind: "system", id: "registry-controller" },
        },
      }),
    );
    expect(result.transition_digest.domain).toBe("capability.registry-transition");
    expect(result.snapshot.networks[0]!.operations.recognize.effective_at).toBe(
      transitionAt,
    );
    expect(result.snapshot.networks[0]!.operations.recognize.reason_class).toBe(
      "availability_degradation",
    );
    // Unchanged operations retain prior audit fields.
    expect(result.snapshot.networks[0]!.operations.prepare.effective_at).toBe(
      FIXTURE_EFFECTIVE_AT,
    );
    expect(result.snapshot.networks[0]!.operations.prepare.reason_class).toBe("healthy");

    const { projection, projection_digest } = expectSuccess(
      projectOrderingCapabilityViews(result.snapshot),
    );
    expect(projection_digest.domain).toBe("capability.registry-ordering-projection");
    const recognizeView = projection.views.find((v) => v.operation === "recognize")!;
    expect(recognizeView.effective_at).toBe(transitionAt);
    expect(recognizeView.source_sequence).toBe("2");
    expect(recognizeView.reason_class).toBe("availability_degradation");

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toMatch(/rpc/i);
    expect(serialized).not.toMatch(/endpoint/i);
    expect(serialized).not.toMatch(/api[_-]?key/i);
    expect(serialized).not.toMatch(/credential/i);
    expect(serialized).not.toMatch(/display_name/);
    expect(serialized).not.toMatch(/attested_at/);
    expect(serialized).not.toMatch(/registry-controller/);
  });

  it("rejects audit timestamp mismatch, reason mismatch, malformed actor, and invalid audit fields", () => {
    const current = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], "1"),
      ),
    );

    const timestampMismatch = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [
            {
              ...ethereumMainnetCapability(),
              operations: {
                recognize: degradedRecognizeOp("2", "partial probe timeouts"),
                prepare: ethereumMainnetCapability().operations.prepare,
                read_evidence: ethereumMainnetCapability().operations.read_evidence,
              },
            },
          ],
          reason_class: "availability_degradation",
          effective_at: "2026-07-16T12:00:00Z",
          actor: { kind: "system", id: "registry-controller" },
        },
      }),
    );
    expect(timestampMismatch._tag).toBe("CapabilityRegistryTransitionError");
    expect(String((timestampMismatch as { reason: string }).reason)).toMatch(
      /effective_at must equal transition/,
    );

    const reasonMismatch = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [
            {
              ...ethereumMainnetCapability(),
              operations: {
                recognize: degradedRecognizeOp("2", "partial probe timeouts"),
                prepare: ethereumMainnetCapability().operations.prepare,
                read_evidence: ethereumMainnetCapability().operations.read_evidence,
              },
            },
          ],
          reason_class: "operator_policy",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
        },
      }),
    );
    expect(reasonMismatch._tag).toBe("CapabilityRegistryTransitionError");
    expect(String((reasonMismatch as { reason: string }).reason)).toMatch(
      /reason_class must bind/,
    );

    const epochResetReasonOnSequenceAdvance = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [
            ethereumMainnetCapability(),
            withInitialSourceSequences(robinhoodDisabledCapability()),
          ],
          reason_class: "epoch_reset",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
        },
      }),
    );
    expect(epochResetReasonOnSequenceAdvance._tag).toBe(
      "CapabilityRegistryTransitionError",
    );
    expect(
      String((epochResetReasonOnSequenceAdvance as { reason: string }).reason),
    ).toMatch(/reason_class must bind/);

    const secretActor = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [ethereumMainnetCapability()],
          reason_class: "catalog_update",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: { kind: "operator", id: "api_key-leaked-value" },
        },
      }),
    );
    expect(secretActor._tag).toBe("CapabilityRegistryDecodeError");
    expect(String((secretActor as { reason: string }).reason)).toMatch(
      /transition envelope failed strict decode/,
    );

    const excessActor = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [ethereumMainnetCapability()],
          reason_class: "catalog_update",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: {
            kind: "operator",
            id: "cr-101-test-operator",
            secret: "should-not-appear",
          },
        },
      }),
    );
    expect(excessActor._tag).toBe("CapabilityRegistryDecodeError");

    const invalidTimestamp = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [ethereumMainnetCapability()],
          reason_class: "catalog_update",
          effective_at: "2026-07-16 12:00:00",
          actor: audit.actor,
        },
      }),
    );
    expect(invalidTimestamp._tag).toBe("CapabilityRegistryDecodeError");

    const invalidReason = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [ethereumMainnetCapability()],
          reason_class: "not_a_real_reason",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
        },
      }),
    );
    expect(invalidReason._tag).toBe("CapabilityRegistryDecodeError");
  });

  it("rejects undeclared top-level envelope fields on sequence_advance and epoch_reset before signature/transition success", () => {
    const current = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], "1"),
      ),
    );

    const sequenceApiKey = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [ethereumMainnetCapability()],
          reason_class: "catalog_update",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
          api_key: "must-be-rejected",
        },
      }),
    );
    expect(sequenceApiKey._tag).toBe("CapabilityRegistryDecodeError");
    expect(String((sequenceApiKey as { reason: string }).reason)).toMatch(
      /transition envelope failed strict decode/,
    );

    const sequenceRogue = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [ethereumMainnetCapability()],
          reason_class: "catalog_update",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
          rogue: { metadata: true },
        },
      }),
    );
    expect(sequenceRogue._tag).toBe("CapabilityRegistryDecodeError");
    expect(String((sequenceRogue as { reason: string }).reason)).toMatch(
      /transition envelope failed strict decode/,
    );

    const nextVersion = {
      registry_epoch: "22222222-2222-4222-8222-222222222222",
      registry_sequence: "0",
    };
    const baseline = expectSuccess(
      makeEpochResetBaseline({
        previousEpoch: current.version.registry_epoch,
        next: nextVersion,
      }),
    );
    const candidateNetworks = [withInitialSourceSequences(ethereumMainnetCapability())];
    const candidate = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks(
          candidateNetworks,
          nextVersion.registry_sequence,
          nextVersion.registry_epoch,
        ),
      ),
    );
    const material = expectSuccess(buildBaselineMaterial(candidate, current.version));
    const verifier = createHermeticBaselineSignatureVerifier();
    const publicKey = "aa".repeat(32);
    const validSignature = {
      algorithm: "ed25519" as const,
      public_key_hex: publicKey,
      signature_hex: hermeticBaselineSignatureHex(
        material.binding_digest.digest,
        publicKey,
      ),
    };

    const epochApiKey = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "epoch_reset",
          from: current.version,
          to: nextVersion,
          networks: candidateNetworks,
          baseline,
          signature: validSignature,
          reason_class: "epoch_reset",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
          api_key: "must-be-rejected",
        },
        signatureVerifier: verifier,
      }),
    );
    expect(epochApiKey._tag).toBe("CapabilityRegistryDecodeError");
    expect(String((epochApiKey as { reason: string }).reason)).toMatch(
      /transition envelope failed strict decode/,
    );

    const epochRogue = expectFailure(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "epoch_reset",
          from: current.version,
          to: nextVersion,
          networks: candidateNetworks,
          baseline,
          signature: validSignature,
          reason_class: "epoch_reset",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
          secret: "also-must-be-rejected",
          rogue: "excess",
        },
        signatureVerifier: verifier,
      }),
    );
    expect(epochRogue._tag).toBe("CapabilityRegistryDecodeError");
    expect(String((epochRogue as { reason: string }).reason)).toMatch(
      /transition envelope failed strict decode/,
    );
  });

  it("supports integrity disable with revoke + cancel_and_reject and contiguous sequences", () => {
    const current = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], "1"),
      ),
    );
    const disabled = expectSuccess(
      applyCapabilityRegistryTransition({
        current,
        transition: {
          kind: "sequence_advance",
          from: current.version,
          to: { ...current.version, registry_sequence: "2" },
          networks: [
            {
              ...ethereumMainnetCapability(),
              kill_switch: true,
              index_support: false,
              operations: {
                recognize: {
                  enabled: false,
                  state: "disabled",
                  reason_class: "integrity_compromise",
                  reason: "security disable",
                  effective_at: FIXTURE_EFFECTIVE_AT,
                  source_sequence: "2",
                  drain_policy: "cancel_and_reject",
                  prior_evidence_revocation_policy: "revoke_integrity",
                  normative_effects: {
                    new_work: "exclude",
                    queued_in_flight: "finish_or_capability_disabled",
                    existing_evidence: "revoke",
                  },
                  deadline: {
                    deadline_ms: 1500,
                    concurrency_class: "interactive",
                  },
                },
                prepare: {
                  enabled: false,
                  state: "disabled",
                  reason_class: "integrity_compromise",
                  reason: "security disable",
                  effective_at: FIXTURE_EFFECTIVE_AT,
                  source_sequence: "3",
                  drain_policy: "cancel_and_reject",
                  prior_evidence_revocation_policy: "revoke_integrity",
                  normative_effects: {
                    new_work: "reject",
                    queued_in_flight: "finish_or_capability_disabled",
                    existing_evidence: "revoke",
                  },
                  deadline: {
                    deadline_ms: 1500,
                    concurrency_class: "interactive",
                  },
                },
                read_evidence: {
                  enabled: false,
                  state: "disabled",
                  reason_class: "integrity_compromise",
                  reason: "security disable",
                  effective_at: FIXTURE_EFFECTIVE_AT,
                  source_sequence: "4",
                  drain_policy: "cancel_and_reject",
                  prior_evidence_revocation_policy: "revoke_integrity",
                  normative_effects: {
                    new_work: "reject",
                    queued_in_flight: "finish_or_capability_disabled",
                    existing_evidence: "revoke",
                  },
                  deadline: {
                    deadline_ms: 1500,
                    concurrency_class: "interactive",
                  },
                },
              },
            },
          ],
          reason_class: "integrity_compromise",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: audit.actor,
        },
      }),
    );
    expect(selectDefaultRecognizeNetworks(disabled.snapshot)).toEqual([]);
    expect(
      disabled.snapshot.networks[0]!.operations.recognize.normative_effects
        .existing_evidence,
    ).toBe("revoke");
  });
});

describe("CR-101 Ordering projection + immutability", () => {
  it("projects admission fields only and refuses credential leakage", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(hermeticResolverRegistryInput()),
    );
    const { projection, projection_digest } = expectSuccess(
      projectOrderingCapabilityViews(snapshot),
    );
    expect(projection.snapshot_identity).toEqual(snapshot.version);
    expect(projection_digest.domain).toBe("capability.registry-ordering-projection");

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toMatch(/rpc/i);
    expect(serialized).not.toMatch(/endpoint/i);
    expect(serialized).not.toMatch(/api[_-]?key/i);
    expect(serialized).not.toMatch(/credential/i);
    expect(serialized).not.toMatch(/display_name/);
    expect(serialized).not.toMatch(/icon_identity/);
    expect(serialized).not.toMatch(/attested_at/);

    expect(projection.views.every((v) => v.finality_policy_version.length > 0)).toBe(
      true,
    );
    expect(projection.views.every((v) => v.effective_at.length > 0)).toBe(true);
    expect(projection.views.every((v) => v.reason_class.length > 0)).toBe(true);
    expect(
      projection.views.some(
        (v) =>
          v.network.network_namespace === "solana" &&
          v.operation === "recognize" &&
          v.index_support === false,
      ),
    ).toBe(true);
  });

  it("is deterministic and mutation-isolated", () => {
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(hermeticResolverRegistryInput()),
    );
    assertFrozen(snapshot);

    const first = expectSuccess(projectOrderingCapabilityViews(snapshot));
    const second = expectSuccess(projectOrderingCapabilityViews(snapshot));
    expect(first.projection_digest).toEqual(second.projection_digest);
    expect(JSON.stringify(first.projection)).toBe(JSON.stringify(second.projection));

    expect(() => {
      (snapshot as { version: { registry_sequence: string } }).version.registry_sequence =
        "999";
    }).toThrow();

    const mutableCopy = structuredClone(first.projection) as unknown as {
      views: Array<{ state: string }>;
    };
    mutableCopy.views[0] = {
      ...mutableCopy.views[0]!,
      state: "disabled",
    };
    expect(first.projection.views[0]!.state).not.toBe("disabled");
  });

  it("digest is stable for identical snapshots", () => {
    const a = expectSuccess(
      decodeCapabilityRegistrySnapshot(hermeticResolverRegistryInput()),
    );
    const b = expectSuccess(
      decodeCapabilityRegistrySnapshot(hermeticResolverRegistryInput()),
    );
    expect(a.snapshot_digest).toEqual(b.snapshot_digest);
  });
});
