import { describe, expect, it, vi } from "vitest";

import { createCoverageAwareStatusReader } from "./coverage-aware-status-reader.js";
import type { CoverageFloorRecord } from "./coverage-readiness.js";
import { collectionKeyId } from "./normalize.js";
import type { IndexedSnapshot } from "./status.js";
import type { CollectionKey } from "./types.js";

const key: CollectionKey = {
  chainId: 1,
  contract: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
};
const floor: CoverageFloorRecord = {
  chainId: 1,
  contract: key.contract,
  physicalJobId: "ingest_bayc",
  requiredFloor: 12_287_507,
  coverageMode: "full_from_required_floor",
  configDigest: "cfg".padEnd(64, "a"),
  capabilityId: "ownership_index.v1",
  capabilityVersion: "cap".padEnd(64, "b"),
};

function createReader(args?: {
  snapshot?: IndexedSnapshot;
  processedThroughBlock?: number;
  headBlock?: number;
  sensorFailed?: boolean;
  physicalJobId?: string;
  configDigest?: string;
}) {
  const snapshot = args?.snapshot ?? {
    holderCount: 5,
    tokenCount: 10,
    trackedHolderCount: 5,
    indexedAtMs: 1_700_000_000_000,
    readiness: {
      state: "ready" as const,
      kind: "indexed_rows" as const,
      observedAtMs: 1_700_000_000_000,
    },
  };
  return createCoverageAwareStatusReader({
    inner: {
      readIndexedSnapshot: vi.fn().mockResolvedValue(snapshot),
    },
    resolveFloor: (candidate) =>
      collectionKeyId(candidate) === collectionKeyId(key) ? floor : null,
    resolveJobBindings: vi.fn().mockResolvedValue(
      new Map([
        [
          collectionKeyId(key),
          {
            physicalJobId: args?.physicalJobId ?? "ingest_bayc",
            deploymentId: "dep".padEnd(64, "c"),
            configDigest: args?.configDigest ?? floor.configDigest,
            capabilityId: floor.capabilityId,
            capabilityVersion: floor.capabilityVersion,
          },
        ],
      ]),
    ),
    readChainProgress: vi.fn().mockResolvedValue(
      new Map([
        [
          1,
          {
            processedThroughBlock: args?.processedThroughBlock ?? 20_000_000,
            headBlock: args?.headBlock ?? 20_000_500,
            ...(args?.sensorFailed ? { sensorFailed: true } : {}),
          },
        ],
      ]),
    ),
    tipLagBlocks: 500,
  });
}

describe("createCoverageAwareStatusReader", () => {
  it("does not complete from positive rows before required progress", async () => {
    const snapshot = await createReader({
      processedThroughBlock: 15_000_000,
      headBlock: 20_000_500,
    }).readIndexedSnapshot(key);

    expect(snapshot.readiness).toBeUndefined();
    expect(snapshot.holderCount).toBe(5);
  });

  it("completes a fully covered zero-row collection with a sync marker", async () => {
    const snapshot = await createReader({
      snapshot: {
        holderCount: 0,
        tokenCount: 0,
        trackedHolderCount: 0,
        indexedAtMs: null,
      },
    }).readIndexedSnapshot(key);

    expect(snapshot.readiness).toMatchObject({
      state: "ready",
      kind: "sync_marker",
      coverage: {
        physicalJobId: "ingest_bayc",
        tokenRows: 0,
        holderRows: 0,
      },
    });
  });

  it.each([
    ["wrong config", { configDigest: "wrong".padEnd(64, "d") }],
    ["wrong physical job", { physicalJobId: "ingest_wrong" }],
    ["failed progress sensor", { sensorFailed: true }],
  ])("fails closed on %s", async (_name, overrides) => {
    const snapshot = await createReader(overrides).readIndexedSnapshot(key);
    expect(snapshot.readiness).toBeUndefined();
  });

  it("propagates an entity GraphQL failure instead of manufacturing green", async () => {
    const reader = createCoverageAwareStatusReader({
      inner: {
        readIndexedSnapshot: vi.fn().mockRejectedValue(new Error("hasura unavailable")),
      },
      resolveFloor: () => floor,
      resolveJobBindings: vi.fn(),
      readChainProgress: vi.fn(),
    });

    await expect(reader.readIndexedSnapshot(key)).rejects.toThrow("hasura unavailable");
  });

  it("strips row readiness for a registry-blocked contract", async () => {
    const resolveBindings = vi.fn();
    const readProgress = vi.fn();
    const reader = createCoverageAwareStatusReader({
      inner: {
        readIndexedSnapshot: vi.fn().mockResolvedValue({
          holderCount: 99,
          tokenCount: 100,
          trackedHolderCount: 99,
          indexedAtMs: 1_700_000_000_000,
          readiness: {
            state: "ready",
            kind: "indexed_rows",
            observedAtMs: 1_700_000_000_000,
          },
        }),
      },
      resolveFloor: () => null,
      isBlocked: () => true,
      resolveJobBindings: resolveBindings,
      readChainProgress: readProgress,
    });

    const snapshot = await reader.readIndexedSnapshot(key);

    expect(snapshot.holderCount).toBe(99);
    expect(snapshot.readiness).toBeUndefined();
    expect(resolveBindings).not.toHaveBeenCalled();
    expect(readProgress).not.toHaveBeenCalled();
  });

  it("evaluates 500 jobs through one inner, binding, and progress batch", async () => {
    const keys = Array.from({ length: 500 }, (_, index) => ({
      chainId: 1,
      contract: `0x${index.toString(16).padStart(40, "0")}` as `0x${string}`,
    }));
    const innerBatch = vi.fn().mockResolvedValue(
      new Map(
        keys.map((candidate) => [
          collectionKeyId(candidate),
          {
            holderCount: 0,
            tokenCount: 0,
            trackedHolderCount: 0,
            indexedAtMs: null,
          },
        ]),
      ),
    );
    const resolveBindings = vi.fn().mockImplementation(async (candidates: CollectionKey[]) =>
      new Map(
        candidates.map((candidate) => [
          collectionKeyId(candidate),
          {
            physicalJobId: `ingest_${candidate.contract.slice(-8)}`,
            deploymentId: "dep".padEnd(64, "c"),
            configDigest: floor.configDigest,
            capabilityId: floor.capabilityId,
            capabilityVersion: floor.capabilityVersion,
          },
        ]),
      ),
    );
    const readProgress = vi.fn().mockResolvedValue(
      new Map([[1, { processedThroughBlock: 20_000_000, headBlock: 20_000_500 }]]),
    );
    const reader = createCoverageAwareStatusReader({
      inner: {
        readIndexedSnapshot: vi.fn(),
        readIndexedSnapshots: innerBatch,
      },
      resolveFloor: (candidate) => ({
        ...floor,
        contract: candidate.contract,
        physicalJobId: `ingest_${candidate.contract.slice(-8)}`,
      }),
      resolveJobBindings: resolveBindings,
      readChainProgress: readProgress,
      tipLagBlocks: 500,
    });

    const snapshots = await reader.readIndexedSnapshots!(keys);

    expect(snapshots).toHaveLength(500);
    expect([...snapshots.values()].every((snapshot) => snapshot.readiness?.kind === "sync_marker")).toBe(true);
    expect(innerBatch).toHaveBeenCalledTimes(1);
    expect(resolveBindings).toHaveBeenCalledTimes(1);
    expect(readProgress).toHaveBeenCalledTimes(1);
  });
});
