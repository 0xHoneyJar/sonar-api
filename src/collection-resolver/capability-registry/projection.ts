import { Effect, Schema } from "effect";
import type { ParseOptions } from "effect/SchemaAST";
import { digestVersioned, type VersionedDigest } from "../protocol.js";
import { CapabilityRegistryDecodeError } from "./errors.js";
import { cloneFreeze } from "./immutable.js";
import { networkIdentityKey, operationKinds } from "./keys.js";
import {
  CAPABILITY_REGISTRY_ORDERING_DIGEST_DOMAIN,
  CAPABILITY_REGISTRY_SCHEMA_VERSION,
  OrderingCapabilityProjection,
  type OrderingCapabilityView,
} from "./schemas.js";
import type { CapabilityRegistrySnapshot } from "./snapshot.js";

const strictOptions: ParseOptions = {
  errors: "all",
  onExcessProperty: "error",
};

const decodeProjection = Schema.decodeUnknown(
  OrderingCapabilityProjection,
  strictOptions,
);

const FORBIDDEN_PROJECTION_KEYS = [
  "rpc_url",
  "rpcUrl",
  "endpoint",
  "endpoints",
  "credentials",
  "api_key",
  "apiKey",
  "adapter_config",
  "chain_definition",
  "display",
  "icon_identity",
  "display_name",
  "source_provenance",
  "deadline",
  "probe_adapter",
] as const;

const FORBIDDEN_PROJECTION_VALUES = [
  /https?:\/\//i,
  /\b(?:authorization|bearer)\b/i,
  /api[_-]?key/i,
  /\b(?:password|secret|credential)\b/i,
  /\b(?:sk|ghp|github_pat)_[a-z0-9_-]+/i,
] as const;

const assertNoLeakage = (value: unknown, path: string): void => {
  if (typeof value === "string") {
    if (FORBIDDEN_PROJECTION_VALUES.some((pattern) => pattern.test(value))) {
      throw new Error(`Ordering projection secret-like value at ${path}`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoLeakage(item, `${path}[${index}]`));
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if ((FORBIDDEN_PROJECTION_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Ordering projection leakage at ${path}.${key}`);
    }
    assertNoLeakage((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
};

/**
 * Deterministic, least-privilege Ordering projection.
 * Contains only admission-relevant capability/finality/health/revocation fields
 * plus snapshot identity — never RPC credentials or internal diagnostics.
 */
export const projectOrderingCapabilityViews = (
  snapshot: CapabilityRegistrySnapshot,
): Effect.Effect<
  {
    readonly projection: Schema.Schema.Type<typeof OrderingCapabilityProjection>;
    readonly projection_digest: VersionedDigest;
  },
  CapabilityRegistryDecodeError
> =>
  Effect.gen(function* () {
    const views: OrderingCapabilityView[] = [];

    const networks = [...snapshot.networks].sort((left, right) => {
      const leftKey = networkIdentityKey(left.network);
      const rightKey = networkIdentityKey(right.network);
      if (leftKey < rightKey) return -1;
      if (leftKey > rightKey) return 1;
      return 0;
    });

    for (const network of networks) {
      for (const operation of operationKinds) {
        const op = network.operations[operation];
        views.push({
          network: network.network,
          environment: network.environment,
          operation,
          enabled: op.enabled,
          state: op.state,
          supported_standards: [...network.supported_standards],
          index_support: network.index_support,
          finality_policy_version: network.finality_policy.policy_version,
          kill_switch: network.kill_switch,
          drain_policy: op.drain_policy,
          prior_evidence_revocation_policy: op.prior_evidence_revocation_policy,
          normative_effects: { ...op.normative_effects },
          source_sequence: op.source_sequence,
          effective_at: op.effective_at,
          reason_class: op.reason_class,
          network_priority: network.network_priority,
        });
      }
    }

    const raw = {
      schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
      snapshot_identity: snapshot.version,
      views,
    };

    yield* Effect.try({
      try: () => assertNoLeakage(raw, "$"),
      catch: (cause) =>
        new CapabilityRegistryDecodeError({
          reason: "Ordering projection failed leakage guard",
          cause,
        }),
    });

    const projection = yield* decodeProjection(raw).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityRegistryDecodeError({
            reason: "Ordering projection failed strict decode",
            cause,
          }),
      ),
    );

    const projection_digest = yield* digestVersioned(
      CAPABILITY_REGISTRY_ORDERING_DIGEST_DOMAIN,
      1,
      projection,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityRegistryDecodeError({
            reason: "failed to digest Ordering projection",
            cause,
          }),
      ),
    );

    return {
      projection: cloneFreeze(projection),
      projection_digest,
    };
  });
