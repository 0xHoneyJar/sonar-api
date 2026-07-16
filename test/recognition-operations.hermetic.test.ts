/**
 * CR-107 — Recognition observability and operator controls (hermetic).
 */
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  assertNoIdentityLeakInEvent,
  assertOperationalEventAllowlist,
  baseMainnetCapability,
  bucketCandidateCount,
  CAPABILITY_REGISTRY_SCHEMA_VERSION,
  createHermeticBoundedDeps,
  createMemoryAdmissionControl,
  createMemoryCapabilitySnapshotStore,
  createMemoryCircuitBreaker,
  createMemoryRecognitionObserver,
  createProcessMonotonicClock,
  createVirtualClock,
  decodeCapabilityRegistrySnapshot,
  defaultBoundedResolverConfig,
  ethereumMainnetCapability,
  FIXTURE_EFFECTIVE_AT,
  hermeticResolveRequest,
  loadHermeticCapabilitySnapshot,
  MULTI_CHAIN_EVM_ADDRESS,
  networkKeysFromCapabilitySnapshot,
  OPERATIONAL_EVENT_LABEL_ALLOWLIST,
  OPERATIONAL_EVENT_VALUE_ALLOWLIST,
  PYTHIANS_COLLECTION_MINT,
  RecognitionOperationalEvent,
  resolveBounded,
  ResolverAdmissionFullStopError,
  SCRIPT_EVM_ERC721,
  SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
  SCRIPT_ZERO_CANDIDATES,
  selectDefaultRecognizeNetworks,
  solanaMainnetCapability,
  type NetworkCapability,
  type RecognitionOperationalEvent as OperationalEvent,
} from "../src/collection-resolver/index.js";

const expectSuccess = <A, E>(effect: Effect.Effect<A, E>): A => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isFailure(exit)) {
    throw new Error(`expected success, got ${JSON.stringify(exit.cause)}`);
  }
  return exit.value;
};

const expectFailure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const exit = Effect.runSyncExit(effect);
  if (!Exit.isFailure(exit)) {
    throw new Error("expected failure");
  }
  const failure = exit.cause;
  if (failure._tag !== "Fail") {
    throw new Error(`expected Fail cause, got ${failure._tag}`);
  }
  return failure.error;
};

const TRANSITION_AT = "2026-07-16T12:00:00Z";

const withNetworks = (
  networks: NetworkCapability[],
  sequence = "3",
  epoch = "7c9e6679-7425-40de-944b-e07fc1f90ae7",
) => ({
  schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
  version: { registry_epoch: epoch, registry_sequence: sequence },
  networks,
});

const policyDisabledOp = (
  sourceSequence: string,
  role: "recognize" | "non_recognize",
): NetworkCapability["operations"]["recognize"] => ({
  enabled: false,
  state: "disabled",
  reason_class: "operator_policy",
  reason: "operator network disable",
  effective_at: TRANSITION_AT,
  source_sequence: sourceSequence,
  drain_policy: "capability_disabled",
  prior_evidence_revocation_policy: "freshness_only",
  normative_effects: {
    new_work: role === "recognize" ? "exclude" : "reject",
    queued_in_flight: "finish_or_capability_disabled",
    existing_evidence: "freshness_policy",
  },
  deadline: { deadline_ms: 1500, concurrency_class: "interactive" },
});

const ethereumPolicyDisabled = (): NetworkCapability => ({
  ...ethereumMainnetCapability(),
  index_support: false,
  operations: {
    recognize: policyDisabledOp("2", "recognize"),
    prepare: policyDisabledOp("3", "non_recognize"),
    read_evidence: policyDisabledOp("4", "non_recognize"),
  },
});

const disableEthereumTransition = (currentVersion: {
  readonly registry_epoch: string;
  readonly registry_sequence: string;
}) => ({
  kind: "sequence_advance" as const,
  from: currentVersion,
  to: {
    ...currentVersion,
    registry_sequence: String(BigInt(currentVersion.registry_sequence) + 1n),
  },
  networks: [
    ethereumPolicyDisabled(),
    baseMainnetCapability(),
    solanaMainnetCapability(),
  ],
  reason_class: "operator_policy" as const,
  effective_at: TRANSITION_AT,
  actor: { kind: "operator" as const, id: "cr-107-operator" },
});

const decodeEvent = Schema.decodeUnknownSync(RecognitionOperationalEvent);

const allEventShapes = (): ReadonlyArray<OperationalEvent> => [
  { kind: "resolver_demand", identifier_format: "evm_address" },
  { kind: "resolver_demand", identifier_format: "solana_public_key" },
  {
    kind: "network_outcome",
    identifier_format: "evm_address",
    network_key: "eip155:1",
    network_outcome: "hit",
    adapter_attempted: true,
  },
  {
    kind: "network_outcome",
    identifier_format: "evm_address",
    network_key: "eip155:8453",
    network_outcome: "conclusive_miss",
    adapter_attempted: true,
  },
  {
    kind: "network_outcome",
    identifier_format: "evm_address",
    network_key: "eip155:1",
    network_outcome: "unavailable",
    adapter_attempted: true,
  },
  {
    kind: "network_outcome",
    identifier_format: "evm_address",
    network_key: "eip155:1",
    network_outcome: "timeout",
    adapter_attempted: true,
  },
  {
    kind: "network_outcome",
    identifier_format: "evm_address",
    network_key: "eip155:1",
    network_outcome: "circuit_open",
    adapter_attempted: false,
  },
  {
    kind: "network_outcome",
    identifier_format: "evm_address",
    network_key: "eip155:1",
    network_outcome: "disabled",
    adapter_attempted: false,
  },
  {
    kind: "resolver_terminal",
    identifier_format: "evm_address",
    terminal_outcome: "complete",
    candidate_count_bucket: "1",
    cache_outcome: "none",
    ambiguous: false,
    role: "leader",
    latency_ms: 12,
    adapter_attempts: 1,
  },
  {
    kind: "resolver_terminal",
    identifier_format: "evm_address",
    terminal_outcome: "partial",
    candidate_count_bucket: "2_to_4",
    cache_outcome: "none",
    ambiguous: true,
    role: "leader",
    latency_ms: 40,
    adapter_attempts: 2,
  },
  {
    kind: "resolver_terminal",
    identifier_format: "evm_address",
    terminal_outcome: "zero_result",
    candidate_count_bucket: "0",
    cache_outcome: "negative_hit",
    ambiguous: false,
    role: "negative_cache",
    latency_ms: 1,
    adapter_attempts: 0,
  },
  {
    kind: "resolver_terminal",
    identifier_format: "evm_address",
    terminal_outcome: "zero_result",
    candidate_count_bucket: "0",
    cache_outcome: "none",
    ambiguous: false,
    role: "capability",
    latency_ms: 0,
    adapter_attempts: 0,
  },
  {
    kind: "resolver_terminal",
    identifier_format: "evm_address",
    terminal_outcome: "rate_limited",
    candidate_count_bucket: "0",
    cache_outcome: "none",
    ambiguous: false,
    role: "rate_limited",
    latency_ms: 0,
    adapter_attempts: 0,
  },
  {
    kind: "resolver_terminal",
    identifier_format: "evm_address",
    terminal_outcome: "full_stop",
    candidate_count_bucket: "0",
    cache_outcome: "none",
    ambiguous: false,
    role: "admission",
    latency_ms: 0,
    adapter_attempts: 0,
  },
  {
    kind: "resolver_terminal",
    identifier_format: "solana_public_key",
    terminal_outcome: "failed",
    candidate_count_bucket: "0",
    cache_outcome: "none",
    ambiguous: false,
    role: "failed",
    latency_ms: 0,
    adapter_attempts: 0,
  },
  {
    kind: "resolver_terminal",
    identifier_format: "unclassified",
    terminal_outcome: "rejected",
    candidate_count_bucket: "0",
    cache_outcome: "none",
    ambiguous: false,
    role: "failed",
    latency_ms: 0,
    adapter_attempts: 0,
  },
  {
    kind: "circuit_transition",
    network_key: "eip155:1",
    circuit_from: "closed",
    circuit_to: "open",
  },
  {
    kind: "circuit_transition",
    network_key: "eip155:1",
    circuit_from: "open",
    circuit_to: "half_open",
  },
  {
    kind: "circuit_transition",
    network_key: "eip155:1",
    circuit_from: "half_open",
    circuit_to: "closed",
  },
];

describe("CR-107 operational event matrix and redaction", () => {
  it("decodes every required event shape and enforces label allowlist", () => {
    for (const shape of allEventShapes()) {
      const decoded = decodeEvent(shape);
      assertOperationalEventAllowlist(decoded);
      assertNoIdentityLeakInEvent(decoded);
    }
    expect(OPERATIONAL_EVENT_LABEL_ALLOWLIST.length).toBeGreaterThan(5);
    expect(OPERATIONAL_EVENT_VALUE_ALLOWLIST).toEqual(
      expect.arrayContaining(["latency_ms", "adapter_attempts"]),
    );
    expect(bucketCandidateCount(0)).toBe("0");
    expect(bucketCandidateCount(1)).toBe("1");
    expect(bucketCandidateCount(3)).toBe("2_to_4");
    expect(bucketCandidateCount(8)).toBe("5_to_8");
  });

  it("refuses raw identity / address leakage in event payloads", () => {
    expect(() =>
      assertNoIdentityLeakInEvent({
        kind: "resolver_demand",
        identifier_format: "evm_address",
        // @ts-expect-error intentional excess identity field
        raw_identifier: MULTI_CHAIN_EVM_ADDRESS,
      }),
    ).toThrow(/excess|unknown field|identity/i);

    expect(() =>
      assertNoIdentityLeakInEvent({
        kind: "network_outcome",
        identifier_format: "evm_address",
        network_key: MULTI_CHAIN_EVM_ADDRESS,
        network_outcome: "hit",
        adapter_attempted: true,
      }),
    ).toThrow(/identity/i);
  });

  it("observer.record drops forged/hostile payloads without throwing", () => {
    const allow = new Set(["eip155:1", "eip155:8453", "solana:mainnet-beta"]);
    const observer = createMemoryRecognitionObserver({
      allowedNetworkKeys: allow,
    });

    expect(
      observer.record({
        kind: "resolver_demand",
        identifier_format: "evm_address",
        raw_identifier: MULTI_CHAIN_EVM_ADDRESS,
        user_id: "community-42",
      }),
    ).toMatchObject({ kind: "dropped" });

    expect(
      observer.record({
        kind: "network_outcome",
        identifier_format: "evm_address",
        network_key: MULTI_CHAIN_EVM_ADDRESS,
        network_outcome: "hit",
        adapter_attempted: true,
      }),
    ).toMatchObject({
      kind: "dropped",
      reason: expect.stringMatching(/decode|identity|network_key/),
    });

    expect(
      observer.record({
        kind: "network_outcome",
        identifier_format: "evm_address",
        network_key: "eip155:999999",
        network_outcome: "hit",
        adapter_attempted: true,
      }),
    ).toMatchObject({ kind: "dropped", reason: "network_key_refused" });

    expect(
      observer.record({
        kind: "circuit_transition",
        network_key: "https://evil.example/rpc",
        circuit_from: "closed",
        circuit_to: "open",
      }),
    ).toMatchObject({ kind: "dropped" });

    expect(
      observer.record({
        kind: "resolver_demand",
        identifier_format: "unclassified",
      }),
    ).toMatchObject({ kind: "dropped", reason: "unclassified_demand" });

    expect(
      observer.record({
        kind: "resolver_terminal",
        identifier_format: "evm_address",
        terminal_outcome: "complete",
        candidate_count_bucket: "1",
        cache_outcome: "none",
        ambiguous: false,
        role: "leader",
        latency_ms: 1,
        adapter_attempts: 1,
        coalesce_key: "demand:abc",
      }),
    ).toMatchObject({ kind: "dropped" });

    expect(observer.events()).toHaveLength(0);
    expect(observer.dropped().length).toBeGreaterThan(0);

    expect(
      observer.record({
        kind: "circuit_transition",
        network_key: "eip155:1",
        circuit_from: "closed",
        circuit_to: "open",
      }),
    ).toMatchObject({ kind: "accepted" });
    expect(observer.events()).toHaveLength(1);
  });

  it("circuit breaker transitions go through the same observer enforcement", () => {
    const allow = new Set(["eip155:1"]);
    const observer = createMemoryRecognitionObserver({
      allowedNetworkKeys: allow,
    });
    const breaker = createMemoryCircuitBreaker(
      { failure_threshold: 1, open_ms: 100, half_open_max_probes: 1 },
      { observer },
    );
    const clock = createVirtualClock({ originMs: 0 });
    expectSuccess(
      breaker.recordFailure({
        network_key: "eip155:1",
        operation: "recognize",
        now_ms: clock.nowMs(),
      }),
    );
    expect(
      observer.events().some(
        (e) => e.kind === "circuit_transition" && e.network_key === "eip155:1",
      ),
    ).toBe(true);

    observer.clear();
    expectSuccess(
      breaker.recordFailure({
        network_key: "eip155:999999",
        operation: "recognize",
        now_ms: clock.nowMs(),
      }),
    );
    expect(observer.events()).toHaveLength(0);
    expect(observer.dropped().some((d) => d.reason === "network_key_refused")).toBe(
      true,
    );
  });

  it("instruments demand, network, and terminal events without identity labels", () => {
    const { deps, observer } = createHermeticBoundedDeps({
      script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config: defaultBoundedResolverConfig(),
        deps,
      }),
    );
    expect(response.candidates.length).toBeGreaterThan(1);

    const events = observer.events();
    for (const event of events) {
      assertNoIdentityLeakInEvent(event);
      expect(JSON.stringify(event)).not.toContain(MULTI_CHAIN_EVM_ADDRESS);
      expect(JSON.stringify(event)).not.toContain("caller-a");
    }

    expect(events.some((e) => e.kind === "resolver_demand")).toBe(true);
    expect(
      events.filter((e) => e.kind === "network_outcome").length,
    ).toBeGreaterThan(0);
    const terminals = events.filter((e) => e.kind === "resolver_terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      terminal_outcome: expect.stringMatching(/complete|partial/),
      candidate_count_bucket: expect.stringMatching(/2_to_4|5_to_8/),
      ambiguous: true,
      role: "leader",
    });
    // Honest: no positive/readiness cache read path ⇒ never claim those hits.
    expect(
      terminals.every(
        (t) =>
          t.kind === "resolver_terminal" &&
          t.cache_outcome !== "positive_hit" &&
          t.cache_outcome !== "readiness_hit",
      ),
    ).toBe(true);
  });
});

describe("CR-107 circuit breaker through resolveBounded", () => {
  it("opens on synthetic unavailable, records circuit_open without adapter, recovers half_open", () => {
    const clock = createVirtualClock({ originMs: 0 });
    const snapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(withNetworks([ethereumMainnetCapability()], "3")),
    );
    const observer = createMemoryRecognitionObserver({
      allowedNetworkKeys: networkKeysFromCapabilitySnapshot(snapshot),
    });
    const config = {
      ...defaultBoundedResolverConfig(),
      max_searched_networks: 1,
      max_concurrent_probes: 1,
      circuit_breaker: {
        failure_threshold: 2,
        open_ms: 100,
        half_open_max_probes: 1,
      },
    };

    const { deps, adapter } = createHermeticBoundedDeps({
      clock,
      config,
      capabilitySnapshot: snapshot,
      observer,
      script: {
        "eip155:1": {
          kind: "unavailable",
          safe_code: "rpc_unavailable",
          safe_message: "synthetic unavailable",
        },
      },
    });
    // Rebind breaker with observer (factory already did — ensure config threshold).
    const breaker = createMemoryCircuitBreaker(config.circuit_breaker, { observer });
    const wired = { ...deps, circuitBreaker: breaker, observer };

    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps: wired,
      }),
    );
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps: wired,
      }),
    );

    expect(
      observer.events().some(
        (e) =>
          e.kind === "circuit_transition" &&
          e.circuit_from === "closed" &&
          e.circuit_to === "open",
      ),
    ).toBe(true);

    const callsAfterOpen = adapter.calls().length;
    observer.clear();
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps: wired,
      }),
    );
    expect(adapter.calls().length).toBe(callsAfterOpen);
    expect(
      observer.events().some(
        (e) => e.kind === "network_outcome" && e.network_outcome === "circuit_open",
      ),
    ).toBe(true);

    clock.advanceMs(100);
    expect(
      breaker.getState({
        network_key: "eip155:1",
        operation: "recognize",
        now_ms: clock.nowMs(),
      }),
    ).toBe("half_open");

    // Recovery probe succeeds.
    const recovering = createHermeticBoundedDeps({
      clock,
      config,
      capabilitySnapshot: snapshot,
      observer,
      script: SCRIPT_EVM_ERC721,
    });
    const recoveredDeps = {
      ...recovering.deps,
      circuitBreaker: breaker,
      observer,
      coalesce: wired.coalesce,
      cache: wired.cache,
      rateLimiter: wired.rateLimiter,
    };
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps: recoveredDeps,
      }),
    );
    expect(
      breaker.getState({
        network_key: "eip155:1",
        operation: "recognize",
        now_ms: clock.nowMs(),
      }),
    ).toBe("closed");
    expect(
      observer.events().some(
        (e) =>
          e.kind === "circuit_transition" &&
          e.circuit_to === "closed",
      ),
    ).toBe(true);
  });
});

describe("CR-107 live capability snapshot disable", () => {
  it("keys positive-cache reads to the request-pinned live snapshot", () => {
    let liveSnapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], "3"),
      ),
    );
    const capabilitySnapshotProvider = {
      current: () => liveSnapshot,
    };
    const { deps, adapter } = createHermeticBoundedDeps({
      capabilitySnapshot: liveSnapshot,
      capabilitySnapshotProvider,
      script: SCRIPT_EVM_ERC721,
    });

    const first = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config: defaultBoundedResolverConfig(),
        deps,
      }),
    );
    expect(first.capability_snapshot_version.registry_sequence).toBe("3");
    const startsAfterFirst = adapter.externalStarts();

    liveSnapshot = expectSuccess(
      decodeCapabilityRegistrySnapshot(
        withNetworks([ethereumMainnetCapability()], "4"),
      ),
    );
    const second = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config: defaultBoundedResolverConfig(),
        deps,
      }),
    );

    expect(second.capability_snapshot_version.registry_sequence).toBe("4");
    expect(adapter.externalStarts()).toBe(startsAfterFirst + 1);
  });

  it("applies valid CR-101 disable without dep reconstruction; next request skips adapter", () => {
    const initial = loadHermeticCapabilitySnapshot();
    const store = createMemoryCapabilitySnapshotStore(initial);
    const { deps, adapter, observer } = createHermeticBoundedDeps({
      capabilitySnapshot: initial,
      capabilitySnapshotProvider: store,
      script: SCRIPT_EVM_ERC721,
    });

    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config: defaultBoundedResolverConfig(),
        deps,
      }),
    );
    expect(adapter.calls()).toContain("eip155:1");
    const callsBefore = adapter.calls().length;

    const applied = expectSuccess(
      store.applyTransition({
        transition: disableEthereumTransition(store.version()),
      }),
    );
    expect(applied.snapshot.version.registry_sequence).toBe("4");
    expect(
      selectDefaultRecognizeNetworks(store.current()).map(
        (h) => `${h.network.network.network_namespace}:${h.network.network.network_reference}`,
      ),
    ).not.toContain("eip155:1");

    // Same deps object — no reconstruction required.
    observer.clear();
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config: defaultBoundedResolverConfig(),
        deps,
      }),
    );
    expect(adapter.calls().slice(callsBefore)).not.toContain("eip155:1");
    expect(deps.capabilitySnapshotProvider?.current().version.registry_sequence).toBe("4");
  });

  it("retains LKG on invalid / noncontiguous transition", () => {
    const initial = loadHermeticCapabilitySnapshot();
    const store = createMemoryCapabilitySnapshotStore(initial);
    const before = store.version();

    const gap = expectFailure(
      store.applyTransition({
        transition: {
          kind: "sequence_advance",
          from: before,
          to: { ...before, registry_sequence: "99" },
          networks: [
            ethereumMainnetCapability(),
            baseMainnetCapability(),
            solanaMainnetCapability(),
          ],
          reason_class: "operator_policy",
          effective_at: TRANSITION_AT,
          actor: { kind: "operator", id: "cr-107-operator" },
        },
      }),
    );
    expect(gap._tag).toBe("CapabilitySnapshotStoreError");
    expect(store.version()).toEqual(before);

    const downgrade = expectFailure(
      store.applyTransition({
        transition: {
          kind: "sequence_advance",
          from: before,
          to: { ...before, registry_sequence: "2" },
          networks: [
            ethereumMainnetCapability(),
            baseMainnetCapability(),
            solanaMainnetCapability(),
          ],
          reason_class: "catalog_update",
          effective_at: FIXTURE_EFFECTIVE_AT,
          actor: { kind: "operator", id: "cr-107-operator" },
        },
      }),
    );
    expect(downgrade._tag).toBe("CapabilitySnapshotStoreError");
    expect(store.version()).toEqual(before);
  });

  it("pins one snapshot version for an in-flight request while store advances via CR-101", async () => {
    const ethOnly = expectSuccess(
      decodeCapabilityRegistrySnapshot(withNetworks([ethereumMainnetCapability()], "3")),
    );
    // Bootstrap with validated snapshot only — no public replace API.
    const store = createMemoryCapabilitySnapshotStore(ethOnly);
    const processClock = createProcessMonotonicClock();
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 400,
      per_network_deadline_ms: 300,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };

    const { deps, observer } = createHermeticBoundedDeps({
      processClock,
      config,
      capabilitySnapshot: ethOnly,
      capabilitySnapshotProvider: store,
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 60 },
    });

    const inFlight = Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    // Advance store mid-flight via a valid contiguous CR-101 disable transition.
    const applied = expectSuccess(
      store.applyTransition({
        transition: {
          kind: "sequence_advance",
          from: store.version(),
          to: {
            ...store.version(),
            registry_sequence: String(BigInt(store.version().registry_sequence) + 1n),
          },
          networks: [ethereumPolicyDisabled()],
          reason_class: "operator_policy",
          effective_at: TRANSITION_AT,
          actor: { kind: "operator", id: "cr-107-operator" },
        },
      }),
    );
    expect(applied.snapshot.version.registry_sequence).toBe("4");

    const response = await inFlight;
    expect(response.capability_snapshot_version.registry_sequence).toBe("3");
    expect(response.candidates.length).toBeGreaterThan(0);
    expect(
      observer.events().some(
        (event) =>
          event.kind === "network_outcome" && event.network_key === "eip155:1",
      ),
    ).toBe(true);
    expect(
      observer.dropped().some((drop) => drop.reason === "network_key_refused"),
    ).toBe(false);

    // Subsequent request uses the new disabled catalog.
    observer.clear();
    const next = expectFailure(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(next._tag).toBe("NoHealthyCapabilityError");
    if (next._tag !== "NoHealthyCapabilityError") return;
    expect(next.capability_snapshot_version.registry_sequence).toBe("4");
    expect(observer.events().filter((e) => e.kind === "resolver_terminal")).toEqual([
      expect.objectContaining({
        identifier_format: "evm_address",
        terminal_outcome: "zero_result",
        candidate_count_bucket: "0",
        cache_outcome: "none",
        role: "capability",
        adapter_attempts: 0,
      }),
    ]);
  });
});

describe("CR-107 global admission full-stop", () => {
  it("full-stops before rate/cache/coalesce/adapter; reopen resumes", () => {
    const admission = createMemoryAdmissionControl("open");
    const { deps, adapter, observer, cache } = createHermeticBoundedDeps({
      admissionControl: admission,
      script: SCRIPT_EVM_ERC721,
    });

    let rateCalls = 0;
    let coalesceBegins = 0;
    const gatedDeps = {
      ...deps,
      rateLimiter: {
        tryAcquire: (input: {
          readonly caller_bucket_id: string;
          readonly now_ms: number;
        }) => {
          rateCalls += 1;
          return deps.rateLimiter.tryAcquire(input);
        },
      },
      coalesce: {
        begin: (key: string) => {
          coalesceBegins += 1;
          return deps.coalesce.begin(key);
        },
        complete: deps.coalesce.complete.bind(deps.coalesce),
      },
    };

    admission.fullStop();
    const denied = expectFailure(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config: defaultBoundedResolverConfig(),
        deps: gatedDeps,
      }),
    );
    expect(denied).toBeInstanceOf(ResolverAdmissionFullStopError);
    expect(adapter.calls()).toHaveLength(0);
    expect(cache.__debug().negative).toBe(0);
    expect(cache.__debug().positive).toBe(0);
    expect(rateCalls).toBe(0);
    expect(coalesceBegins).toBe(0);
    expect(
      observer.events().some(
        (e) => e.kind === "resolver_terminal" && e.terminal_outcome === "full_stop",
      ),
    ).toBe(true);
    expect(
      observer.events().filter((e) => e.kind === "resolver_terminal"),
    ).toHaveLength(1);
    expect(
      observer.events().every((e) => e.kind !== "network_outcome"),
    ).toBe(true);

    admission.open();
    observer.clear();
    const resumed = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config: defaultBoundedResolverConfig(),
        deps: gatedDeps,
      }),
    );
    expect(resumed.candidates.length).toBeGreaterThan(0);
    expect(adapter.calls().length).toBeGreaterThan(0);
    expect(rateCalls).toBeGreaterThan(0);
    expect(coalesceBegins).toBeGreaterThan(0);
    expect(
      observer.events().some(
        (e) => e.kind === "resolver_terminal" && e.terminal_outcome !== "full_stop",
      ),
    ).toBe(true);
  });
});

describe("CR-107 coalesce follower work accounting", () => {
  it("followers do not double-count network adapter work", async () => {
    const processClock = createProcessMonotonicClock();
    const ethOnly = expectSuccess(
      decodeCapabilityRegistrySnapshot(withNetworks([ethereumMainnetCapability()], "3")),
    );
    const observer = createMemoryRecognitionObserver({
      allowedNetworkKeys: networkKeysFromCapabilitySnapshot(ethOnly),
    });
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 200,
      per_network_deadline_ms: 150,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const { deps, adapter } = createHermeticBoundedDeps({
      processClock,
      config,
      capabilitySnapshot: ethOnly,
      observer,
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 40 },
    });

    const leaderP = Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "coal-lead"),
        config,
        deps,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    const followerP = Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "coal-follow"),
        config,
        deps,
      }),
    );
    const [leader, follower] = await Promise.all([leaderP, followerP]);
    expect(leader.candidates.length).toBeGreaterThan(0);
    expect(follower.diagnostics.cache.coalesced).toBe(true);

    const networkEvents = observer
      .events()
      .filter((e) => e.kind === "network_outcome" && e.adapter_attempted);
    expect(networkEvents.length).toBe(adapter.externalStarts());
    expect(adapter.externalStarts()).toBe(1);

    const terminals = observer.events().filter((e) => e.kind === "resolver_terminal");
    expect(terminals).toHaveLength(2);
    const followerTerminal = terminals.find((t) => t.role === "follower");
    const leaderTerminal = terminals.find((t) => t.role === "leader");
    expect(followerTerminal?.adapter_attempts).toBe(0);
    expect(leaderTerminal?.adapter_attempts).toBe(1);
  });

  it("classifies a distinct short-budget demand as partial", async () => {
    const processClock = createProcessMonotonicClock();
    const ethOnly = expectSuccess(
      decodeCapabilityRegistrySnapshot(withNetworks([ethereumMainnetCapability()], "3")),
    );
    const observer = createMemoryRecognitionObserver({
      allowedNetworkKeys: networkKeysFromCapabilitySnapshot(ethOnly),
    });
    const leaderConfig = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 200,
      per_network_deadline_ms: 150,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const followerConfig = {
      ...leaderConfig,
      global_deadline_ms: 15,
      per_network_deadline_ms: 10,
    };
    const { deps } = createHermeticBoundedDeps({
      processClock,
      config: leaderConfig,
      capabilitySnapshot: ethOnly,
      observer,
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 80 },
    });

    const leader = Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "partial-leader"),
        config: leaderConfig,
        deps,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const follower = await Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "partial-follower"),
        config: followerConfig,
        deps,
      }),
    );

    expect(follower.diagnostics.partial).toBe(true);
    await leader;
    const shortBudgetTerminals = observer
      .events()
      .filter(
        (event) =>
          event.kind === "resolver_terminal" &&
          event.role === "leader" &&
          event.terminal_outcome === "partial",
      );
    expect(shortBudgetTerminals).toHaveLength(1);
    expect(shortBudgetTerminals[0]).toMatchObject({
      terminal_outcome: "partial",
      candidate_count_bucket: "0",
      adapter_attempts: 1,
    });
  });
});

describe("CR-107 terminal finalizer — exactly one resolver_terminal per exit", () => {
  const countTerminals = (observer: { events: () => ReadonlyArray<OperationalEvent> }) =>
    observer.events().filter((e) => e.kind === "resolver_terminal");

  it("finalizes a warm positive/readiness cache hit as complete", () => {
    const config = {
      ...defaultBoundedResolverConfig(),
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const { deps, observer } = createHermeticBoundedDeps({
      config,
      script: SCRIPT_EVM_ERC721,
    });
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "cache-cold"),
        config,
        deps,
      }),
    );
    observer.clear();

    const warm = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "cache-warm"),
        config,
        deps,
      }),
    );

    expect(warm.diagnostics.cache).toMatchObject({
      positive_hit: true,
      readiness_hit: true,
    });
    const terminals = countTerminals(observer);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      terminal_outcome: "complete",
      candidate_count_bucket: "1",
      cache_outcome: "readiness_hit",
      role: "leader",
      adapter_attempts: 0,
    });
  });

  it("emits rejected unclassified terminal for config decode failure (no demand)", () => {
    const { deps, observer } = createHermeticBoundedDeps({
      script: SCRIPT_EVM_ERC721,
    });
    const err = expectFailure(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config: { ...defaultBoundedResolverConfig(), schema_version: 99 },
        deps,
      }),
    );
    expect(err._tag).toMatch(/Config|Decode/);
    expect(observer.events().filter((e) => e.kind === "resolver_demand")).toHaveLength(0);
    const terminals = countTerminals(observer);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      identifier_format: "unclassified",
      terminal_outcome: "rejected",
      role: "failed",
      adapter_attempts: 0,
    });
  });

  it("emits rejected unclassified terminal for request decode failure (no demand)", () => {
    const { deps, observer } = createHermeticBoundedDeps({
      script: SCRIPT_EVM_ERC721,
    });
    const err = expectFailure(
      resolveBounded({
        request: { schema_version: 1, identifier: MULTI_CHAIN_EVM_ADDRESS },
        config: defaultBoundedResolverConfig(),
        deps,
      }),
    );
    expect(err._tag).toBe("BoundedResolverDecodeError");
    expect(observer.events().filter((e) => e.kind === "resolver_demand")).toHaveLength(0);
    const terminals = countTerminals(observer);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      identifier_format: "unclassified",
      terminal_outcome: "rejected",
    });
  });

  it("emits rejected unclassified terminal for structural preflight failure (no demand)", () => {
    const { deps, observer } = createHermeticBoundedDeps({
      script: SCRIPT_EVM_ERC721,
    });
    const err = expectFailure(
      resolveBounded({
        request: hermeticResolveRequest("not-a-valid-identifier"),
        config: defaultBoundedResolverConfig(),
        deps,
      }),
    );
    expect(err._tag).toBe("StructuralPreflightError");
    expect(observer.events().filter((e) => e.kind === "resolver_demand")).toHaveLength(0);
    const terminals = countTerminals(observer);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      identifier_format: "unclassified",
      terminal_outcome: "rejected",
    });
  });

  it("emits exactly one failed terminal for post-fanout leader candidate build failure", () => {
    const ethOnly = expectSuccess(
      decodeCapabilityRegistrySnapshot(withNetworks([ethereumMainnetCapability()], "3")),
    );
    const { deps, observer, adapter } = createHermeticBoundedDeps({
      capabilitySnapshot: ethOnly,
      config: {
        ...defaultBoundedResolverConfig(),
        max_searched_networks: 1,
        max_concurrent_probes: 1,
      },
      script: {
        "eip155:1": {
          kind: "hit",
          address: "0x0000000000000000000000000000000000000001",
          token_standard: "erc721",
          name: "Mismatch",
          symbol: "MM",
          recognition: "recognized",
          index_status: "indexed",
          report_readiness: "ready",
          metadata_quality: "onchain",
          observed_at: "2026-07-16T08:00:00Z",
          ranking_reasons: ["supported_standard"],
          evidence_material: { adapter: "evm_rpc" },
        },
      },
    });
    const err = expectFailure(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config: {
          ...defaultBoundedResolverConfig(),
          max_searched_networks: 1,
          max_concurrent_probes: 1,
        },
        deps,
      }),
    );
    expect(err._tag).toBe("BoundedResolverDecodeError");
    expect(adapter.externalStarts()).toBe(1);
    expect(observer.events().some((e) => e.kind === "resolver_demand")).toBe(true);
    const terminals = countTerminals(observer);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      identifier_format: "evm_address",
      terminal_outcome: "failed",
      role: "failed",
      adapter_attempts: 1,
    });
  });
});

describe("CR-107 zero-result and solana format", () => {
  it("records zero_result terminal for conclusive misses", () => {
    const { deps, observer } = createHermeticBoundedDeps({
      script: SCRIPT_ZERO_CANDIDATES,
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config: defaultBoundedResolverConfig(),
        deps,
      }),
    );
    expect(response.candidates).toHaveLength(0);
    const terminal = observer.events().find((e) => e.kind === "resolver_terminal");
    expect(terminal).toMatchObject({
      terminal_outcome: "zero_result",
      candidate_count_bucket: "0",
      ambiguous: false,
    });
  });

  it("records solana_public_key identifier format on demand", () => {
    const { deps, observer } = createHermeticBoundedDeps({
      script: {
        "solana:mainnet-beta": { kind: "miss" },
      },
    });
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(PYTHIANS_COLLECTION_MINT),
        config: defaultBoundedResolverConfig(),
        deps,
      }),
    );
    expect(
      observer.events().some(
        (e) =>
          e.kind === "resolver_demand" && e.identifier_format === "solana_public_key",
      ),
    ).toBe(true);
  });
});

describe("CR-107 OPERATIONS runbook present", () => {
  it("names degraded and full-stop procedures", async () => {
    const fs = await import("node:fs/promises");
    const path = new URL(
      "../src/collection-resolver/OPERATIONS.md",
      import.meta.url,
    );
    const text = await fs.readFile(path, "utf8");
    expect(text).toMatch(/Degraded procedure/i);
    expect(text).toMatch(/Full-stop procedure/i);
    expect(text).toMatch(/Circuit breaker vs explicit disable/i);
    expect(text).toMatch(/last-known-good/i);
    expect(text).toMatch(/Honest external blocker/i);
    expect(text).toMatch(/process-local substrate/i);
    expect(text).toMatch(/fleet-wide/i);
  });
});
