import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  applyInvalidation,
  AuthorizationScope,
  assertNoSecretLeak,
  createHermeticBoundedDeps,
  createMemoryCircuitBreaker,
  createMemoryInvalidationEdgePort,
  createMemoryResolverCache,
  createProcessMonotonicClock,
  createScriptedInventoryPort,
  createScriptedNetworkAdapter,
  createVirtualClock,
  decodeBoundedResolverConfig,
  defaultBoundedResolverConfig,
  digestPositiveBinding,
  digestReadinessBinding,
  hermeticResolveRequest,
  invalidateNegativeOnCoverageGrowth,
  loadHermeticCapabilitySnapshot,
  MULTI_CHAIN_EVM_ADDRESS,
  PYTHIANS_COLLECTION_MINT,
  raceSettlementAgainstDeadlines,
  rankCandidatesDeterministic,
  redactSafeMessage,
  resolveBounded,
  ResolverRateLimitedError,
  runColdRateLimitDenialHarness,
  runDeterministicLoadHarness,
  SCRIPT_EVM_ERC721,
  SCRIPT_HIT_WITHOUT_BINDING,
  SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
  SCRIPT_PARTIAL_TIMEOUT,
  SCRIPT_SOLANA_COLLECTION,
  SCRIPT_ZERO_CANDIDATES,
  sha256Canonical,
  StructuralPreflightError,
  structuralIdentifierDigest,
  structuralPreflight,
} from "../src/collection-resolver/index.js";
import type { CollectionCandidate } from "../src/collection-resolver/protocol.js";

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

describe("CR-102 structural preflight", () => {
  it("fails incomplete identifiers before rate-limit / cache / adapter", () => {
    const { deps, config, adapter } = createHermeticBoundedDeps({
      script: SCRIPT_EVM_ERC721,
    });
    const beforeCalls = adapter.calls().length;
    const err = expectFailure(
      resolveBounded({
        request: hermeticResolveRequest("not-an-address"),
        config,
        deps,
      }),
    );
    expect(err).toBeInstanceOf(StructuralPreflightError);
    expect(adapter.calls().length).toBe(beforeCalls);
    expect(deps.metrics.snapshot().adapter_calls).toBe(0);
    expect(deps.metrics.snapshot().rate_limited).toBe(0);
    if (err instanceof StructuralPreflightError) {
      expect(err.identifier_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(err)).not.toMatch(/not-an-address/);
    }
  });

  it("preflight alone classifies valid EVM and Solana identifiers", () => {
    const evm = expectSuccess(structuralPreflight(MULTI_CHAIN_EVM_ADDRESS));
    expect(evm.identifier.format).toBe("evm_address");
    const sol = expectSuccess(structuralPreflight(PYTHIANS_COLLECTION_MINT));
    expect(sol.identifier.format).toBe("solana_public_key");
    expect(sol.identifier.raw).toBe(PYTHIANS_COLLECTION_MINT);
  });
});

describe("CR-102 authorization scope isolation", () => {
  const decodeAuthorizationScope = Schema.decodeUnknown(AuthorizationScope, {
    errors: "all",
    onExcessProperty: "error",
  });

  it("requires the community discriminator digest", () => {
    expectFailure(decodeAuthorizationScope({ scope_class: "community" }));
    expectSuccess(
      decodeAuthorizationScope({
        scope_class: "community",
        community_ref_digest: sha256Canonical("community-a"),
      }),
    );
  });

  it("rejects community digests on non-community scopes", () => {
    const community_ref_digest = sha256Canonical("community-a");
    expectFailure(
      decodeAuthorizationScope({ scope_class: "anonymous", community_ref_digest }),
    );
    expectFailure(
      decodeAuthorizationScope({ scope_class: "authenticated", community_ref_digest }),
    );
  });
});

describe("CR-102 capability selection", () => {
  it("resolves only against healthy mainnet recognize from CR-101 snapshot", () => {
    const { deps, config } = createHermeticBoundedDeps({
      script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(response.capability_snapshot_version).toEqual(
      loadHermeticCapabilitySnapshot().version,
    );
    expect(response.candidates.length).toBe(2);
    expect(
      response.diagnostics.searched.map(
        (n) => `${n.network_namespace}:${n.network_reference}`,
      ),
    ).toEqual(["eip155:1", "eip155:8453"]);
  });

  it("does not search Solana for EVM identifiers", () => {
    const { deps, config, adapter } = createHermeticBoundedDeps({
      script: SCRIPT_EVM_ERC721,
    });
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(adapter.calls().some((k: string) => k.startsWith("solana:"))).toBe(false);
  });
});

describe("CR-102 deadlines and late-result suppression", () => {
  it("10ms per-network deadline aborts 60ms work as timeout", () => {
    const clock = createVirtualClock({ originMs: 0 });
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 4_000,
      per_network_deadline_ms: 10,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const { deps, cache } = createHermeticBoundedDeps({
      clock,
      config,
      script: SCRIPT_EVM_ERC721,
      workMsByNetwork: { "eip155:1": 60 },
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(response.diagnostics.timed_out.length).toBeGreaterThan(0);
    expect(response.candidates).toHaveLength(0);
    expect(cache.__debug().negative).toBe(0);
  });

  it("60ms per-network deadline allows 10ms work to complete", () => {
    const clock = createVirtualClock({ originMs: 0 });
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 4_000,
      per_network_deadline_ms: 60,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const { deps, adapter } = createHermeticBoundedDeps({
      clock,
      config,
      script: SCRIPT_EVM_ERC721,
      workMsByNetwork: { "eip155:1": 10 },
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(response.candidates.length).toBe(1);
    expect(response.diagnostics.timed_out).toHaveLength(0);
  });

  it("30ms global deadline seals before awaiting late adapters", () => {
    const clock = createVirtualClock({ originMs: 0 });
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 30,
      per_network_deadline_ms: 25,
      max_concurrent_probes: 2,
    };
    const { deps, cache } = createHermeticBoundedDeps({
      clock,
      config,
      script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
      workMsByNetwork: {
        "eip155:1": 20,
        "eip155:8453": 80,
      },
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(response.diagnostics.partial || response.diagnostics.global_deadline_exceeded).toBe(
      true,
    );
    expect(cache.__debug().negative).toBe(0);
  });

  it("83ms global deadline with mixed work returns partial without negative cache", () => {
    const clock = createVirtualClock({ originMs: 0 });
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 83,
      per_network_deadline_ms: 80,
    };
    const { deps, cache } = createHermeticBoundedDeps({
      clock,
      config,
      script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
      workMsByNetwork: {
        "eip155:1": 30,
        "eip155:8453": 100,
      },
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(response.diagnostics.partial || response.diagnostics.timed_out.length > 0).toBe(
      true,
    );
    expect(cache.__debug().negative).toBe(0);
  });

  it("returns partial when per-network work exceeds global deadline", () => {
    const clock = createVirtualClock({ originMs: 0 });
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 100,
      per_network_deadline_ms: 80,
    };
    const { deps } = createHermeticBoundedDeps({
      clock,
      config,
      script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
      workMsByNetwork: {
        "eip155:1": 30,
        "eip155:8453": 200,
      },
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(response.diagnostics.partial || response.diagnostics.timed_out.length > 0).toBe(
      true,
    );
  });

  it("suppresses cache writes after global deadline seal", () => {
    const clock = createVirtualClock({ originMs: 0 });
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 50,
      per_network_deadline_ms: 40,
      negative_cache_ttl_ms: 10_000,
      report_readiness_ttl_ms: 20_000,
      positive_recognition_ttl_ms: 30_000,
    };
    const { deps, cache } = createHermeticBoundedDeps({
      clock,
      config,
      script: SCRIPT_ZERO_CANDIDATES,
      workMsByNetwork: {
        "eip155:1": 80,
        "eip155:8453": 80,
      },
    });
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    const debug = cache.__debug();
    expect(debug.positive).toBe(0);
    expect(debug.negative).toBe(0);
  });
});

describe("CR-102 concurrency and deterministic ordering", () => {
  it("strict-decodes bounded concurrency / network ceilings", () => {
    const bad = expectFailure(
      decodeBoundedResolverConfig({
        ...defaultBoundedResolverConfig(),
        max_concurrent_probes: 99,
      }),
    );
    expect(bad._tag).toBe("BoundedResolverDecodeError");

    const ok = expectSuccess(decodeBoundedResolverConfig(defaultBoundedResolverConfig()));
    expect(ok.max_concurrent_probes).toBe(6);
    expect(ok.max_searched_networks).toBe(8);
  });

  it("rejects equality at both strict TTL ordering boundaries", () => {
    const defaults = defaultBoundedResolverConfig();
    const readinessEqualsPositive = expectFailure(
      decodeBoundedResolverConfig({
        ...defaults,
        report_readiness_ttl_ms: defaults.positive_recognition_ttl_ms,
      }),
    );
    expect(readinessEqualsPositive._tag).toBe("BoundedResolverConfigError");

    const negativeEqualsReadiness = expectFailure(
      decodeBoundedResolverConfig({
        ...defaults,
        negative_cache_ttl_ms: defaults.report_readiness_ttl_ms,
      }),
    );
    expect(negativeEqualsReadiness._tag).toBe("BoundedResolverConfigError");
  });

  it("max_concurrent_probes: 0 fails preflight and cannot write cache", () => {
    const { deps, cache } = createHermeticBoundedDeps({
      script: SCRIPT_EVM_ERC721,
    });
    const before = cache.__debug();
    const err = expectFailure(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config: { ...defaultBoundedResolverConfig(), max_concurrent_probes: 0 },
        deps,
      }),
    );
    expect(err._tag).toBe("BoundedResolverDecodeError");
    expect(deps.metrics.snapshot().adapter_calls).toBe(0);
    expect(cache.__debug()).toEqual(before);
  });

  it("excess config property fails strict decode before adapters", () => {
    const { deps, adapter } = createHermeticBoundedDeps({ script: SCRIPT_EVM_ERC721 });
    const err = expectFailure(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config: { ...defaultBoundedResolverConfig(), unexpected_knob: true },
        deps,
      }),
    );
    expect(err._tag).toBe("BoundedResolverDecodeError");
    expect(adapter.calls()).toHaveLength(0);
  });

  it("canonical ranking is stable under randomized completion scripts", () => {
    const mk = (script: typeof SCRIPT_MULTI_CHAIN_SAME_ADDRESS) => {
      const { deps, config } = createHermeticBoundedDeps({ script });
      return expectSuccess(
        resolveBounded({
          request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
          config,
          deps,
        }),
      );
    };
    const a = mk(SCRIPT_MULTI_CHAIN_SAME_ADDRESS);
    const b = mk({
      "eip155:8453": SCRIPT_MULTI_CHAIN_SAME_ADDRESS["eip155:8453"]!,
      "eip155:1": SCRIPT_MULTI_CHAIN_SAME_ADDRESS["eip155:1"]!,
    });
    expect(a.candidates.map((c) => c.identity.deployments[0]!.deployment_id.digest)).toEqual(
      b.candidates.map((c) => c.identity.deployments[0]!.deployment_id.digest),
    );
    expect(a.ranking_evidence.map((r) => r.deployment_key)).toEqual(
      b.ranking_evidence.map((r) => r.deployment_key),
    );
  });

  it("caps searched networks at configured ceiling", () => {
    const config = {
      ...defaultBoundedResolverConfig(),
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const { deps, adapter } = createHermeticBoundedDeps({
      config,
      script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(response.diagnostics.searched.length).toBe(1);
    expect(adapter.calls().length).toBe(1);
  });
});

describe("CR-102 rate limit and coalescing", () => {
  it("returns typed 429 with safe retry metadata when caller budget exceeded", () => {
    const config = {
      ...defaultBoundedResolverConfig(),
      caller_rate_limit: { limit: 1, window_ms: 60_000, max_cardinality: 100 },
      global_rate_limit: { limit: 1000, window_ms: 1000 },
    };
    const { deps } = createHermeticBoundedDeps({
      config,
      script: SCRIPT_EVM_ERC721,
    });
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "same"),
        config,
        deps,
      }),
    );
    const err = expectFailure(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "same"),
        config,
        deps,
      }),
    );
    expect(err).toBeInstanceOf(ResolverRateLimitedError);
    if (err instanceof ResolverRateLimitedError) {
      expect(err.scope).toBe("caller");
      expect(err.retry_after_ms).toBeGreaterThan(0);
      expect(err.limit).toBe(1);
      assertNoSecretLeak(err);
    }
  });

  it("coalesces / negative-caches zero-result demand so it cannot amplify fanout", () => {
    const { deps, config, adapter } = createHermeticBoundedDeps({
      script: SCRIPT_ZERO_CANDIDATES,
    });
    const first = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(first.candidates).toHaveLength(0);
    const callsAfterFirst = adapter.calls().length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(second.candidates).toHaveLength(0);
    expect(second.diagnostics.cache.negative_hit || second.diagnostics.cache.coalesced).toBe(
      true,
    );
    expect(adapter.calls().length).toBe(callsAfterFirst);
  });

  it("does not reuse negative evidence across authorization scopes", () => {
    const { deps, config, adapter } = createHermeticBoundedDeps({
      script: SCRIPT_ZERO_CANDIDATES,
    });
    const authenticated = hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "scope-auth");
    expectSuccess(resolveBounded({ request: authenticated, config, deps }));
    const authenticatedCalls = adapter.calls().length;

    const anonymous = {
      ...hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "scope-anon"),
      caller: {
        bucket_id: "scope-anon",
        authorization_scope: { scope_class: "anonymous" as const },
      },
    };
    const isolated = expectSuccess(resolveBounded({ request: anonymous, config, deps }));
    expect(isolated.diagnostics.cache.negative_hit).toBe(false);
    expect(adapter.calls().length).toBeGreaterThan(authenticatedCalls);
  });

  it("reprobes after a negative entry expires instead of trusting the fixture hint", () => {
    const clock = createVirtualClock({ originMs: 0 });
    const { deps, config, adapter } = createHermeticBoundedDeps({
      clock,
      script: SCRIPT_ZERO_CANDIDATES,
    });
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "negative-expiry-cold"),
        config,
        deps,
      }),
    );
    const coldCalls = adapter.calls().length;
    clock.advanceMs(config.negative_cache_ttl_ms);

    const refreshed = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "negative-expiry-warm"),
        config,
        deps,
      }),
    );
    expect(refreshed.diagnostics.cache.negative_hit).toBe(false);
    expect(adapter.calls().length).toBeGreaterThan(coldCalls);
  });
});

describe("CR-102 negative cache conclusive coverage", () => {
  it("timeout recovery forbids negative cache and must probe again", () => {
    const clock = createVirtualClock({ originMs: 0 });
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 4_000,
      per_network_deadline_ms: 1_500,
    };
    const first = createHermeticBoundedDeps({
      clock,
      config,
      script: SCRIPT_PARTIAL_TIMEOUT,
    });
    const timedOut = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps: first.deps,
      }),
    );
    expect(timedOut.diagnostics.timed_out.length).toBeGreaterThan(0);
    expect(first.cache.__debug().negative).toBe(0);

    // Recovery: same identity, conclusive misses — must probe again (no negative).
    const recovered = createHermeticBoundedDeps({
      clock,
      config,
      script: SCRIPT_ZERO_CANDIDATES,
      capabilitySnapshot: first.deps.capabilitySnapshot,
    });
    // Share the first cache to prove timeout path did not seed negative.
    const recoveredDeps = { ...recovered.deps, cache: first.cache, coalesce: first.deps.coalesce };
    const again = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps: recoveredDeps,
      }),
    );
    expect(again.candidates.length).toBeGreaterThan(0);
    expect(again.diagnostics.cache.positive_hit).toBe(true);
    expect(recovered.adapter.calls().length).toBeGreaterThan(0);
  });
});

describe("CR-102 circuit breaker", () => {
  it("transitions closed → open → half_open → closed with monotonic time", () => {
    const clock = createVirtualClock({ originMs: 0 });
    const breaker = createMemoryCircuitBreaker({
      failure_threshold: 2,
      open_ms: 100,
      half_open_max_probes: 1,
    });

    expect(
      Effect.runSync(
        breaker.beforeCall({ network_key: "eip155:1", operation: "recognize", now_ms: clock.nowMs() }),
      ).allow,
    ).toBe(true);

    Effect.runSync(
      breaker.recordFailure({ network_key: "eip155:1", operation: "recognize", now_ms: clock.nowMs() }),
    );
    Effect.runSync(
      breaker.recordFailure({ network_key: "eip155:1", operation: "recognize", now_ms: clock.nowMs() }),
    );
    expect(breaker.getState({ network_key: "eip155:1", operation: "recognize", now_ms: clock.nowMs() })).toBe(
      "open",
    );

    const denied = Effect.runSync(
      breaker.beforeCall({ network_key: "eip155:1", operation: "recognize", now_ms: clock.nowMs() }),
    );
    expect(denied.allow).toBe(false);

    clock.advanceMs(100);
    expect(breaker.getState({ network_key: "eip155:1", operation: "recognize", now_ms: clock.nowMs() })).toBe(
      "half_open",
    );
    expect(
      Effect.runSync(
        breaker.beforeCall({ network_key: "eip155:1", operation: "recognize", now_ms: clock.nowMs() }),
      ).allow,
    ).toBe(true);

    Effect.runSync(
      breaker.recordSuccess({ network_key: "eip155:1", operation: "recognize", now_ms: clock.nowMs() }),
    );
    expect(breaker.getState({ network_key: "eip155:1", operation: "recognize", now_ms: clock.nowMs() })).toBe(
      "closed",
    );
  });
});

describe("CR-102 cache separation and invalidation", () => {
  it("uses separate positive / readiness / negative namespaces", () => {
    const { deps, config, cache } = createHermeticBoundedDeps({
      script: SCRIPT_EVM_ERC721,
    });
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    const debug = cache.__debug();
    expect(debug.positive).toBeGreaterThan(0);
    expect(debug.readiness).toBeGreaterThan(0);
    expect(debug.negative).toBe(0);
  });

  it("reuses warm positive/readiness entries and probes only uncovered networks", () => {
    const { deps, config, adapter } = createHermeticBoundedDeps({
      script: SCRIPT_EVM_ERC721,
    });
    const first = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "warm-first"),
        config,
        deps,
      }),
    );
    expect(first.candidates.length).toBeGreaterThan(0);
    const callsAfterColdResolve = adapter.calls().length;

    const warm = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "warm-second"),
        config,
        deps,
      }),
    );
    expect(warm.candidates).toEqual(first.candidates);
    expect(warm.diagnostics.cache.positive_hit).toBe(true);
    expect(warm.diagnostics.cache.readiness_hit).toBe(true);
    expect(adapter.calls().length).toBeGreaterThan(callsAfterColdResolve);
    expect(adapter.calls().length - callsAfterColdResolve).toBeLessThan(callsAfterColdResolve);
  });

  it("reprobes a warm positive entry after its shorter readiness binding expires", () => {
    const clock = createVirtualClock({ originMs: 0 });
    const config = {
      ...defaultBoundedResolverConfig(),
      positive_recognition_ttl_ms: 200,
      report_readiness_ttl_ms: 50,
      negative_cache_ttl_ms: 20,
    };
    const { deps, adapter } = createHermeticBoundedDeps({
      clock,
      config,
      script: SCRIPT_EVM_ERC721,
    });

    const cold = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "readiness-cold"),
        config,
        deps,
      }),
    );
    expect(cold.candidates.length).toBeGreaterThan(0);
    const coldCalls = adapter.calls().length;

    clock.advanceMs(config.report_readiness_ttl_ms);
    const refreshed = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "readiness-refresh"),
        config,
        deps,
      }),
    );

    expect(refreshed.candidates.length).toBeGreaterThan(0);
    expect(refreshed.diagnostics.cache.positive_hit).toBe(true);
    expect(refreshed.diagnostics.cache.readiness_hit).toBe(false);
    expect(adapter.calls().length).toBeGreaterThan(coldCalls);
  });

  it("reprobes warm positive/readiness entries after adapter policy rotation", () => {
    const firstConfig = {
      ...defaultBoundedResolverConfig(),
      max_searched_networks: 1,
      max_concurrent_probes: 1,
      adapter_policy_version: "resolver-adapter-policy.v1",
    };
    const rotatedConfig = {
      ...firstConfig,
      adapter_policy_version: "resolver-adapter-policy.v2",
    };
    const { deps, adapter } = createHermeticBoundedDeps({
      config: firstConfig,
      script: SCRIPT_EVM_ERC721,
    });
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "policy-cold"),
        config: firstConfig,
        deps,
      }),
    );
    const coldCalls = adapter.calls().length;

    const rotated = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "policy-rotated"),
        config: rotatedConfig,
        deps,
      }),
    );
    expect(rotated.diagnostics.cache.positive_hit).toBe(false);
    expect(rotated.diagnostics.cache.readiness_hit).toBe(false);
    expect(adapter.calls().length).toBeGreaterThan(coldCalls);
  });

  it("reprobes a warm negative entry after adapter policy rotation", () => {
    const firstConfig = {
      ...defaultBoundedResolverConfig(),
      max_searched_networks: 1,
      max_concurrent_probes: 1,
      adapter_policy_version: "resolver-adapter-policy.v1",
    };
    const rotatedConfig = {
      ...firstConfig,
      adapter_policy_version: "resolver-adapter-policy.v2",
    };
    const { deps, adapter } = createHermeticBoundedDeps({
      config: firstConfig,
      script: SCRIPT_ZERO_CANDIDATES,
    });
    const first = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "negative-policy-cold"),
        config: firstConfig,
        deps,
      }),
    );
    expect(first.candidates).toHaveLength(0);
    const coldCalls = adapter.calls().length;

    const rotated = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(
          MULTI_CHAIN_EVM_ADDRESS,
          "negative-policy-rotated",
        ),
        config: rotatedConfig,
        deps,
      }),
    );
    expect(rotated.candidates).toHaveLength(0);
    expect(rotated.diagnostics.cache.negative_hit).toBe(false);
    expect(adapter.calls().length).toBeGreaterThan(coldCalls);
  });

  it("strict-decodes candidates returned exclusively from warm cache", () => {
    const config = {
      ...defaultBoundedResolverConfig(),
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const base = createHermeticBoundedDeps({
      config,
      script: SCRIPT_EVM_ERC721,
    });
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "corrupt-cold"),
        config,
        deps: base.deps,
      }),
    );
    const corruptDeps = {
      ...base.deps,
      cache: {
        ...base.deps.cache,
        findPositive: (query: Parameters<typeof base.deps.cache.findPositive>[0]) =>
          base.deps.cache.findPositive(query).pipe(
            Effect.map((entries) =>
              entries.map((entry) => ({
                ...entry,
                candidate: {
                  ...entry.candidate,
                  provenance: entry.candidate.provenance.map((item) => ({
                    ...item,
                    observed_at: "not-an-iso-timestamp",
                  })),
                },
              })),
            ),
          ),
      },
    };

    const error = expectFailure(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "corrupt-warm"),
        config,
        deps: corruptDeps,
      }),
    );
    expect(error._tag).toBe("BoundedResolverDecodeError");
  });

  it("uses exported digest helpers for positive/readiness writes and readiness reads", () => {
    const base = createHermeticBoundedDeps({ script: SCRIPT_EVM_ERC721 });
    const positiveWrites: Array<{
      readonly key: string;
      readonly binding: Parameters<typeof digestPositiveBinding>[0];
    }> = [];
    const readinessWrites: Array<{
      readonly key: string;
      readonly binding: Parameters<typeof digestReadinessBinding>[0];
    }> = [];
    const readinessReads: string[] = [];
    const deps = {
      ...base.deps,
      cache: {
        ...base.deps.cache,
        setPositive: (key: string, entry: Parameters<typeof base.deps.cache.setPositive>[1]) =>
          Effect.gen(function* () {
            positiveWrites.push({ key, binding: entry.binding });
            yield* base.deps.cache.setPositive(key, entry);
          }),
        setReadiness: (key: string, entry: Parameters<typeof base.deps.cache.setReadiness>[1]) =>
          Effect.gen(function* () {
            readinessWrites.push({ key, binding: entry.binding });
            yield* base.deps.cache.setReadiness(key, entry);
          }),
        getReadiness: (key: string) =>
          Effect.gen(function* () {
            readinessReads.push(key);
            return yield* base.deps.cache.getReadiness(key);
          }),
      },
    };

    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "digest-cold"),
        config: base.config,
        deps,
      }),
    );
    expect(positiveWrites.length).toBeGreaterThan(0);
    expect(readinessWrites.length).toBeGreaterThan(0);
    for (const write of positiveWrites) {
      expect(write.key).toBe(expectSuccess(digestPositiveBinding(write.binding)));
      expect(write.binding.identifier_format).toBe("evm_address");
      expect(write.binding.identifier_structural_digest).toBe(
        structuralIdentifierDigest({
          format: "evm_address",
          raw: MULTI_CHAIN_EVM_ADDRESS,
        }),
      );
    }
    for (const write of readinessWrites) {
      expect(write.key).toBe(expectSuccess(digestReadinessBinding(write.binding)));
    }

    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "digest-warm"),
        config: base.config,
        deps,
      }),
    );
    expect(readinessReads.sort()).toEqual(readinessWrites.map((write) => write.key).sort());
  });

  it("emits equivalence-revocation impact edge; eviction alone is insufficient", () => {
    const { deps, cache, edges } = createHermeticBoundedDeps({
      script: SCRIPT_EVM_ERC721,
    });
    const affectedOne = sha256Canonical("dep-1");
    const affectedTwo = sha256Canonical("dep-2");
    const unaffected = sha256Canonical("dep-3");
    const positiveBinding = (deployment_id: string) => ({
      schema_version: 1 as const,
      namespace: "positive_recognition" as const,
      identifier_format: "evm_address" as const,
      identifier_structural_digest: structuralIdentifierDigest({
        format: "evm_address",
        raw: MULTI_CHAIN_EVM_ADDRESS,
      }),
      capability_snapshot_version: deps.capabilitySnapshot.version,
      capability_source_sequence: "1",
      deployment_id,
      account_digest: "22".repeat(32),
      code_digest: "11".repeat(32),
      observed_position: {
        family: "evm" as const,
        block_number: "1",
        block_hash: "33".repeat(32),
      },
      standard_evidence: {
        token_standard: "erc721" as const,
        evidence_quality: "confirmed" as const,
      },
      proxy_evidence: { is_proxy: false },
      authorization_scope: { scope_class: "authenticated" as const },
      adapter_policy_version: "resolver-adapter-policy.v1",
      finality_policy_version: "ethereum-finalized.v1",
    });
    for (const deployment_id of [affectedOne, affectedTwo, unaffected]) {
      Effect.runSync(
        cache.setPositive(`positive-${deployment_id}`, {
          binding: positiveBinding(deployment_id),
          candidate: {} as CollectionCandidate,
          stored_at_ms: 0,
          expires_at_ms: 60_000,
        }),
      );
    }
    const impact = {
      schema_version: 1 as const,
      kind: "collection_equivalence_revocation" as const,
      equivalence_digest: sha256Canonical("eq-1"),
      previous_collection_identity_digest: sha256Canonical("id-1"),
      affected_deployment_ids: [affectedOne, affectedTwo],
      capability_snapshot_version: deps.capabilitySnapshot.version,
      emitted_at: deps.clock.nowIso(),
      impact: {
        cache_namespaces: ["positive_recognition" as const, "report_readiness" as const],
        requires_quarantine: true as const,
        remediation: "new_identity_version_required" as const,
        eviction_alone_insufficient: true as const,
      },
    };
    const result = expectSuccess(
      applyInvalidation({
        cache,
        edges,
        cause: "equivalence_revocation",
        impact,
        // A caller-provided deployment is only a hint; the canonical impact list
        // is authoritative for every affected deployment.
        deployment_id: affectedOne,
      }),
    );
    expect(result.evicted).toBe(2);
    expect(cache.__debug().positive).toBe(1);
    expect(result.edge_emitted).toBe(true);
    expect(edges.listEmitted()).toHaveLength(1);
    expect(edges.listEmitted()[0]!.impact.eviction_alone_insufficient).toBe(true);
    assertNoSecretLeak(edges.listEmitted()[0]);
  });

  it("failed impact-store does not claim edge_emitted and does not evict", () => {
    const clock = createVirtualClock({ originMs: 0 });
    const cache = createMemoryResolverCache({ nowMs: () => clock.nowMs() });
    Effect.runSync(
      cache.setPositive("keep-me", {
        binding: {
          schema_version: 1,
          namespace: "positive_recognition",
          identifier_format: "evm_address",
          identifier_structural_digest: structuralIdentifierDigest({
            format: "evm_address",
            raw: MULTI_CHAIN_EVM_ADDRESS,
          }),
          capability_snapshot_version: loadHermeticCapabilitySnapshot().version,
          capability_source_sequence: "1",
          deployment_id: sha256Canonical("dep-keep"),
          account_digest: "22".repeat(32),
          code_digest: "11".repeat(32),
          observed_position: {
            family: "evm",
            block_number: "1",
            block_hash: "33".repeat(32),
          },
          standard_evidence: { token_standard: "erc721", evidence_quality: "confirmed" },
          proxy_evidence: { is_proxy: false },
          authorization_scope: { scope_class: "authenticated" },
          adapter_policy_version: "resolver-adapter-policy.v1",
          finality_policy_version: "ethereum-finalized.v1",
        },
        candidate: {} as CollectionCandidate,
        stored_at_ms: 0,
        expires_at_ms: 60_000,
      }),
    );
    const edges = createMemoryInvalidationEdgePort({ failStore: true });
    const before = cache.__debug().positive;
    const impact = {
      schema_version: 1 as const,
      kind: "collection_equivalence_revocation" as const,
      equivalence_digest: sha256Canonical("eq-fail"),
      previous_collection_identity_digest: sha256Canonical("id-fail"),
      affected_deployment_ids: [sha256Canonical("dep-keep")],
      capability_snapshot_version: loadHermeticCapabilitySnapshot().version,
      emitted_at: clock.nowIso(),
      impact: {
        cache_namespaces: ["positive_recognition" as const],
        requires_quarantine: true as const,
        remediation: "new_identity_version_required" as const,
        eviction_alone_insufficient: true as const,
      },
    };
    const err = expectFailure(
      applyInvalidation({
        cache,
        edges,
        cause: "equivalence_revocation",
        impact,
        deployment_id: sha256Canonical("dep-keep"),
      }),
    );
    expect(err._tag).toBe("InvalidationEdgeStoreError");
    expect(edges.listEmitted()).toHaveLength(0);
    expect(cache.__debug().positive).toBe(before);
  });

  it("invalidates negative cache when capability coverage grows", () => {
    const { cache } = createHermeticBoundedDeps({ script: SCRIPT_ZERO_CANDIDATES });
    Effect.runSync(
      cache.setNegative("neg-key", {
        binding: {
          schema_version: 1,
          namespace: "negative_probe",
          identifier_format: "evm_address",
          identifier_structural_digest: sha256Canonical("id"),
          capability_snapshot_version: loadHermeticCapabilitySnapshot().version,
          adapter_policy_version: "resolver-adapter-policy.v1",
          authorization_scope: { scope_class: "anonymous" },
          searched_coverage: ["eip155:1"],
          claims_beyond_coverage: false,
        },
        stored_at_ms: 0,
        expires_at_ms: 60_000,
      }),
    );
    const grew = expectSuccess(
      invalidateNegativeOnCoverageGrowth({
        cache,
        previous_coverage: ["eip155:1"],
        next_coverage: ["eip155:1", "eip155:8453"],
      }),
    );
    expect(grew.evicted).toBeGreaterThan(0);
  });

  it("covers every invalidation cause enum via applyInvalidation", () => {
    const causes = [
      "network_disable",
      "network_security",
      "code_digest_drift",
      "account_digest_drift",
      "identity_drift",
      "reorg_below_finality",
      "capability_change",
      "finality_policy_change",
      "adapter_policy_change",
      "capability_coverage_growth",
      "transient_recovery",
      "ttl_expiry",
    ] as const;
    const { cache, edges } = createHermeticBoundedDeps();
    for (const cause of causes) {
      const result = expectSuccess(
        applyInvalidation({ cache, edges, cause }),
      );
      expect(result.evicted).toBe(0);
      expect(result.edge_emitted).toBe(false);
    }
  });

  it("refuses unscoped invalidation that would wipe unrelated cache entries", () => {
    const clock = createVirtualClock({ originMs: 0 });
    const cache = createMemoryResolverCache({ nowMs: () => clock.nowMs() });
    const edges = createMemoryInvalidationEdgePort();
    const deployment_id = sha256Canonical("unrelated-deployment");
    Effect.runSync(
      cache.setPositive("positive-keep", {
        binding: {
          schema_version: 1,
          namespace: "positive_recognition",
          identifier_format: "evm_address",
          identifier_structural_digest: sha256Canonical("id"),
          capability_snapshot_version: loadHermeticCapabilitySnapshot().version,
          capability_source_sequence: "1",
          deployment_id,
          account_digest: "22".repeat(32),
          code_digest: "11".repeat(32),
          observed_position: {
            family: "evm",
            block_number: "1",
            block_hash: "33".repeat(32),
          },
          standard_evidence: { token_standard: "erc721", evidence_quality: "confirmed" },
          proxy_evidence: { is_proxy: false },
          authorization_scope: { scope_class: "authenticated" },
          adapter_policy_version: "resolver-adapter-policy.v1",
          finality_policy_version: "ethereum-finalized.v1",
        },
        candidate: {} as CollectionCandidate,
        stored_at_ms: 0,
        expires_at_ms: 60_000,
      }),
    );
    Effect.runSync(
      cache.setNegative("negative-keep", {
        binding: {
          schema_version: 1,
          namespace: "negative_probe",
          identifier_format: "evm_address",
          identifier_structural_digest: sha256Canonical("neg-id"),
          capability_snapshot_version: loadHermeticCapabilitySnapshot().version,
          adapter_policy_version: "resolver-adapter-policy.v1",
          authorization_scope: { scope_class: "anonymous" },
          searched_coverage: ["eip155:1"],
          claims_beyond_coverage: false,
        },
        stored_at_ms: 0,
        expires_at_ms: 60_000,
      }),
    );

    const bare = expectSuccess(
      applyInvalidation({ cache, edges, cause: "ttl_expiry" }),
    );
    expect(bare.evicted).toBe(0);
    expect(cache.__debug().positive).toBe(1);
    expect(cache.__debug().negative).toBe(1);

    const scoped = expectSuccess(
      applyInvalidation({
        cache,
        edges,
        cause: "ttl_expiry",
        keyDigest: "positive-keep",
        namespace: "positive_recognition",
      }),
    );
    expect(scoped.evicted).toBe(1);
    expect(cache.__debug().positive).toBe(0);
    expect(cache.__debug().negative).toBe(1);
  });
});

describe("CR-102 observed evidence binding", () => {
  it("refuses positive cache when binding evidence is absent", () => {
    const { deps, config, cache } = createHermeticBoundedDeps({
      script: SCRIPT_HIT_WITHOUT_BINDING,
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(response.candidates.length).toBeGreaterThan(0);
    expect(response.diagnostics.partial).toBe(true);
    expect(
      response.diagnostics.entries.some((e) => e.code === "binding_evidence_absent"),
    ).toBe(true);
    expect(cache.__debug().positive).toBe(0);
    expect(cache.__debug().readiness).toBe(0);
  });

  it("binds per-network observed digests/positions without fabrication", () => {
    const { deps, config, cache } = createHermeticBoundedDeps({
      script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
    });
    expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(cache.__debug().positive).toBe(2);
    // Distinct proxy evidence across networks (8453 is_proxy true, 1 false).
    expect(SCRIPT_MULTI_CHAIN_SAME_ADDRESS["eip155:8453"]).toMatchObject({
      kind: "hit",
    });
    const base8453 = SCRIPT_MULTI_CHAIN_SAME_ADDRESS["eip155:8453"];
    if (base8453 && base8453.kind === "hit") {
      expect(base8453.binding_evidence?.proxy_evidence.is_proxy).toBe(true);
      expect(base8453.binding_evidence?.observed_position).toMatchObject({
        family: "evm",
        block_number: "20000001",
      });
    }
    const base1 = SCRIPT_MULTI_CHAIN_SAME_ADDRESS["eip155:1"];
    if (base1 && base1.kind === "hit") {
      expect(base1.binding_evidence?.proxy_evidence.is_proxy).toBe(false);
      expect(base1.binding_evidence?.code_digest).not.toBe(
        sha256Canonical(MULTI_CHAIN_EVM_ADDRESS),
      );
    }
  });
});

describe("CR-102 Inventory enrichment", () => {
  it("Inventory failure yields typed partial without corrupting adapter evidence", () => {
    const inventory = createScriptedInventoryPort({
      failWith: {
        kind: "error",
        safe_message: "inventory unavailable (api_key=SUPERSECRET should redact)",
      },
    });
    const { deps, config } = createHermeticBoundedDeps({
      script: SCRIPT_EVM_ERC721,
      inventory,
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(response.candidates.length).toBeGreaterThan(0);
    expect(response.candidates[0]!.recognition).toBe("recognized");
    expect(response.diagnostics.inventory?.outcome).toBe("error");
    expect(response.diagnostics.entries[0]?.safe_message).not.toMatch(/api_key\s*=/i);
    expect(response.diagnostics.entries[0]?.safe_message).not.toMatch(/SUPERSECRET/);
    expect(response.diagnostics.entries[0]?.safe_message).toMatch(/redacted/i);
  });

  it("exact Inventory match improves ranking without address-only aliasing", () => {
    const { deps, config } = createHermeticBoundedDeps({
      script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
    });
    const base = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    const deploymentId = base.candidates[0]!.identity.deployments[0]!.deployment_id.digest;
    const inventory = createScriptedInventoryPort({
      byDeployment: {
        [deploymentId]: {
          kind: "enriched",
          deployment_id: deploymentId,
          curated_name: "Curated",
          enrichment_version: "inv-1",
          equivalence_basis_kind: "single_deployment",
          ranking_reason: "exact_inventory_match",
        },
      },
    });
    const { deps: deps2, config: config2 } = createHermeticBoundedDeps({
      script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
      inventory,
    });
    const enriched = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config: config2,
        deps: deps2,
      }),
    );
    expect(enriched.candidates[0]!.ranking_reasons).toContain("exact_inventory_match");
    expect(enriched.candidates).toHaveLength(2);
  });
});

describe("CR-102 ranking and diagnostics safety", () => {
  it("tie-breaks with stable canonical deployment keys", () => {
    const left = {
      ranking_reasons: ["supported_standard"],
      token_standard: { value: "erc721" },
      index_status: "missing",
      report_readiness: "preparation_required",
      metadata_quality: "onchain",
      identity: {
        deployments: [
          {
            network: { network_namespace: "eip155", network_reference: "8453" },
            normalized_address: MULTI_CHAIN_EVM_ADDRESS.toLowerCase(),
            deployment_id: { digest: sha256Canonical("8453") },
          },
        ],
      },
    };
    const right = {
      ranking_reasons: ["supported_standard"],
      token_standard: { value: "erc721" },
      index_status: "missing",
      report_readiness: "preparation_required",
      metadata_quality: "onchain",
      identity: {
        deployments: [
          {
            network: { network_namespace: "eip155", network_reference: "1" },
            normalized_address: MULTI_CHAIN_EVM_ADDRESS.toLowerCase(),
            deployment_id: { digest: sha256Canonical("1") },
          },
        ],
      },
    };
    const ranked = rankCandidatesDeterministic([
      left as unknown as CollectionCandidate,
      right as unknown as CollectionCandidate,
    ]);
    expect(ranked[0]!.identity.deployments[0]!.network.network_reference).toBe("1");
  });

  it("redacts secret-like diagnostics and forbids leak assertions", () => {
    expect(redactSafeMessage("bearer token abc")).toMatch(/redacted/i);
    expect(redactSafeMessage("api_key=SUPERSECRET&q=1")).toMatch(/redacted/i);
    expect(() => assertNoSecretLeak({ api_key: "x" })).toThrow(/secret-like/);
    expect(() => assertNoSecretLeak({ body: "SUPERSECRET" })).toThrow(/secret-like/);
  });

  it("maps unrecognized adapter diagnostic codes to a local safe fallback", () => {
    const config = {
      ...defaultBoundedResolverConfig(),
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const { deps } = createHermeticBoundedDeps({
      config,
      script: {
        "eip155:1": {
          kind: "unavailable",
          safe_code: "https://rpc.example.test/?token=SUPERSECRET",
          safe_message: "provider https://rpc.example.test/?token=SUPERSECRET failed",
        },
      },
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(response.diagnostics.entries).toContainEqual({
      network: {
        schema_version: 1,
        network_namespace: "eip155",
        network_reference: "1",
      },
      code: "adapter_unavailable",
      safe_message: "adapter unavailable without a recognized diagnostic code",
    });
    expect(JSON.stringify(response.diagnostics)).not.toContain("SUPERSECRET");
    expect(JSON.stringify(response.diagnostics)).not.toContain("rpc.example.test");
  });

  it("raw decode-cause probe never retains ParseError bodies on public errors", () => {
    const err = expectFailure(
      decodeBoundedResolverConfig({
        ...defaultBoundedResolverConfig(),
        max_concurrent_probes: "not-a-number",
        api_key: "SUPERSECRET",
      }),
    );
    expect(err._tag).toBe("BoundedResolverDecodeError");
    const serialized = JSON.stringify(err);
    expect(serialized).not.toMatch(/SUPERSECRET/);
    expect(serialized).not.toMatch(/ParseError/);
    expect(serialized).not.toMatch(/not-a-number/);
    if (err._tag === "BoundedResolverDecodeError") {
      expect(err.safe_cause).toMatch(/schema_decode_failed|BoundedResolverDecodeError|non_error|ParseError|schema/i);
      expect(err.safe_cause).not.toMatch(/SUPERSECRET/);
      assertNoSecretLeak(err);
    }
  });

  it("Solana path retains case and returns ranking reasons", () => {
    const { deps, config } = createHermeticBoundedDeps({
      script: SCRIPT_SOLANA_COLLECTION,
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(PYTHIANS_COLLECTION_MINT),
        config,
        deps,
      }),
    );
    expect(response.candidates[0]!.identity.deployments[0]!.address).toBe(
      PYTHIANS_COLLECTION_MINT,
    );
    expect(response.ranking_evidence[0]!.ranking_reasons.length).toBeGreaterThan(0);
  });
});

describe("CR-102 abort propagation", () => {
  it("scripted adapter observes abort and does not return hit after abort", () => {
    const clock = createVirtualClock();
    let aborted = 0;
    const adapter = createScriptedNetworkAdapter({
      script: SCRIPT_EVM_ERC721,
      clock,
      workMsByNetwork: { "eip155:1": 100 },
      onAbort: () => {
        aborted += 1;
      },
    });
    const controller = new AbortController();
    controller.abort("test");
    const outcome = Effect.runSync(
      adapter.probe({
        network: {
          schema_version: 1,
          network_namespace: "eip155",
          network_reference: "1",
        },
        network_capability: loadHermeticCapabilitySnapshot().networks[0]!,
        address: MULTI_CHAIN_EVM_ADDRESS,
        abort: { signal: controller.signal, aborted: true },
        clock,
        deadline_at_ms: 1000,
      }),
    ) as { kind: string };
    expect(outcome.kind).toBe("timeout");
    expect(aborted).toBe(1);
  });
});

describe("CR-102 deterministic load harness", () => {
  it("default healthy fixture set meets four-second internal budget with honest denominator", () => {
    const report = runDeterministicLoadHarness({ iterations: 48, workMsPerProbe: 3 });
    expect(report.within_four_second_budget).toBe(true);
    expect(report.virtual_elapsed_ms).toBeLessThanOrEqual(4_000);
    expect(report.p50_ms).toBeGreaterThanOrEqual(0);
    expect(report.p95_ms).toBeGreaterThanOrEqual(report.p50_ms);
    expect(report.cold_adapter_calls).toBeGreaterThanOrEqual(report.expected_adapter_calls_min);
    expect(report.acceptance.uncached_fanout_met).toBe(true);
    expect(report.iterations).toBe(48);
    expect(report.acceptance.denominator).toBe(48);
    expect(report.successful_completions + report.failure_or_rate_limited).toBe(48);
    expect(report.acceptance.successful_met).toBe(true);
    expect(report.cold_phase_iterations).toBeGreaterThan(0);
    expect(report.warm_phase_iterations).toBeGreaterThan(0);
  });

  it("caller min_successful cannot lower acceptance floor", () => {
    const report = runDeterministicLoadHarness({
      iterations: 48,
      workMsPerProbe: 3,
      min_successful: 1,
    });
    expect(report.acceptance.min_successful).toBe(Math.floor(48 * 0.75));
    expect(report.acceptance.min_successful).toBeGreaterThan(1);
  });
});

describe("CR-102 partial timeout fixture", () => {
  it("records timed_out networks without dropping successful hits", () => {
    const { deps, config, cache } = createHermeticBoundedDeps({
      script: SCRIPT_PARTIAL_TIMEOUT,
    });
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(response.candidates.length).toBeGreaterThanOrEqual(1);
    expect(response.diagnostics.timed_out.some((n) => n.network_reference === "8453")).toBe(
      true,
    );
    expect(response.diagnostics.partial).toBe(true);
    expect(cache.__debug().negative).toBe(0);
  });
});

describe("CR-102 revision-2 real-timer non-cooperative adapters", () => {
  it("10ms per-network deadline returns near 10ms (not 60ms) when adapter ignores abort", async () => {
    const processClock = createProcessMonotonicClock();
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 4_000,
      per_network_deadline_ms: 10,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const { deps, cache, adapter } = createHermeticBoundedDeps({
      processClock,
      config,
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 60 },
      ignoreAbort: true,
    });
    const t0 = processClock.nowMs();
    const response = await Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    const elapsed = processClock.nowMs() - t0;
    expect(response.diagnostics.timed_out.length).toBeGreaterThan(0);
    expect(response.candidates).toHaveLength(0);
    expect(cache.__debug().negative).toBe(0);
    // Near 10ms, not 60ms — allow timer slack but must not wait for ignored-abort sleep.
    expect(elapsed).toBeGreaterThanOrEqual(8);
    expect(elapsed).toBeLessThan(35);
    // Single execution: no hidden runSyncExit probe before the raced fiber.
    expect(adapter.externalStarts()).toBe(1);
    expect(adapter.calls()).toHaveLength(1);
    expect(deps.metrics.snapshot().adapter_calls).toBe(1);
  });

  it("30ms global deadline returns near 30ms (not 80ms) with ignored-abort late adapter", async () => {
    const processClock = createProcessMonotonicClock();
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 30,
      per_network_deadline_ms: 25,
      max_concurrent_probes: 2,
    };
    const { deps, cache, adapter } = createHermeticBoundedDeps({
      processClock,
      config,
      script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
      realSleepMsByNetwork: {
        "eip155:1": 20,
        "eip155:8453": 80,
      },
      ignoreAbort: true,
    });
    const t0 = processClock.nowMs();
    const response = await Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    const elapsed = processClock.nowMs() - t0;
    expect(response.diagnostics.partial || response.diagnostics.global_deadline_exceeded).toBe(
      true,
    );
    expect(cache.__debug().negative).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(55);
    expect(adapter.externalStarts()).toBe(2);
    expect(adapter.calls()).toHaveLength(2);
    expect(adapter.peakExternalConcurrency()).toBeLessThanOrEqual(2);
    expect(adapter.peakExternalConcurrency()).toBe(2);
  });
});

describe("CR-102 revision-2 slow Inventory under global deadline", () => {
  it("80ms Inventory under 30ms global returns near 30ms, partial, abort observed, no positive/readiness cache", async () => {
    const processClock = createProcessMonotonicClock();
    let inventoryAbort = 0;
    const inventory = createScriptedInventoryPort({
      clock: processClock,
      realSleepMs: 80,
      ignoreAbort: true,
      onAbort: () => {
        inventoryAbort += 1;
      },
      results: [
        {
          kind: "enriched",
          deployment_id: "late-should-not-cache",
          enrichment_version: "inv-late",
          equivalence_basis_kind: "single_deployment",
          ranking_reason: "exact_inventory_match",
        },
      ],
    });
    // Fast adapters so Inventory is the slow path inside the global deadline.
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 30,
      per_network_deadline_ms: 20,
      inventory_enrichment_budget_ms: 500,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const { deps, cache } = createHermeticBoundedDeps({
      processClock,
      config,
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 5 },
      inventory,
    });
    // Force abort observation: cooperative abort path after deadline race fires.
    const inventoryCoop = createScriptedInventoryPort({
      clock: processClock,
      realSleepMs: 80,
      ignoreAbort: false,
      onAbort: () => {
        inventoryAbort += 1;
      },
    });
    const { deps: deps2, cache: cache2 } = createHermeticBoundedDeps({
      processClock,
      config,
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 5 },
      inventory: inventoryCoop,
    });

    const t0 = processClock.nowMs();
    const response = await Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps: deps2,
      }),
    );
    const elapsed = processClock.nowMs() - t0;

    expect(response.diagnostics.global_deadline_exceeded || response.diagnostics.partial).toBe(
      true,
    );
    expect(
      response.diagnostics.inventory?.outcome === "timeout" ||
        response.diagnostics.inventory?.outcome === "skipped",
    ).toBe(true);
    expect(cache2.__debug().positive).toBe(0);
    expect(cache2.__debug().readiness).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(55);
    expect(inventoryAbort).toBeGreaterThan(0);
    // Slow Inventory Effect executes exactly once (no probe-then-re-run).
    expect(inventoryCoop.calls()).toHaveLength(1);

    // Non-cooperative Inventory also cannot write positive/readiness after deadline.
    const t1 = processClock.nowMs();
    const late = await Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "inv-ignore"),
        config,
        deps,
      }),
    );
    const elapsedLate = processClock.nowMs() - t1;
    expect(late.diagnostics.partial || late.diagnostics.global_deadline_exceeded).toBe(true);
    expect(cache.__debug().positive).toBe(0);
    expect(cache.__debug().readiness).toBe(0);
    expect(elapsedLate).toBeLessThan(55);
    expect(inventory.calls()).toHaveLength(1);
  });
});

describe("CR-102 revision-2 concurrent leader/follower coalesce", () => {
  it("strict-decodes a leader response before returning it to a follower", async () => {
    const base = createHermeticBoundedDeps({ script: SCRIPT_EVM_ERC721 });
    const deps = {
      ...base.deps,
      coalesce: {
        begin: () =>
          Effect.succeed({
            kind: "follower" as const,
            wait_for_leader: true as const,
            shared: Promise.resolve({
              kind: "response" as const,
              response: { schema_version: 1, candidates: "not-an-array" },
            }),
          }),
        complete: () => Effect.void,
      },
    };
    const exit = await Effect.runPromiseExit(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "malformed-follower"),
        config: base.config,
        deps,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("does not coalesce identical identifiers across authorization scopes", async () => {
    const processClock = createProcessMonotonicClock();
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
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 40 },
    });
    const authenticated = hermeticResolveRequest(
      MULTI_CHAIN_EVM_ADDRESS,
      "scope-authenticated",
    );
    const anonymous = {
      ...hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "scope-anonymous"),
      caller: {
        bucket_id: "scope-anonymous",
        authorization_scope: { scope_class: "anonymous" as const },
      },
    };

    const first = Effect.runPromise(resolveBounded({ request: authenticated, config, deps }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = Effect.runPromise(resolveBounded({ request: anonymous, config, deps }));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.diagnostics.cache.coalesced).toBe(false);
    expect(secondResult.diagnostics.cache.coalesced).toBe(false);
    expect(adapter.externalStarts()).toBe(2);
  });

  it("follower receives leader sealed candidates (not fabricated empty)", async () => {
    const processClock = createProcessMonotonicClock();
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 200,
      per_network_deadline_ms: 150,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const { deps } = createHermeticBoundedDeps({
      processClock,
      config,
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 40 },
    });

    const leaderP = Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "coal-a"),
        config,
        deps,
      }),
    );
    // Yield so leader registers in-flight before follower begins.
    await new Promise((r) => setTimeout(r, 5));
    const followerP = Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "coal-b"),
        config,
        deps,
      }),
    );

    const [leader, follower] = await Promise.all([leaderP, followerP]);
    expect(leader.candidates.length).toBeGreaterThan(0);
    expect(follower.candidates.length).toBe(leader.candidates.length);
    expect(follower.diagnostics.cache.coalesced).toBe(true);
    expect(follower.candidates.map((c) => c.identity.deployments[0]!.deployment_id.digest)).toEqual(
      leader.candidates.map((c) => c.identity.deployments[0]!.deployment_id.digest),
    );
  });

  it("requests with different deadline budgets do not coalesce", async () => {
    const processClock = createProcessMonotonicClock();
    const slowConfig = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 200,
      per_network_deadline_ms: 150,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const fastFollowerConfig = {
      ...slowConfig,
      global_deadline_ms: 15,
      per_network_deadline_ms: 10,
    };
    const { deps, adapter } = createHermeticBoundedDeps({
      processClock,
      config: slowConfig,
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 80 },
    });

    const leaderP = Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "lead"),
        config: slowConfig,
        deps,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    const follower = await Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "follow"),
        config: fastFollowerConfig,
        deps,
      }),
    );
    // The short-budget request must execute under its own policy rather than
    // inheriting the long-budget leader's result.
    expect(follower.diagnostics.partial).toBe(true);
    expect(follower.diagnostics.cache.coalesced).toBe(false);
    expect(follower.candidates).toHaveLength(0);
    expect(
      follower.diagnostics.entries.some((e) => e.code.includes("coalesce")),
    ).toBe(false);

    const leader = await leaderP;
    expect(leader.candidates.length).toBeGreaterThan(0);
    expect(adapter.externalStarts()).toBe(2);
  });

  it("releases a follower with a safe typed result when the leader defects", async () => {
    const processClock = createProcessMonotonicClock();
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 300,
      per_network_deadline_ms: 250,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const base = createHermeticBoundedDeps({
      processClock,
      config,
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 30 },
    });
    const deps = {
      ...base.deps,
      cache: {
        ...base.deps.cache,
        setPositive: () => Effect.die("raw cache defect must not reach follower"),
      },
    };

    const leaderP = Effect.runPromiseExit(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "defect-leader"),
        config,
        deps,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const followerStartedAt = Date.now();
    const follower = await Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS, "defect-follower"),
        config,
        deps,
      }),
    );

    expect(Exit.isFailure(await leaderP)).toBe(true);
    expect(Date.now() - followerStartedAt).toBeLessThan(config.global_deadline_ms);
    expect(follower.diagnostics.partial).toBe(true);
    expect(follower.diagnostics.cache.coalesced).toBe(true);
    expect(follower.diagnostics.entries).toContainEqual({
      code: "bounded_resolver_failure",
      safe_message: expect.not.stringContaining("raw cache defect"),
    });
  });
});

describe("CR-102 revision-2 cold rate-limit acceptance denial", () => {
  it("23/24 cold rate-limited fails acceptance regardless of warm or min_successful", () => {
    const denied = runColdRateLimitDenialHarness({
      cold_iterations: 24,
      allowed_cold_successes: 1,
    });
    expect(denied.successful_completions).toBe(1);
    expect(denied.failure_or_rate_limited).toBe(23);
    expect(denied.acceptance.denominator).toBe(24);
    expect(denied.acceptance.successful_met).toBe(false);
    // Attempting to pass a lowered min_successful on the main harness cannot rescue this class.
    const lowered = runDeterministicLoadHarness({
      iterations: 8,
      workMsPerProbe: 1,
      min_successful: 1,
    });
    // Healthy small run still uses non-configurable floor (6), not 1.
    expect(lowered.acceptance.min_successful).toBe(Math.floor(8 * 0.75));
    expect(denied.within_four_second_budget).toBe(false);
  });
});

describe("CR-102 single-execution deadline race", () => {
  it("does not start work for expired absolute deadlines and selects the earliest expiry", () => {
    const clock = createVirtualClock({ originMs: 100 });
    let starts = 0;
    const fired: string[] = [];
    const value = expectSuccess(
      raceSettlementAgainstDeadlines({
        effect: Effect.sync(() => {
          starts += 1;
          return "started";
        }),
        clock,
        timer: clock,
        deadlines: [
          { at_ms: 90, kind: "per_network_deadline" },
          { at_ms: 80, kind: "global_deadline" },
        ],
        onDeadline: (kind) => fired.push(kind),
        timeoutValue: "timeout",
      }),
    );

    expect(value).toBe("timeout");
    expect(fired).toEqual(["global_deadline"]);
    expect(starts).toBe(0);
  });

  it("one configured network under deadline invokes adapter once", async () => {
    const processClock = createProcessMonotonicClock();
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 4_000,
      per_network_deadline_ms: 15,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const { deps, adapter } = createHermeticBoundedDeps({
      processClock,
      config,
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 5 },
    });
    await Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(adapter.externalStarts()).toBe(1);
    expect(adapter.calls()).toHaveLength(1);
    expect(deps.metrics.snapshot().adapter_calls).toBe(1);
    expect(adapter.peakExternalConcurrency()).toBe(1);
    expect(deps.metrics.snapshot().peak_concurrency).toBe(1);
  });

  it("two targets with max_concurrent_probes: 2 produce exactly two external starts and peak <= 2", async () => {
    const processClock = createProcessMonotonicClock();
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 4_000,
      per_network_deadline_ms: 100,
      max_concurrent_probes: 2,
    };
    const { deps, adapter } = createHermeticBoundedDeps({
      processClock,
      config,
      script: SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
      realSleepMsByNetwork: {
        "eip155:1": 25,
        "eip155:8453": 25,
      },
    });
    await Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    expect(adapter.externalStarts()).toBe(2);
    expect(adapter.calls()).toHaveLength(2);
    expect(deps.metrics.snapshot().adapter_calls).toBe(2);
    expect(adapter.peakExternalConcurrency()).toBeLessThanOrEqual(2);
    expect(deps.metrics.snapshot().peak_concurrency).toBeLessThanOrEqual(2);
    expect(adapter.peakExternalConcurrency()).toBe(2);
  });

  it("slow Inventory invokes once under global deadline", async () => {
    const processClock = createProcessMonotonicClock();
    const inventory = createScriptedInventoryPort({
      clock: processClock,
      realSleepMs: 80,
      ignoreAbort: true,
    });
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 30,
      per_network_deadline_ms: 20,
      inventory_enrichment_budget_ms: 500,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const { deps } = createHermeticBoundedDeps({
      processClock,
      config,
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 5 },
      inventory,
    });
    const t0 = processClock.nowMs();
    await Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    const elapsed = processClock.nowMs() - t0;
    expect(inventory.calls()).toHaveLength(1);
    expect(elapsed).toBeLessThan(55);
  });

  it("cooperative deadline: near deadline with exactly one external start", async () => {
    const processClock = createProcessMonotonicClock();
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 4_000,
      per_network_deadline_ms: 10,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const { deps, adapter } = createHermeticBoundedDeps({
      processClock,
      config,
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 60 },
      ignoreAbort: false,
    });
    const t0 = processClock.nowMs();
    const response = await Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    const elapsed = processClock.nowMs() - t0;
    expect(response.diagnostics.timed_out.length).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(8);
    expect(elapsed).toBeLessThan(35);
    expect(adapter.externalStarts()).toBe(1);
    expect(adapter.calls()).toHaveLength(1);
  });

  it("non-cooperative deadline: near deadline with no second call", async () => {
    const processClock = createProcessMonotonicClock();
    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 4_000,
      per_network_deadline_ms: 10,
      max_searched_networks: 1,
      max_concurrent_probes: 1,
    };
    const { deps, adapter } = createHermeticBoundedDeps({
      processClock,
      config,
      script: SCRIPT_EVM_ERC721,
      realSleepMsByNetwork: { "eip155:1": 60 },
      ignoreAbort: true,
    });
    const t0 = processClock.nowMs();
    await Effect.runPromise(
      resolveBounded({
        request: hermeticResolveRequest(MULTI_CHAIN_EVM_ADDRESS),
        config,
        deps,
      }),
    );
    const elapsed = processClock.nowMs() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(8);
    expect(elapsed).toBeLessThan(35);
    expect(adapter.externalStarts()).toBe(1);
    expect(adapter.calls()).toHaveLength(1);
  });

  it("no hidden first execution mutates state before the raced execution", async () => {
    // Direct unit proof: raceSettlementAgainstDeadlines must not runSyncExit-probe.
    const clock = createProcessMonotonicClock();
    let starts = 0;
    let mutatedBeforeRace = 0;
    const effect = Effect.promise(async () => {
      starts += 1;
      if (starts === 1) {
        // First (and only) execution may mutate; a hidden probe would bump this twice.
        mutatedBeforeRace += 1;
      }
      await new Promise((r) => setTimeout(r, 40));
      return "late";
    });
    const t0 = clock.nowMs();
    const value = await Effect.runPromise(
      raceSettlementAgainstDeadlines({
        effect,
        clock,
        timer: clock,
        deadlines: [{ at_ms: clock.nowMs() + 10, kind: "per_network_deadline" }],
        onDeadline: () => undefined,
        timeoutValue: "timeout",
      }),
    );
    const elapsed = clock.nowMs() - t0;
    expect(value).toBe("timeout");
    expect(starts).toBe(1);
    expect(mutatedBeforeRace).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(8);
    expect(elapsed).toBeLessThan(35);
    // Allow late settlement to finish without a second start.
    await new Promise((r) => setTimeout(r, 50));
    expect(starts).toBe(1);
  });
});
