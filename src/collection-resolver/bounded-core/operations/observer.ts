/**
 * CR-107 recognition observer port — typed events at resolver boundaries.
 *
 * `record` mechanically enforces:
 * 1. Strict RecognitionOperationalEvent decode (excess properties rejected)
 * 2. Identity / high-cardinality leak validation
 * 3. Registry-derived network_key allowlist for any event carrying network_key
 *
 * Invalid / forged payloads are dropped via a typed result — never thrown into
 * the resolve path. Bridges to legacy MetricsPort aggregate counters for
 * load-harness compatibility only when explicitly enabled.
 */
import { Either, Schema } from "effect";
import type { ParseOptions } from "effect/SchemaAST";
import type { CapabilityRegistrySnapshot } from "../../capability-registry/snapshot.js";
import { networkIdentityKey } from "../../capability-registry/keys.js";
import type { BoundedResolverMetrics, MetricsPort } from "../ports.js";
import { createMemoryMetrics } from "../metrics.js";
import {
  OPERATIONAL_EVENT_LABEL_ALLOWLIST,
  OPERATIONAL_EVENT_VALUE_ALLOWLIST,
  RecognitionOperationalEvent,
  type RecognitionOperationalEvent as OperationalEvent,
} from "./events.js";

export interface RecognitionObserverPort {
  readonly record: (
    event: unknown,
  ) => ObserverRecordResult;
}

export type ObserverDropReason =
  | "decode_failed"
  | "excess_property"
  | "identity_leak"
  | "network_key_refused"
  | "unclassified_demand";

export type ObserverRecordResult =
  | { readonly kind: "accepted"; readonly event: OperationalEvent }
  | { readonly kind: "dropped"; readonly reason: ObserverDropReason };

export interface MemoryRecognitionObserver extends RecognitionObserverPort {
  readonly events: () => ReadonlyArray<OperationalEvent>;
  readonly dropped: () => ReadonlyArray<{
    readonly reason: ObserverDropReason;
    readonly raw: unknown;
  }>;
  readonly metrics: MetricsPort;
  readonly clear: () => void;
}

/** Bounded allowlist / provider for registry-derived network keys. */
export type AllowedNetworkKeySource =
  | ReadonlySet<string>
  | { readonly currentKeys: () => ReadonlySet<string> };

export const networkKeysFromCapabilitySnapshot = (
  snapshot: CapabilityRegistrySnapshot,
): ReadonlySet<string> =>
  new Set(snapshot.networks.map((n) => networkIdentityKey(n.network)));

export const allowedNetworkKeysFromSnapshot = (
  snapshot: CapabilityRegistrySnapshot,
): AllowedNetworkKeySource => networkKeysFromCapabilitySnapshot(snapshot);

export const liveAllowedNetworkKeys = (
  current: () => CapabilityRegistrySnapshot,
): AllowedNetworkKeySource => ({
  currentKeys: () => networkKeysFromCapabilitySnapshot(current()),
});

const LABEL_SET = new Set<string>(OPERATIONAL_EVENT_LABEL_ALLOWLIST);
const VALUE_SET = new Set<string>(OPERATIONAL_EVENT_VALUE_ALLOWLIST);

const strictEventOptions: ParseOptions = {
  errors: "all",
  onExcessProperty: "error",
};

const decodeOperationalEvent = Schema.decodeUnknownEither(
  RecognitionOperationalEvent,
  strictEventOptions,
);

/**
 * Strict allowlist walk — every own enumerable key on an event must be a known
 * label or numeric observation field.
 */
export const assertOperationalEventAllowlist = (
  event: OperationalEvent,
): void => {
  for (const key of Object.keys(event)) {
    if (!LABEL_SET.has(key) && !VALUE_SET.has(key)) {
      throw new Error(`operational event excess/unknown field refused: ${key}`);
    }
  }
};

const FORBIDDEN_IDENTITY_PATTERNS: ReadonlyArray<RegExp> = [
  /^0x[a-fA-F0-9]{40}$/,
  /api[_-]?key/i,
  /bearer\s+/i,
  /community/i,
  /user[_-]?id/i,
  /order[_-]?id/i,
  /bucket_id/i,
  /authorization/i,
  /coalesce/i,
  /digest/i,
  /https?:\/\//i,
];

export const assertNoIdentityLeakInEvent = (
  event: OperationalEvent,
): void => {
  assertOperationalEventAllowlist(event);
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      for (const pattern of FORBIDDEN_IDENTITY_PATTERNS) {
        if (pattern.test(value)) {
          // Network keys like eip155:1 are allowlisted via network_key field only
          // AND must still pass the registry allowlist at record time.
          if (path.endsWith(".network_key") && /^[a-z0-9]+:/i.test(value)) {
            continue;
          }
          throw new Error(`identity-like value leaked at ${path}: ${value.slice(0, 32)}`);
        }
      }
      return;
    }
    if (typeof value === "boolean" || typeof value === "number") return;
    if (value !== null && typeof value === "object") {
      for (const [k, child] of Object.entries(value)) {
        walk(child, `${path}.${k}`);
      }
    }
  };
  walk(event, "$");
};

const resolveAllowlist = (
  source: AllowedNetworkKeySource | undefined,
): ReadonlySet<string> | undefined => {
  if (source === undefined) return undefined;
  if (source instanceof Set || Object.prototype.toString.call(source) === "[object Set]") {
    return source as ReadonlySet<string>;
  }
  if (
    typeof source === "object" &&
    source !== null &&
    "currentKeys" in source &&
    typeof source.currentKeys === "function"
  ) {
    return source.currentKeys();
  }
  return source as ReadonlySet<string>;
};

const bridgeToMetrics = (
  metrics: MetricsPort,
  event: OperationalEvent,
): void => {
  switch (event.kind) {
    case "network_outcome":
      if (event.adapter_attempted) {
        metrics.incr("adapter_calls");
      }
      if (event.network_outcome === "timeout") {
        metrics.incr("timeouts");
      }
      break;
    case "resolver_terminal":
      metrics.recordLatency(event.latency_ms);
      if (event.terminal_outcome === "partial") {
        metrics.incr("partials");
      }
      if (event.terminal_outcome === "rate_limited") {
        metrics.incr("rate_limited");
      }
      if (event.cache_outcome === "negative_hit") {
        metrics.incr("cache_negative_hit");
        metrics.incr("coalesced");
      }
      if (event.cache_outcome === "negative_miss" && event.role === "leader") {
        metrics.incr("cache_negative_miss");
      }
      if (event.role === "follower") {
        metrics.incr("coalesced");
      }
      break;
    default:
      break;
  }
};

export const createMemoryRecognitionObserver = (options: {
  readonly metrics?: MetricsPort;
  /**
   * When true, mirror selected events onto aggregate MetricsPort counters.
   * Default false — resolveBounded still owns legacy counters so bridging would
   * double-count when both paths are live.
   */
  readonly bridgeMetrics?: boolean;
  /**
   * Registry-derived network_key allowlist. Required at construction so
   * production callers cannot silently drop network/circuit events.
   */
  readonly allowedNetworkKeys: AllowedNetworkKeySource;
}): MemoryRecognitionObserver => {
  const metrics = options.metrics ?? createMemoryMetrics();
  const bridge = options.bridgeMetrics === true;
  const recorded: OperationalEvent[] = [];
  const dropped: Array<{ reason: ObserverDropReason; raw: unknown }> = [];

  const drop = (reason: ObserverDropReason, raw: unknown): ObserverRecordResult => {
    dropped.push({ reason, raw });
    return { kind: "dropped", reason };
  };

  return {
    metrics,
    events: () => [...recorded],
    dropped: () => [...dropped],
    clear: () => {
      recorded.length = 0;
      dropped.length = 0;
    },
    record: (raw): ObserverRecordResult => {
      try {
        const decodedEither = decodeOperationalEvent(raw);
        if (Either.isLeft(decodedEither)) {
          const msg = String(decodedEither.left);
          if (/excess|unexpected|must not have/i.test(msg)) {
            return drop("excess_property", raw);
          }
          return drop("decode_failed", raw);
        }
        const event = decodedEither.right;

        try {
          assertNoIdentityLeakInEvent(event);
        } catch {
          return drop("identity_leak", raw);
        }

        // Demand must never claim an unclassified identifier format.
        if (
          event.kind === "resolver_demand" &&
          event.identifier_format === "unclassified"
        ) {
          return drop("unclassified_demand", raw);
        }

        if ("network_key" in event) {
          const allow = resolveAllowlist(options.allowedNetworkKeys);
          if (allow === undefined || !allow.has(event.network_key)) {
            return drop("network_key_refused", raw);
          }
        }

        recorded.push(event);
        if (bridge) {
          bridgeToMetrics(metrics, event);
        }
        return { kind: "accepted", event };
      } catch {
        // Absolute safety: never throw into resolveBounded / circuit breaker.
        return drop("decode_failed", raw);
      }
    },
  };
};

export type { BoundedResolverMetrics };
