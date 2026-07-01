import { Hono } from "hono";

import { requireServiceToken } from "../auth";
import { ingestJobStore } from "./ingest-store";
import { collectionKeyFromParams } from "./normalize";
import { resolveCollectionStatus, toStatusResponse, type CollectionStatusReader } from "./status";
import type { IngestRequestBody } from "./types";

function parseIngestBody(raw: unknown): IngestRequestBody | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.order_id !== "string" || body.order_id.trim() === "") return null;
  if (typeof body.source !== "string" || body.source.trim() === "") return null;
  const parsed: IngestRequestBody = {
    order_id: body.order_id.trim(),
    source: body.source.trim(),
  };
  if (typeof body.contact_email === "string" && body.contact_email.trim() !== "") {
    parsed.contact_email = body.contact_email.trim();
  }
  if (typeof body.community_name === "string" && body.community_name.trim() !== "") {
    parsed.community_name = body.community_name.trim();
  }
  return parsed;
}

export function createCollectionRoutes(deps: {
  reader: CollectionStatusReader;
  store?: typeof ingestJobStore;
}): Hono {
  const { reader } = deps;
  const store = deps.store ?? ingestJobStore;
  const routes = new Hono();

  routes.use("*", requireServiceToken);

  routes.get("/:chain_id/:contract_address/status", async (c) => {
    const key = collectionKeyFromParams(c.req.param("chain_id"), c.req.param("contract_address"));
    if (!key) return c.json({ error: "invalid chain_id or contract_address" }, 400);

    const indexed = await reader.readIndexedSnapshot(key);
    const job = store.get(key);
    const status = resolveCollectionStatus({ indexed, job });

    if (status === "missing") {
      return c.json({ error: "collection not found" }, 404);
    }

    return c.json(toStatusResponse(status, indexed), 200);
  });

  routes.post("/:chain_id/:contract_address/ingest", async (c) => {
    const key = collectionKeyFromParams(c.req.param("chain_id"), c.req.param("contract_address"));
    if (!key) return c.json({ error: "invalid chain_id or contract_address" }, 400);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "request body must be JSON" }, 400);
    }

    const body = parseIngestBody(raw);
    if (!body) {
      return c.json({ error: "invalid ingest payload" }, 400);
    }

    const indexed = await reader.readIndexedSnapshot(key);
    if (indexed.holderCount > 0) {
      return c.json(
        {
          status: "indexed" as const,
          holder_count: indexed.holderCount,
          ...(indexed.indexedAtMs !== null
            ? { indexed_at: new Date(indexed.indexedAtMs).toISOString() }
            : {}),
        },
        200,
      );
    }

    const job = store.upsertQueued(key, body);
    return c.json({ job_id: job.jobId, status: "queued" as const }, 202);
  });

  return routes;
}
