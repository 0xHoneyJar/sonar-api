import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryIngestJobStore } from "./ingest-store.js";
import {
  createFailingTransport,
  createPullBufferTransport,
  relayOutboxRow,
} from "./outbox.js";
import { createKitchenApp } from "./routes.js";
import { INJECTED_PREPARATION_RUNTIME } from "./preparation-runtime.js";
import type { CollectionStatusReader } from "./status.js";

const TOKEN = "kitchen-test-token";
const ADDRESS = "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684" as `0x${string}`;
const reader: CollectionStatusReader = {
  readIndexedSnapshot: async () => ({
    holderCount: 1,
    indexedAtMs: 1_700_000_000_000,
    readiness: {
      state: "ready",
      kind: "indexed_rows",
      observedAtMs: 1_700_000_000_000,
    },
  }),
};

describe("kitchen outbox three proofs", () => {
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

  async function completeOneJob() {
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
    const body = await admit.json();
    const physicalJobId = body.physical_job_id as string;
    await store.updateStatus(physicalJobId, "indexing");
    const completed = await store.updateStatus(physicalJobId, "completed");
    expect(completed?.status).toBe("completed");
    return physicalJobId;
  }

  it("proof 1: completed job commits ownership.ready outbox pending", async () => {
    await completeOneJob();
    const pending = await store.listOutbox({ publishState: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.event_type).toBe("ownership.ready");
    expect(pending[0]?.payload.plane).toBe("sonar_kitchen_ownership");
    expect(pending[0]?.publish_state).toBe("pending");
  });

  it("proof 2: failing transport leaves pending — never swallows as published", async () => {
    await completeOneJob();
    const [row] = await store.listOutbox({ publishState: "pending" });
    expect(row).toBeTruthy();
    const result = await relayOutboxRow({
      row: row!,
      transport: createFailingTransport("nats_down"),
      markPublishing: (id) => store.markOutboxPublishing(id),
      markPublished: (id, at) => store.markOutboxPublished(id, at),
      markFailed: (id, err, terminal) => store.markOutboxFailed(id, err, terminal),
    });
    expect(result).toBe("failed");
    const after = await store.listOutbox();
    expect(after[0]?.publish_state).toBe("pending");
    expect(after[0]?.last_error).toBe("nats_down");
    expect(after[0]?.publish_state).not.toBe("published");
  });

  it("proof 2b: pull accept marks published without implying consumer acted", async () => {
    await completeOneJob();
    const relay = await app().request("/v2/outbox/relay-pull", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(relay.status).toBe(200);
    const body = await relay.json();
    expect(body.accepted_count).toBe(1);
    expect(body.note).toMatch(/Score\/order consumers must act separately/);
    const published = await store.listOutbox({ publishState: "published" });
    expect(published).toHaveLength(1);
  });

  it("idempotent enqueue on reconcile", async () => {
    await completeOneJob();
    const n = await store.reconcileOwnershipReadyOutbox(10);
    expect(n).toBe(0);
    const pending = await store.listOutbox({ publishState: "pending" });
    expect(pending).toHaveLength(1);
  });

  it("GET /v2/outbox lists pending intents", async () => {
    await completeOneJob();
    const res = await app().request("/v2/outbox?publish_state=pending", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.events[0].event_type).toBe("ownership.ready");
  });

});
