import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  assertNoSecretLeak,
  assertSolanaKeyCaseRetained,
  buildCandidateFromHit,
  createHermeticBoundedDeps,
  createProcessMonotonicClock,
  createFetchDasSamplePort,
  createProductionSolanaDasNetworkAdapter,
  createSolanaDasNetworkAdapter,
  createScriptedDasSamplePort,
  createVirtualClock,
  DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT,
  MAX_DAS_RECOGNITION_SAMPLE_LIMIT,
  defaultBoundedResolverConfig,
  deriveIndexAndReadiness,
  findCollectionByMintExact,
  hermeticResolveRequest,
  loadHermeticCapabilitySnapshot,
  normalizeDasCollectionProbe,
  normalizeDasSampleLimit,
  normalizeSolanaAddress,
  parseDasGetAssetRpcResponse,
  parseDasSampleRpcResponse,
  parseDasSampleLimitArgument,
  projectSolanaDasHit,
  PYTHIANS_COLLECTION_MINT,
  resolveBounded,
  solanaMainnetCapability,
  solanaRecognizeCapability,
  buildDasGetAssetRequestBody,
  buildDasSampleRequestBody,
  classifyDasSampleItems,
  classifyHttpStatus,
  type AdapterProbeRequest,
  type DasSampleRequest,
  type NetworkAdapterPort,
  type NetworkCapability,
} from "../src/collection-resolver/index.js";
import {
  FIXTURE_CLASSIC_ITEMS,
  FIXTURE_COMPRESSED_ITEMS,
  FIXTURE_MIXED_ITEMS,
  FIXTURE_PROGRAMMABLE_ITEMS,
  FIXTURE_UNKNOWN_ITEMS,
  FIXTURE_UNVERIFIED_ITEMS,
  REGISTERED_COLLECTION_MINT,
  WRONG_CASE_PYTHIANS_MINT,
  sampleOutcome,
} from "../src/collection-resolver/adapters/solana/testing.js";
import type {
  CollectionSnapshot,
  DasAsset,
} from "../src/svm/nft-collection-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_DAS_FIXTURE: { result: { items: DasAsset[] } } = JSON.parse(
  readFileSync(join(HERE, "fixtures", "pyth-das-getassetsbygroup.json"), "utf8"),
);

const expectSuccess = <A, E>(effect: Effect.Effect<A, E>): A => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isFailure(exit)) {
    throw new Error(`expected success, got ${String(exit.cause)}`);
  }
  return exit.value;
};

const expectAsyncSuccess = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(exit)) {
    throw new Error(`expected success, got ${String(exit.cause)}`);
  }
  return exit.value;
};

const solanaCapability = () => solanaMainnetCapability();
const defaultProbeClock = createProcessMonotonicClock();

const probeRequest = (
  address: string,
  overrides: Partial<AdapterProbeRequest> = {},
): AdapterProbeRequest => {
  const capability = solanaCapability();
  const controller = new AbortController();
  const clock = overrides.clock ?? defaultProbeClock;
  return {
    network: capability.network,
    network_capability: capability,
    address,
    abort: {
      signal: controller.signal,
      get aborted() {
        return controller.signal.aborted;
      },
    },
    clock,
    deadline_at_ms: clock.nowMs() + 5_000,
    ...overrides,
  };
};

const adapterFor = (
  handler: (
    request: DasSampleRequest,
  ) =>
    | ReturnType<typeof sampleOutcome>
    | { kind: "timeout" }
    | {
        kind: "unavailable";
        failure:
          | "http_429"
          | "http_5xx"
          | "http_auth"
          | "http_4xx"
          | "rpc_error"
          | "malformed"
          | "incomplete"
          | "timeout"
          | "aborted"
          | "network";
      },
  sharedState?: { mutations: number },
  extras?: {
    collectionAssetHandler?: Parameters<
      typeof createScriptedDasSamplePort
    >[0]["collectionAssetHandler"];
    readinessPort?: Parameters<typeof createSolanaDasNetworkAdapter>[0]["readinessPort"];
    capabilityOverride?: NetworkCapability;
  },
): {
  adapter: NetworkAdapterPort;
  port: ReturnType<typeof createScriptedDasSamplePort>;
  sharedState: { mutations: number };
} => {
  const state = sharedState ?? { mutations: 0 };
  const port = createScriptedDasSamplePort({
    handler: (req) => handler(req),
    sharedState: state,
    collectionAssetHandler: extras?.collectionAssetHandler,
  });
  const adapter = createSolanaDasNetworkAdapter({
    dasPort: port,
    sampleLimit: DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT,
    observedAt: "2026-07-16T12:00:00.000Z",
    sharedState: state,
    readinessPort: extras?.readinessPort,
  });
  return { adapter, port, sharedState: state };
};

const waitUntil = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 1_000,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("CR-104 Solana DAS sample classifier (CLI parity)", () => {
  it("types classic, programmable, and compressed coverage", () => {
    expect(classifyDasSampleItems(FIXTURE_CLASSIC_ITEMS).coverage).toBe("classic");
    expect(classifyDasSampleItems(FIXTURE_CLASSIC_ITEMS).token_standard).toBe(
      "metaplex_collection",
    );
    expect(classifyDasSampleItems(FIXTURE_PROGRAMMABLE_ITEMS).coverage).toBe(
      "programmable",
    );
    expect(classifyDasSampleItems(FIXTURE_PROGRAMMABLE_ITEMS).token_standard).toBe(
      "programmable_nft",
    );
    expect(classifyDasSampleItems(FIXTURE_COMPRESSED_ITEMS).coverage).toBe(
      "compressed",
    );
    expect(classifyDasSampleItems(FIXTURE_COMPRESSED_ITEMS).token_standard).toBe(
      "compressed_nft",
    );
  });

  it("types mixed and unknown without inventing a supported standard", () => {
    expect(classifyDasSampleItems(FIXTURE_MIXED_ITEMS).coverage).toBe("mixed");
    expect(classifyDasSampleItems(FIXTURE_MIXED_ITEMS).token_standard).toBe("unknown");
    expect(classifyDasSampleItems(FIXTURE_UNKNOWN_ITEMS).coverage).toBe("unknown");
    expect(classifyDasSampleItems(FIXTURE_UNKNOWN_ITEMS).token_standard).toBe("unknown");
  });

  it("does not infer a supported standard from one known and one unknown interface", () => {
    const unknown = FIXTURE_UNKNOWN_ITEMS[0]!;
    const programmable = classifyDasSampleItems([
      FIXTURE_PROGRAMMABLE_ITEMS[0]!,
      unknown,
    ]);
    expect(programmable.coverage).toBe("mixed");
    expect(programmable.token_standard).toBe("unknown");

    const classic = classifyDasSampleItems([FIXTURE_CLASSIC_ITEMS[0]!, unknown]);
    expect(classic.coverage).toBe("mixed");
    expect(classic.token_standard).toBe("unknown");
  });

  it("builds a single-page getAssetsByGroup body with exact-case groupValue", () => {
    const body = buildDasSampleRequestBody({
      collection_mint: PYTHIANS_COLLECTION_MINT,
      limit: 8,
    });
    expect(body.method).toBe("getAssetsByGroup");
    expect(body.params.page).toBe(1);
    expect(body.params.groupValue).toBe(PYTHIANS_COLLECTION_MINT);
    expect(body.params.groupValue).not.toBe(PYTHIANS_COLLECTION_MINT.toLowerCase());
  });

  it("rejects non-finite budgets and clamps finite adapter/CLI budgets", () => {
    expect(normalizeDasSampleLimit(Number.NaN)).toBeUndefined();
    expect(normalizeDasSampleLimit(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeDasSampleLimit(0)).toBe(1);
    expect(normalizeDasSampleLimit(7.9)).toBe(7);
    expect(normalizeDasSampleLimit(50_000)).toBe(MAX_DAS_RECOGNITION_SAMPLE_LIMIT);
    expect(parseDasSampleLimitArgument("50000")).toBe(
      MAX_DAS_RECOGNITION_SAMPLE_LIMIT,
    );
    expect(() => parseDasSampleLimitArgument("Infinity")).toThrow(/finite/);
    expect(() => parseDasSampleLimitArgument("not-a-number")).toThrow(/finite/);
    expect(() =>
      buildDasSampleRequestBody({
        collection_mint: PYTHIANS_COLLECTION_MINT,
        limit: Number.NaN,
      }),
    ).toThrow(/finite/);
  });
});

describe("CR-104 parseDasSampleRpcResponse — conclusive empty vs incomplete", () => {
  it("treats explicit result.items: [] as ok empty (conclusive miss candidate)", () => {
    const parsed = parseDasSampleRpcResponse({ jsonrpc: "2.0", result: { items: [] } });
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") expect(parsed.page.items).toEqual([]);
  });

  it("treats missing/null result as incomplete, never empty ok", () => {
    expect(parseDasSampleRpcResponse({ jsonrpc: "2.0" }).kind).toBe("incomplete");
    expect(parseDasSampleRpcResponse({ jsonrpc: "2.0", result: null }).kind).toBe(
      "incomplete",
    );
    const missing = parseDasSampleRpcResponse({ jsonrpc: "2.0" });
    if (missing.kind === "incomplete") {
      expect(missing.safe_reason).toBe("das_result_missing");
    }
  });

  it("treats missing/null items as incomplete, never empty ok", () => {
    expect(parseDasSampleRpcResponse({ result: {} }).kind).toBe("incomplete");
    expect(parseDasSampleRpcResponse({ result: { items: null } }).kind).toBe(
      "incomplete",
    );
  });

  it("treats malformed schema as malformed", () => {
    expect(parseDasSampleRpcResponse({ result: { items: "nope" } }).kind).toBe(
      "malformed",
    );
    expect(parseDasSampleRpcResponse("not-object").kind).toBe("malformed");
  });
});

describe("CR-104 exact-case registry lookup", () => {
  it("enriches only on exact collection-mint match", () => {
    const hit = findCollectionByMintExact(REGISTERED_COLLECTION_MINT);
    expect(hit?.collectionKey).toBe("pythians");
    expect(hit?.displayName).toBe("Pythenians");
    expect(findCollectionByMintExact(WRONG_CASE_PYTHIANS_MINT)).toBeUndefined();
    expect(findCollectionByMintExact(` ${REGISTERED_COLLECTION_MINT} `)).toBeUndefined();
  });
});

describe("CR-104 Solana DAS NetworkAdapterPort", () => {
  it("recognizes classic coverage with preparation_required", async () => {
    const mint = "ClassicCollectionMint111111111111111111111";
    const { adapter, port, sharedState } = adapterFor(() =>
      sampleOutcome(mint, FIXTURE_CLASSIC_ITEMS),
    );
    const outcome = await expectAsyncSuccess(adapter.probe(probeRequest(mint)));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.token_standard).toBe("metaplex_collection");
    expect(outcome.recognition).toBe("recognized");
    expect(outcome.index_status).toBe("missing");
    expect(outcome.report_readiness).toBe("preparation_required");
    expect(outcome.binding_evidence).toBeUndefined();
    expect(outcome.address).toBe(mint);
    expect(port.calls()).toHaveLength(1);
    expect(port.calls()[0]!.page).toBe(1);
    expect(port.calls()[0]!.collection_mint).toBe(mint);
    expect(sharedState.mutations).toBe(1);
  });

  it("recognizes programmable coverage separately from index readiness", async () => {
    const { adapter } = adapterFor(() =>
      sampleOutcome(PYTHIANS_COLLECTION_MINT, FIXTURE_PROGRAMMABLE_ITEMS),
    );
    const outcome = await expectAsyncSuccess(
      adapter.probe(probeRequest(PYTHIANS_COLLECTION_MINT)),
    );
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.token_standard).toBe("programmable_nft");
    expect(outcome.index_status).toBe("missing");
    expect(outcome.report_readiness).toBe("preparation_required");
  });

  it("recognizes compressed coverage while requiring later preparation", async () => {
    const mint = "CompressedCollectionMint111111111111111111";
    const { adapter } = adapterFor(() =>
      sampleOutcome(mint, FIXTURE_COMPRESSED_ITEMS),
    );
    const outcome = await expectAsyncSuccess(adapter.probe(probeRequest(mint)));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.token_standard).toBe("compressed_nft");
    expect(outcome.recognition).toBe("recognized");
    expect(outcome.report_readiness).toBe("preparation_required");
  });

  it("marks mixed/unknown as ambiguous without inventing readiness", async () => {
    const mint = "MixedCollectionMint11111111111111111111111";
    const { adapter } = adapterFor(() => sampleOutcome(mint, FIXTURE_MIXED_ITEMS));
    const mixed = await expectAsyncSuccess(adapter.probe(probeRequest(mint)));
    expect(mixed.kind).toBe("hit");
    if (mixed.kind === "hit") {
      expect(mixed.recognition).toBe("ambiguous");
      expect(mixed.token_standard).toBe("unknown");
      expect(mixed.report_readiness).toBe("preparation_required");
    }

    const unknownMint = "UnknownCollectionMint1111111111111111111";
    const { adapter: unknownAdapter } = adapterFor(() =>
      sampleOutcome(unknownMint, FIXTURE_UNKNOWN_ITEMS),
    );
    const unknown = await expectAsyncSuccess(
      unknownAdapter.probe(probeRequest(unknownMint)),
    );
    expect(unknown.kind).toBe("hit");
    if (unknown.kind === "hit") {
      expect(unknown.recognition).toBe("ambiguous");
      expect(unknown.collection_key).toBeUndefined();
    }
  });

  it("enriches registered exact mint with display name/symbol/collection_key without member image", async () => {
    const { adapter } = adapterFor(() =>
      sampleOutcome(REGISTERED_COLLECTION_MINT, FIXTURE_PROGRAMMABLE_ITEMS),
    );
    const outcome = await expectAsyncSuccess(
      adapter.probe(probeRequest(REGISTERED_COLLECTION_MINT)),
    );
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.name).toBe("Pythenians");
    expect(outcome.symbol).toBe("$PTN");
    expect(outcome.collection_key).toBe("pythians");
    expect(outcome.image).toBeUndefined();
    expect(outcome.ranking_reasons).toContain("exact_registry_match");
    expect(outcome.ranking_reasons).not.toContain("onchain_metadata");
    const material = outcome.evidence_material as {
      sample_member_name?: string;
      sample_member_image?: string;
    };
    expect(material.sample_member_name).toBe("Pythian #1");
    expect(material.sample_member_image).toMatch(/^https:\/\/ipfs\.pythenians\.xyz\//);

    const candidate = expectSuccess(
      buildCandidateFromHit({
        capability: solanaRecognizeCapability(),
        address: REGISTERED_COLLECTION_MINT,
        hit: outcome,
      }),
    );
    expect(candidate.identity.collection_key).toBe("pythians");
    expect(candidate.identity.name).toBe("Pythenians");
    expect(candidate.identity.image).toBeUndefined();
    expect(candidate.identity.equivalence_basis.kind).toBe("single_deployment");
    expect(candidate.identity.deployments).toHaveLength(1);
  });

  it("unknown-but-recognized preparation stays preparation_required without registry", async () => {
    const mint = "UnregisteredMint11111111111111111111111111";
    const { adapter } = adapterFor(() =>
      sampleOutcome(mint, FIXTURE_CLASSIC_ITEMS),
    );
    const outcome = await expectAsyncSuccess(adapter.probe(probeRequest(mint)));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.collection_key).toBeUndefined();
    // Member name/image must not become collection identity.
    expect(outcome.name).toBeUndefined();
    expect(outcome.image).toBeUndefined();
    expect(outcome.report_readiness).toBe("preparation_required");
    expect(outcome.ranking_reasons).not.toContain("exact_registry_match");
  });

  it("returns miss only on explicit empty sample", async () => {
    const mint = "EmptyCollectionMint11111111111111111111111";
    const { adapter } = adapterFor(() => sampleOutcome(mint, []));
    const outcome = await expectAsyncSuccess(adapter.probe(probeRequest(mint)));
    expect(outcome).toEqual({ kind: "miss" });
  });

  it("returns unavailable for non-empty page with zero valid members", async () => {
    const mint = "UnverifiedCollectionMint111111111111111111";
    const { adapter } = adapterFor(() =>
      sampleOutcome(mint, FIXTURE_UNVERIFIED_ITEMS),
    );
    const outcome = await expectAsyncSuccess(adapter.probe(probeRequest(mint)));
    expect(outcome).toEqual({ kind: "unavailable" });
  });

  it("maps malformed / incomplete / 429 / 5xx / auth to typed unavailable without leaking secrets", async () => {
    for (const failure of [
      "malformed",
      "incomplete",
      "http_429",
      "http_5xx",
      "http_auth",
      "http_4xx",
    ] as const) {
      const { adapter } = adapterFor(() => ({ kind: "unavailable", failure }));
      const outcome = await expectAsyncSuccess(
        adapter.probe(probeRequest(PYTHIANS_COLLECTION_MINT)),
      );
      expect(outcome).toEqual({ kind: "unavailable" });
      assertNoSecretLeak(outcome);
    }
    expect(classifyHttpStatus(429)).toBe("http_429");
    expect(classifyHttpStatus(503)).toBe("http_5xx");
    expect(classifyHttpStatus(401)).toBe("http_auth");
    expect(classifyHttpStatus(404)).toBe("http_4xx");
  });

  it("parseDasSampleRpcResponse never returns raw provider bodies", () => {
    const parsed = parseDasSampleRpcResponse({
      error: { code: -32000, message: "api_key=SUPERSECRET https://helius.example/?api-key=abc" },
    });
    expect(parsed.kind).toBe("rpc_error");
    if (parsed.kind === "rpc_error") {
      expect(parsed.safe_reason).toBe("das_rpc_error");
      expect(parsed.safe_reason).not.toMatch(/SUPERSECRET|api-key|helius/i);
    }
  });

  it("uses collection getAsset observation for identity when registry absent", async () => {
    const mint = "UnregisteredWithAsset111111111111111111111";
    const { adapter } = adapterFor(
      () => sampleOutcome(mint, FIXTURE_CLASSIC_ITEMS),
      undefined,
      {
        collectionAssetHandler: () => ({
          kind: "observed",
          observation: {
            collection_mint: mint,
            name: "Collection From GetAsset",
            symbol: "CGA",
            image: "https://cdn.example.test/collection.png",
          },
        }),
      },
    );
    const outcome = await expectAsyncSuccess(adapter.probe(probeRequest(mint)));
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.name).toBe("Collection From GetAsset");
    expect(outcome.symbol).toBe("CGA");
    expect(outcome.image).toBe("https://cdn.example.test/collection.png");
    expect(outcome.ranking_reasons).toContain("onchain_metadata");
  });

  it("does not auto-upgrade programmable when capability prepare is enabled", () => {
    const cap = solanaMainnetCapability();
    const prepareEnabled: NetworkCapability = {
      ...cap,
      index_support: true,
      operations: {
        ...cap.operations,
        prepare: {
          ...cap.operations.prepare,
          enabled: true,
          state: "available",
        },
      },
    };
    const derived = deriveIndexAndReadiness(prepareEnabled, undefined);
    expect(derived).toEqual({
      index_status: "missing",
      report_readiness: "preparation_required",
    });

    const hit = projectSolanaDasHit({
      collection_mint: PYTHIANS_COLLECTION_MINT,
      items: [...FIXTURE_PROGRAMMABLE_ITEMS],
      sample_limit: DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT,
      classification: classifyDasSampleItems(FIXTURE_PROGRAMMABLE_ITEMS),
      capability: prepareEnabled,
      registry: findCollectionByMintExact(PYTHIANS_COLLECTION_MINT),
      observed_at: "2026-07-16T12:00:00.000Z",
    });
    expect(hit.index_status).toBe("missing");
    expect(hit.report_readiness).toBe("preparation_required");
    expect(hit.image).toBeUndefined();
  });

  it("applies injected readiness observation only under capability ceiling", async () => {
    const { adapter } = adapterFor(
      () => sampleOutcome(PYTHIANS_COLLECTION_MINT, FIXTURE_PROGRAMMABLE_ITEMS),
      undefined,
      {
        readinessPort: {
          observe: () =>
            Effect.succeed({
              kind: "observed" as const,
              readiness: {
                index_status: "indexed" as const,
                report_readiness: "ready" as const,
              },
            }),
        },
      },
    );
    // Default solana capability has index_support=false — ceiling clamps.
    const clamped = await expectAsyncSuccess(
      adapter.probe(probeRequest(PYTHIANS_COLLECTION_MINT)),
    );
    expect(clamped.kind).toBe("hit");
    if (clamped.kind === "hit") {
      expect(clamped.index_status).toBe("missing");
      expect(clamped.report_readiness).toBe("preparation_required");
    }

    const cap = solanaMainnetCapability();
    const prepareEnabled: NetworkCapability = {
      ...cap,
      index_support: true,
      operations: {
        ...cap.operations,
        prepare: {
          ...cap.operations.prepare,
          enabled: true,
          state: "available",
        },
      },
    };
    expect(
      deriveIndexAndReadiness(prepareEnabled, {
        index_status: "indexed",
        report_readiness: "ready",
      }),
    ).toEqual({ index_status: "indexed", report_readiness: "ready" });
  });

  it("preserves DAS recognition when the readiness dependency is unavailable", async () => {
    const { adapter } = adapterFor(
      () => sampleOutcome(PYTHIANS_COLLECTION_MINT, FIXTURE_PROGRAMMABLE_ITEMS),
      undefined,
      {
        readinessPort: {
          observe: () => Effect.succeed({ kind: "unavailable" as const }),
        },
      },
    );

    const outcome = await expectAsyncSuccess(
      adapter.probe(probeRequest(PYTHIANS_COLLECTION_MINT)),
    );

    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.recognition).toBe("recognized");
    expect(outcome.index_status).toBe("missing");
    expect(outcome.report_readiness).toBe("preparation_required");
  });

  it("honors abort/deadline and does not mutate state after abort", async () => {
    const sharedState = { mutations: 0 };
    const controller = new AbortController();
    const clock = createVirtualClock({ originMs: 1_000 });
    const port = createScriptedDasSamplePort({
      sharedState,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return sampleOutcome(PYTHIANS_COLLECTION_MINT, FIXTURE_PROGRAMMABLE_ITEMS);
      },
    });
    const adapter = createSolanaDasNetworkAdapter({
      dasPort: port,
      sharedState,
      observedAt: "2026-07-16T12:00:00.000Z",
    });

    controller.abort("test-abort");
    const outcome = await expectAsyncSuccess(
      adapter.probe({
        ...probeRequest(PYTHIANS_COLLECTION_MINT),
        abort: {
          signal: controller.signal,
          get aborted() {
            return controller.signal.aborted;
          },
        },
        clock,
        deadline_at_ms: clock.nowMs() + 1_000,
      }),
    );
    expect(outcome.kind).toBe("timeout");
    expect(sharedState.mutations).toBe(0);

    const shared2 = { mutations: 0 };
    const expiredClock = createVirtualClock({ originMs: 1_000 });
    const { adapter: deadlineAdapter } = adapterFor(
      () => sampleOutcome(PYTHIANS_COLLECTION_MINT, FIXTURE_PROGRAMMABLE_ITEMS),
      shared2,
    );
    const timedOut = await expectAsyncSuccess(
      deadlineAdapter.probe({
        ...probeRequest(PYTHIANS_COLLECTION_MINT),
        clock: expiredClock,
        deadline_at_ms: expiredClock.nowMs() - 1,
      }),
    );
    expect(timedOut.kind).toBe("timeout");
    expect(shared2.mutations).toBe(0);
  });

  it("uses the resolver monotonic clock with default adapter wiring", async () => {
    const clock = createVirtualClock({ originMs: 1_000 });
    let sampleCalls = 0;
    const port = createScriptedDasSamplePort({
      handler: () => {
        sampleCalls += 1;
        return sampleOutcome(
          PYTHIANS_COLLECTION_MINT,
          FIXTURE_PROGRAMMABLE_ITEMS,
        );
      },
    });
    const adapter = createSolanaDasNetworkAdapter({ dasPort: port });

    const outcome = await expectAsyncSuccess(
      adapter.probe(
        probeRequest(PYTHIANS_COLLECTION_MINT, {
          clock,
          deadline_at_ms: clock.nowMs() + 500,
        }),
      ),
    );

    expect(outcome.kind).toBe("hit");
    expect(sampleCalls).toBe(1);
    expect(port.calls()).toHaveLength(1);
  });

  it("in-flight abort after probe start: prompt timeout, one op, no late mutation", async () => {
    const sharedState = { mutations: 0 };
    let release!: (outcome: ReturnType<typeof sampleOutcome>) => void;
    const pending = new Promise<ReturnType<typeof sampleOutcome>>((resolve) => {
      release = resolve;
    });
    let handlerStarted = 0;

    const port = createScriptedDasSamplePort({
      sharedState,
      handler: async () => {
        handlerStarted += 1;
        return pending;
      },
    });
    const adapter = createSolanaDasNetworkAdapter({
      dasPort: port,
      sharedState,
      observedAt: "2026-07-16T12:00:00.000Z",
    });

    const controller = new AbortController();
    const startedAt = Date.now();
    const probePromise = expectAsyncSuccess(
      adapter.probe({
        ...probeRequest(PYTHIANS_COLLECTION_MINT),
        abort: {
          signal: controller.signal,
          get aborted() {
            return controller.signal.aborted;
          },
        },
      }),
    );

    await waitUntil(() => handlerStarted === 1 && port.calls().length === 1, "DAS start");
    controller.abort("in-flight-abort");

    const outcome = await probePromise;
    const elapsed = Date.now() - startedAt;
    expect(outcome.kind).toBe("timeout");
    expect(elapsed).toBeLessThan(500);
    expect(port.calls()).toHaveLength(1);
    expect(sharedState.mutations).toBe(0);

    // Late DAS settlement must not mutate candidate/cache bags.
    release(sampleOutcome(PYTHIANS_COLLECTION_MINT, FIXTURE_PROGRAMMABLE_ITEMS));
    await new Promise((r) => setTimeout(r, 40));
    expect(sharedState.mutations).toBe(0);
  });

  it("retains exact Solana case and refuses wrong-case registry enrichment", async () => {
    const { adapter, port } = adapterFor((req) =>
      sampleOutcome(req.collection_mint, FIXTURE_PROGRAMMABLE_ITEMS),
    );
    const outcome = await expectAsyncSuccess(
      adapter.probe(probeRequest(PYTHIANS_COLLECTION_MINT)),
    );
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.address).toBe(PYTHIANS_COLLECTION_MINT);
    expect(normalizeSolanaAddress(outcome.address)).toBe(PYTHIANS_COLLECTION_MINT);
    expect(port.calls()[0]!.collection_mint).toBe(PYTHIANS_COLLECTION_MINT);

    const surfaces = [
      JSON.stringify(outcome),
      JSON.stringify(port.calls()),
      JSON.stringify(outcome.evidence_material),
    ];
    expectSuccess(
      assertSolanaKeyCaseRetained({
        original: PYTHIANS_COLLECTION_MINT,
        surfaces,
      }),
    );

    const wrong = await expectAsyncSuccess(
      adapter.probe(probeRequest(WRONG_CASE_PYTHIANS_MINT)),
    );
    expect(wrong.kind).toBe("hit");
    if (wrong.kind === "hit") {
      expect(wrong.address).toBe(WRONG_CASE_PYTHIANS_MINT);
      expect(wrong.collection_key).toBeUndefined();
      expect(wrong.name).not.toBe("Pythenians");
    }
  });

  it("never unbounded-paginates (single page call only)", async () => {
    const { adapter, port } = adapterFor(() =>
      sampleOutcome(PYTHIANS_COLLECTION_MINT, FIXTURE_PROGRAMMABLE_ITEMS, 8),
    );
    const outcome = await expectAsyncSuccess(
      adapter.probe(probeRequest(PYTHIANS_COLLECTION_MINT)),
    );
    expect(port.calls()).toHaveLength(1);
    expect(port.calls()[0]!.page).toBe(1);
    expect(port.calls()[0]!.limit).toBeLessThanOrEqual(
      DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT,
    );
    expect(outcome.kind).toBe("hit");
    if (outcome.kind === "hit") {
      const evidence = outcome.evidence_material as {
        sample_limit: number;
        sample_size: number;
      };
      expect(evidence.sample_limit).toBe(8);
      expect(evidence.sample_size).toBe(
        FIXTURE_PROGRAMMABLE_ITEMS.length,
      );
    }
  });

  it("clamps at the adapter boundary before any custom DAS port sees the limit", async () => {
    const port = createScriptedDasSamplePort({
      handler: () => sampleOutcome(PYTHIANS_COLLECTION_MINT, FIXTURE_PROGRAMMABLE_ITEMS),
    });
    const adapter = createSolanaDasNetworkAdapter({
      dasPort: port,
      sampleLimit: 50_000,
    });
    await expectAsyncSuccess(adapter.probe(probeRequest(PYTHIANS_COLLECTION_MINT)));
    expect(port.calls()[0]!.limit).toBe(MAX_DAS_RECOGNITION_SAMPLE_LIMIT);

    expect(() =>
      createSolanaDasNetworkAdapter({
        dasPort: port,
        sampleLimit: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/finite/);
  });
});

describe("CR-104 production-captured DAS fixture parity", () => {
  it("routes pyth-das-getassetsbygroup through classifier + adapter; asserts unknown interface", async () => {
    const items = REAL_DAS_FIXTURE.result.items;
    expect(items.length).toBe(5);
    // Deliberate: production capture omits DAS `interface` — do not invent programmable.
    for (const item of items) {
      expect(item.interface).toBeUndefined();
    }

    const parsed = parseDasSampleRpcResponse(REAL_DAS_FIXTURE);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;

    const classification = classifyDasSampleItems(parsed.page.items);
    expect(classification.coverage).toBe("unknown");
    expect(classification.token_standard).toBe("unknown");
    expect(classification.dominant_interface).toBe("unknown");
    expect(classification.sample_size).toBe(5);

    const { adapter } = adapterFor(() =>
      sampleOutcome(PYTHIANS_COLLECTION_MINT, parsed.page.items),
    );
    const outcome = await expectAsyncSuccess(
      adapter.probe(probeRequest(PYTHIANS_COLLECTION_MINT)),
    );
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.recognition).toBe("ambiguous");
    expect(outcome.token_standard).toBe("unknown");
    expect(outcome.collection_key).toBe("pythians");
    expect(outcome.name).toBe("Pythenians");
    // Registry must not inherit sampled member image from production fixture.
    expect(outcome.image).toBeUndefined();
    expect(outcome.index_status).toBe("missing");
    expect(outcome.report_readiness).toBe("preparation_required");
  });
});

describe("CR-104 binding omission + CR-102 cache refusal", () => {
  it("omits binding_evidence and CR-102 refuses positive/readiness cache writes", () => {
    const port = createScriptedDasSamplePort({
      handler: () =>
        sampleOutcome(PYTHIANS_COLLECTION_MINT, FIXTURE_PROGRAMMABLE_ITEMS),
    });
    const solanaAdapter = createSolanaDasNetworkAdapter({
      dasPort: port,
      observedAt: "2026-07-16T12:00:00.000Z",
    });

    const base = createHermeticBoundedDeps({
      clock: createVirtualClock({ originMs: 0 }),
    });
    const deps = {
      ...base.deps,
      adapter: solanaAdapter,
      clock: base.clock,
      capabilitySnapshot: loadHermeticCapabilitySnapshot(),
    };

    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(PYTHIANS_COLLECTION_MINT),
        config: base.config,
        deps,
      }),
    );

    expect(response.candidates.length).toBe(1);
    expect(response.candidates[0]!.identity.deployments[0]!.address).toBe(
      PYTHIANS_COLLECTION_MINT,
    );
    expect(response.candidates[0]!.identity.collection_key).toBe("pythians");
    expect(response.candidates[0]!.identity.image).toBeUndefined();
    expect(response.diagnostics.partial).toBe(true);
    expect(
      response.diagnostics.entries.some((e) => e.code === "binding_evidence_absent"),
    ).toBe(true);
    expect(base.cache.__debug().positive).toBe(0);
    expect(base.cache.__debug().readiness).toBe(0);
    assertNoSecretLeak(response.diagnostics.entries);
    assertNoSecretLeak({
      ranking_reasons: response.candidates[0]!.ranking_reasons,
      address: response.candidates[0]!.identity.deployments[0]!.address,
    });
  });
});

describe("CR-104 resolver-level negative cache refusal for non-conclusive samples", () => {
  const resolveWithOutcome = (
    handler: Parameters<typeof adapterFor>[0],
  ): { negative: number; candidates: number; partial: boolean; unavailable: number } => {
    const clock = createVirtualClock({ originMs: 0 });
    const state = { mutations: 0 };
    const port = createScriptedDasSamplePort({
      handler: (req) => handler(req),
      sharedState: state,
    });
    const adapter = createSolanaDasNetworkAdapter({
      dasPort: port,
      sampleLimit: DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT,
      observedAt: "2026-07-16T12:00:00.000Z",
      sharedState: state,
    });
    const base = createHermeticBoundedDeps({ clock });
    const deps = {
      ...base.deps,
      adapter,
      clock: base.clock,
      capabilitySnapshot: loadHermeticCapabilitySnapshot(),
    };
    const response = expectSuccess(
      resolveBounded({
        request: hermeticResolveRequest(PYTHIANS_COLLECTION_MINT),
        config: base.config,
        deps,
      }),
    );
    return {
      negative: base.cache.__debug().negative,
      candidates: response.candidates.length,
      partial: response.diagnostics.partial,
      unavailable: response.diagnostics.unavailable.length,
    };
  };

  it("incomplete/malformed transport does not write authoritative negative cache", () => {
    for (const failure of ["incomplete", "malformed"] as const) {
      const result = resolveWithOutcome(() => ({ kind: "unavailable", failure }));
      expect(result.negative).toBe(0);
      expect(result.candidates).toBe(0);
      expect(result.partial).toBe(true);
      expect(result.unavailable).toBeGreaterThan(0);
    }
  });

  it("non-empty zero-valid members do not write authoritative negative cache", () => {
    const result = resolveWithOutcome(() =>
      sampleOutcome(PYTHIANS_COLLECTION_MINT, FIXTURE_UNVERIFIED_ITEMS),
    );
    expect(result.negative).toBe(0);
    expect(result.candidates).toBe(0);
    expect(result.partial).toBe(true);
    expect(result.unavailable).toBeGreaterThan(0);
  });

  it("missing result/items parse paths surface as unavailable at the adapter (no miss)", async () => {
    for (const failure of ["incomplete", "malformed"] as const) {
      const { adapter } = adapterFor(() => ({ kind: "unavailable", failure }));
      const outcome = await expectAsyncSuccess(
        adapter.probe(probeRequest(PYTHIANS_COLLECTION_MINT)),
      );
      expect(outcome.kind).not.toBe("miss");
      expect(outcome.kind).toBe("unavailable");
    }
  });
});

describe("CR-104 in-flight abort at resolver — no late candidate/cache mutation", () => {
  it("pending DAS aborted via deadline: one op, empty candidates, zero caches", async () => {
    const sharedState = { mutations: 0 };
    let release!: (outcome: ReturnType<typeof sampleOutcome>) => void;
    const pending = new Promise<ReturnType<typeof sampleOutcome>>((resolve) => {
      release = resolve;
    });
    let starts = 0;

    const port = createScriptedDasSamplePort({
      sharedState,
      handler: async () => {
        starts += 1;
        return pending;
      },
    });
    const processClock = createProcessMonotonicClock();
    const solanaAdapter = createSolanaDasNetworkAdapter({
      dasPort: port,
      sharedState,
      observedAt: "2026-07-16T12:00:00.000Z",
    });

    const config = {
      ...defaultBoundedResolverConfig(),
      global_deadline_ms: 80,
      per_network_deadline_ms: 50,
    };
    const base = createHermeticBoundedDeps({
      processClock,
      config,
    });
    const deps = {
      ...base.deps,
      adapter: solanaAdapter,
      capabilitySnapshot: loadHermeticCapabilitySnapshot(),
    };

    const startedAt = Date.now();
    const response = await expectAsyncSuccess(
      resolveBounded({
        request: hermeticResolveRequest(PYTHIANS_COLLECTION_MINT),
        config,
        deps,
      }),
    );
    const elapsed = Date.now() - startedAt;

    expect(response.candidates).toHaveLength(0);
    expect(response.diagnostics.partial).toBe(true);
    expect(base.cache.__debug().positive).toBe(0);
    expect(base.cache.__debug().readiness).toBe(0);
    expect(base.cache.__debug().negative).toBe(0);
    expect(starts).toBe(1);
    expect(port.calls()).toHaveLength(1);
    expect(elapsed).toBeLessThan(400);
    expect(sharedState.mutations).toBe(0);

    release(sampleOutcome(PYTHIANS_COLLECTION_MINT, FIXTURE_PROGRAMMABLE_ITEMS));
    await new Promise((r) => setTimeout(r, 40));
    expect(sharedState.mutations).toBe(0);
    expect(base.cache.__debug().positive).toBe(0);
    expect(base.cache.__debug().negative).toBe(0);
  });
});

describe("CR-104 preserves CR-003 DAS case-retention invariant", () => {
  it("normalizeDasCollectionProbe still retains exact Solana keys", () => {
    const snapshot: CollectionSnapshot = {
      collectionMint: PYTHIANS_COLLECTION_MINT,
      slot: 250_000_001,
      source: "das",
      members: [
        {
          nftMint: "MemberMintWithCase11111111111111111111111",
          owner: "OwnerWithCase111111111111111111111111111",
          delegate: null,
          name: "Pythian #1",
          image: null,
          uri: null,
          compressed: false,
        },
      ],
    };
    const surfaces = expectSuccess(
      normalizeDasCollectionProbe({
        capability: solanaRecognizeCapability(),
        observation: {
          snapshot,
          observedAt: "2026-07-16T08:00:00Z",
          indexStatus: "missing",
          reportReadiness: "preparation_required",
          interfaceName: "ProgrammableNFT",
          name: "Pythenians",
          symbol: "$PTN",
        },
        collectionKey: "pythians",
      }),
    );
    expect(surfaces.response.identity.deployments[0]!.address).toBe(
      PYTHIANS_COLLECTION_MINT,
    );
    expectSuccess(
      assertSolanaKeyCaseRetained({
        original: PYTHIANS_COLLECTION_MINT,
        surfaces: [
          JSON.stringify(surfaces.storage),
          JSON.stringify(surfaces.log),
          JSON.stringify(surfaces.response),
        ],
      }),
    );
  });
});

describe("CR-104 capability fixture alignment", () => {
  it("uses CR-101 Solana capability with index_support=false", () => {
    const cap = solanaMainnetCapability();
    expect(cap.index_support).toBe(false);
    expect(cap.probe_adapter.adapter_id).toBe("solana_das");
    expect(cap.operations.prepare.enabled).toBe(false);
  });
});

describe("CR-104 parseDasGetAssetRpcResponse — result.id identity gate", () => {
  it("requires non-empty exact-case Solana result.id on ok", () => {
    const parsed = parseDasGetAssetRpcResponse({
      jsonrpc: "2.0",
      result: {
        id: PYTHIANS_COLLECTION_MINT,
        content: {
          metadata: { name: "Pythenians", symbol: "$PTN" },
          links: { image: "https://cdn.example.test/collection.png" },
        },
      },
    });
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.id).toBe(PYTHIANS_COLLECTION_MINT);
    expect(parsed.name).toBe("Pythenians");
    expect(parsed.symbol).toBe("$PTN");
    expect(parsed.image).toBe("https://cdn.example.test/collection.png");
  });

  it("treats missing/null id as incomplete even when metadata is present", () => {
    const tempting = {
      content: {
        metadata: { name: "UNRELATED_NAME", symbol: "BAD" },
        links: { image: "https://evil.example/x.png" },
      },
    };
    expect(parseDasGetAssetRpcResponse({ result: tempting }).kind).toBe(
      "incomplete",
    );
    expect(parseDasGetAssetRpcResponse({ result: { id: null, ...tempting } }).kind).toBe(
      "incomplete",
    );
    const missing = parseDasGetAssetRpcResponse({ result: tempting });
    if (missing.kind === "incomplete") {
      expect(missing.safe_reason).toBe("das_get_asset_id_missing");
    }
  });

  it("treats empty / non-string / structurally invalid id as malformed", () => {
    expect(
      parseDasGetAssetRpcResponse({ result: { id: "", content: { metadata: { name: "X" } } } })
        .kind,
    ).toBe("malformed");
    expect(
      parseDasGetAssetRpcResponse({ result: { id: 42, content: { metadata: { name: "X" } } } })
        .kind,
    ).toBe("malformed");
    expect(
      parseDasGetAssetRpcResponse({
        result: { id: "not-a-solana-key!!!", content: { metadata: { name: "X" } } },
      }).kind,
    ).toBe("malformed");
  });
});

describe("CR-104 createFetchDasSamplePort — getAsset identity binding", () => {
  /** Valid Solana mint distinct from Pythenians — foreign asset id fixture. */
  const FOREIGN_COLLECTION_MINT = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  /** Valid unregistered mint used as the requested collection identity. */
  const UNREGISTERED_COLLECTION_MINT = "So11111111111111111111111111111111111111112";

  const UNRELATED_META = {
    name: "UNRELATED_FOREIGN_NAME",
    symbol: "EVIL",
    image: "https://evil.example/foreign.png",
  } as const;

  const sampleItemsFor = (mint: string): DasAsset[] => [
    {
      id: `${mint.slice(0, 8)}Member111111111111111111111111111111`,
      interface: "V1_NFT",
      ownership: { owner: "Owner1111111111111111111111111111111111111" },
      content: {
        metadata: { name: "Member Must Not Become Identity" },
        links: { image: "https://cdn.example.test/member.png" },
      },
      compression: { compressed: false },
    },
  ];

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const fetchPortFor = (handlers: {
    getAsset: (requestedId: string) => unknown;
    getAssetsByGroup?: (groupValue: string) => unknown;
  }) => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        method: string;
        params: { id?: string; groupValue?: string };
      };
      if (body.method === "getAsset") {
        return jsonResponse(handlers.getAsset(body.params.id ?? ""));
      }
      if (body.method === "getAssetsByGroup") {
        const groupValue = body.params.groupValue ?? "";
        if (handlers.getAssetsByGroup !== undefined) {
          return jsonResponse(handlers.getAssetsByGroup(groupValue));
        }
        return jsonResponse({
          jsonrpc: "2.0",
          result: { items: sampleItemsFor(groupValue) },
        });
      }
      return jsonResponse({ error: { code: -32601, message: "unknown method" } }, 200);
    };
    return createFetchDasSamplePort({
      endpoint: "https://das.example.test/?api-key=SUPERSECRET",
      clock: { nowMs: () => Date.now() },
      fetchImpl,
      observeCollectionAsset: true,
    });
  };

  const observeRequest = (mint: string): DasSampleRequest => {
    const controller = new AbortController();
    return {
      collection_mint: mint,
      limit: DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT,
      abort: controller.signal,
      deadline_at_ms: Date.now() + 5_000,
      now_ms: () => Date.now(),
    };
  };

  it("builds getAsset body with exact-case collection mint id", () => {
    const body = buildDasGetAssetRequestBody({
      collection_mint: PYTHIANS_COLLECTION_MINT,
    });
    expect(body.method).toBe("getAsset");
    expect(body.params.id).toBe(PYTHIANS_COLLECTION_MINT);
    expect(body.params.id).not.toBe(PYTHIANS_COLLECTION_MINT.toLowerCase());
  });

  it("observes metadata only when result.id exactly matches the requested mint", async () => {
    const port = fetchPortFor({
      getAsset: (requestedId) => ({
        jsonrpc: "2.0",
        result: {
          id: requestedId,
          content: {
            metadata: { name: "Bound Collection", symbol: "BND" },
            links: { image: "https://cdn.example.test/bound.png" },
          },
        },
      }),
    });
    expect(port.observeCollectionAsset).toBeDefined();
    const outcome = await expectAsyncSuccess(
      port.observeCollectionAsset!(observeRequest(UNREGISTERED_COLLECTION_MINT)),
    );
    expect(outcome).toEqual({
      kind: "observed",
      observation: {
        collection_mint: UNREGISTERED_COLLECTION_MINT,
        name: "Bound Collection",
        symbol: "BND",
        image: "https://cdn.example.test/bound.png",
      },
    });
  });

  it("rejects a different result.id as unavailable and never stamps request mint", async () => {
    const port = fetchPortFor({
      getAsset: () => ({
        jsonrpc: "2.0",
        result: {
          id: FOREIGN_COLLECTION_MINT,
          content: {
            metadata: {
              name: UNRELATED_META.name,
              symbol: UNRELATED_META.symbol,
            },
            links: { image: UNRELATED_META.image },
          },
        },
      }),
    });
    const outcome = await expectAsyncSuccess(
      port.observeCollectionAsset!(observeRequest(UNREGISTERED_COLLECTION_MINT)),
    );
    expect(outcome).toEqual({ kind: "unavailable", failure: "incomplete" });
    assertNoSecretLeak(outcome);
  });

  it("rejects wrong-case result.id as unavailable (byte-for-byte)", async () => {
    // Structurally valid Solana key that differs only by case from the request.
    // (Full toLowerCase() of Pythenians is not a valid 32-byte key — that path
    // is covered by the malformed-id case below.)
    const wrongCaseId = "PyTh2UtBKfuDW6KCdT3swospYeoLmmKaGujWA91Moru";
    expect(wrongCaseId).not.toBe(PYTHIANS_COLLECTION_MINT);
    expect(wrongCaseId.toLowerCase()).toBe(PYTHIANS_COLLECTION_MINT.toLowerCase());

    const port = fetchPortFor({
      getAsset: () => ({
        jsonrpc: "2.0",
        result: {
          id: wrongCaseId,
          content: {
            metadata: { name: UNRELATED_META.name, symbol: UNRELATED_META.symbol },
            links: { image: UNRELATED_META.image },
          },
        },
      }),
    });
    const outcome = await expectAsyncSuccess(
      port.observeCollectionAsset!(observeRequest(PYTHIANS_COLLECTION_MINT)),
    );
    expect(outcome).toEqual({ kind: "unavailable", failure: "incomplete" });
  });

  it("treats missing result.id as incomplete/unavailable even with tempting metadata", async () => {
    const port = fetchPortFor({
      getAsset: () => ({
        jsonrpc: "2.0",
        result: {
          content: {
            metadata: { name: UNRELATED_META.name, symbol: UNRELATED_META.symbol },
            links: { image: UNRELATED_META.image },
          },
        },
      }),
    });
    const outcome = await expectAsyncSuccess(
      port.observeCollectionAsset!(observeRequest(UNREGISTERED_COLLECTION_MINT)),
    );
    expect(outcome).toEqual({ kind: "unavailable", failure: "incomplete" });
  });

  it("treats malformed getAsset responses as unavailable", async () => {
    const port = fetchPortFor({
      getAsset: () => ({
        jsonrpc: "2.0",
        result: {
          id: "!!!not-base58!!!",
          content: { metadata: { name: UNRELATED_META.name } },
        },
      }),
    });
    const outcome = await expectAsyncSuccess(
      port.observeCollectionAsset!(observeRequest(UNREGISTERED_COLLECTION_MINT)),
    );
    expect(outcome).toEqual({ kind: "unavailable", failure: "malformed" });
  });

  it("never publishes unrelated getAsset name/symbol/image onto candidate identity", async () => {
    const port = fetchPortFor({
      getAsset: () => ({
        jsonrpc: "2.0",
        result: {
          id: FOREIGN_COLLECTION_MINT,
          content: {
            metadata: {
              name: UNRELATED_META.name,
              symbol: UNRELATED_META.symbol,
            },
            links: { image: UNRELATED_META.image },
          },
        },
      }),
      getAssetsByGroup: () => ({
        jsonrpc: "2.0",
        result: { items: sampleItemsFor(UNREGISTERED_COLLECTION_MINT) },
      }),
    });
    const adapter = createSolanaDasNetworkAdapter({
      dasPort: port,
      sampleLimit: DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT,
      observedAt: "2026-07-16T12:00:00.000Z",
    });
    const outcome = await expectAsyncSuccess(
      adapter.probe(probeRequest(UNREGISTERED_COLLECTION_MINT)),
    );
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    // Recognition may succeed from the sample; identity fields must not carry
    // foreign getAsset metadata (and must not invent member metadata either).
    expect(outcome.name).toBeUndefined();
    expect(outcome.symbol).toBeUndefined();
    expect(outcome.image).toBeUndefined();
    expect(outcome.ranking_reasons).not.toContain("onchain_metadata");
    expect(JSON.stringify(outcome)).not.toContain(UNRELATED_META.name);
    expect(JSON.stringify(outcome)).not.toContain(UNRELATED_META.symbol);
    expect(JSON.stringify(outcome)).not.toContain(UNRELATED_META.image);
    expect(outcome.evidence_material).toMatchObject({
      collection_asset_observed: false,
    });
    expect(
      (outcome.evidence_material as { collection_asset_id?: string }).collection_asset_id,
    ).toBeUndefined();

    const candidate = expectSuccess(
      buildCandidateFromHit({
        capability: solanaRecognizeCapability(),
        address: UNREGISTERED_COLLECTION_MINT,
        hit: outcome,
      }),
    );
    expect(candidate.identity.name).toBeUndefined();
    expect(candidate.identity.symbol).toBeUndefined();
    expect(candidate.identity.image).toBeUndefined();
    expect(JSON.stringify(candidate)).not.toContain(UNRELATED_META.name);
    expect(JSON.stringify(candidate)).not.toContain(UNRELATED_META.image);
  });

  it("binds observed result.id into evidence when getAsset identity matches", async () => {
    const port = fetchPortFor({
      getAsset: (requestedId) => ({
        jsonrpc: "2.0",
        result: {
          id: requestedId,
          content: {
            metadata: { name: "Observed Collection", symbol: "OBS" },
            links: { image: "https://cdn.example.test/observed.png" },
          },
        },
      }),
      getAssetsByGroup: () => ({
        jsonrpc: "2.0",
        result: { items: sampleItemsFor(UNREGISTERED_COLLECTION_MINT) },
      }),
    });
    const adapter = createSolanaDasNetworkAdapter({
      dasPort: port,
      sampleLimit: DEFAULT_DAS_RECOGNITION_SAMPLE_LIMIT,
      observedAt: "2026-07-16T12:00:00.000Z",
    });
    const outcome = await expectAsyncSuccess(
      adapter.probe(probeRequest(UNREGISTERED_COLLECTION_MINT)),
    );
    expect(outcome.kind).toBe("hit");
    if (outcome.kind !== "hit") return;
    expect(outcome.name).toBe("Observed Collection");
    expect(outcome.symbol).toBe("OBS");
    expect(outcome.image).toBe("https://cdn.example.test/observed.png");
    expect(outcome.evidence_material).toMatchObject({
      collection_asset_observed: true,
      collection_asset_id: UNREGISTERED_COLLECTION_MINT,
      collection_asset_name: "Observed Collection",
    });
  });

  it("production factory wires the sealed fetch port into the network adapter", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        params: { groupValue: string };
      };
      return jsonResponse({
        jsonrpc: "2.0",
        result: { items: sampleItemsFor(body.params.groupValue) },
      });
    };
    const adapter = createProductionSolanaDasNetworkAdapter({
      endpoint: "https://das.example.test/?api-key=SEALED",
      clock: { nowMs: () => 0 },
      fetchImpl,
      observedAt: "2026-07-16T12:00:00.000Z",
    });
    const outcome = await expectAsyncSuccess(
      adapter.probe(probeRequest(UNREGISTERED_COLLECTION_MINT)),
    );
    expect(outcome.kind).toBe("hit");
  });

  it("returns at the deadline even when an injected fetch ignores AbortSignal", async () => {
    let transportSignal: AbortSignal | undefined;
    const neverSettles: typeof fetch = (_url, init) => {
      transportSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    };
    const port = createFetchDasSamplePort({
      endpoint: "https://das.example.test",
      clock: { nowMs: () => Date.now() },
      fetchImpl: neverSettles,
    });
    const started = Date.now();
    const outcome = await expectAsyncSuccess(
      port.sampleCollection({
        collection_mint: UNREGISTERED_COLLECTION_MINT,
        limit: 1,
        abort: new AbortController().signal,
        deadline_at_ms: Date.now() + 20,
        now_ms: () => Date.now(),
      }),
    );
    expect(outcome).toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(100);
    expect(transportSignal?.aborted).toBe(true);
  });

  it("bounds a response body that stalls after headers", async () => {
    let cancelled = false;
    const stalledBody: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => undefined),
        body: {
          cancel: async () => {
            cancelled = true;
          },
        },
      }) as unknown as Response;
    const port = createFetchDasSamplePort({
      endpoint: "https://das.example.test",
      clock: { nowMs: () => Date.now() },
      fetchImpl: stalledBody,
    });
    const outcome = await expectAsyncSuccess(
      port.sampleCollection({
        collection_mint: UNREGISTERED_COLLECTION_MINT,
        limit: 1,
        abort: new AbortController().signal,
        deadline_at_ms: Date.now() + 20,
        now_ms: () => Date.now(),
      }),
    );
    expect(outcome).toEqual({ kind: "timeout" });
    expect(cancelled).toBe(true);
  });
});
