import { Effect } from "effect";
import { cloneFreeze } from "../../capability-registry/immutable.js";
import type {
  NegativeCacheEntry,
  PositiveCacheEntry,
  ReadinessCacheEntry,
  ResolverCachePort,
} from "../ports.js";
import type { CacheInvalidationCause } from "../schemas.js";

interface Store {
  positive: Map<string, PositiveCacheEntry>;
  readiness: Map<string, ReadinessCacheEntry>;
  negative: Map<string, NegativeCacheEntry>;
}

const expired = (expires_at_ms: number, now_ms: number): boolean => now_ms >= expires_at_ms;

/**
 * In-memory reference cache with separate positive / readiness / negative stores.
 * Late writers MUST check seal/accept flags in the orchestrator before calling set*.
 */
export const createMemoryResolverCache = (input: {
  readonly nowMs: () => number;
}): ResolverCachePort & {
  readonly __debug: () => {
    positive: number;
    readiness: number;
    negative: number;
  };
} => {
  const store: Store = {
    positive: new Map(),
    readiness: new Map(),
    negative: new Map(),
  };

  return {
    findPositive: (query) =>
      Effect.sync(() => {
        const found: PositiveCacheEntry[] = [];
        const snapshot = JSON.stringify(query.capability_snapshot_version);
        const scope = JSON.stringify(query.authorization_scope);
        const networks = new Set(query.allowed_network_keys);
        for (const [key, entry] of [...store.positive.entries()]) {
          if (expired(entry.expires_at_ms, input.nowMs())) {
            store.positive.delete(key);
            continue;
          }
          const deployment = entry.candidate.identity.deployments[0];
          if (
            deployment !== undefined &&
            deployment.normalized_address === query.normalized_address &&
            networks.has(`${deployment.network.network_namespace}:${deployment.network.network_reference}`) &&
            JSON.stringify(entry.binding.capability_snapshot_version) === snapshot &&
            JSON.stringify(entry.binding.authorization_scope) === scope &&
            entry.binding.adapter_policy_version === query.adapter_policy_version
          ) {
            found.push(cloneFreeze(entry));
          }
        }
        return found;
      }),

    getPositive: (keyDigest) =>
      Effect.sync(() => {
        const entry = store.positive.get(keyDigest);
        if (entry === undefined) return undefined;
        if (expired(entry.expires_at_ms, input.nowMs())) {
          store.positive.delete(keyDigest);
          return undefined;
        }
        return cloneFreeze(entry);
      }),

    setPositive: (keyDigest, entry) =>
      Effect.sync(() => {
        store.positive.set(keyDigest, cloneFreeze(entry));
      }),

    getReadiness: (keyDigest) =>
      Effect.sync(() => {
        const entry = store.readiness.get(keyDigest);
        if (entry === undefined) return undefined;
        if (expired(entry.expires_at_ms, input.nowMs())) {
          store.readiness.delete(keyDigest);
          return undefined;
        }
        return cloneFreeze(entry);
      }),

    setReadiness: (keyDigest, entry) =>
      Effect.sync(() => {
        store.readiness.set(keyDigest, cloneFreeze(entry));
      }),

    getNegative: (keyDigest) =>
      Effect.sync(() => {
        const entry = store.negative.get(keyDigest);
        if (entry === undefined) return undefined;
        if (expired(entry.expires_at_ms, input.nowMs())) {
          store.negative.delete(keyDigest);
          return undefined;
        }
        return cloneFreeze(entry);
      }),

    setNegative: (keyDigest, entry) =>
      Effect.sync(() => {
        store.negative.set(keyDigest, cloneFreeze(entry));
      }),

    invalidate: ({ cause, namespace, keyDigest, deployment_id, predicate }) =>
      Effect.sync(() => {
        let evicted = 0;
        const match = (
          ns: "positive_recognition" | "report_readiness" | "negative_probe",
          key: string,
          binding: unknown,
        ): boolean => {
          if (namespace !== undefined && namespace !== ns) return false;
          if (keyDigest !== undefined && keyDigest !== key) return false;
          if (deployment_id !== undefined) {
            const maybe = binding as { deployment_id?: string };
            if (maybe.deployment_id !== deployment_id) return false;
          }
          if (predicate !== undefined && !predicate({ namespace: ns, binding })) {
            return false;
          }
          // cause is recorded by caller; all matched entries are refused/evicted.
          void cause;
          return true;
        };

        for (const [key, entry] of [...store.positive.entries()]) {
          if (match("positive_recognition", key, entry.binding)) {
            store.positive.delete(key);
            evicted += 1;
          }
        }
        for (const [key, entry] of [...store.readiness.entries()]) {
          if (match("report_readiness", key, entry.binding)) {
            store.readiness.delete(key);
            evicted += 1;
          }
        }
        for (const [key, entry] of [...store.negative.entries()]) {
          if (match("negative_probe", key, entry.binding)) {
            store.negative.delete(key);
            evicted += 1;
          }
        }
        return { evicted };
      }),

    __debug: () => ({
      positive: store.positive.size,
      readiness: store.readiness.size,
      negative: store.negative.size,
    }),
  };
};

export type { CacheInvalidationCause };
