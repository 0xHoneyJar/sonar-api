import { serve } from "@hono/node-server";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolvePreparationCapability } from "./capability.js";
import {
  createCoverageAwareStatusReader,
  type ChainProgress,
} from "./coverage-aware-status-reader.js";
import type { CoverageFloorRecord } from "./coverage-readiness.js";
import {
  createHasuraCollectionStatusReader,
  beltGraphqlUrlFromEnv,
} from "./hasura-status-reader.js";
import { MemoryIngestJobStore } from "./ingest-store.js";
import { kitchenWorkerEnabled, startKitchenIngestWorker } from "./ingest-worker.js";
import {
  createPostgresIngestJobStore,
  kitchenDatabaseUrlFromEnv,
} from "./postgres-ingest-store.js";
import { createKitchenApp } from "./routes.js";
import { preparationRuntimeFromEnv } from "./preparation-runtime.js";
import type { IngestJobStorePort } from "./ingest-store.js";
import type { CollectionStatusReader } from "./status.js";
import { collectionKeyId, deploymentFromCollectionKey } from "./normalize.js";

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

type FloorRegistryRow = {
  chain_id: number;
  contract: string;
  physical_job_id?: string | null;
  required_floor?: number | null;
  verified_contract_creation_block?: number | null;
  blocked?: boolean;
  coverage_mode?: "full_from_required_floor" | "partial_operator_approved";
  config_digest?: string | null;
};

async function loadFloorRegistry(): Promise<{
  floors: Map<string, CoverageFloorRecord>;
  blockedKeys: Set<string>;
  configDigest: string;
}> {
  const registryPath =
    process.env.KITCHEN_FLOOR_REGISTRY_PATH?.trim() ||
    resolve(process.cwd(), "scripts/profiling/floor-registry.w1.json");
  const configPath =
    process.env.KITCHEN_BELT_CONFIG_PATH?.trim() ||
    resolve(process.cwd(), "config.yaml");
  if (!existsSync(registryPath)) {
    throw new Error(`coverage floor registry missing: ${registryPath}`);
  }
  if (!existsSync(configPath)) {
    throw new Error(`coverage Belt config missing: ${configPath}`);
  }

  const configDigest = createHash("sha256")
    .update(readFileSync(configPath, "utf8"))
    .digest("hex");
  const rows = JSON.parse(readFileSync(registryPath, "utf8")) as FloorRegistryRow[];
  const floors = new Map<string, CoverageFloorRecord>();
  const blockedKeys = new Set<string>();
  const capabilityVersions = new Map<number, string>();

  for (const row of rows) {
    const chainId = Number(row.chain_id);
    const contract = row.contract.toLowerCase();
    if (row.blocked) {
      blockedKeys.add(`${chainId}:${contract}`);
      continue;
    }
    const required = row.required_floor ?? row.verified_contract_creation_block;
    if (required == null) continue;
    if (row.config_digest !== configDigest) {
      throw new Error(
        `coverage config digest mismatch for ${row.chain_id}:${row.contract}: ` +
          `${row.config_digest ?? "<missing>"} != ${configDigest}`,
      );
    }

    let capabilityVersion = capabilityVersions.get(chainId);
    if (!capabilityVersion) {
      const deployment = await deploymentFromCollectionKey({
        chainId,
        contract: row.contract.toLowerCase() as `0x${string}`,
      });
      const capability = await resolvePreparationCapability({
        network: deployment.network,
        tokenStandard: "erc721",
      });
      if (!capability.enabled || capability.capabilityId !== "ownership_index.v1") {
        throw new Error(`coverage capability unavailable for chain ${chainId}`);
      }
      capabilityVersion = capability.capabilityVersion;
      capabilityVersions.set(chainId, capabilityVersion);
    }

    floors.set(`${chainId}:${contract}`, {
      chainId,
      contract,
      ...(row.physical_job_id
        ? { physicalJobId: row.physical_job_id }
        : {}),
      requiredFloor: Number(required),
      coverageMode: row.coverage_mode ?? "full_from_required_floor",
      configDigest,
      capabilityId: "ownership_index.v1",
      capabilityVersion,
    });
  }

  if (floors.size === 0) {
    throw new Error("coverage floor registry has no usable entries");
  }
  return { floors, blockedKeys, configDigest };
}

function failedProgress(chainIds: number[]): Map<number, ChainProgress> {
  return new Map(
    chainIds.map((chainId) => [
      chainId,
      { processedThroughBlock: 0, headBlock: 0, sensorFailed: true },
    ]),
  );
}

async function createStatusReader(
  store: IngestJobStorePort,
): Promise<CollectionStatusReader> {
  const inner = createHasuraCollectionStatusReader();
  if (process.env.KITCHEN_COVERAGE_READINESS?.trim() !== "1") {
    return inner;
  }

  const { floors, blockedKeys, configDigest } = await loadFloorRegistry();
  const graphqlUrl = beltGraphqlUrlFromEnv();

  return createCoverageAwareStatusReader({
    inner,
    resolveFloor: (key) => floors.get(collectionKeyId(key)) ?? null,
    isBlocked: (key) => blockedKeys.has(collectionKeyId(key)),
    resolveJobBindings: async (keys) => {
      const jobs = await store.getMany(keys);
      const bindings = new Map();
      for (const key of keys) {
        const id = collectionKeyId(key);
        const job = jobs.get(id);
        if (!job?.key) continue;
        const sameDeployment =
          job.key.chainId === key.chainId &&
          job.key.contract === key.contract &&
          job.deployment.network.network_namespace === "eip155" &&
          job.deployment.network.network_reference === String(key.chainId) &&
          job.deployment.normalized_address === key.contract;
        if (!sameDeployment) continue;
        bindings.set(id, {
          physicalJobId: job.physicalJobId,
          deploymentId: job.deployment.deployment_id.digest,
          configDigest,
          capabilityId: job.capabilityId,
          capabilityVersion: job.capabilityVersion,
        });
      }
      return bindings;
    },
    readChainProgress: async (chainIds) => {
      try {
        const response = await fetch(graphqlUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query:
              "{ chain_metadata { chain_id latest_processed_block block_height } }",
          }),
        });
        if (!response.ok) return failedProgress(chainIds);
        const payload = (await response.json()) as {
          data?: {
            chain_metadata?: Array<{
              chain_id: number;
              latest_processed_block: number;
              block_height: number;
            }>;
          };
          errors?: unknown[];
        };
        if (payload.errors?.length) return failedProgress(chainIds);
        const requested = new Set(chainIds);
        const progress = new Map<number, ChainProgress>();
        for (const row of payload.data?.chain_metadata ?? []) {
          const chainId = Number(row.chain_id);
          if (!requested.has(chainId)) continue;
          progress.set(chainId, {
            processedThroughBlock: Number(row.latest_processed_block),
            headBlock: Number(row.block_height),
          });
        }
        for (const chainId of chainIds) {
          if (!progress.has(chainId)) {
            progress.set(chainId, {
              processedThroughBlock: 0,
              headBlock: 0,
              sensorFailed: true,
            });
          }
        }
        return progress;
      } catch {
        return failedProgress(chainIds);
      }
    },
    tipLagBlocks: Number(process.env.KITCHEN_TIP_LAG_BLOCKS ?? 500),
  });
}

export async function createKitchenServer() {
  const store = await resolveIngestStore();
  const reader = await createStatusReader(store);
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
