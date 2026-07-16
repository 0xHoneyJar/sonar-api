/**
 * Hermetic fixtures and deps factory for CR-102 bounded resolver core.
 */
import { Effect } from "effect";
import {
  decodeCapabilityRegistrySnapshot,
  type CapabilityRegistrySnapshot,
} from "../capability-registry/snapshot.js";
import { hermeticResolverRegistryInput } from "../capability-registry/fixtures.js";
import {
  MULTI_CHAIN_EVM_ADDRESS,
  PYTHIANS_COLLECTION_MINT,
  SCRIPT_EVM_ERC721,
  SCRIPT_HIT_WITHOUT_BINDING,
  SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
  SCRIPT_PARTIAL_TIMEOUT,
  SCRIPT_SOLANA_COLLECTION,
  SCRIPT_ZERO_CANDIDATES,
} from "../hermetic-fixtures.js";
import { asDeadlineTimer, createVirtualClock, type VirtualClock } from "./clock.js";
import { createMemoryCircuitBreaker } from "./circuit-breaker.js";
import { createMemoryCoalesce } from "./coalesce.js";
import { defaultBoundedResolverConfig } from "./config.js";
import { createMemoryMetrics } from "./metrics.js";
import { createMemoryRateLimiter } from "./rate-limit.js";
import { createMemoryInvalidationEdgePort } from "./caching/invalidation.js";
import { createMemoryResolverCache } from "./caching/store.js";
import {
  createMemoryRecognitionObserver,
  liveAllowedNetworkKeys,
} from "./operations/observer.js";
import type { BoundedResolverDeps } from "./ports.js";
import type { BoundedResolverConfig } from "./schemas.js";
import { createScriptedNetworkAdapter } from "./reference/scripted-adapter.js";
import { createScriptedInventoryPort } from "./reference/scripted-inventory.js";
import type { ProbeOutcome } from "../candidate.js";

export {
  MULTI_CHAIN_EVM_ADDRESS,
  PYTHIANS_COLLECTION_MINT,
  SCRIPT_EVM_ERC721,
  SCRIPT_HIT_WITHOUT_BINDING,
  SCRIPT_MULTI_CHAIN_SAME_ADDRESS,
  SCRIPT_PARTIAL_TIMEOUT,
  SCRIPT_SOLANA_COLLECTION,
  SCRIPT_ZERO_CANDIDATES,
};

export const loadHermeticCapabilitySnapshot = (): CapabilityRegistrySnapshot => {
  const exit = Effect.runSyncExit(decodeCapabilityRegistrySnapshot(hermeticResolverRegistryInput()));
  if (exit._tag === "Failure") {
    throw new Error("hermetic CR-101 snapshot failed to decode");
  }
  return exit.value;
};

export interface HermeticBoundedDepsOptions {
  readonly clock?: VirtualClock;
  readonly config?: BoundedResolverConfig;
  readonly script?: Readonly<Record<string, ProbeOutcome>>;
  readonly workMsByNetwork?: Readonly<Record<string, number>>;
  readonly realSleepMsByNetwork?: Readonly<Record<string, number>>;
  readonly ignoreAbort?: boolean;
  readonly inventory?: ReturnType<typeof createScriptedInventoryPort>;
  readonly capabilitySnapshot?: CapabilityRegistrySnapshot;
  readonly capabilitySnapshotProvider?: import("./ports.js").CapabilitySnapshotProviderPort;
  readonly admissionControl?: import("./ports.js").AdmissionControlPort;
  readonly observer?: import("./ports.js").RecognitionObserverPort;
  readonly failImpactStore?: boolean;
  /** Override clock/timer (e.g. process monotonic for real-timer probes). */
  readonly processClock?: import("./clock.js").MonotonicClock &
    import("./clock.js").DeadlineTimerPort;
}

export const createHermeticBoundedDeps = (
  options: HermeticBoundedDepsOptions = {},
): {
  readonly deps: BoundedResolverDeps;
  readonly clock: VirtualClock;
  readonly config: BoundedResolverConfig;
  readonly cache: ReturnType<typeof createMemoryResolverCache>;
  readonly edges: ReturnType<typeof createMemoryInvalidationEdgePort>;
  readonly adapter: ReturnType<typeof createScriptedNetworkAdapter>;
  readonly observer: ReturnType<typeof createMemoryRecognitionObserver>;
} => {
  const virtual = options.clock ?? createVirtualClock({ originMs: 0 });
  const clock = options.processClock ?? virtual;
  const config = options.config ?? defaultBoundedResolverConfig();
  const cache = createMemoryResolverCache({ nowMs: () => clock.nowMs() });
  const edges = createMemoryInvalidationEdgePort({
    failStore: options.failImpactStore === true,
  });
  const negativeKeys = new Set<string>();
  const metrics = createMemoryMetrics();
  const capabilitySnapshot =
    options.capabilitySnapshot ?? loadHermeticCapabilitySnapshot();
  const snapshotCurrent = () =>
    options.capabilitySnapshotProvider?.current() ?? capabilitySnapshot;
  const observer =
    (options.observer as ReturnType<typeof createMemoryRecognitionObserver> | undefined) ??
    createMemoryRecognitionObserver({
      metrics,
      allowedNetworkKeys: liveAllowedNetworkKeys(snapshotCurrent),
    });

  const wrappedCache: typeof cache = {
    ...cache,
    setNegative: (key, entry) =>
      Effect.gen(function* () {
        negativeKeys.add(key);
        yield* cache.setNegative(key, entry);
      }),
    getNegative: (key) =>
      Effect.gen(function* () {
        const entry = yield* cache.getNegative(key);
        if (entry !== undefined) negativeKeys.add(key);
        else negativeKeys.delete(key);
        return entry;
      }),
    invalidate: (input) =>
      Effect.gen(function* () {
        const result = yield* cache.invalidate(input);
        if (input.namespace === undefined || input.namespace === "negative_probe") {
          // The fixture's Set is only a synchronous coalesce hint. Clear it
          // conservatively whenever negative entries may have been evicted.
          negativeKeys.clear();
        }
        return result;
      }),
  };

  const adapter = createScriptedNetworkAdapter({
    script: options.script ?? SCRIPT_EVM_ERC721,
    clock,
    workMsByNetwork: options.workMsByNetwork,
    realSleepMsByNetwork: options.realSleepMsByNetwork,
    ignoreAbort: options.ignoreAbort,
  });

  const deps: BoundedResolverDeps = {
    clock,
    timer: asDeadlineTimer(clock),
    adapter,
    inventory: options.inventory,
    cache: wrappedCache,
    invalidationEdges: edges,
    circuitBreaker: createMemoryCircuitBreaker(config.circuit_breaker, {
      observer,
    }),
    rateLimiter: createMemoryRateLimiter({
      caller: config.caller_rate_limit,
      global: config.global_rate_limit,
    }),
    coalesce: createMemoryCoalesce({
      isNegativeCached: (key) => {
        const demandDigest = /^demand:([0-9a-f]{64})(?::|$)/.exec(key)?.[1];
        const digest = demandDigest ?? (key.startsWith("neg:") ? key.slice(4) : key);
        return negativeKeys.has(digest);
      },
    }),
    metrics,
    capabilitySnapshot,
    ...(options.capabilitySnapshotProvider !== undefined
      ? { capabilitySnapshotProvider: options.capabilitySnapshotProvider }
      : {}),
    ...(options.admissionControl !== undefined
      ? { admissionControl: options.admissionControl }
      : {}),
    observer,
  };

  return {
    deps,
    clock: virtual,
    config,
    cache: wrappedCache,
    edges,
    adapter,
    observer,
  };
};

export const hermeticResolveRequest = (identifier: string, bucket = "caller-a") => ({
  schema_version: 1 as const,
  identifier,
  environment: "mainnet" as const,
  caller: {
    bucket_id: bucket,
    authorization_scope: { scope_class: "authenticated" as const },
  },
});
