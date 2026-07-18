import { serve } from "@hono/node-server";

import { createHasuraCollectionStatusReader } from "./hasura-status-reader.js";
import { MemoryIngestJobStore } from "./ingest-store.js";
import { kitchenWorkerEnabled, startKitchenIngestWorker } from "./ingest-worker.js";
import {
  createPostgresIngestJobStore,
  kitchenDatabaseUrlFromEnv,
} from "./postgres-ingest-store.js";
import { createKitchenApp } from "./routes.js";
import { preparationRuntimeFromEnv } from "./preparation-runtime.js";
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
  const preparationRuntime = preparationRuntimeFromEnv();
  const app = createKitchenApp({ reader, store, preparationRuntime });
  return { app, store, reader };
}

const port = Number(process.env.PORT ?? 8080);

createKitchenServer()
  .then(({ app, store, reader }) => {
    if (kitchenWorkerEnabled()) {
      startKitchenIngestWorker({ store, reader });
      console.log("kitchen ingest worker enabled");
    } else if (process.env.KITCHEN_WORKER_ENABLED) {
      console.warn(
        "kitchen ingest worker requested but disabled: set KITCHEN_PREPARATION_PORT=belt_config_batch (with a drain strategy) or local_config (non-prod)",
      );
    }
    serve({ fetch: app.fetch, port }, () => {
      console.log(`kitchen-api listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
