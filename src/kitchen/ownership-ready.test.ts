import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryIngestJobStore } from "./ingest-store.js";
import {
  buildOwnershipReadyInventory,
  caip10ForJob,
  jobToOwnershipReadyRow,
} from "./ownership-ready.js";
import { createKitchenApp } from "./routes.js";
import { INJECTED_PREPARATION_RUNTIME } from "./preparation-runtime.js";
import type { CollectionStatusReader } from "./status.js";
import type { IngestJobRecord } from "./types.js";

const TOKEN = "kitchen-test-token";
const ADDRESS = "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684" as `0x${string}`;
const reader: CollectionStatusReader = {
  readIndexedSnapshot: async () => ({
    holderCount: 42,
    indexedAtMs: 1_700_000_000_000,
  }),
};

function sampleJob(overrides: Partial<IngestJobRecord> = {}): IngestJobRecord {
  return {
    physicalJobId: "ingest_ready_1",
    jobId: "ingest_ready_1",
    status: "completed",
    attempt: 1,
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
        network_reference: "8453",
      },
      address: ADDRESS,
      normalized_address: ADDRESS,
      deployment_id: {
        algorithm: "sha-256",
        domain: "collection.deployment",
        major_version: 1,
        digest: "a".repeat(64),
      },
    },
    correlation: { source: "ordering-service", correlationId: "c1" },
    ...overrides,
  } as IngestJobRecord;
}

describe("ownership-ready inventory", () => {
  it("builds CAIP-10 from deployment", () => {
    expect(caip10ForJob(sampleJob())).toBe(`eip155:8453:${ADDRESS}`);
  });

  it("maps completed jobs only", () => {
    expect(jobToOwnershipReadyRow(sampleJob({ status: "queued" }))).toBeNull();
    const row = jobToOwnershipReadyRow(sampleJob(), {
      holderCount: 7,
      indexedAtMs: 3_000,
    });
    expect(row?.kitchen_job_status).toBe("completed");
    expect(row?.holder_count).toBe(7);
    expect(row?.plane).toBeUndefined();
    expect(row?.caip10).toBe(`eip155:8453:${ADDRESS}`);
  });

  it("buildOwnershipReadyInventory sets Sonar kitchen plane", async () => {
    const inventory = await buildOwnershipReadyInventory({
      listCompleted: async () => [sampleJob()],
      enrich: async () => ({ holderCount: 9, indexedAtMs: 4_000 }),
      nowMs: 5_000,
    });
    expect(inventory.plane).toBe("sonar_kitchen_ownership");
    expect(inventory.count).toBe(1);
    expect(inventory.subjects[0]?.holder_count).toBe(9);
    expect(inventory.observed_at).toBe(new Date(5_000).toISOString());
  });
});

describe("GET /v2/ownership-ready + indexing-status.ownership_ready", () => {
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

  it("lists completed prepare jobs as ownership_ready", async () => {
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
    const admitted = await admit.json();
    const physicalJobId = admitted.physical_job_id as string;
    await store.updateStatus(physicalJobId, "indexing");
    await store.updateStatus(physicalJobId, "completed");

    const ready = await app().request("/v2/ownership-ready", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ready.status).toBe(200);
    const inventory = await ready.json();
    expect(inventory.plane).toBe("sonar_kitchen_ownership");
    expect(inventory.count).toBe(1);
    expect(inventory.subjects[0].caip10).toBe(`eip155:8453:${ADDRESS}`);
    expect(inventory.subjects[0].holder_count).toBe(42);

    const status = await app().request("/v2/indexing-status", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = await status.json();
    expect(body.ownership_ready.plane).toBe("sonar_kitchen_ownership");
    expect(body.ownership_ready.count).toBe(1);
  });

  it("rejects unauthenticated ownership-ready reads", async () => {
    const res = await app().request("/v2/ownership-ready");
    expect(res.status).toBe(401);
  });
});
