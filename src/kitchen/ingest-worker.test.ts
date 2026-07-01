import { describe, expect, it, vi } from "vitest";

import { MemoryIngestJobStore } from "./ingest-store.js";
import {
  applyBeltConfigPatch,
  advanceIndexingJobs,
  processQueuedIngestJob,
  runKitchenIngestWorkerTick,
} from "./ingest-worker.js";
import type { CollectionStatusReader } from "./status.js";

const FIXTURE_CONFIG = `
chains:
  - id: 1
    start_block: 100
    contracts:
      - name: HoneyJar
        address:
          - 0xa20cf9b0874c3e46b344deaeea9c2e0c3e1db37d
`.trim();

describe("ingest-worker", () => {
  it("patches belt config and moves job to indexing", async () => {
    const store = new MemoryIngestJobStore();
    const job = await store.upsertQueued(
      { chainId: 1, contract: "0xED5Af388653567Af2F388e6224DcC93746104133" },
      { order_id: "order-1", source: "ordering-service", community_name: "Azuki" },
    );

    let written = FIXTURE_CONFIG;
    await processQueuedIngestJob({
      job,
      store,
      readFile: () => FIXTURE_CONFIG,
      writeFile: (_path, contents) => {
        written = contents;
      },
    });

    const updated = await store.get(job.key);
    expect(updated?.status).toBe("indexing");
    expect(written.toLowerCase()).toContain("0xed5af388653567af2f388e6224dcc93746104133");
  });

  it("marks job completed when holders appear", async () => {
    const store = new MemoryIngestJobStore();
    const key = { chainId: 1, contract: "0xED5Af388653567Af2F388e6224DcC93746104133" as const };
    await store.upsertQueued(key, { order_id: "order-1", source: "ordering-service" });
    await store.updateStatus(key, "indexing");

    const reader: CollectionStatusReader = {
      readIndexedSnapshot: vi.fn().mockResolvedValue({ holderCount: 42, indexedAtMs: Date.now() }),
    };

    await advanceIndexingJobs({ store, reader });
    const updated = await store.get(key);
    expect(updated?.status).toBe("completed");
  });

  it("runKitchenIngestWorkerTick processes queued then indexing jobs", async () => {
    const store = new MemoryIngestJobStore();
    const key = { chainId: 1, contract: "0xED5Af388653567Af2F388e6224DcC93746104133" as const };
    await store.upsertQueued(key, { order_id: "order-1", source: "ordering-service" });

    const reader: CollectionStatusReader = {
      readIndexedSnapshot: vi.fn().mockResolvedValue({ holderCount: 1, indexedAtMs: Date.now() }),
    };

    await runKitchenIngestWorkerTick({
      store,
      reader,
      readFile: () => FIXTURE_CONFIG,
      writeFile: () => {},
    });

    const updated = await store.get(key);
    expect(updated?.status).toBe("completed");
  });

  it("applyBeltConfigPatch is idempotent for listed contracts", () => {
    const { changed } = applyBeltConfigPatch({
      configPath: "ignored",
      job: {
        jobId: "x",
        key: { chainId: 1, contract: "0xa20cf9b0874c3e46b344deaeea9c2e0c3e1db37d" },
        orderId: "o",
        source: "s",
        status: "queued",
        createdAtMs: 0,
        updatedAtMs: 0,
      },
      readFile: () => FIXTURE_CONFIG,
      writeFile: () => {
        throw new Error("should not write");
      },
    });
    expect(changed).toBe(false);
  });
});
