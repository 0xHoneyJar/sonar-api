import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryIngestJobStore } from "./ingest-store.js";
import { createKitchenApp } from "./routes.js";
import { resolvePreparationCapability } from "./capability.js";
import { decodeCanonicalPreparationResponse } from "./protocol.js";
import { INJECTED_PREPARATION_RUNTIME } from "./preparation-runtime.js";
import { preparationRuntimeFromEnv } from "./preparation-runtime.js";
import type { CollectionStatusReader } from "./status.js";

const TOKEN = "kitchen-test-token";
const ADDRESS = "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684";
const reader: CollectionStatusReader = {
  readIndexedSnapshot: async () => ({ holderCount: 0, indexedAtMs: null }),
};

describe("canonical collection preparation", () => {
  let store: MemoryIngestJobStore;
  beforeEach(() => {
    store = new MemoryIngestJobStore();
    vi.stubEnv("SERVICE_TOKEN", TOKEN);
  });
  afterEach(() => vi.unstubAllEnvs());

  function request(body: unknown) {
    return createKitchenApp({
      store,
      reader,
      preparationRuntime: INJECTED_PREPARATION_RUNTIME,
    }).request("/v2/collection-preparations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  const evmRequest = (overrides: Record<string, unknown> = {}) => ({
    schema_version: 1,
    network: {
      schema_version: 1,
      network_namespace: "eip155",
      network_reference: "80094",
    },
    address: ADDRESS,
    token_standard: "erc721",
    ...overrides,
  });

  it("strictly rejects excess properties and unknown schema majors", async () => {
    expect((await request(evmRequest({ secret: "nope" }))).status).toBe(400);
    expect((await request(evmRequest({ schema_version: 2 }))).status).toBe(400);
  });

  it("joins legacy and v2 requests to one physical job without subscriber ownership", async () => {
    const canonical = await request(evmRequest({
      correlation: { source: "ordering-service", correlation_id: "order-a" },
    }));
    expect(canonical.status).toBe(202);
    const canonicalBody = await decodeCanonicalPreparationResponse(await canonical.json());

    const legacy = await createKitchenApp({
      store,
      reader,
      preparationRuntime: INJECTED_PREPARATION_RUNTIME,
    }).request(
      `/v1/collections/80094/${ADDRESS}/ingest`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          order_id: "order-b",
          source: "ordering-service",
          contact_email: "must-not-own@example.com",
          community_name: "Must Not Own",
        }),
      },
    );
    expect(legacy.status).toBe(202);
    await expect(legacy.json()).resolves.toEqual({
      job_id: canonicalBody.physical_job_id,
      status: "queued",
    });

    const job = await store.getByPhysicalJobId(canonicalBody.physical_job_id);
    expect(job).toBeDefined();
    expect(job).not.toHaveProperty("orderId");
    expect(job).not.toHaveProperty("contactEmail");
    expect(job).not.toHaveProperty("communityName");
    expect(await store.listCorrelations(job!.physicalJobId)).toHaveLength(2);
  });

  it("admits concurrent replay exactly once", async () => {
    const responses = await Promise.all(Array.from({ length: 50 }, () => request(evmRequest())));
    const ids = await Promise.all(
      responses.map(async (response) => (await response.json() as { physical_job_id: string }).physical_job_id),
    );
    expect(new Set(ids).size).toBe(1);
    expect(responses.filter((response) => response.status === 202)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(49);
  });

  it("returns typed unsupported outcomes without creating jobs", async () => {
    const erc1155 = await request(evmRequest({ token_standard: "erc1155" }));
    expect(erc1155.status).toBe(422);
    await expect(erc1155.json()).resolves.toMatchObject({
      error: { code: "unsupported_standard" },
    });

    const solana = await request({
      schema_version: 1,
      network: {
        schema_version: 1,
        network_namespace: "solana",
        network_reference: "mainnet-beta",
      },
      address: "So11111111111111111111111111111111111111112",
      token_standard: "metaplex_collection",
    });
    expect(solana.status).toBe(409);
    await expect(solana.json()).resolves.toMatchObject({
      error: { code: "capability_disabled" },
    });
    expect(await store.listByStatus("queued")).toHaveLength(0);
  });

  it("returns typed unsupported-network and degraded outcomes", async () => {
    const network = await request(evmRequest({
      network: {
        schema_version: 1,
        network_namespace: "eip155",
        network_reference: "999999",
      },
    }));
    expect(network.status).toBe(422);
    await expect(network.json()).resolves.toMatchObject({
      error: { code: "unsupported_network" },
    });

    const disabled = await request(evmRequest({
      network: {
        schema_version: 1,
        network_namespace: "eip155",
        network_reference: "4663",
      },
    }));
    expect(disabled.status).toBe(409);
    await expect(disabled.json()).resolves.toMatchObject({
      error: { code: "capability_disabled", reason_class: "kill_switch" },
    });

    const degradedApp = createKitchenApp({
      store,
      reader,
      capabilityResolver: async (input) => ({
        ...(await resolvePreparationCapability(input)),
        health: "degraded",
        reasonClass: "availability_degradation",
        reason: "preparation temporarily degraded",
      }),
      preparationRuntime: INJECTED_PREPARATION_RUNTIME,
    });
    const degraded = await degradedApp.request("/v2/collection-preparations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(evmRequest()),
    });
    expect(degraded.status).toBe(503);
    await expect(degraded.json()).resolves.toMatchObject({
      error: { code: "capability_degraded" },
    });
  });

  it("fails closed when migration parity diverges", async () => {
    store.setMigrationDivergenceForTests("injected mismatch");
    const response = await request(evmRequest());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "migration_divergence" },
    });
    const health = await createKitchenApp({
      store,
      reader,
      preparationRuntime: INJECTED_PREPARATION_RUNTIME,
    }).request("/health");
    expect(health.status).toBe(200);
    const ready = await createKitchenApp({
      store,
      reader,
      preparationRuntime: INJECTED_PREPARATION_RUNTIME,
    }).request("/ready");
    expect(ready.status).toBe(503);
  });

  it("does not admit immortal production jobs without a drain port", async () => {
    const unavailableApp = createKitchenApp({ store, reader });
    const response = await unavailableApp.request("/v2/collection-preparations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(evmRequest()),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "capability_degraded" },
    });
    expect(await store.listByStatus("queued")).toHaveLength(0);
    expect((await unavailableApp.request("/health")).status).toBe(200);
    expect((await unavailableApp.request("/ready")).status).toBe(503);

    expect(preparationRuntimeFromEnv({
      NODE_ENV: "production",
      KITCHEN_PREPARATION_PORT: "local_config",
      KITCHEN_WORKER_ENABLED: "true",
    })).toMatchObject({ available: false, mode: "unavailable" });
  });

  it("separates process liveness from preparation readiness", async () => {
    const app = createKitchenApp({
      store,
      reader,
      preparationRuntime: INJECTED_PREPARATION_RUNTIME,
    });
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      ok: true,
      service: "kitchen-api",
    });

    const ready = await app.request("/ready");
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      ok: true,
      service: "kitchen-api",
      preparation_admission: "enabled",
      migration_phase: "canonical",
    });
  });

  it("enables local_config only when the non-production worker is also enabled", () => {
    expect(preparationRuntimeFromEnv({
      NODE_ENV: "development",
      KITCHEN_PREPARATION_PORT: "local_config",
    })).toMatchObject({ available: false, mode: "unavailable" });
    expect(preparationRuntimeFromEnv({
      NODE_ENV: "development",
      KITCHEN_PREPARATION_PORT: "local_config",
      KITCHEN_WORKER_ENABLED: "false",
    })).toMatchObject({ available: false, mode: "unavailable" });
    expect(preparationRuntimeFromEnv({
      NODE_ENV: "development",
      KITCHEN_PREPARATION_PORT: "local_config",
      KITCHEN_WORKER_ENABLED: "true",
    })).toMatchObject({ available: true, mode: "local_config" });
  });

  it("leases one queued job to only one worker", async () => {
    await request(evmRequest());
    const [first, second] = await Promise.all([
      store.claimQueued({ workerId: "a", nowMs: 100, leaseMs: 1_000 }),
      store.claimQueued({ workerId: "b", nowMs: 100, leaseMs: 1_000 }),
    ]);
    expect(first.length + second.length).toBe(1);
  });
});
