import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { MemoryIngestJobStore } from "./ingest-store.js";
import { createKitchenApp } from "./routes.js";
import { resolveProbeRuntimeFromEnv } from "./resolve-probe-runtime.js";

const SERVICE_TOKEN = "test-service-token";

describe("POST /v1/collections/resolve-probe", () => {
  beforeEach(() => {
    vi.stubEnv("SERVICE_TOKEN", SERVICE_TOKEN);
    vi.stubEnv("NODE_ENV", "test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const app = () =>
    createKitchenApp({
      reader: {
        readIndexedSnapshot: async () => ({ holderCount: 0, indexedAtMs: null }),
      },
      store: new MemoryIngestJobStore(),
      resolveProbeRuntime: resolveProbeRuntimeFromEnv({ RESOLVER_MODE: "catalog" }),
    });

  it("rejects missing bearer", async () => {
    const res = await app().request("/v1/collections/resolve-probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        identifier: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
        environment: "mainnet",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns BAYC candidate for the BAYC address", async () => {
    const res = await app().request("/v1/collections/resolve-probe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SERVICE_TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: 1,
        identifier: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
        environment: "mainnet",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: Array<{ identity: { name: string; symbol: string } }>;
    };
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    expect(body.candidates[0]?.identity.name).toBe("Bored Ape Yacht Club");
    expect(body.candidates[0]?.identity.symbol).toBe("BAYC");
  });

  it("returns empty candidates for unknown address (200)", async () => {
    const res = await app().request("/v1/collections/resolve-probe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SERVICE_TOKEN}`,
      },
      body: JSON.stringify({
        schema_version: 1,
        identifier: "0x0000000000000000000000000000000000000001",
        environment: "mainnet",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: unknown[] };
    expect(body.candidates).toEqual([]);
  });
});
