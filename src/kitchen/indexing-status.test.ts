import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryIngestJobStore } from "./ingest-store.js";
import { buildIndexingStatus, jobToIndexingRow } from "./indexing-status.js";
import { createKitchenApp } from "./routes.js";
import { INJECTED_PREPARATION_RUNTIME } from "./preparation-runtime.js";
import type { CollectionStatusReader } from "./status.js";
import type { IngestJobRecord } from "./types.js";

const TOKEN = "kitchen-test-token";
const ADDRESS = "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684";
const reader: CollectionStatusReader = {
  readIndexedSnapshot: async () => ({ holderCount: 0, indexedAtMs: null }),
};

describe("GET /v2/indexing-status", () => {
  let store: MemoryIngestJobStore;

  beforeEach(() => {
    store = new MemoryIngestJobStore();
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
  });
  afterEach(() => vi.unstubAllEnvs());

  function app() {
    return createKitchenApp({
      store,
      reader,
      preparationRuntime: INJECTED_PREPARATION_RUNTIME,
    });
  }

  it("returns chains empty for memory store and lists active jobs", async () => {
    const admit = await app().request("/v2/collection-preparations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema_version: 1,
        network: {
          schema_version: 1,
          network_namespace: "eip155",
          network_reference: "8453",
        },
        address: ADDRESS,
        token_standard: "erc721",
      }),
    });
    expect(admit.status).toBe(202);

    const res = await app().request("/v2/indexing-status", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema_version).toBe(1);
    expect(body.chains).toEqual([]);
    expect(body.jobs.by_status.queued).toBe(1);
    expect(body.jobs.active).toHaveLength(1);
    expect(body.jobs.active[0].address).toBe(ADDRESS);
    expect(body.jobs.active[0].network_reference).toBe("8453");
    expect(body.ownership_ready).toMatchObject({
      schema_version: 1,
      plane: "sonar_kitchen_ownership",
      count: 0,
      subjects: [],
    });
  });

  it("rejects unauthenticated reads", async () => {
    const res = await app().request("/v2/indexing-status");
    expect(res.status).toBe(401);
  });

  it("maps job rows for the public snapshot", () => {
    const job = {
      physicalJobId: "ingest_x",
      jobId: "ingest_x",
      status: "indexing",
      attempt: 2,
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      tokenStandard: "erc721",
      prepareAdapterId: "belt.evm-erc721",
      prepareAdapterVersion: "belt-config-erc721.v1",
      capabilityId: "ownership_index.v1",
      capabilityVersion: "v",
      sourceSequence: "1",
      finalityPolicyVersion: "base-finalized.v1",
      leaseEpoch: 0,
      deployment: {
        schema_version: 1,
        network: {
          schema_version: 1,
          network_namespace: "eip155",
          network_reference: "1",
        },
        address: ADDRESS,
        normalized_address: ADDRESS,
        deployment_id: {
          algorithm: "sha-256",
          domain: "collection.deployment",
          major_version: 1,
          digest: "b".repeat(64),
        },
      },
      correlation: { source: "ordering-service", correlationId: "c1" },
    } as IngestJobRecord;
    const row = jobToIndexingRow(job);
    expect(row.correlation_id).toBe("c1");
    expect(row.updated_at).toBe(new Date(2_000).toISOString());
  });

  it("buildIndexingStatus merges queued and indexing", async () => {
    await app().request("/v2/collection-preparations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema_version: 1,
        network: {
          schema_version: 1,
          network_namespace: "eip155",
          network_reference: "1",
        },
        address: ADDRESS,
        token_standard: "erc721",
      }),
    });
    const body = await buildIndexingStatus({
      countByStatus: () => store.countByStatus(),
      listByStatus: (s, n) => store.listByStatus(s, n),
      readChains: async () => [
        {
          chain_id: 1,
          start_block: 1,
          latest_processed_block: 10,
          latest_fetched_block_number: 11,
          num_events_processed: 2,
          num_batches_fetched: 1,
        },
      ],
      nowMs: 5_000,
    });
    expect(body.observed_at).toBe(new Date(5_000).toISOString());
    expect(body.chains).toHaveLength(1);
    expect(body.jobs.active[0].network_reference).toBe("1");
    expect(body.ownership_ready.plane).toBe("sonar_kitchen_ownership");
    expect(body.ownership_ready.count).toBe(0);
  });
});
