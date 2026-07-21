import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createCoverageAwareStatusReader } from "./coverage-aware-status-reader.js";
import type { CoverageFloorRecord } from "./coverage-readiness.js";
import { createHasuraCollectionStatusReader, beltGraphqlUrlFromEnv } from "./hasura-status-reader.js";
import { MemoryIngestJobStore } from "./ingest-store.js";
import { kitchenWorkerEnabled, startKitchenIngestWorker } from "./ingest-worker.js";
import {
  createHasuraOwnershipSnapshotReader,
  type OwnershipSnapshotReader,
} from "./ownership-snapshot-reader.js";
import {
  createPostgresIngestJobStore,
  kitchenDatabaseUrlFromEnv,
} from "./postgres-ingest-store.js";
import { createKitchenApp } from "./routes.js";
import { preparationRuntimeFromEnv } from "./preparation-runtime.js";
import type { ChainProgressRow } from "./indexing-status.js";
import type { IngestJobStorePort } from "./ingest-store.js";
import {
  createRoutedCollectionStatusReader,
  ROBINHOOD_CHAIN_ID,
  robinhoodGraphqlUrlFromEnv,
} from "./routed-status-reader.js";
import type { CollectionStatusReader } from "./status.js";
import { parseCaip10 } from "./ownership-snapshot.js";

async function resolveIngestStore(): Promise<IngestJobStorePort> {
  const dbUrl = kitchenDatabaseUrlFromEnv();
  if (dbUrl) {
    return createPostgresIngestJobStore(dbUrl);
  }

  const nodeEnv = process.env.NODE_ENV?.trim();
  if (nodeEnv === "production" || nodeEnv === "prod") {
    throw new Error(
      "KITCHEN_DATABASE_URL required in production (dedicated Postgres; not belt ENVIO_PG wipe target — sonar-api#236)",
    );
  }

  return new MemoryIngestJobStore();
}

function loadFloorRegistry(): Map<string, CoverageFloorRecord> {
  const path =
    process.env.KITCHEN_FLOOR_REGISTRY_PATH?.trim() ||
    resolve(process.cwd(), "scripts/profiling/floor-registry.w1.json");
  const map = new Map<string, CoverageFloorRecord>();
  if (!existsSync(path)) return map;
  const rows = JSON.parse(readFileSync(path, "utf8")) as Array<{
    chain_id: number;
    contract: string;
    required_floor?: number | null;
    verified_contract_creation_block?: number | null;
    blocked?: boolean;
    coverage_mode?: "full_from_required_floor" | "partial_operator_approved";
  }>;
  const configDigest =
    process.env.KITCHEN_CONFIG_DIGEST?.trim() ||
    "unbound".padEnd(64, "0");
  const capabilityVersion =
    process.env.KITCHEN_CAPABILITY_VERSION?.trim() ||
    "unbound".padEnd(64, "0");
  for (const row of rows) {
    if (row.blocked) continue;
    const required = row.required_floor ?? row.verified_contract_creation_block;
    if (required == null) continue;
    const contract = row.contract.toLowerCase();
    map.set(`${row.chain_id}:${contract}`, {
      chainId: row.chain_id,
      contract,
      requiredFloor: required,
      coverageMode: row.coverage_mode ?? "full_from_required_floor",
      configDigest,
      capabilityId: "ownership_index.v1",
      capabilityVersion,
    });
  }
  return map;
}

async function fetchChainProgressRows(
  graphqlUrl: string,
  adminSecret?: string,
): Promise<ChainProgressRow[]> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (adminSecret) headers["x-hasura-admin-secret"] = adminSecret;
    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query:
          "{ chain_metadata { chain_id start_block latest_processed_block latest_fetched_block_number num_events_processed } }",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      data?: {
        chain_metadata?: Array<{
          chain_id: number;
          start_block?: number;
          latest_processed_block: number;
          latest_fetched_block_number: number;
          num_events_processed: number;
        }>;
      };
      errors?: unknown[];
    };
    if (payload.errors?.length) return [];
    return (payload.data?.chain_metadata ?? []).map((row) => ({
      chain_id: Number(row.chain_id),
      start_block: Number(row.start_block ?? 0),
      latest_processed_block: Number(row.latest_processed_block),
      latest_fetched_block_number: Number(row.latest_fetched_block_number),
      num_events_processed: Number(row.num_events_processed),
      num_batches_fetched: 0,
    }));
  } catch {
    return [];
  }
}

function createStatusReader(): CollectionStatusReader {
  const monobelt = createHasuraCollectionStatusReader();
  const rhUrl = robinhoodGraphqlUrlFromEnv();
  const rhAdmin = process.env.ROBINHOOD_HASURA_ADMIN_SECRET?.trim();
  const inner = rhUrl
    ? createRoutedCollectionStatusReader({
        defaultReader: monobelt,
        robinhoodReader: createHasuraCollectionStatusReader({
          url: rhUrl,
          adminSecret: rhAdmin,
        }),
      })
    : monobelt;

  if (process.env.KITCHEN_COVERAGE_READINESS?.trim() !== "1") {
    return inner;
  }

  const floors = loadFloorRegistry();
  const monobeltGraphql = beltGraphqlUrlFromEnv();

  return createCoverageAwareStatusReader({
    inner,
    resolveFloor: (key) => floors.get(`${key.chainId}:${key.contract}`) ?? null,
    readChainProgress: async (chainId) => {
      const useRh = chainId === ROBINHOOD_CHAIN_ID && rhUrl;
      const url = useRh ? rhUrl : monobeltGraphql;
      try {
        const rows = await fetchChainProgressRows(url, useRh ? rhAdmin : undefined);
        const row = rows.find((c) => c.chain_id === chainId);
        if (!row) return { processedThroughBlock: 0, sensorFailed: true };
        return { processedThroughBlock: row.latest_processed_block };
      } catch {
        return { processedThroughBlock: 0, sensorFailed: true };
      }
    },
    // Job digest binding must be supplied by the worker path in a follow-up;
    // without it the coverage wrapper refuses to invent readiness (inner rows alone).
    resolveJobBinding: () => null,
  });
}

/** Monobelt chains + RH sidecar 4663 when ROBINHOOD_BELT_GRAPHQL_URL is set. */
async function readChainProgressViaGraphql(): Promise<ChainProgressRow[]> {
  const mono = await fetchChainProgressRows(beltGraphqlUrlFromEnv());
  const rhUrl = robinhoodGraphqlUrlFromEnv();
  const rhAdmin = process.env.ROBINHOOD_HASURA_ADMIN_SECRET?.trim();
  if (!rhUrl) return mono.filter((r) => r.chain_id !== ROBINHOOD_CHAIN_ID);
  const rh = await fetchChainProgressRows(rhUrl, rhAdmin);
  const byId = new Map<number, ChainProgressRow>();
  for (const row of mono) {
    if (row.chain_id !== ROBINHOOD_CHAIN_ID) byId.set(row.chain_id, row);
  }
  for (const row of rh) {
    if (row.chain_id === ROBINHOOD_CHAIN_ID) byId.set(row.chain_id, row);
  }
  return [...byId.values()].sort((a, b) => a.chain_id - b.chain_id);
}

function createOwnershipSnapshotReader(): OwnershipSnapshotReader {
  const monobelt = createHasuraOwnershipSnapshotReader();
  const rhUrl = robinhoodGraphqlUrlFromEnv();
  const rhAdmin = process.env.ROBINHOOD_HASURA_ADMIN_SECRET?.trim();
  if (!rhUrl) return monobelt;
  const robinhood = createHasuraOwnershipSnapshotReader({
    url: rhUrl,
    adminSecret: rhAdmin,
  });
  return {
    async readOwnershipSnapshot(args) {
      const subject = parseCaip10(args.caip10);
      if (subject?.network_reference === String(ROBINHOOD_CHAIN_ID)) {
        return robinhood.readOwnershipSnapshot(args);
      }
      return monobelt.readOwnershipSnapshot(args);
    },
  };
}

export async function createKitchenServer() {
  const store = await resolveIngestStore();
  const reader = createStatusReader();
  const preparationRuntime = preparationRuntimeFromEnv();
  const app = createKitchenApp({
    reader,
    store,
    preparationRuntime,
    readChainProgress: readChainProgressViaGraphql,
    ownershipSnapshotReader: createOwnershipSnapshotReader(),
  });
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
