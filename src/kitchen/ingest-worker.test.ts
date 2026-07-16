import { describe, expect, it, vi } from "vitest";

import { MemoryIngestJobStore } from "./ingest-store.js";
import {
  applyBeltConfigPatch,
  advanceIndexingJobs,
  processQueuedIngestJob,
  runKitchenIngestWorkerTick,
} from "./ingest-worker.js";
import type { CollectionStatusReader } from "./status.js";

const ETH_CONFIG = `
chains:
  - id: 1
    start_block: 100
    contracts:
      - name: EthTrackedErc721
        address:
          - 0xa20cf9b0874c3e46b344deaeea9c2e0c3e1db37d
`.trim();

const BERA_CONFIG = `
chains:
  - id: 80094
    start_block: 1
    contracts:
      - name: TrackedErc721
        address:
          - 0x6b31859e5e32a5212f1ba4d7b377604b9d4c7a60
`.trim();

describe("ingest-worker", () => {
  it("uses the dedicated Ethereum adapter without subscriber-derived labels", async () => {
    const store = new MemoryIngestJobStore();
    await store.upsertQueued(
      { chainId: 1, contract: "0xed5af388653567af2f388e6224dc7c4b3241c544" },
      { order_id: "private-order", source: "ordering-service", community_name: "Private Community" },
    );
    const [job] = await store.claimQueued({ workerId: "worker-a" });
    let written = ETH_CONFIG;
    await processQueuedIngestJob({
      job,
      store,
      readFile: () => ETH_CONFIG,
      writeFile: (_path, contents) => {
        written = contents;
      },
      restart: async () => {},
    });
    expect((await store.get(job.key!))?.status).toBe("indexing");
    expect(job.prepareAdapterId).toBe("belt.eth-erc721");
    expect(written).toContain("- name: EthTrackedErc721");
    expect(written).not.toContain("Private Community");
    expect(written).not.toContain("private-order");
  });

  it("uses TrackedErc721 for supported non-Ethereum EVM", async () => {
    const store = new MemoryIngestJobStore();
    await store.upsertQueued(
      { chainId: 80094, contract: "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684" },
      { order_id: "order", source: "ordering-service" },
    );
    const [job] = await store.claimQueued({ workerId: "worker-a" });
    let written = BERA_CONFIG;
    await processQueuedIngestJob({
      job,
      store,
      readFile: () => BERA_CONFIG,
      writeFile: (_path, contents) => {
        written = contents;
      },
      restart: async () => {},
    });
    expect(job.prepareAdapterId).toBe("belt.evm-erc721");
    expect(written).toContain("- name: TrackedErc721");
  });

  it("completes only from explicit readiness evidence", async () => {
    const store = new MemoryIngestJobStore();
    const job = await store.upsertQueued(
      { chainId: 1, contract: "0xed5af388653567af2f388e6224dc7c4b3241c544" },
      { order_id: "order-1", source: "ordering-service" },
    );
    await store.updateStatus(job.physicalJobId, "indexing");
    const noEvidence: CollectionStatusReader = {
      readIndexedSnapshot: vi.fn().mockResolvedValue({ holderCount: 42, indexedAtMs: Date.now() }),
    };
    await advanceIndexingJobs({ store, reader: noEvidence, nowMs: job.updatedAtMs + 1 });
    expect((await store.get(job.key!))?.status).toBe("indexing");

    const explicit: CollectionStatusReader = {
      readIndexedSnapshot: vi.fn().mockResolvedValue({
        holderCount: 0,
        indexedAtMs: null,
        readiness: { state: "ready", kind: "registration_marker", observedAtMs: Date.now() },
      }),
    };
    await advanceIndexingJobs({ store, reader: explicit });
    expect((await store.get(job.key!))?.status).toBe("completed");
  });

  it("claims and processes a queued job once", async () => {
    const store = new MemoryIngestJobStore();
    const key = { chainId: 80094, contract: "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684" as const };
    await store.upsertQueued(key, { order_id: "order-1", source: "ordering-service" });
    const reader: CollectionStatusReader = {
      readIndexedSnapshot: vi.fn().mockResolvedValue({
        holderCount: 1,
        indexedAtMs: Date.now(),
        readiness: { state: "ready", kind: "indexed_rows", observedAtMs: Date.now() },
      }),
    };
    await runKitchenIngestWorkerTick({
      store,
      reader,
      workerId: "worker-a",
      readFile: () => BERA_CONFIG,
      writeFile: () => {},
      restart: async () => {},
    });
    expect((await store.get(key))?.status).toBe("completed");
  });

  it("is idempotent for an already-listed Ethereum contract", async () => {
    const store = new MemoryIngestJobStore();
    const job = await store.upsertQueued(
      { chainId: 1, contract: "0xa20cf9b0874c3e46b344deaeea9c2e0c3e1db37d" },
      { order_id: "o", source: "s" },
    );
    const { changed } = applyBeltConfigPatch({
      configPath: "ignored",
      job,
      readFile: () => ETH_CONFIG,
      writeFile: () => {
        throw new Error("should not write");
      },
    });
    expect(changed).toBe(false);
  });

  it("defensively refuses unsupported standards without config mutation", async () => {
    const store = new MemoryIngestJobStore();
    const admitted = await store.upsertQueued(
      { chainId: 80094, contract: "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684" },
      { order_id: "order", source: "ordering-service" },
    );
    const impossibleLegacyJob = {
      ...admitted,
      tokenStandard: "erc1155" as const,
      prepareAdapterId: "unsupported" as const,
    };
    let writes = 0;
    expect(() => applyBeltConfigPatch({
      configPath: "ignored",
      job: impossibleLegacyJob,
      readFile: () => {
        throw new Error("read must not run");
      },
      writeFile: () => {
        writes += 1;
      },
    })).toThrow("unsupported_standard");
    expect(writes).toBe(0);
  });

  it("does not let an expired and reclaimed worker publish status", async () => {
    const store = new MemoryIngestJobStore();
    const admitted = await store.upsertQueued(
      { chainId: 80094, contract: "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684" },
      { order_id: "order", source: "ordering-service" },
      100,
    );
    const [stale] = await store.claimQueued({
      workerId: "stale-worker",
      nowMs: 100,
      leaseMs: 10,
    });
    const [current] = await store.claimQueued({
      workerId: "current-worker",
      nowMs: 111,
      leaseMs: 1_000,
    });
    expect(current.leaseEpoch).toBe(stale.leaseEpoch + 1);

    let writes = 0;
    await processQueuedIngestJob({
      job: stale,
      store,
      nowMs: 112,
      readFile: () => BERA_CONFIG,
      writeFile: () => {
        writes += 1;
      },
      restart: async () => {},
    });
    expect(writes).toBe(0);
    await expect(store.getByPhysicalJobId(admitted.physicalJobId)).resolves.toMatchObject({
      status: "queued",
      leaseOwner: "current-worker",
      leaseEpoch: current.leaseEpoch,
    });

    const stalePublish = await store.updateStatus(admitted.physicalJobId, "failed", {
      nowMs: 112,
      expectedLease: { owner: "stale-worker", epoch: stale.leaseEpoch },
    });
    expect(stalePublish).toBeUndefined();
  });

  it("lets the first terminal coordinator result win", async () => {
    const store = new MemoryIngestJobStore();
    const job = await store.upsertQueued(
      { chainId: 80094, contract: "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684" },
      { order_id: "order", source: "ordering-service" },
      100,
    );
    await store.updateStatus(job.physicalJobId, "indexing", {
      nowMs: 101,
      expectedStatus: "queued",
    });
    const completed = await store.updateStatus(job.physicalJobId, "completed", {
      nowMs: 102,
      expectedStatus: "indexing",
    });
    expect(completed?.status).toBe("completed");

    const staleTimeout = await store.updateStatus(job.physicalJobId, "failed", {
      nowMs: 103,
      expectedStatus: "indexing",
      errorCode: "indexing_timeout",
    });
    expect(staleTimeout).toBeUndefined();
    await expect(store.getByPhysicalJobId(job.physicalJobId)).resolves.toMatchObject({
      status: "completed",
    });
  });
});
