/**
 * CR-RECOG-ENRICH — Kitchen collection-index candidates for resolve-probe (#229).
 *
 * Hermetic only: scripted probe outcomes + a scripted index registry. No live
 * RPC, no Hasura, no placeable Ordering digests.
 */
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  createHermeticBoundedDeps,
  defaultBoundedResolverConfig,
  hermeticResolveRequest,
  resolveBounded,
} from "../src/collection-resolver/bounded-core/index.js";
import {
  createIndexRegistryEnrichedAdapter,
  createKitchenIndexRegistryPort,
  createScriptedIndexRegistryPort,
  INDEX_REGISTRY_RANKING_REASON,
} from "../src/collection-resolver/adapters/evm/index.js";
import {
  defaultLiveRecognizeNetworkCapabilities,
  DEFAULT_REGISTRY_EPOCH,
} from "../src/collection-resolver/capability-registry/fixtures.js";
import { CAPABILITY_REGISTRY_SCHEMA_VERSION } from "../src/collection-resolver/capability-registry/schemas.js";
import { decodeCapabilityRegistrySnapshot } from "../src/collection-resolver/capability-registry/snapshot.js";
import type { ProbeOutcome } from "../src/collection-resolver/candidate.js";
import type { IndexedSnapshot } from "../src/kitchen/status.js";

/** Berachain-deployed community collection — the #229 reference case. */
const BERACHAIN_ADDRESS = "0x6666397dfe9a8c469bf65dc744cb1c733416c420";
const BERACHAIN_IDENTIFIER = `eip155:80094:${BERACHAIN_ADDRESS}`;
const REGISTRY_KEY = `80094:${BERACHAIN_ADDRESS}`;

const expectSuccess = <A, E>(effect: Effect.Effect<A, E>): A => {
  const exit = Effect.runSyncExit(effect);
  if (exit._tag === "Failure") {
    throw new Error(`expected success, got ${String(exit.cause)}`);
  }
  return exit.value;
};

const liveSnapshot = () =>
  expectSuccess(
    decodeCapabilityRegistrySnapshot({
      schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
      version: {
        registry_epoch: DEFAULT_REGISTRY_EPOCH,
        registry_sequence: "4",
      },
      networks: defaultLiveRecognizeNetworkCapabilities(),
    }),
  );

const ALL_MISS: Readonly<Record<string, ProbeOutcome>> = {
  "eip155:1": { kind: "miss" },
  "eip155:8453": { kind: "miss" },
  "eip155:10": { kind: "miss" },
  "eip155:42161": { kind: "miss" },
  "eip155:80094": { kind: "miss" },
  "eip155:4663": { kind: "miss" },
};

const ONCHAIN_HIT: ProbeOutcome = {
  kind: "hit",
  address: BERACHAIN_ADDRESS,
  token_standard: "erc721",
  name: "Onchain Name",
  symbol: "ONCHAIN",
  recognition: "recognized",
  index_status: "indexed",
  report_readiness: "ready",
  metadata_quality: "onchain",
  observed_at: "2026-07-25T00:00:00.000Z",
  ranking_reasons: ["supported_standard", "indexed"],
  evidence_material: { adapter: "scripted_onchain" },
};

const resolveWith = (input: {
  readonly script: Readonly<Record<string, ProbeOutcome>>;
  readonly registry: Readonly<
    Record<string, { holder_count: number; indexed_at_ms: number | null }>
  >;
  readonly identifier?: string;
}) => {
  const hermetic = createHermeticBoundedDeps({
    capabilitySnapshot: liveSnapshot(),
    script: input.script as never,
  });
  const deps = {
    ...hermetic.deps,
    adapter: createIndexRegistryEnrichedAdapter({
      base: hermetic.deps.adapter,
      registry: createScriptedIndexRegistryPort(input.registry),
    }),
  };
  return expectSuccess(
    resolveBounded({
      request: hermeticResolveRequest(input.identifier ?? BERACHAIN_IDENTIFIER),
      config: hermetic.config ?? defaultBoundedResolverConfig(),
      deps,
    }),
  );
};

describe("CR-RECOG-ENRICH index-registry candidates", () => {
  it("surfaces an inventory_registry candidate when the index has it and the probe missed", () => {
    const response = resolveWith({
      script: ALL_MISS,
      registry: {
        [REGISTRY_KEY]: { holder_count: 412, indexed_at_ms: 1_750_000_000_000 },
      },
    });

    expect(response.candidates).toHaveLength(1);
    const candidate = response.candidates[0]!;

    // Honest provenance — never borrowed from the on-chain probe.
    expect(candidate.provenance.map((p) => p.source)).toEqual(["inventory_registry"]);
    expect(candidate.ranking_reasons).toContain(INDEX_REGISTRY_RANKING_REASON);
    expect(candidate.index_status).toBe("indexed");
    expect(
      candidate.identity.deployments.map(
        (d) => `${d.network.network_namespace}:${d.network.network_reference}`,
      ),
    ).toEqual(["eip155:80094"]);

    // Nothing the index did not observe is asserted.
    expect(candidate.token_standard.value).toBe("unknown");
    expect(candidate.metadata_quality).toBe("unavailable");
    expect(candidate.identity.name).toBeUndefined();
    expect(candidate.identity.symbol).toBeUndefined();
    expect(candidate.identity.image).toBeUndefined();
  });

  it("refuses to fabricate binding evidence Ordering cannot confirm", () => {
    const response = resolveWith({
      script: ALL_MISS,
      registry: {
        [REGISTRY_KEY]: { holder_count: 412, indexed_at_ms: 1_750_000_000_000 },
      },
    });

    // No code/account digest or block coordinate was observed, so the core
    // marks the response partial and refuses positive/readiness cache writes.
    expect(response.diagnostics.partial).toBe(true);
    expect(response.diagnostics.entries.map((e) => e.code)).toContain(
      "binding_evidence_absent",
    );
    expect(response.diagnostics.cache.positive_hit).toBe(false);
    expect(response.diagnostics.cache.readiness_hit).toBe(false);
  });

  it("yields zero candidates when neither the probe nor the index has the address", () => {
    const response = resolveWith({ script: ALL_MISS, registry: {} });

    expect(response.candidates).toEqual([]);
    expect(
      response.diagnostics.searched.map(
        (n) => `${n.network_namespace}:${n.network_reference}`,
      ),
    ).toEqual(["eip155:80094"]);
  });

  it("never replaces an on-chain hit — enrichment is additive only", () => {
    const response = resolveWith({
      script: { ...ALL_MISS, "eip155:80094": ONCHAIN_HIT },
      registry: {
        [REGISTRY_KEY]: { holder_count: 412, indexed_at_ms: 1_750_000_000_000 },
      },
    });

    expect(response.candidates).toHaveLength(1);
    const candidate = response.candidates[0]!;
    expect(candidate.provenance.map((p) => p.source)).toEqual(["sonar_probe"]);
    expect(candidate.identity.name).toBe("Onchain Name");
    expect(candidate.token_standard.value).toBe("erc721");
    expect(candidate.ranking_reasons).not.toContain(INDEX_REGISTRY_RANKING_REASON);
  });

  it("does not enrich a chain the index registry has no entry for", () => {
    // Coverage on Ethereum must not leak onto the Berachain-qualified probe.
    const response = resolveWith({
      script: ALL_MISS,
      registry: {
        [`1:${BERACHAIN_ADDRESS}`]: { holder_count: 9, indexed_at_ms: null },
      },
    });

    expect(response.candidates).toEqual([]);
  });
});

describe("CR-RECOG-ENRICH Kitchen collection-index port", () => {
  const port = (snapshot: IndexedSnapshot | Error) =>
    createKitchenIndexRegistryPort({
      reader: {
        readIndexedSnapshot: async () => {
          if (snapshot instanceof Error) throw snapshot;
          return snapshot;
        },
      },
      clock: {
        nowMs: () => 0,
        nowIso: () => "2026-07-25T00:00:00.000Z",
        scheduleAt: () => () => undefined,
      },
    });

  const lookup = (
    snapshot: IndexedSnapshot | Error,
  ): Promise<Exit.Exit<unknown, never>> =>
    Effect.runPromiseExit(
      port(snapshot).lookup({
        chain_id: 80094,
        normalized_address: BERACHAIN_ADDRESS,
        abort: new AbortController().signal,
        deadline_at_ms: 10_000,
        now_ms: () => 0,
      }),
    );

  it("reports coverage only when the snapshot carries ratified readiness", async () => {
    const exit = await lookup({
      holderCount: 412,
      indexedAtMs: 1_750_000_000_000,
      readiness: { state: "ready", kind: "indexed_rows", observedAtMs: 1 },
    });
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(Exit.isSuccess(exit) ? exit.value : undefined).toEqual({
      holder_count: 412,
      indexed_at_ms: 1_750_000_000_000,
      readiness_kind: "indexed_rows",
    });
  });

  it("returns the absent state for an un-ready snapshot", async () => {
    const exit = await lookup({ holderCount: 0, indexedAtMs: null });
    expect(Exit.isSuccess(exit) ? exit.value : "failed").toBeUndefined();
  });

  it("returns the absent state when the reader is unavailable", async () => {
    const exit = await lookup(new Error("hasura unreachable"));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(Exit.isSuccess(exit) ? exit.value : "failed").toBeUndefined();
  });
});
