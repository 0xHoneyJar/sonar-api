import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { patchConfigForKitchenIngest } from "./config-patcher.js";
import type { IngestJobStorePort } from "./ingest-store.js";
import { preparationRuntimeFromEnv } from "./preparation-runtime.js";
import { isIndexedSnapshotReady, type CollectionStatusReader } from "./status.js";
import type { IngestJobRecord } from "./types.js";

export function beltConfigPathFromEnv(): string {
  return process.env.KITCHEN_BELT_CONFIG_PATH?.trim() || "config.yaml";
}

/**
 * Async preparation stays off unless the operator explicitly selects the local
 * config seam. This seam is useful for hermetic proof but is not a production
 * deployment port.
 */
export function kitchenWorkerEnabled(): boolean {
  const raw = process.env.KITCHEN_WORKER_ENABLED?.trim().toLowerCase();
  const requested = raw === "1" || raw === "true" || raw === "yes";
  return requested && preparationRuntimeFromEnv().mode === "local_config";
}

export function kitchenWorkerIntervalMs(): number {
  const parsed = Number(process.env.KITCHEN_WORKER_INTERVAL_MS ?? 30_000);
  return Number.isFinite(parsed) && parsed >= 5_000 ? parsed : 30_000;
}

export function kitchenIngestTimeoutMs(): number {
  const parsed = Number(process.env.KITCHEN_INGEST_TIMEOUT_MS ?? 86_400_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 86_400_000;
}

function deterministicJobLabel(job: IngestJobRecord): string {
  const network = job.deployment.network;
  return `kitchen_${network.network_namespace}_${network.network_reference}_${job.deployment.deployment_id.digest.slice(0, 12)}`;
}

export function applyBeltConfigPatch(args: {
  configPath: string;
  job: IngestJobRecord;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
}): { changed: boolean } {
  if (args.job.tokenStandard !== "erc721" || !args.job.key) {
    throw new Error(`unsupported_standard: ${args.job.tokenStandard} cannot mutate Belt config`);
  }
  if (
    args.job.prepareAdapterId !== "belt.eth-erc721" &&
    args.job.prepareAdapterId !== "belt.evm-erc721"
  ) {
    throw new Error(`unsupported_adapter: ${args.job.prepareAdapterId}`);
  }

  const readFile = args.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const writeFile = args.writeFile ?? ((path: string, contents: string) => {
    writeFileSync(path, contents, "utf8");
  });
  const current = readFile(args.configPath);
  const { changed, configYaml } = patchConfigForKitchenIngest({
    configYaml: current,
    key: args.job.key,
    label: deterministicJobLabel(args.job),
    contractName:
      args.job.prepareAdapterId === "belt.eth-erc721"
        ? "EthTrackedErc721"
        : "TrackedErc721",
  });
  if (changed) writeFile(args.configPath, configYaml);
  return { changed };
}

async function notifyIndexerRestart(): Promise<void> {
  const webhook = process.env.KITCHEN_INDEXER_RESTART_WEBHOOK?.trim();
  if (!webhook) return;
  const response = await /* @non-metadata-fetch kitchen webhook */ fetch(webhook, { method: "POST" });
  if (!response.ok) {
    throw new Error(`indexer restart webhook HTTP ${response.status}`);
  }
}

export async function processQueuedIngestJob(args: {
  job: IngestJobRecord;
  store: IngestJobStorePort;
  configPath?: string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
  restart?: () => Promise<void>;
  nowMs?: number;
}): Promise<void> {
  const configPath = args.configPath ?? beltConfigPathFromEnv();
  if (!args.job.leaseOwner || args.job.leaseUntilMs === undefined) return;
  const lease = { owner: args.job.leaseOwner, epoch: args.job.leaseEpoch };
  const renewed = await args.store.renewLease({
    physicalJobId: args.job.physicalJobId,
    lease,
    nowMs: args.nowMs,
  });
  if (!renewed) return;
  try {
    applyBeltConfigPatch({
      configPath,
      job: renewed,
      readFile: args.readFile,
      writeFile: args.writeFile,
    });
    await (args.restart ?? notifyIndexerRestart)();
    await args.store.updateStatus(args.job.physicalJobId, "indexing", {
      nowMs: args.nowMs,
      expectedLease: lease,
      expectedStatus: "queued",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = message.includes(":") ? message.split(":", 1)[0] : "preparation_failed";
    await args.store.updateStatus(args.job.physicalJobId, "failed", {
      errorCode,
      errorMessage: message,
      nowMs: args.nowMs,
      expectedLease: lease,
      expectedStatus: "queued",
    });
  }
}

export async function advanceIndexingJobs(args: {
  store: IngestJobStorePort;
  reader: CollectionStatusReader;
  nowMs?: number;
  timeoutMs?: number;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const timeoutMs = args.timeoutMs ?? kitchenIngestTimeoutMs();
  const jobs = await args.store.listByStatus("indexing", 100);

  for (const job of jobs) {
    if (!job.key) {
      await args.store.updateStatus(job.physicalJobId, "failed", {
        nowMs,
        errorCode: "readiness_unsupported",
        errorMessage: "no readiness adapter exists for this deployment",
        expectedStatus: "indexing",
      });
      continue;
    }
    const indexed = await args.reader.readIndexedSnapshot(job.key);
    if (isIndexedSnapshotReady(indexed)) {
      // Readiness completion is an intentional coordinator transition after
      // preparation has reached indexing; it is not publication by the former
      // queued-job lease holder.
      await args.store.updateStatus(job.physicalJobId, "completed", {
        nowMs,
        expectedStatus: "indexing",
      });
      continue;
    }
    if (nowMs - job.updatedAtMs > timeoutMs) {
      await args.store.updateStatus(job.physicalJobId, "failed", {
        nowMs,
        errorCode: "indexing_timeout",
        errorMessage: `indexing timeout after ${timeoutMs}ms (no explicit readiness evidence)`,
        expectedStatus: "indexing",
      });
    }
  }
}

export async function runKitchenIngestWorkerTick(args: {
  store: IngestJobStorePort;
  reader: CollectionStatusReader;
  workerId?: string;
  configPath?: string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string) => void;
  restart?: () => Promise<void>;
  nowMs?: number;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  await args.store.reconcileUnbackfilledActiveJobs(nowMs);
  const queued = await args.store.claimQueued({
    workerId: args.workerId ?? `kitchen-${randomUUID()}`,
    limit: 10,
    nowMs,
  });
  for (const job of queued) {
    await processQueuedIngestJob({
      job,
      store: args.store,
      configPath: args.configPath,
      readFile: args.readFile,
      writeFile: args.writeFile,
      restart: args.restart,
      nowMs,
    });
  }
  await advanceIndexingJobs({ store: args.store, reader: args.reader, nowMs });
}

export function startKitchenIngestWorker(args: {
  store: IngestJobStorePort;
  reader: CollectionStatusReader;
}): () => void {
  const intervalMs = kitchenWorkerIntervalMs();
  const workerId = `kitchen-${randomUUID()}`;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runKitchenIngestWorkerTick({ ...args, workerId });
    } catch (error) {
      console.error("[kitchen-worker] tick failed:", error);
    } finally {
      running = false;
    }
  };
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(handle);
}
