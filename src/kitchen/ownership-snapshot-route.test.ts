import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryIngestJobStore } from "./ingest-store.js";
import {
  buildOwnershipSnapshot,
  parseCaip10,
  type OwnershipSnapshot,
} from "./ownership-snapshot.js";
import type { OwnershipSnapshotReader } from "./ownership-snapshot-reader.js";
import { createKitchenApp } from "./routes.js";
import { INJECTED_PREPARATION_RUNTIME } from "./preparation-runtime.js";
import type { CollectionStatusReader } from "./status.js";
import type { IngestJobRecord } from "./types.js";

const TOKEN = "kitchen-test-token";
const CAIP10 = "eip155:1:0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9";
const ADDRESS = "0x902d94ba5bfc0cb408d1a6ca4b8f255d845e50e9";

const reader: CollectionStatusReader = {
  readIndexedSnapshot: async () => ({
    holderCount: 42,
    indexedAtMs: 1_700_000_000_000,
  }),
};

describe("GET /v2/ownership-snapshot", () => {
  beforeEach(() => {
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function app(ownershipSnapshotReader?: OwnershipSnapshotReader) {
    return createKitchenApp({
      store: new MemoryIngestJobStore(),
      reader,
      preparationRuntime: INJECTED_PREPARATION_RUNTIME,
      ownershipSnapshotReader,
    });
  }

  it("rejects unauthenticated reads", async () => {
    // Mirror ownership-ready: token must be required (not open-auth).
    process.env.SERVICE_TOKEN = TOKEN;
    const res = await app({
      readOwnershipSnapshot: async () =>
        buildOwnershipSnapshot({
          subject: parseCaip10(CAIP10)!,
          holders: [{ address: "0xaaa", balance: 1 }],
          asOfUnixSeconds: null,
        }),
    }).request(`/v2/ownership-snapshot?caip10=${encodeURIComponent(CAIP10)}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("returns 503 when reader is not configured", async () => {
    const res = await app().request(`/v2/ownership-snapshot?caip10=${CAIP10}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
  });

  it("returns E2 concentration evidence for current ownership", async () => {
    const snapReader: OwnershipSnapshotReader = {
      readOwnershipSnapshot: async ({ caip10, asOfRaw }) => {
        expect(caip10).toBe(CAIP10);
        expect(asOfRaw).toBeUndefined();
        return buildOwnershipSnapshot({
          subject: parseCaip10(CAIP10)!,
          holders: [
            { address: "0xaaa", balance: 50 },
            { address: "0xbbb", balance: 30 },
            { address: "0xccc", balance: 20 },
          ],
          asOfUnixSeconds: null,
          observedAtMs: 1_700_000_000_000,
        });
      },
    };
    const res = await app(snapReader).request(`/v2/ownership-snapshot?caip10=${CAIP10}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OwnershipSnapshot;
    expect(body.plane).toBe("sonar_kitchen_ownership");
    expect(body.as_of).toBeNull();
    expect(body.subject.address).toBe(ADDRESS);
    expect(body.holder_count).toBe(3);
    expect(body.concentration).toMatchObject({ top10_share: 1 });
    expect(body.concentration).toEqual(
      expect.objectContaining({ hhi: expect.any(Number), gini: expect.any(Number) }),
    );
    expect(body.whale_candidate_count).toBe(1);
    expect(body.holders[0]).toMatchObject({ address: "0xaaa", balance: 50 });
  });

  it("accepts as_of and reference_date for E1", async () => {
    const snapReader: OwnershipSnapshotReader = {
      readOwnershipSnapshot: async ({ asOfRaw, referenceDateRaw }) => {
        expect(asOfRaw ?? referenceDateRaw).toBe("2026-06-21");
        return buildOwnershipSnapshot({
          subject: parseCaip10(CAIP10)!,
          holders: [{ address: "0xddd", balance: 2 }],
          asOfUnixSeconds: Math.floor(Date.UTC(2026, 5, 21, 23, 59, 59) / 1000),
          observedAtMs: 1_700_000_000_000,
        });
      },
    };
    const res = await app(snapReader).request(
      `/v2/ownership-snapshot?caip10=${CAIP10}&as_of=2026-06-21`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as OwnershipSnapshot;
    expect(body.as_of).toBe("2026-06-21");
    expect(body.coverage.ownership).toBe("available");
    expect(body.holder_count).toBe(1);
  });

  it("surfaces insufficient_data when history cannot support as_of", async () => {
    const snapReader: OwnershipSnapshotReader = {
      readOwnershipSnapshot: async () =>
        buildOwnershipSnapshot({
          subject: parseCaip10(CAIP10)!,
          holders: [],
          asOfUnixSeconds: Math.floor(Date.UTC(2026, 5, 21, 23, 59, 59) / 1000),
          insufficient: {
            status: "insufficient_data",
            reason: "indexed history starts after as_of",
          },
        }),
    };
    const res = await app(snapReader).request(
      `/v2/ownership-snapshot?caip10=${CAIP10}&reference_date=2026-06-21`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as OwnershipSnapshot;
    expect(body.coverage.ownership).toBe("unavailable");
    expect(body.metrics).toMatchObject({
      status: "insufficient_data",
      reason: "indexed history starts after as_of",
    });
  });

  it("rejects missing caip10", async () => {
    const res = await app({
      readOwnershipSnapshot: async () => {
        throw new Error("should not be called");
      },
    }).request("/v2/ownership-snapshot", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /v2/ownership-ready unchanged inventory shape", () => {
  beforeEach(() => {
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not add concentration fields to ownership-ready subjects", async () => {
    const { jobToOwnershipReadyRow } = await import("./ownership-ready.js");
    const job = {
      physicalJobId: "ingest_ready_shape",
      jobId: "ingest_ready_shape",
      status: "completed",
      attempt: 1,
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      tokenStandard: "erc721",
      prepareAdapterId: "belt.eth-erc721",
      prepareAdapterVersion: "belt-config-erc721.v1",
      capabilityId: "ownership_index.v1",
      capabilityVersion: "v",
      sourceSequence: "1",
      finalityPolicyVersion: "ethereum-finalized.v1",
      leaseEpoch: 0,
      deployment: {
        schema_version: 1,
        network: {
          schema_version: 1,
          network_namespace: "eip155",
          network_reference: "1",
        },
        address: ADDRESS as `0x${string}`,
        normalized_address: ADDRESS as `0x${string}`,
        deployment_id: {
          algorithm: "sha-256",
          domain: "collection.deployment",
          digest: "a".repeat(64),
        },
      },
      key: { chainId: 1, contract: ADDRESS as `0x${string}` },
    } as IngestJobRecord;
    const row = jobToOwnershipReadyRow(job, { holderCount: 10, indexedAtMs: 3_000 });
    expect(row).toBeTruthy();
    expect(Object.keys(row!).sort()).toEqual(
      [
        "address",
        "caip10",
        "completed_at",
        "holder_count",
        "indexed_at",
        "kitchen_job_status",
        "network_namespace",
        "network_reference",
        "physical_job_id",
        "prepare_adapter_id",
        "token_standard",
      ].sort(),
    );
    expect(row).not.toHaveProperty("concentration");
    expect(row).not.toHaveProperty("whale_candidate_count");
  });
});
