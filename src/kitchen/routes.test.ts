import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryIngestJobStore } from "./ingest-store.js";
import { createCollectionRoutes } from "./routes.js";
import { INJECTED_PREPARATION_RUNTIME } from "./preparation-runtime.js";
import type { CollectionStatusReader } from "./status.js";

/** Berachain fixture from tracked-erc721-bera-collections.test.ts */
const FIXTURE_CHAIN_ID = 80094;
const FIXTURE_CONTRACT = "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684";

const SERVICE_TOKEN = "test-service-token";

function makeReader(snapshot: {
  holderCount: number;
  indexedAtMs?: number | null;
  ready?: boolean;
}): CollectionStatusReader {
  return {
    readIndexedSnapshot: async () => ({
      holderCount: snapshot.holderCount,
      indexedAtMs: snapshot.indexedAtMs ?? null,
      ...((snapshot.ready ?? snapshot.holderCount > 0)
        ? {
            readiness: {
              state: "ready" as const,
              kind: "indexed_rows" as const,
              observedAtMs: snapshot.indexedAtMs ?? Date.now(),
            },
          }
        : {}),
    }),
  };
}

describe("kitchen collection routes", () => {
  const store = new MemoryIngestJobStore();
  let app = createCollectionRoutes({
    reader: makeReader({ holderCount: 0 }),
    store,
    preparationRuntime: INJECTED_PREPARATION_RUNTIME,
  });

  beforeEach(() => {
    store.clearForTests();
    vi.stubEnv("SERVICE_TOKEN", SERVICE_TOKEN);
    app = createCollectionRoutes({
      reader: makeReader({ holderCount: 0 }),
      store,
      preparationRuntime: INJECTED_PREPARATION_RUNTIME,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function authHeaders(extra: Record<string, string> = {}) {
    return {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      ...extra,
    };
  }

  it("rejects unauthenticated status probes", async () => {
    const res = await app.request(`/${FIXTURE_CHAIN_ID}/${FIXTURE_CONTRACT}/status`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for missing collections (consumer maps to missing)", async () => {
    const res = await app.request(`/${FIXTURE_CHAIN_ID}/${FIXTURE_CONTRACT}/status`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "collection not found" });
  });

  it("returns indexed status for fixture contract with holders", async () => {
    app = createCollectionRoutes({
      reader: makeReader({
        holderCount: 1234,
        indexedAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
      }),
      store,
      preparationRuntime: INJECTED_PREPARATION_RUNTIME,
    });

    const res = await app.request(`/${FIXTURE_CHAIN_ID}/${FIXTURE_CONTRACT}/status`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: "indexed",
      holder_count: 1234,
      indexed_at: "2026-07-01T12:00:00.000Z",
    });
  });

  it("returns indexing after ingest is queued", async () => {
    const ingest = await app.request(`/${FIXTURE_CHAIN_ID}/${FIXTURE_CONTRACT}/ingest`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        order_id: "11111111-1111-4111-8111-111111111111",
        source: "ordering-service",
        contact_email: "cm@example.com",
        community_name: "Fixture Community",
      }),
    });
    expect(ingest.status).toBe(202);
    const queued = await ingest.json();
    expect(queued).toMatchObject({
      status: "queued",
      job_id: expect.stringMatching(/^ingest_[0-9a-f]+_[0-9a-f]+$/),
    });

    const status = await app.request(`/${FIXTURE_CHAIN_ID}/${FIXTURE_CONTRACT}/status`, {
      headers: authHeaders(),
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({ status: "indexing" });
  });

  it("preserves legacy clients that send blank optional ingest fields", async () => {
    for (const optionalFields of [
      { contact_email: "", community_name: "   " },
      { contact_email: null, community_name: null },
    ]) {
      store.clearForTests();
      const ingest = await app.request(
        `/${FIXTURE_CHAIN_ID}/${FIXTURE_CONTRACT}/ingest`,
        {
          method: "POST",
          headers: {
            ...authHeaders(),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            order_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            source: "ordering-service",
            ...optionalFields,
          }),
        },
      );
      expect(ingest.status).toBe(202);
      await expect(ingest.json()).resolves.toMatchObject({
        status: "queued",
        job_id: expect.stringMatching(/^ingest_[0-9a-f]+_[0-9a-f]+$/),
      });
    }
  });

  it("is idempotent on repeat ingest for the same collection", async () => {
    const body = JSON.stringify({
      order_id: "22222222-2222-4222-8222-222222222222",
      source: "ordering-service",
    });
    const headers = {
      ...authHeaders(),
      "content-type": "application/json",
    };

    const first = await app.request(`/${FIXTURE_CHAIN_ID}/${FIXTURE_CONTRACT}/ingest`, {
      method: "POST",
      headers,
      body,
    });
    const second = await app.request(`/${FIXTURE_CHAIN_ID}/${FIXTURE_CONTRACT}/ingest`, {
      method: "POST",
      headers,
      body,
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    await expect(first.json()).resolves.toEqual(await second.json());
  });

  it("preserves legacy trimming and excess-field compatibility", async () => {
    const res = await app.request(`/${FIXTURE_CHAIN_ID}/${FIXTURE_CONTRACT}/ingest`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        order_id: "  legacy-order  ",
        source: "  ordering-service  ",
        ignored_legacy_extension: true,
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { job_id: string };
    await expect(store.listCorrelations(body.job_id)).resolves.toEqual([
      expect.objectContaining({
        source: "ordering-service",
        correlationId: "legacy-order",
      }),
    ]);
  });

  it("returns failed when the ingest job failed", async () => {
    const key = {
      chainId: FIXTURE_CHAIN_ID,
      contract: FIXTURE_CONTRACT as `0x${string}`,
    };
    await store.upsertQueued(key, {
      order_id: "44444444-4444-4444-8444-444444444444",
      source: "ordering-service",
    });
    store.markFailed(key);

    const res = await app.request(`/${FIXTURE_CHAIN_ID}/${FIXTURE_CONTRACT}/status`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "failed" });
  });

  it("re-queues ingest after a failed job", async () => {
    const key = {
      chainId: FIXTURE_CHAIN_ID,
      contract: FIXTURE_CONTRACT as `0x${string}`,
    };
    await store.upsertQueued(key, {
      order_id: "44444444-4444-4444-8444-444444444444",
      source: "ordering-service",
    });
    store.markFailed(key);

    const res = await app.request(`/${FIXTURE_CHAIN_ID}/${FIXTURE_CONTRACT}/ingest`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        order_id: "55555555-5555-4555-8555-555555555555",
        source: "ordering-service",
      }),
    });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ status: "queued" });

    const status = await app.request(`/${FIXTURE_CHAIN_ID}/${FIXTURE_CONTRACT}/status`, {
      headers: authHeaders(),
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({ status: "indexing" });
  });

  it("returns 200 when ingest is requested for an already indexed collection", async () => {
    app = createCollectionRoutes({
      reader: makeReader({
        holderCount: 42,
        indexedAtMs: Date.parse("2026-07-01T12:00:00.000Z"),
      }),
      store,
      preparationRuntime: INJECTED_PREPARATION_RUNTIME,
    });

    const res = await app.request(`/${FIXTURE_CHAIN_ID}/${FIXTURE_CONTRACT}/ingest`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        order_id: "33333333-3333-4333-8333-333333333333",
        source: "ordering-service",
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: "indexed",
      holder_count: 42,
      indexed_at: "2026-07-01T12:00:00.000Z",
    });
  });
});
