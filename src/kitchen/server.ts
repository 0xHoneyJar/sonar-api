import { serve } from "@hono/node-server";

import { createHasuraCollectionStatusReader } from "./hasura-status-reader.js";
import { MemoryIngestJobStore } from "./ingest-store.js";
import {
  createPostgresIngestJobStore,
  kitchenDatabaseUrlFromEnv,
} from "./postgres-ingest-store.js";
import { createKitchenApp } from "./routes.js";
import type { IngestJobStorePort } from "./ingest-store.js";

async function resolveIngestStore(): Promise<IngestJobStorePort> {
  const dbUrl = kitchenDatabaseUrlFromEnv();
  if (dbUrl) {
    return createPostgresIngestJobStore(dbUrl);
  }

  const nodeEnv = process.env.NODE_ENV?.trim();
  if (nodeEnv === "production" || nodeEnv === "prod") {
    throw new Error("KITCHEN_DATABASE_URL or ENVIO_PG_* required in production");
  }

  return new MemoryIngestJobStore();
}

export async function createKitchenServer() {
  const store = await resolveIngestStore();
  const reader = createHasuraCollectionStatusReader();
  return createKitchenApp({ reader, store });
}

const port = Number(process.env.PORT ?? 8080);

createKitchenServer()
  .then((app) => {
    serve({ fetch: app.fetch, port }, () => {
      console.log(`kitchen-api listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
